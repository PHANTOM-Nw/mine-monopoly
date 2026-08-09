# 用 GitHub Actions 部署到自有服务器

通过 `.github/workflows/deploy-server.yml` 把服务端和客户端 web 部署到任意一台服务器。
**所有环境相关配置都在 GitHub 上的 Variables / Secrets 里，仓库里不存任何机器的地址和密码** ——
换服务器只改 GitHub 配置，不改代码。

## 架构

```
GitHub Actions
├── build-image  docker/Dockerfile → ghcr.io/<owner>/mine-monopoly-server:sha-xxxxxx
├── build-web    客户端 web 产物（域名/前缀是编译期注入的，必须在 CI 构建）
└── deploy       SSH 到目标机
                 ├── rsync docker/deploy/ → ${DEPLOY_PATH}
                 ├── docker compose pull && up -d   (mysql + server)
                 ├── 静态产物原子切换到 ${WEB_ROOT}
                 ├── 装 nginx location 片段并 reload
                 └── 本机自检 + 公网自检

目标机
├── nginx :80                         宿主机已有的 nginx，只往里加 location
│   ├── /monopoly/          → 静态产物 ${WEB_ROOT}
│   ├── /monopoly-server/   → 127.0.0.1:SERVER_PORT        (API)
│   ├── /monopoly-ice/      → 127.0.0.1:ICE_SERVER_PORT    (PeerJS 信令 / WebSocket)
│   └── /monopoly-admin/    → 127.0.0.1:MONOPOLY_ADMIN_PORT (管理后台)
└── docker compose project "monopoly"
    ├── monopoly-server  三个端口只绑 127.0.0.1
    └── monopoly-mysql   不对外映射端口
```

**为什么走 nginx 路径反代而不是端口模式**：端口模式要求把 SERVER_PORT / ICE_SERVER_PORT /
MONOPOLY_ADMIN_PORT 都在云安全组里放行。路径模式全部走已经开着的 80 端口，一个安全组规则都不用加。

**为什么镜像在 CI 构建**：小规格云主机（1～2G 内存）跑不动这个 monorepo 的构建，
而且 admin 前端的编译期变量本来就该由 CI 注入。

## 一、准备目标服务器

只需要三样东西，其余全由 workflow 处理：

```bash
# 1. Docker + compose v2
docker --version && docker compose version

# 2. nginx，并且有一个被 server{} include 的 location 片段文件
#    （下面 NGINX_INCLUDE_FILE 指向它）
nginx -v

# 3. 一个能 SSH 登录、且是 root 或有免密 sudo 的账号
```

生成一对专用于部署的密钥（**不要复用你自己的登录密钥**）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/monopoly_deploy -C "github-actions-deploy" -N ""
ssh-copy-id -i ~/.ssh/monopoly_deploy.pub root@<你的服务器IP>

# 私钥内容 → GitHub Secret DEPLOY_SSH_KEY
cat ~/.ssh/monopoly_deploy

# 主机指纹 → GitHub Secret DEPLOY_KNOWN_HOSTS（强烈建议配，否则退化成首次连接就信任）
ssh-keyscan -H <你的服务器IP>
```

## 二、Repository Variables

`Settings → Secrets and variables → Actions → Variables → New repository variable`

### 必填

| Variable | 说明 | 示例 |
| --- | --- | --- |
| `DEPLOY_HOST` | 服务器地址（也可放 Secrets） | `116.62.47.225` |
| `DEPLOY_USER` | SSH 用户（也可放 Secrets） | `root` |
| `DEPLOY_PATH` | 部署目录，workflow 独占管理 | `/opt/monopoly` |
| `MONOPOLY_DOMAIN` | 对外访问的域名或 IP | `116.62.47.225` |
| `PROTOCOL` | `http` 或 `https` | `http` |
| `SERVER_PORT` | API 端口（容器内 + 宿主机 loopback） | `8181` |
| `ICE_SERVER_PORT` | PeerJS 信令端口 | `8182` |
| `MONOPOLY_ADMIN_PORT` | 管理后台端口 | `8183` |
| `API_BASE_PREFIX` | API 反代前缀，形如 `/xxx` | `/monopoly-server` |
| `ICE_BASE_PREFIX` | 信令反代前缀 | `/monopoly-ice` |
| `ADMIN_BASE_PREFIX` | 后台反代前缀 | `/monopoly-admin` |

> 三个端口只要在目标机上没被占用就行（它们只绑 127.0.0.1，不对公网开放）。
> 用 `ss -lntp` 先确认。

### 可选（有默认值）

| Variable | 默认 | 说明 |
| --- | --- | --- |
| `DEPLOY_PORT` | `22` | SSH 端口 |
| `VITE_WEB_BASE_PATH` | `/monopoly/` | 客户端 web 的访问路径 |
| `WEB_ROOT` | `/var/www/monopoly` | 静态产物落盘目录 |
| `NGINX_INCLUDE_FILE` | `/etc/nginx/inc/site-common.conf` | 被 `server{}` include 的文件，workflow 往里追加一行 include |
| `NGINX_SNIPPET_PATH` | `/etc/nginx/inc/monopoly.conf` | 生成的 location 片段落盘位置 |
| `NGINX_MAX_BODY_SIZE` | `50M` | 地图/头像上传体积上限 |
| `BIND_ADDRESS` | `127.0.0.1` | 容器端口绑定地址。改成 `0.0.0.0` 才是端口直连模式（需开安全组） |
| `MYSQL_HOST` | `mysql` | 用自带 MySQL 时必须是 compose 服务名 `mysql` |
| `MYSQL_PORT` | `3306` | |
| `MYSQL_DATABASE` | `monopoly` | ⚠ `dbConnecter.ts` 把库名硬编码成 `monopoly`，改这个不生效 |
| `MYSQL_USERNAME` | `root` | 非 root 时首次初始化会自动建号授权 |
| `MYSQL_IMAGE` | `mysql:8.0` | 别升到 8.4，`my.cnf` 里的老参数在 8.4 会启动失败 |
| `MYSQL_INNODB_BUFFER_POOL_SIZE` | `96M` | 小内存机器的关键参数 |
| `MYSQL_MAX_CONNECTIONS` | `60` | |
| `MYSQL_MEMORY_LIMIT` | `512m` | 容器内存上限 |
| `SERVER_MEMORY_LIMIT` | `512m` | 容器内存上限 |
| `MYSQL_POOL_SIZE` | `10` | TypeORM 连接池 |
| `TURN_URL` | 同 `MONOPOLY_DOMAIN` | TURN/STUN 地址 |
| `STUN_PORT` | `3478` | |
| `TURN_PORT` | `5349` | TURN over TLS |
| `TURN_TTL` | `86400` | 动态凭证有效期（秒） |
| `EXTERNAL_IP` | 同 `MONOPOLY_DOMAIN` | 自带 coturn 时的公网 IP |
| `TURN_REALM` | 同 `MONOPOLY_DOMAIN` | 自带 coturn 的 realm |
| `COTURN_RELAY_MIN` / `COTURN_RELAY_MAX` | `49160` / `49200` | 自带 coturn 的中继端口范围 |
| `COTURN_METRICS_URL` | `http://host.docker.internal:9641/metrics` | 后台采集 coturn 指标 |
| `COTURN_CERTS_PATH` | `./coturn/certs` | 相对 `DEPLOY_PATH`；证书要手动放，rsync 不会清它 |
| `AVATAR_STORAGE_PATH` | `monopoly/user-avatar` | |
| `GAME_MAP_STORAGE_PATH` | `monopoly/game-map` | |
| `TC_BUCKET_NAME` / `TC_REGION` | 空 | 腾讯云 COS，不填则用本地存储 |
| `GHCR_USERNAME` | `github.actor` | 只有用 `GHCR_PAT` 且账号不同时才需要 |
| `IMAGE_KEEP` | `3` | 目标机保留几个历史镜像 |
| `HEALTH_TIMEOUT` | `300` | 等容器健康的秒数 |
| `TZ` | `Asia/Shanghai` | |

## 三、Repository Secrets

### 必填

| Secret | 说明 |
| --- | --- |
| `DEPLOY_SSH_KEY` | 部署用私钥全文（含 `-----BEGIN...` 与 `-----END...` 两行） |
| `MYSQL_PASSWORD` | 数据库密码。⚠ 避免用 `"` `'` `#` 和空格 —— 它要经过 `.env` 文件 |
| `TURN_SECRET` | TURN 动态凭证密钥，随便一串随机字符串 |
| `MAP_ENCRYPT_KEY` | **必须正好 16 个 ASCII 字符**，预检会拦。这个 key 换了以后老地图产物解不开 |

### 可选

| Secret | 说明 |
| --- | --- |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -H <host>` 的输出。不配会打 warning 并退化为首连即信任。SSH 端口不是 22 时要用 `ssh-keyscan -p <port> -H <host>`，条目里得带 `[host]:port` 形式才匹配得上 |
| `MYSQL_ROOT_PASSWORD` | 不填则复用 `MYSQL_PASSWORD` |
| `GHCR_PAT` | 有 `read:packages` 的 PAT。不配就用本次 run 的 `GITHUB_TOKEN`（一次性，见下文） |
| `TC_ID` / `TC_KEY` | 腾讯云 COS 凭据 |

不需要配 `GITHUB_TOKEN`，它是 Actions 自动注入的。

### 关于 GHCR 凭据

镜像包默认是私有的，目标机 pull 需要凭据：

- **不配 `GHCR_PAT`**：用本次 run 的 `GITHUB_TOKEN` 登录，拉完镜像后脚本会 `docker logout`。
  能正常部署，但之后你在服务器上手动 `docker compose pull` 会 401（镜像已缓存在本地，
  `docker compose up -d` 重启不受影响）。
- **配了 `GHCR_PAT`**：登录状态保留，服务器上随时能手动 pull。推荐。
- 或者把 GHCR 上的 package 改成 public，两个都不用配。

## 四、跑一次部署

`Actions → Deploy Server → Run workflow`

| 输入 | 默认 | 说明 |
| --- | --- | --- |
| Branch | `main` | 上方分支选择器，决定部署哪个 commit |
| `environment` | `production` | 选用哪一套 Variables/Secrets。没配 environment 级的就自动用 repo 级 |
| `deploy_web` | ✅ | 是否同时发布客户端 web 静态产物 |
| `update_nginx` | ✅ | 是否写入/更新 nginx 片段并 reload |
| `deploy_coturn` | ❌ | 是否启动自带 coturn。**目标机已有 coturn 占 3478 时别勾** |

跑完在 Summary 里能看到镜像 tag、访问地址和回滚命令。

## 五、部署到 116.62.47.225 的具体填法

这台机器的现状（已实地确认）：

- Alibaba Cloud Linux 3，2 vCPU / 1.8G 内存、**无 swap**、27G 可用磁盘
- Docker 26.1.3 + compose v2.27.0，当前没有任何容器
- nginx 1.24 在 80 端口，已有站点：`/chatjudge`、`/GameSimulator`、`/amongai/`、`/interleaf/`；
  共用的 location 文件是 `/etc/nginx/inc/site-common.conf`
- 没有 MySQL（3306 空闲）→ 用自带的 MySQL 容器
- **已有一个宿主机 coturn 占用 3478**，用的是 `lt-cred-mech` 静态账号模式
- 8080 / 8081 被 PM2 占用；81 / 82 / 83 / 8181 / 8182 / 8183 都空闲

### Variables

```
DEPLOY_HOST             = 116.62.47.225
DEPLOY_USER             = root
DEPLOY_PATH             = /opt/monopoly
MONOPOLY_DOMAIN         = 116.62.47.225
PROTOCOL                = http
SERVER_PORT             = 8181
ICE_SERVER_PORT         = 8182
MONOPOLY_ADMIN_PORT     = 8183
API_BASE_PREFIX         = /monopoly-server
ICE_BASE_PREFIX         = /monopoly-ice
ADMIN_BASE_PREFIX       = /monopoly-admin
VITE_WEB_BASE_PATH      = /monopoly/
WEB_ROOT                = /var/www/monopoly
NGINX_INCLUDE_FILE      = /etc/nginx/inc/site-common.conf
NGINX_SNIPPET_PATH      = /etc/nginx/inc/monopoly.conf

# 1.8G 内存 + 无 swap，这几个必须收紧
MYSQL_INNODB_BUFFER_POOL_SIZE = 96M
MYSQL_MAX_CONNECTIONS         = 40
MYSQL_MEMORY_LIMIT            = 448m
SERVER_MEMORY_LIMIT           = 448m
MYSQL_POOL_SIZE               = 8
```

### Secrets

```
DEPLOY_SSH_KEY      = <部署私钥全文>
DEPLOY_KNOWN_HOSTS  = <ssh-keyscan -H 116.62.47.225 的输出>
MYSQL_PASSWORD      = <自己定，别用引号和 # >
TURN_SECRET         = <openssl rand -hex 24>
MAP_ENCRYPT_KEY     = <正好 16 位>
```

部署完访问 <http://116.62.47.225/monopoly>。

### 这台机器上 TURN 的处理

`deploy_coturn` 保持不勾。原因：

服务端用的是 HMAC-SHA1 动态凭证（`apps/server/src/utils/turn-credentials.ts`），
要求 coturn 开 `use-auth-secret`；而机器上已有的 coturn 用的是 `lt-cred-mech` 静态账号。
这两种模式在 coturn 里互斥 —— 既不能复用，也不该去改它的配置（会打断依赖它的其他服务）。

按上面的填法，`STUN_PORT=3478` 指向的就是现有的 coturn，**STUN 是可用的**
（STUN binding 不需要认证），大部分家宽/同局域网场景能直连成功。
`turns:...:5349` 那条候选会失败，浏览器会自动跳过。

需要完整 TURN 中继（跨对称 NAT / 移动网络）时，两条路：

1. 换端口另起一份自带 coturn：把 `STUN_PORT` / `TURN_PORT` 改成 `3479` / `5350`，
   勾上 `deploy_coturn`，然后在阿里云安全组放行 `3479/udp`、`3479/tcp`、`5350/tcp`
   以及中继端口段 `49160-49200/udp`。TLS 还需要往 `${DEPLOY_PATH}/coturn/certs/`
   放 `fullchain.pem` + `privkey.pem`（IP 签不出证书，`turns:` 需要域名）。
2. 或者把现有 coturn 迁到 `use-auth-secret` 模式 —— 但要先确认没有别的服务在用它。

### 注意事项

- **无 swap**：MySQL 首次启动 + TypeORM `synchronize=true` 建表那一阵内存是峰值。
  真遇到 OOM 就加 swap：`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`
  （这会改宿主机，workflow 不会自动做）。
- **nginx 有个已存在的告警**：`conflicting server name "116.62.47.225" on 0.0.0.0:80, ignored`
  —— `chatjudge.conf` 和 `jewstd.conf` 都为这个 IP 定义了 server 块，`jewstd.conf` 那个被忽略。
  这是部署前就有的状况，本 workflow 没碰它。我们的 location 片段进的是生效的那个（`site-common.conf`）。

## 六、验证与排查

workflow 自己会做两轮自检，看日志就能定位：

| 阶段 | 失败说明什么 |
| --- | --- |
| `wait_healthy monopoly-mysql` | MySQL 起不来。日志会打出来，通常是内存不够或密码里有特殊字符 |
| `wait_healthy monopoly-server` | 服务端连不上库或环境变量缺失，看 `docker logs monopoly-server` |
| 本机自检 `probe` | 容器端口不通 → 容器自身问题 |
| 本机自检 `probe_nginx` | 容器通但 nginx 不通 → location 片段或 include 没生效 |
| `Verify Public Endpoints` | 本机全通但公网不通 → **云安全组没放行 80**，或域名解析没生效 |

手动排查：

```bash
cd /opt/monopoly
docker compose ps
docker compose logs -f server
docker compose logs --tail 100 mysql

# 绕过 nginx 直连容器
curl -i http://127.0.0.1:8181/health

# 走 nginx（必须带 Host，机器上有多个 server 块）
curl -i -H 'Host: 116.62.47.225' http://127.0.0.1/monopoly-server/health

# 看生效的 nginx 配置
nginx -T | grep -A5 monopoly
```

## 七、回滚

```bash
cd /opt/monopoly

# 服务端：换回上一个镜像 tag（docker images 能看到保留的历史 tag）
docker images | grep mine-monopoly-server
sed -i 's|^SERVER_IMAGE=.*|SERVER_IMAGE=ghcr.io/<owner>/mine-monopoly-server:sha-<旧tag>|' .env
docker compose up -d

# 客户端静态产物：上一版留在 .old
rm -rf /var/www/monopoly && mv /var/www/monopoly.old /var/www/monopoly

# nginx 配置：每次改动前都有带时间戳的备份
ls /etc/nginx/inc/*.bak-*
cp /etc/nginx/inc/site-common.conf.bak-<时间戳> /etc/nginx/inc/site-common.conf
nginx -t && systemctl reload nginx
```

## 八、这个 workflow 不会做什么

目标机上通常还跑着别的服务，所以脚本有意做了限制：

- 不执行 `docker system prune` / `docker network prune`（会波及其他容器）
- 清理旧镜像时只针对本项目的 image repo，且依赖"在用镜像 `docker rmi` 会失败"作为兜底
- 只操作 compose project `monopoly`、`${WEB_ROOT}`、`${NGINX_SNIPPET_PATH}` 三处
- 改 nginx 前必备份；`nginx -t` 不通过就自动回滚且不 reload —— 现有站点不会被打断
- 不动宿主机的 coturn、PM2 进程、防火墙和安全组
- 不自动加 swap、不自动装任何软件包

## 九、和 release.yml 的关系

两个 workflow 各管一段，互不干扰：

| | `release.yml` | `deploy-server.yml` |
| --- | --- | --- |
| 触发 | 推 `client-v*` / `map-editor-v*` tag | 手动 |
| 产出 | Electron 安装包、Android APK、OTA 包、web 产物 → R2 + GitHub Release | 服务端镜像 → GHCR，并部署到你自己的服务器 |
| 目标 | 官方发布渠道（`environment: build`） | 自有服务器（`environment: production` / `staging`） |
