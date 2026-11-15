#!/usr/bin/env bash
# 由部署脚本加载；只读取清单字段，不执行包内配置。
import_bundle() {
    local directory=$1 architecture expected config_id actual key value
    directory=$(cd -- "$directory" && pwd)
    [[ -f "$directory/offline/manifest.env" && -f "$directory/SHA256SUMS" ]] || fail '缺少离线镜像清单或 SHA256SUMS。'
    (cd -- "$directory" && sha256sum --strict -c SHA256SUMS) || fail '离线包校验失败，尚未导入镜像。'
    bundle_image= bundle_caddy= bundle_arch= bundle_app_id= bundle_caddy_id= bundle_app_config= bundle_caddy_config=
    while IFS='=' read -r key value; do
        case "$key" in
            ARCH) bundle_arch=$value ;;
            TRAVEL_IMAGE) bundle_image=$value ;;
            CADDY_IMAGE) bundle_caddy=$value ;;
            TRAVEL_IMAGE_ID) bundle_app_id=$value ;;
            CADDY_IMAGE_ID) bundle_caddy_id=$value ;;
            TRAVEL_CONFIG_ID) bundle_app_config=$value ;;
            CADDY_CONFIG_ID) bundle_caddy_config=$value ;;
            *) fail '离线镜像清单字段无效。' ;;
        esac
    done < "$directory/offline/manifest.env"
    [[ "$bundle_arch" == amd64 || "$bundle_arch" == arm64 ]] || fail '离线包架构无效。'
    for value in "$bundle_image" "$bundle_caddy"; do
        [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9./:_-]*$ ]] || fail '离线包镜像名称无效。'
    done
    for value in "$bundle_app_id" "$bundle_caddy_id" "$bundle_app_config" "$bundle_caddy_config"; do
        [[ "$value" =~ ^sha256:[a-f0-9]{64}$ ]] || fail '离线包镜像 ID 无效。'
    done
    architecture=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')
    [[ "$architecture" == "linux/$bundle_arch" ]] || fail "离线包架构 linux/$bundle_arch 与 Docker $architecture 不匹配。"
    docker load --input "$directory/offline/images.tar"
    for key in app caddy; do
        if [[ "$key" == app ]]; then
            value=$bundle_image; expected=$bundle_app_id; config_id=$bundle_app_config
        else
            value=$bundle_caddy; expected=$bundle_caddy_id; config_id=$bundle_caddy_config
        fi
        actual=$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$value")
        [[ "$actual" == "$expected linux/$bundle_arch" || "$actual" == "$config_id linux/$bundle_arch" ]] || fail "镜像 $value 的 ID 或架构与离线清单不符：实际 $actual。"
    done
}
