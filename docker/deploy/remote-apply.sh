#!/usr/bin/env bash
#
# 目标机上的部署执行脚本。由 .github/workflows/deploy-server.yml rsync 到
# ${DEPLOY_PATH} 后以 root 执行。
#
# 设计原则 —— 这台机器上通常还跑着别的服务（nginx 上有其他站点、PM2 有其他进程），
# 所以这个脚本严格遵守：
#   * 只操作 compose project "monopoly"、${WEB_ROOT}、${NGINX_SNIPPET_PATH} 三处
#   * 绝不 docker system prune / docker network prune（会波及其他容器）
#   * 改 nginx 前先备份，nginx -t 不通过就自动回滚并且不 reload
#   * 清理旧镜像时依赖 docker rmi 对"正在使用"的镜像会失败的特性作为兜底
#
# 配置来源：
#   ./deploy.conf  非敏感部署参数（由 workflow 从 repo variables 生成）
#   ./.env         应用运行时环境变量（由 workflow 从 repo variables/secrets 生成）
#                  本脚本不 source 它 —— 交给 docker compose 自己解析，
#                  避免密码里的特殊字符被 shell 二次解释。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[fail] %s\033[0m\n' "$*" >&2; exit 1; }

[ -f ./deploy.conf ] || die "deploy.conf 不存在，rsync 没同步完整"
[ -f ./.env ] || die ".env 不存在，rsync 没同步完整"
[ -f ./docker-compose.yml ] || die "docker-compose.yml 不存在"

# shellcheck disable=SC1091
source ./deploy.conf

: "${SERVER_IMAGE:?deploy.conf 缺少 SERVER_IMAGE}"
: "${IMAGE_REPO:?deploy.conf 缺少 IMAGE_REPO}"
: "${BIND_ADDRESS:=127.0.0.1}"
# 自检走 http 还是 https。https 部署时域名的 80 通常会 301 到 443，
# 继续用 http 打自检会拿到 301 而不是 200，把好好的部署判成失败。
: "${PROTOCOL:=http}"
: "${DEPLOY_WEB:=false}"
: "${UPDATE_NGINX:=true}"
: "${GHCR_PERSIST_LOGIN:=false}"
: "${IMAGE_KEEP:=3}"
: "${HEALTH_TIMEOUT:=300}"
: "${PULL_RETRIES:=4}"
# ssh：镜像由 workflow 的 Ship Images to Remote 步骤 docker load 到本机，
#      这台机器全程不连任何 registry。registry：本机自己 pull。
: "${IMAGE_TRANSPORT:=registry}"
# docker compose 是从环境变量读 COMPOSE_PROFILES 的，source 进来的还得导出
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-}"

STAMP="$(date +%Y%m%d%H%M%S)"

# ---------------------------------------------------------------- GHCR 登录
ghcr_login() {
  if [ "$IMAGE_TRANSPORT" = "ssh" ]; then
    log "镜像由 CI 经 SSH 送达，跳过 registry 登录"
    return 0
  fi
  if [ ! -s ./.ghcr-token ]; then
    warn "没有收到 GHCR 凭据，假定镜像是公开的或本机已登录"
    return 0
  fi
  log "登录 ghcr.io（用户 ${GHCR_USERNAME:-unknown}）"
  docker login ghcr.io -u "${GHCR_USERNAME:?deploy.conf 缺少 GHCR_USERNAME}" --password-stdin < ./.ghcr-token
  rm -f ./.ghcr-token
}

ghcr_logout() {
  rm -f ./.ghcr-token
  if [ "$GHCR_PERSIST_LOGIN" != "true" ]; then
    # GITHUB_TOKEN 只在本次 workflow run 期间有效，留在 config.json 里是个死凭据
    docker logout ghcr.io >/dev/null 2>&1 || true
  fi
}
trap ghcr_logout EXIT

# ---------------------------------------------------------------- 容器
# IMAGE_TRANSPORT=ssh：镜像已经由 CI docker load 进来了，这里只确认一遍。
# 缺镜像时不去 pull —— 这台机器可能压根连不上 registry，与其卡在超时上，
# 不如立刻报错指向真正出问题的那一步。compose config --images 会按当前
# COMPOSE_PROFILES 列出实际要用的镜像，coturn 开没开都能覆盖到。
verify_images() {
  log "校验 CI 送过来的镜像"
  local img images missing=""
  # 分两步写：local 和赋值合在一行的话，退出码会变成 local 的，命令失败就吞了
  images="$(docker compose config --images)" \
    || die "docker compose config --images 执行失败，检查 .env 与 docker-compose.yml"
  [ -n "$images" ] || die "compose 没解析出任何镜像，bundle 可能不完整"

  while read -r img; do
    [ -n "$img" ] || continue
    if docker image inspect "$img" >/dev/null 2>&1; then
      printf '  \033[32mok\033[0m   %s\n' "$img"
    else
      printf '  \033[31mMISS\033[0m %s\n' "$img"
      missing="${missing} ${img}"
    fi
  done <<< "$images"

  [ -z "$missing" ] || die "目标机上缺少这些镜像：${missing}
     IMAGE_TRANSPORT=ssh 时镜像由 workflow 的 Ship Images to Remote 步骤送达，
     该步骤失败或被跳过时会出现这种情况。也可以把 variable IMAGE_TRANSPORT
     改成 registry，让目标机自己去 pull。"
}

# 目标机到 ghcr.io 的链路不稳：manifest 走 ghcr.io，blob 走
# pkg-containers.githubusercontent.com，后者经常传到一半断流，日志里表现为
# 一屏 "<layer> Retrying in N seconds"。compose 自己只在层级别重试有限次，
# 用尽就整体失败 —— 在 set -e 下会把整次部署带崩。
#
# 对策两条：
#   1. 已经拉完的层是留在本地的，所以每一轮重试都是净进展，整体重试有意义
#   2. 串行拉（COMPOSE_PARALLEL_LIMIT=1）：窄带宽下并发只会互相抢，反而更难拉完
pull_images() {
  if [ "$IMAGE_TRANSPORT" = "ssh" ]; then
    verify_images
    return 0
  fi

  if docker image inspect "$SERVER_IMAGE" >/dev/null 2>&1; then
    # sha-xxx tag 不可变，层齐了 pull 只是校验一下 manifest，几乎不耗时
    log "本地已有 ${SERVER_IMAGE}，pull 只做校验"
  else
    log "拉取镜像 ${SERVER_IMAGE}"
  fi

  local attempt=1 delay
  export COMPOSE_PARALLEL_LIMIT=1
  while :; do
    if docker compose pull; then
      return 0
    fi
    if [ "$attempt" -ge "$PULL_RETRIES" ]; then
      die "拉取镜像失败（已尝试 ${PULL_RETRIES} 次）。目标机到 ghcr.io 的连通性有问题，
     先在机器上试 curl -sSI https://pkg-containers.githubusercontent.com/ ；
     长期方案见 docs/deployment-github-actions.md 的「镜像拉不动」一节。"
    fi
    delay=$((attempt * 15))
    warn "拉取失败（第 ${attempt}/${PULL_RETRIES} 次），${delay}s 后重试（已完成的层会复用）"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

start_stack() {
  pull_images

  log "启动 compose project 'monopoly'（profiles=${COMPOSE_PROFILES:-<none>}）"
  # 不用 --remove-orphans：coturn 是 profile 服务，profile 关闭时可能被误判为孤儿
  if docker compose up -d; then
    return 0
  fi

  # MySQL 首次初始化期间若抖动一下（被 restart 策略重启），compose 的
  # depends_on: service_healthy 会当场放弃，把 server 容器留在 Created 状态。
  # 这时 MySQL 自己往往几秒后就好了，等它 healthy 再补一次 up 即可。
  warn "首次 up 失败，等 MySQL 稳定后重试一次"
  wait_healthy monopoly-mysql "$HEALTH_TIMEOUT"
  docker compose up -d
}

wait_healthy() {
  local name="$1" timeout="$2" waited=0 state
  log "等待 ${name} 健康（最多 ${timeout}s）"
  while [ "$waited" -lt "$timeout" ]; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
    case "$state" in
      healthy) echo "  ${name}: healthy"; return 0 ;;
      exited|dead)
        docker logs --tail 100 "$name" 2>&1 || true
        die "${name} 已退出（state=${state}）"
        ;;
      missing) die "${name} 容器不存在" ;;
      *) printf '  %s: %s (%ss)\n' "$name" "$state" "$waited" ;;
    esac
    sleep 5
    waited=$((waited + 5))
  done
  docker logs --tail 100 "$name" 2>&1 || true
  die "${name} 在 ${timeout}s 内没有变成 healthy"
}

# ---------------------------------------------------------------- 静态产物
publish_web() {
  [ "$DEPLOY_WEB" = "true" ] || { log "跳过 web 静态产物发布"; return 0; }
  : "${WEB_ROOT:?deploy.conf 缺少 WEB_ROOT}"

  local incoming="${WEB_ROOT}.incoming"
  [ -d "$incoming" ] || die "${incoming} 不存在，rsync 没上传 web 产物"
  [ -f "$incoming/index.html" ] || die "${incoming}/index.html 不存在，产物不完整"

  log "发布 web 产物到 ${WEB_ROOT}"
  find "$incoming" -type d -exec chmod 755 {} +
  find "$incoming" -type f -exec chmod 644 {} +

  rm -rf "${WEB_ROOT}.old"
  if [ -d "$WEB_ROOT" ]; then
    mv "$WEB_ROOT" "${WEB_ROOT}.old"
  else
    mkdir -p "$(dirname "$WEB_ROOT")"
  fi
  # 目录级 mv，切换是原子的，不会出现"一半新一半旧"的窗口
  mv "$incoming" "$WEB_ROOT"
  echo "  上一版保留在 ${WEB_ROOT}.old（回滚：mv 回来即可）"
}

# ---------------------------------------------------------------- nginx
install_nginx_snippet() {
  [ "$UPDATE_NGINX" = "true" ] || { log "跳过 nginx 配置更新"; return 0; }
  : "${NGINX_SNIPPET_PATH:?deploy.conf 缺少 NGINX_SNIPPET_PATH}"
  : "${NGINX_INCLUDE_FILE:?deploy.conf 缺少 NGINX_INCLUDE_FILE}"
  [ -f ./nginx/monopoly.conf ] || die "./nginx/monopoly.conf 不存在"
  [ -f "$NGINX_INCLUDE_FILE" ] || die "${NGINX_INCLUDE_FILE} 不存在，检查 repo variable 是否填对"

  local snippet_backup="" include_backup=""

  log "写入 nginx 片段 ${NGINX_SNIPPET_PATH}"
  mkdir -p "$(dirname "$NGINX_SNIPPET_PATH")"
  if [ -f "$NGINX_SNIPPET_PATH" ]; then
    snippet_backup="${NGINX_SNIPPET_PATH}.bak-${STAMP}"
    cp -a "$NGINX_SNIPPET_PATH" "$snippet_backup"
  fi
  install -m 644 ./nginx/monopoly.conf "$NGINX_SNIPPET_PATH"

  if grep -qF "include ${NGINX_SNIPPET_PATH};" "$NGINX_INCLUDE_FILE"; then
    echo "  ${NGINX_INCLUDE_FILE} 里已有 include，不重复追加"
  else
    include_backup="${NGINX_INCLUDE_FILE}.bak-${STAMP}"
    cp -a "$NGINX_INCLUDE_FILE" "$include_backup"
    echo "  追加 include 到 ${NGINX_INCLUDE_FILE}（备份 ${include_backup}）"
    printf '\n# ---- MineMonopoly (managed by .github/workflows/deploy-server.yml) ----\ninclude %s;\n' \
      "$NGINX_SNIPPET_PATH" >> "$NGINX_INCLUDE_FILE"
  fi

  if ! nginx -t; then
    warn "nginx -t 不通过，回滚所有 nginx 改动并且不 reload"
    if [ -n "$include_backup" ]; then cp -a "$include_backup" "$NGINX_INCLUDE_FILE"; fi
    if [ -n "$snippet_backup" ]; then
      cp -a "$snippet_backup" "$NGINX_SNIPPET_PATH"
    else
      rm -f "$NGINX_SNIPPET_PATH"
    fi
    nginx -t || warn "回滚后 nginx -t 依然失败，这说明改动前配置就有问题"
    die "nginx 配置校验失败，已回滚（现有站点未受影响）"
  fi

  log "reload nginx"
  systemctl reload nginx || nginx -s reload
}

# ---------------------------------------------------------------- 本机自检
smoke_test() {
  log "本机自检（走 127.0.0.1，绕过公网与安全组）"
  local fail=0

  # 直连容器端口
  probe() {
    local label="$1" url="$2" expect="$3" code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || echo 000)"
    if [ "$code" = "$expect" ]; then
      printf '  \033[32mok\033[0m   %-22s %s -> %s\n' "$label" "$url" "$code"
    else
      printf '  \033[31mFAIL\033[0m %-22s %s -> %s (期望 %s)\n' "$label" "$url" "$code" "$expect"
      fail=1
    fi
  }

  # 走 nginx 时必须命中正确的 server 块 —— nginx 上有多个站点，用 127.0.0.1 当
  # Host 会落到 server_name _ 的默认站点上，拿到的 404 是假故障。
  #
  # 用 --resolve 而不是 -H "Host:"：https 下 TLS 的 SNI 和证书校验都看真实主机名，
  # 光改 Host 头握手就过不去。--resolve 把域名钉在 127.0.0.1 上，既走了完整的 TLS
  # 链路，又不出公网、不依赖云安全组。
  probe_nginx() {
    local label="$1" path="$2" expect="$3" code url port
    if [ "$PROTOCOL" = "https" ]; then port=443; else port=80; fi
    url="${PROTOCOL}://${MONOPOLY_DOMAIN}${path}"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
      --resolve "${MONOPOLY_DOMAIN}:${port}:127.0.0.1" "$url" || echo 000)"
    if [ "$code" = "$expect" ]; then
      printf '  \033[32mok\033[0m   %-22s %s -> %s\n' "$label" "$url" "$code"
    else
      printf '  \033[31mFAIL\033[0m %-22s %s -> %s (期望 %s)\n' "$label" "$url" "$code" "$expect"
      fail=1
    fi
  }

  probe "server /health" "http://${BIND_ADDRESS}:${SERVER_PORT}/health" 200
  probe "ice root" "http://${BIND_ADDRESS}:${ICE_SERVER_PORT}/" 200
  probe "admin index" "http://${BIND_ADDRESS}:${MONOPOLY_ADMIN_PORT}/" 200

  if [ "$UPDATE_NGINX" = "true" ]; then
    : "${MONOPOLY_DOMAIN:?deploy.conf 缺少 MONOPOLY_DOMAIN}"
    probe_nginx "nginx api" "${API_BASE_PREFIX}/health" 200
    probe_nginx "nginx ice" "${ICE_BASE_PREFIX}/" 200
    probe_nginx "nginx admin" "${ADMIN_BASE_PREFIX}/" 200
    [ "$DEPLOY_WEB" = "true" ] && probe_nginx "nginx web" "${WEB_BASE_PATH}" 200
  fi

  [ "$fail" -eq 0 ] || die "本机自检有失败项"
}

# ---------------------------------------------------------------- 旧镜像清理
prune_old_images() {
  log "清理 ${IMAGE_REPO} 的旧镜像（保留最近 ${IMAGE_KEEP} 个）"
  # 正在被容器使用的镜像 docker rmi 会失败，这正是我们要的兜底保护
  docker images --filter "reference=${IMAGE_REPO}" --format '{{.CreatedAt}}|{{.ID}}|{{.Repository}}:{{.Tag}}' \
    | sort -r | awk -F'|' -v keep="$IMAGE_KEEP" 'NR>keep {print $2"|"$3}' | sort -u \
    | while IFS='|' read -r id tag; do
        [ -n "$id" ] || continue
        if docker rmi "$tag" >/dev/null 2>&1; then
          echo "  removed ${tag}"
        else
          echo "  skip ${tag}（仍在使用或有其他引用）"
        fi
      done
  return 0
}

# ---------------------------------------------------------------- main
echo "MineMonopoly deploy @ $(hostname) $(date -Is)"
echo "  image        : ${SERVER_IMAGE}"
echo "  transport    : ${IMAGE_TRANSPORT}"
echo "  deploy path  : ${SCRIPT_DIR}"
echo "  web          : ${DEPLOY_WEB} -> ${WEB_ROOT:-<n/a>}"
echo "  nginx        : ${UPDATE_NGINX} -> ${NGINX_SNIPPET_PATH:-<n/a>}"
echo "  free memory  : $(free -m | awk '/^Mem:/ {print $7"MB available / "$2"MB total"}')"

ghcr_login
start_stack
wait_healthy monopoly-mysql "$HEALTH_TIMEOUT"
wait_healthy monopoly-server "$HEALTH_TIMEOUT"
publish_web
install_nginx_snippet
smoke_test
prune_old_images

log "部署完成"
docker compose ps
