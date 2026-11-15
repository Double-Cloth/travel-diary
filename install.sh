#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    echo '用法 bash install.sh [域名或 IPv4 地址] [internal|certificate|http]'
    echo '默认使用内部 CA 的 HTTPS。已有证书放入 deploy/certs/site.crt 和 site.key。'
    echo '升级已有部署请使用 bash scripts/deploy.sh --offline update --bundle /新包目录。'
    exit 0
fi
[[ ! -e "${TRAVEL_ENV_FILE:-.env}" ]] || { echo '已存在部署配置，请使用 deploy.sh update 升级或 deploy.sh up 启动。' >&2; exit 1; }
bash scripts/deploy.sh --offline init "$@"
bash scripts/deploy.sh --offline up
echo '安装完成。内部 CA 的根证书信任及远程编辑设置见 doc/OFFLINE_DEPLOYMENT.md。'
