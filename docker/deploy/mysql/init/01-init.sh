#!/bin/bash
# MySQL 首次初始化脚本（只在数据卷为空时由官方镜像 entrypoint 执行一次）。
#
# 做两件事：
#   1. 建库 —— apps/server 的 dbConnecter.ts 把 database 硬编码成 "monopoly"，
#      表结构由 TypeORM synchronize=true 自动建，这里只负责 database 本身。
#   2. 如果 MYSQL_USERNAME 不是 root，建同名应用账号并只授权这两个库。
#
# 已有数据卷时本脚本不会再跑；后续想改账号请手动进容器执行 SQL。
set -euo pipefail

APP_DB="${MONOPOLY_DATABASE:-monopoly}"
LEGACY_DB="fatpaper_user"
APP_USER="${MONOPOLY_DB_USER:-root}"
APP_PASSWORD="${MONOPOLY_DB_PASSWORD:-}"

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
