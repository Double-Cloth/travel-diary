#!/bin/sh
set -eu
umask 077

# 整个运行目录位于同一卷，支持数据导入对目录执行原子重命名。
runtime=/var/lib/travel-diary
test -w "$runtime" || { echo '持久卷不可写，请核对 UID/GID 1000 的目录权限。' >&2; exit 1; }
cd /opt/travel-diary
if [ "${2:-}" = /opt/travel-diary/js/server.js ]; then
    for directory in js css assets scripts; do
        cp -R "$directory" "$runtime/"
    done
    cp package.json index.html travel-diary.config.json travel-diary.config.schema.json "$runtime/"
fi
if [ -n "${SITE_DOMAIN:-}" ]; then
    TRAVEL_ALLOWED_ORIGINS=$(node -e '
        const domain = process.env.SITE_DOMAIN;
        const origin = new URL("https://" + domain);
        if (origin.host !== domain || origin.origin !== "https://" + domain || origin.port || origin.username || origin.password) {
            throw new Error("SITE_DOMAIN 必须是域名，不包含协议、端口或路径。");
        }
        console.log(JSON.stringify(process.env.TRAVEL_WRITE_MODE === "remote" ? [origin.origin] : []));
    ')
    export TRAVEL_ALLOWED_ORIGINS
fi
exec "$@"
