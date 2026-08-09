#!/usr/bin/env bash
#
# MySQL 首次初始化脚本（只在数据卷为空时由官方镜像 entrypoint 执行一次）。
#
# 做两件事：
#   1. 建库 —— apps/server 的 dbConnecter.ts 把 database 硬编码成 "monopoly"，
#      表结构由 TypeORM synchronize=true 自动建，这里只负责 database 本身。
#   2. 如果 MYSQL_USERNAME 不是 root，建同名应用账号并只授权这两个库。
#
# ⚠ 必须在"被 source"的情况下也安全。
# MySQL 官方 entrypoint 对 *.sh 的处理是：
#     if [ -x "$f" ]; then "$f"; else . "$f"; fi
# 挂载进容器的权限位不可靠（rsync/cp/git 都可能丢 exec 位），所以随时可能走 source 分支。
# 一旦被 source，顶层的 `set -euo pipefail` 会污染 entrypoint 自己的 shell，
# 让它在后续某个正常的非零返回处直接退出 —— 现象是 MySQL 第一次启动就挂、
# 被 restart 策略拉起、而 compose 在那个窗口把它判成 unhealthy 并放弃依赖它的服务。
# 因此所有逻辑一律关在子 shell 里，选项不外泄。
#
# 已有数据卷时本脚本不会再跑；后续想改账号请手动进容器执行 SQL。

(
  set -euo pipefail

  APP_DB="${MONOPOLY_DATABASE:-monopoly}"
  LEGACY_DB="fatpaper_user"
  APP_USER="${MONOPOLY_DB_USER:-root}"
  APP_PASSWORD="${MONOPOLY_DB_PASSWORD:-}"

  # 初始化阶段的临时服务器是 socket-only（port=0），必须走 socket 而非 TCP
  mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE DATABASE IF NOT EXISTS \`${APP_DB}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS \`${LEGACY_DB}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SQL

  if [ "${APP_USER}" != "root" ] && [ -n "${APP_PASSWORD}" ]; then
    echo "[init] creating application user '${APP_USER}'"
    mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS '${APP_USER}'@'%' IDENTIFIED BY '${APP_PASSWORD}';
ALTER USER '${APP_USER}'@'%' IDENTIFIED BY '${APP_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${APP_DB}\`.* TO '${APP_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${LEGACY_DB}\`.* TO '${APP_USER}'@'%';
FLUSH PRIVILEGES;
SQL
  else
    echo "[init] MYSQL_USERNAME=root, skipping application user creation"
  fi

  echo "[init] done: databases ${APP_DB}, ${LEGACY_DB}"
)

# 子 shell 失败时大声报出来。这里刻意不 exit 1 ——
# 让 MySQL 正常启动，然后由 remote-apply.sh 的 wait_healthy monopoly-server
# 去暴露"库没建好导致服务端连不上"，那个报错比卡在 MySQL 启动更好定位。
init_status=$?
if [ "$init_status" -ne 0 ]; then
  echo "[init] !!! 初始化失败（exit=${init_status}）—— 服务端大概会连不上库，请检查上面的 SQL 报错"
fi
