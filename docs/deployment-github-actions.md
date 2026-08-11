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
                 ├── docker save | gzip | ssh docker load  (mysql + server)
                 │   ← IMAGE_TRANSPORT=registry 时改成目标机自己 compose pull
                 ├── docker compose up -d
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

### 镜像投递方式（`IMAGE_TRANSPORT`）

很多云主机（尤其国内）拉镜像很痛苦：Docker Hub 的 `registry-1.docker.io` 常年连不上，
GHCR 的 manifest 走 `ghcr.io` 但 blob 走 `pkg-containers.githubusercontent.com`，
后者经常传到一半断流。所以镜像怎么落到目标机上是可选的：

| 值 | 做法 | 目标机需要能访问 |
| --- | --- | --- |
| `ssh`（默认） | CI 拉好镜像，`docker save \| gzip \| ssh docker load` 推过去 | **什么 registry 都不需要** |
| `registry` | 目标机自己 `docker compose pull` | `ghcr.io` + `pkg-containers.githubusercontent.com` |

`ssh` 模式的取舍：

- 目标机零 registry 依赖，**也不需要 GHCR 凭据**——`.ghcr-token` 根本不会下发到那台机器
- 服务端、MySQL、以及勾了 `deploy_coturn` 时的 coturn，三个镜像全走这条路
- 代价是每次新 commit 要经 SSH 传一次完整镜像（约 500MB 未压缩，gzip 后小得多）。
  tag 是不可变的 `sha-xxx`，目标机已有的镜像会跳过，重跑同一 commit 不会重传
- 镜像照旧会推到 GHCR，回滚仍然可用

`registry` 模式适合带宽好、且目标机能顺畅访问 GHCR 的情况，能省下 CI 的传输时间。
这时 `remote-apply.sh` 会带退避重试地 pull（轮数看 `PULL_RETRIES`），
并且 `MYSQL_MIRROR_TO_GHCR` 才有意义：`build-image` 会用
`docker buildx imagetools create` 把 MySQL 镜像**原样拷一份到 GHCR**（registry 到
registry 的 manifest 拷贝，不落地到 runner 磁盘，保留多架构 manifest），
这样目标机只需要能访问 `ghcr.io` 一个域名，不必碰 Docker Hub。
把它设成 `false` 可关掉；`MYSQL_IMAGE` 填 `ghcr.io/...` 开头的值时也会自动跳过转存。

> 从 `registry` 切到 `ssh` 后，目标机上原先转存的 `*-mysql:8.0` 镜像会变成无人引用的
> 残留（`prune_old_images` 只清服务端镜像）。想回收磁盘就手动
> `docker rmi ghcr.io/<owner>/mine-monopoly-mysql:8.0`。

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
# ⚠ 必须显式列出类型：部分环境下 ssh-keyscan 的默认类型不含 ed25519，
#   而现代 OpenSSH 优先协商 ed25519，漏了它可能导致 host key 校验失败。
#   三种类型全放进去最稳，ssh 会自己挑匹配的那条。
ssh-keyscan -t ed25519,ecdsa,rsa -H <你的服务器IP>
```

如果 `ssh-copy-id` 卡在密码提示上（不知道 root 密码 / 只允许密钥登录），
用一把**已经能登录**的密钥把新公钥追加进去，注意别覆盖已有的 key：

```bash
ssh -i ~/.ssh/<已有可用密钥> root@<IP> \
  "PUBKEY='$(cat ~/.ssh/monopoly_deploy.pub)'; \
   cp -a ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-\$(date +%s); \
   grep -qF \"\$PUBKEY\" ~/.ssh/authorized_keys || printf '%s\n' \"\$PUBKEY\" >> ~/.ssh/authorized_keys"
```

## 二、Repository Variables

`Settings → Secrets and variables → Actions → Variables → New repository variable`

### 必填

| Variable | 说明 | 示例 |
| --- | --- | --- |
| `DEPLOY_HOST` | 服务器地址（也可放 Secrets） | `203.0.113.10` |
| `DEPLOY_USER` | SSH 用户（也可放 Secrets） | `root` |
| `DEPLOY_PATH` | 部署目录，workflow 独占管理 | `/opt/monopoly` |
| `MONOPOLY_DOMAIN` | 对外访问的域名或 IP | `game.example.com` |
| `PROTOCOL` | `http` 或 `https` | `http` |
| `SERVER_PORT` | API 端口（容器内 + 宿主机 loopback） | `8181` |
| `ICE_SERVER_PORT` | PeerJS 信令端口 | `8182` |
| `MONOPOLY_ADMIN_PORT` | 管理后台端口 | `8183` |
| `API_BASE_PREFIX` | API 反代前缀，形如 `/xxx` | `/monopoly-server` |
| `ICE_BASE_PREFIX` | 信令反代前缀 | `/monopoly-ice` |
| `ADMIN_BASE_PREFIX` | 后台反代前缀 | `/monopoly-admin` |
| `NGINX_INCLUDE_FILE` | 目标机上**已被某个 `server{}` include** 的文件，workflow 往里追加一行 include | 见下 |

> 三个端口只要在目标机上没被占用就行（它们只绑 127.0.0.1，不对公网开放）。
> 用 `ss -lntp` 先确认。

`NGINX_INCLUDE_FILE` 没有通用默认值 —— 每台机器 nginx 布局不同，只能你自己给。
用 `nginx -T` 找到你的 `server{}` 块里已有的 include，或者自己建一个再在 server 块里
include 一次。确认方法：

```bash
nginx -T | grep -n "include\|server_name"
```

### 可选（有默认值）

| Variable | 默认 | 说明 |
| --- | --- | --- |
| `DEPLOY_PORT` | `22` | SSH 端口 |
| `VITE_WEB_BASE_PATH` | `/monopoly/` | 客户端 web 的访问路径 |
| `WEB_ROOT` | `/var/www/monopoly` | 静态产物落盘目录 |
| `NGINX_SNIPPET_PATH` | `/etc/nginx/inc/monopoly.conf` | 生成的片段落盘位置。⚠ **不要放进 `conf.d/` 之类被 `http{}` 自动 glob 的目录** —— 片段里是 `location`，在 `http` 层是非法指令，会让整个 nginx 起不来 |
| `NGINX_MAX_BODY_SIZE` | `50M` | 地图/头像上传体积上限 |
| `BIND_ADDRESS` | `127.0.0.1` | 容器端口绑定地址。改成 `0.0.0.0` 才是端口直连模式（需开安全组） |
| `ICE_SIGNAL_PORT` | `PROTOCOL=https` 时 `443`，否则 `80` | 浏览器连 peerjs 信令用的端口。**只有 nginx 监听在非标准端口时才要填** —— peerjs 不传 port 会默认用它云服务的 443 |
| `MYSQL_HOST` | `mysql` | 用自带 MySQL 时必须是 compose 服务名 `mysql` |
| `MYSQL_PORT` | `3306` | |
| `MYSQL_DATABASE` | `monopoly` | ⚠ `dbConnecter.ts` 把库名硬编码成 `monopoly`，改这个不生效 |
| `MYSQL_USERNAME` | `root` | 非 root 时首次初始化会自动建号授权 |
| `MYSQL_IMAGE` | `mysql:8.0` | 别升到 8.4，`my.cnf` 里的老参数在 8.4 会启动失败 |
| `IMAGE_TRANSPORT` | `ssh` | 镜像怎么到目标机，见「镜像投递方式」 |
| `MYSQL_MIRROR_TO_GHCR` | `true` | 是否把 MySQL 镜像转存到 GHCR。**只在 `IMAGE_TRANSPORT=registry` 下有意义**，ssh 模式会强制关掉 |
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
| `PULL_RETRIES` | `4` | 目标机拉镜像整体重试轮数，见「镜像拉不动」 |
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

**`IMAGE_TRANSPORT=ssh`（默认）下这一节可以整段跳过** —— 镜像是 CI 推过去的，
目标机不连 registry，`.ghcr-token` 也不会下发到那台机器上，`GHCR_PAT` / `GHCR_USERNAME`
都不用配。

`IMAGE_TRANSPORT=registry` 时镜像包默认是私有的，目标机 pull 需要凭据：

- **不配 `GHCR_PAT`**：用本次 run 的 `GITHUB_TOKEN` 登录，拉完镜像后脚本会 `docker logout`。
  能正常部署，但之后你在服务器上手动 `docker compose pull` 会 401（镜像已缓存在本地，
  `docker compose up -d` 重启不受影响）。
- **配了 `GHCR_PAT`**：登录状态保留，服务器上随时能手动 pull。推荐。
- 或者把 GHCR 上的 package 改成 public，两个都不用配。

## 四、跑一次部署

### 两个前置条件

1. **workflow 文件必须在默认分支上。** `workflow_dispatch` 只认默认分支里的
   workflow —— 文件还在特性分支时，Actions 页面**根本不会出现 `Deploy Server`**。
   先把 PR 合进 `main`。（合进去之后，运行时仍可在分支选择器里挑任意分支部署。）
2. **fork 仓库的 Actions 默认是禁用的。** 去 `Settings → Actions → General`
   打开（页面上会有一个 "I understand my workflows, go ahead and enable them"）。

### 运行

`Actions → Deploy Server → Run workflow`

| 输入 | 默认 | 说明 |
| --- | --- | --- |
| Branch | `main` | 上方分支选择器，决定部署哪个 commit |
| `environment` | `production` | 选用哪一套 Variables/Secrets。没配 environment 级的就自动用 repo 级 |
| `deploy_web` | ✅ | 是否同时发布客户端 web 静态产物 |
| `update_nginx` | ✅ | 是否写入/更新 nginx 片段并 reload |
| `deploy_coturn` | ❌ | 是否启动自带 coturn。**目标机已有 coturn 占 3478 时别勾** |

跑完在 Summary 里能看到镜像 tag、访问地址和回滚命令。

## 五、填写范例

> ⚠ **不要把你自己机器的 IP、主机名、同机其他服务、目录布局写进这个文件。**
> 这些信息的唯一归宿是 GitHub 上的 Variables / Secrets —— 那才是这套 workflow
> 存在的意义。仓库是公开的（fork 也是），写进来等于对外发布一份基础设施清单：
> 公网 IP + SSH 用户 + 同机跑了什么 + nginx 布局，是相当完整的侦察材料。
> 下面全部用占位符，照着填到 GitHub 上即可。

### Variables

```
DEPLOY_HOST             = <你的服务器地址>
DEPLOY_USER             = <SSH 用户>
DEPLOY_PATH             = /opt/monopoly
MONOPOLY_DOMAIN         = <对外访问的域名或 IP>
PROTOCOL                = http            # 有证书就填 https
SERVER_PORT             = 8181            # 先用 ss -lntp 确认没被占用
ICE_SERVER_PORT         = 8182
MONOPOLY_ADMIN_PORT     = 8183
API_BASE_PREFIX         = /monopoly-server
ICE_BASE_PREFIX         = /monopoly-ice
ADMIN_BASE_PREFIX       = /monopoly-admin
VITE_WEB_BASE_PATH      = /monopoly/
WEB_ROOT                = /var/www/monopoly
NGINX_INCLUDE_FILE      = <被 server{} include 的那个文件>
NGINX_SNIPPET_PATH      = <生成的片段放哪，如 /etc/nginx/inc/monopoly.conf>
```

小内存机器（2G 以下、尤其无 swap）务必收紧下面这几项，否则 MySQL 首次启动叠加
TypeORM `synchronize=true` 建表的内存峰值容易触发 OOM：

```
MYSQL_INNODB_BUFFER_POOL_SIZE = 96M
MYSQL_MAX_CONNECTIONS         = 40
MYSQL_MEMORY_LIMIT            = 448m
SERVER_MEMORY_LIMIT           = 448m
MYSQL_POOL_SIZE               = 8
```

无 swap 又真的 OOM，可以手动加（会改宿主机，workflow 不会自动做）：

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

### Secrets

```
DEPLOY_SSH_KEY      = <部署私钥全文>
DEPLOY_KNOWN_HOSTS  = <ssh-keyscan -t ed25519,ecdsa,rsa -H <你的服务器地址> 的输出>
MYSQL_PASSWORD      = <自己定，别用引号和 # >
TURN_SECRET         = <openssl rand -hex 24>
MAP_ENCRYPT_KEY     = <正好 16 位>
```

部署完访问 `<PROTOCOL>://<MONOPOLY_DOMAIN><VITE_WEB_BASE_PATH>`。

### 目标机已有 coturn 时怎么办

如果目标机上已经跑着一个 coturn，**先确认它的认证模式**：

```bash
grep -E "use-auth-secret|lt-cred-mech" /etc/coturn/turnserver.conf
```

服务端用的是 HMAC-SHA1 动态凭证（`apps/server/src/utils/turn-credentials.ts`），
要求 coturn 开 `use-auth-secret`。如果现有的那份用的是 `lt-cred-mech`（静态账号），
两种模式在 coturn 里**互斥** —— 既不能复用，也不该去改它的配置（会打断依赖它的其他服务）。
这种情况下 `deploy_coturn` 保持不勾。

此时把 `STUN_PORT` 指向现有 coturn 的监听端口，**STUN 仍然可用**
（STUN binding 不需要认证），大部分家宽 / 同局域网场景能直连成功；
`turns:` 那条候选会失败，浏览器自动跳过。

需要完整 TURN 中继（跨对称 NAT / 移动网络）时，两条路：

1. 换端口另起一份自带 coturn：把 `STUN_PORT` / `TURN_PORT` 改成未被占用的值
   （如 `3479` / `5350`），勾上 `deploy_coturn`，然后在云安全组放行对应的
   udp/tcp 端口以及中继端口段（`COTURN_RELAY_MIN`-`COTURN_RELAY_MAX`）。
   TLS 还需要往 `${DEPLOY_PATH}/coturn/certs/` 放 `fullchain.pem` + `privkey.pem`
   —— 纯 IP 签不出证书，`turns:` 必须有域名。
2. 或者把现有 coturn 迁到 `use-auth-secret` 模式 —— 但要先确认没有别的服务在用它。

### 公网连不上、只有局域网能联机

先跑体检脚本，它会把 TURN 链路上每一环拆开报：

```bash
node scripts/check-turn.mjs <公网IP或域名>          # 不带 secret，只测连通性和中继地址
TURN_SECRET=<你的 secret> node scripts/check-turn.mjs <公网IP>   # 顺带验证凭证匹配
```

按出现频率排，通常是这几个原因：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 中继地址是 `172.x` / `10.x` | **coturn 少配 `external-ip`** | 云主机网卡上只有内网地址，coturn 不知道自己的公网 IP 就把内网地址当中继地址发出去。填 `external-ip=<公网IP>` 后重启。这是最隐蔽的一个 —— 端口、认证、日志全正常，就是连不上 |
| Allocate 报 401 / 438 | coturn 的 `static-auth-secret` 和 `.env` 的 `TURN_SECRET` 对不上 | 两边改一致；coturn 必须是 `use-auth-secret` 模式 |
| Allocate 不要凭证就成功 | coturn 没开认证，是开放中继 | 打开 `use-auth-secret`，否则谁都能白嫖你的带宽 |
| `turns:` 端口连不上 | TURN_PORT 上没起 TLS，或用裸 IP 部署签不出证书 | 设 `TURN_TLS_ENABLED=false`，别把连不上的 turns: 下发给浏览器白等超时 |
| Allocate 成功但依然连不上 | 中继端口段没放行 | 云安全组要放行 `COTURN_RELAY_MIN`-`COTURN_RELAY_MAX` 整段 UDP，只放 3478 不够 |

注意 `EXTERNAL_IP` 默认回落到 `MONOPOLY_DOMAIN`。如果 `MONOPOLY_DOMAIN` 填的是**域名**，
这个默认值对 coturn 是无效的（它要 IP），必须单独配 `EXTERNAL_IP` 变量。

### 多站点共存的注意事项

目标机的 nginx 上如果已经有别的站点：

- 本 workflow 只往 `NGINX_INCLUDE_FILE` 追加**一行** include，并且改动前必备份、
  `nginx -t` 不通过就自动回滚且不 reload，现有站点不会被打断。
- 生成的 location 全部锚定在自己的前缀上，不会抢别的站点的路由。
- 部署前先跑一次 `nginx -t`。**如果它本来就有告警**（例如多个 conf 为同一
  `server_name` 定义了 server 块导致 "conflicting server name ... ignored"），
  先确认你的 `NGINX_INCLUDE_FILE` 是被**生效的那个** server 块 include 的，
  否则片段装上去也不起作用。

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
curl -i -H "Host: $MONOPOLY_DOMAIN" http://127.0.0.1/monopoly-server/health

# 看生效的 nginx 配置
nginx -T | grep -A5 monopoly
```

### 镜像拉不动（`Apply on Remote` 刷屏 `Retrying in N seconds`）

日志长这样，而且是在 `Apply on Remote` 步骤里：

```
 4feea04c1543 Retrying in 15 seconds
 4feea04c1543 Retrying in 14 seconds
 ...
 4feea04c1543 Downloading [>       ]  131.1kB/11.77MB
```

这是**目标机**在 `docker compose pull`，不是 CI 在拉 —— 也就是说你跑在
`IMAGE_TRANSPORT=registry` 下。GHCR 的 manifest 走 `ghcr.io`，但 blob 走
`pkg-containers.githubusercontent.com`，后者从国内机器经常传到一半断流。

> 顺带：重试后进度条上的"总量"是**剩余量**，所以一个 43MB 的层会显示成
> `11.77MB`，别把它当成另一个层去查。

**直接的解法是把 variable `IMAGE_TRANSPORT` 设成 `ssh`（现在的默认值）** ——
改由 CI 把镜像推过去，目标机彻底不连 registry。

一定要留在 `registry` 模式的话，`remote-apply.sh` 已经做了整体重试（已下完的层留在
本地，每轮都是净进展）和串行拉取；还不够就：

```bash
# 1. 降低单次 pull 的并发（默认 3 条并发抢窄带宽，反而更容易断）
#    在目标机上：
cat /etc/docker/daemon.json                     # 先看有没有，别覆盖已有配置
# 加入 "max-concurrent-downloads": 1 后
systemctl restart docker

# 2. 调大重试轮数：repo variable PULL_RETRIES=8

# 3. 先手动把镜像拉下来，再跑 workflow（sha-xxx tag 不可变，本地有就直接复用）
docker login ghcr.io -u <你的GitHub用户名>       # 私有包才需要
docker pull ghcr.io/<owner>/mine-monopoly-server:sha-<12位commit>
```

### `ssh` 模式下报「目标机上缺少这些镜像」

`Ship Images to Remote` 步骤没跑成功（或因为 `IMAGE_TRANSPORT` 中途改过而被跳过）。
先看那一步的日志；`docker load` 失败最常见的原因是目标机 `/var/lib/docker` 磁盘满了。

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
ls "$NGINX_INCLUDE_FILE".bak-* "$NGINX_SNIPPET_PATH".bak-*
cp "$NGINX_INCLUDE_FILE".bak-<时间戳> "$NGINX_INCLUDE_FILE"
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
