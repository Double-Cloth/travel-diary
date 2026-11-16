#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

config_file=${TRAVEL_ENV_FILE:-.env}
previous_image_file="${config_file}.previous-image"
dc() { docker compose --env-file "$config_file" "$@"; }
fail() { echo "$*" >&2; exit 1; }
help() {
    cat <<'EOF'
用法 bash scripts/deploy.sh 命令 [参数]
  init [域名] [模式]    创建 .env、准备镜像、初始化空数据并交互设置密码
  up / down           启动 / 停止服务，保留所有卷
  status / logs       查看状态 / 跟踪最近日志
  backup              短暂停写，生成并校验宿主机备份
  verify 备份名称      校验完整备份
  restore 备份名称     两次确认、停机、备份当前状态后恢复
  update [版本或镜像]   拉取镜像、备份、验证配置并更新，成功后保存版本
  rollback            备份当前状态，切换到上次更新前保留的镜像
  --offline 命令       禁止拉取或构建；也可在 .env 设置 TRAVEL_OFFLINE=1
  --offline update --bundle 目录  校验并导入新离线包，备份后升级应用
  doctor              按部署模式检查配置、网络、持久卷及公开入口
  --help              显示帮助
备份目录通过 .env 的 BACKUP_DIR 设置。默认从 GHCR 拉取镜像。
源码构建需叠加 compose.build.yaml 并显式设置 TRAVEL_BUILD=1。
Portal 在 .env 设置 TRAVEL_DEPLOYMENT_MODE=portal，自动叠加 compose.portal.yaml。
EOF
}

# 这里只读取枚举值，不执行配置内容。其余配置继续由 Compose 解析。
read_setting() {
    if [[ -f "$config_file" ]]; then
        awk -F= -v key="$1" '$1 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*$" {gsub(/[[:space:]"\047]/,"",$2); value=$2} END {print value}' "$config_file"
    fi
}
deployment_mode=${TRAVEL_DEPLOYMENT_MODE:-$(read_setting TRAVEL_DEPLOYMENT_MODE)}
deployment_mode=${deployment_mode:-standalone}
[[ "$deployment_mode" == standalone || "$deployment_mode" == portal ]] || fail 'TRAVEL_DEPLOYMENT_MODE 必须为 standalone 或 portal。'
services=(app caddy)
if [[ "$deployment_mode" == portal ]]; then services=(app); fi
offline=${TRAVEL_OFFLINE:-}
if [[ "${1:-}" == --offline ]]; then offline=1; shift; fi
command=${1:---help}
case "$command" in --help|-h|help) help; exit 0 ;; esac
if [[ -z "$offline" && -f "$config_file" ]]; then
    offline=$(awk -F= '/^[[:space:]]*(export[[:space:]]+)?TRAVEL_OFFLINE[[:space:]]*=/ {gsub(/[[:space:]"\047]/,"",$2); print $2}' "$config_file")
fi
offline=${offline:-0}
[[ "$offline" == 0 || "$offline" == 1 ]] || fail 'TRAVEL_OFFLINE 必须为 0 或 1。'
if [[ "$offline" == 1 ]]; then
    [[ "${TRAVEL_BUILD:-0}" != 1 ]] || fail '离线模式禁止构建镜像，请先导入离线包。'
    export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}:compose.offline.yaml"
fi
if [[ "$deployment_mode" == portal ]]; then
    export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}:compose.portal.yaml"
fi
# shellcheck source=offline-images.sh
source scripts/offline-images.sh

# 仅修改指定变量，不执行 .env 中的任何内容。
set_config() {
    local temporary
    temporary=$(mktemp "${config_file}.tmp.XXXXXX")
    if awk -v key="$1" -v value="$2" '
        $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {if (!found++) print key "=" value; next}
        {print}
        END {if (!found) print key "=" value}
    ' "$config_file" > "$temporary" && mv -- "$temporary" "$config_file"; then return 0; fi
    rm -f -- "$temporary"
    return 1
}
case "$command" in
    init|up|down|backup|restore|update|rollback)
        exec 9>.travel-deployment.lock
        flock -n 9 || fail '另一项部署维护正在进行，请稍后重试。'
        ;;
esac
docker compose version >/dev/null
docker info >/dev/null

if [[ "$command" == init && ! -e "$config_file" ]]; then
    domain=${2:-}
    if [[ -z "$domain" ]]; then read -r -p '站点域名（例如 diary.example.com） ' domain; fi
    [[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$domain" == *.* ]] || fail '请使用小写完整域名。'
    if [[ "$offline" == 1 ]]; then
        mode=${3:-internal}
        case "$mode" in internal|certificate|http) ;; *) fail '离线模式请选择 internal、certificate 或 http。' ;; esac
        if [[ "$mode" == certificate ]]; then
            [[ -s deploy/certs/site.crt && -s deploy/certs/site.key ]] || fail '请先放置 deploy/certs/site.crt 和 site.key。'
        fi
        import_bundle .
    fi
    sed "s/diary.example.com/$domain/" .env.example > "$config_file"
    chmod 600 "$config_file"
    set_config TRAVEL_DEPLOYMENT_MODE "$deployment_mode"
    if [[ "$deployment_mode" == portal ]]; then
        for key in TRAVEL_BASE_PATH TRAVEL_PUBLIC_ORIGIN TRAVEL_PORTAL_NETWORK TRAVEL_PORTAL_ALIAS; do
            if [[ -n "${!key:-}" ]]; then set_config "$key" "${!key}"; fi
        done
    fi
    if [[ "$offline" == 1 ]]; then
        set_config TRAVEL_OFFLINE 1
        set_config TRAVEL_IMAGE "$bundle_image"
        set_config CADDY_IMAGE "$bundle_caddy"
        set_config CADDY_CONFIG "./deploy/Caddyfile.$mode"
        if [[ "$mode" == http ]]; then set_config SITE_SCHEME http; fi
    fi
fi
[[ -f "$config_file" ]] || fail '缺少环境配置文件，请先执行 init 或复制 .env.example。'
dc config --quiet
# 固定 Compose 已经解析出的项目名，沿用已有目录名或显式项目名，避免后续移动目录换卷。
project_name=$(dc config --environment | sed -n 's/^COMPOSE_PROJECT_NAME=//p')
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail '无法确定稳定的 Compose 项目名。'
if [[ "$command" == init ]]; then set_config COMPOSE_PROJECT_NAME "$project_name"; fi
export COMPOSE_PROJECT_NAME="$project_name"

run_app() { dc run --rm --no-deps --pull never -T app "$@"; }
config_check() {
    if [[ "$offline" == 1 && "$deployment_mode" == standalone ]]; then
        dc config --format json | run_app node -e '
            let input=""; process.stdin.on("data", b=>input+=b);
            process.stdin.on("end", ()=>{
                const mount=JSON.parse(input).services.caddy.volumes.find(v=>v.target==="/etc/caddy/Caddyfile");
                if(!/\/Caddyfile\.(http|internal|certificate)$/.test(mount?.source || "")) throw new Error("离线模式请选择 http、internal 或 certificate 代理模板。");
            });
        ' || return 1
    fi
    run_app node /opt/travel-diary/scripts/check-runtime-config.js --dir /var/lib/travel-diary || return 1
    if [[ "$deployment_mode" == portal ]]; then
        local network
        network=$(dc config --format json | run_app node -e 'let data="";process.stdin.on("data",b=>data+=b);process.stdin.on("end",()=>console.log(JSON.parse(data).networks.portal.name))') || return 1
        docker network inspect "$network" >/dev/null || fail "共享网络 $network 不存在，请先创建并接入共享网关。"
    fi
}
wait_ready() { dc up -d --no-build --pull never --wait --wait-timeout 180 "${services[@]}"; }

acquire_image() {
    if [[ "$offline" == 1 ]]; then
        local image
        while IFS= read -r image; do docker image inspect "$image" >/dev/null || fail "缺少本地镜像 $image，请导入离线包。"; done < <(dc config --images "${services[@]}")
    elif [[ "${TRAVEL_BUILD:-0}" == 1 ]]; then dc build app; else dc pull app; fi
}

# 仅替换镜像变量，保留域名、写入模式和备份路径，并原子保存。
save_image() {
    local temporary
    temporary=$(mktemp "${config_file}.tmp.XXXXXX")
    if awk -v image="$1" '
        /^[[:space:]]*(export[[:space:]]+)?TRAVEL_IMAGE[[:space:]]*=/ { if (!found++) print "TRAVEL_IMAGE=" image; next }
        { print }
        END { if (!found) print "TRAVEL_IMAGE=" image }
    ' "$config_file" > "$temporary" && mv -- "$temporary" "$config_file"; then
        return 0
    fi
    rm -f -- "$temporary"
    return 1
}

# 不执行 .env 内容，由 Compose 解析变量并通过固定容器路径绑定专用备份目录。
prepare_backups() {
    # 从 Compose 的环境插值结果读取宿主机路径，不依赖宿主机 Node.js。
    backup_dir=$(dc --profile maintenance config --format json | run_app node -e '
        let input=""; process.stdin.on("data", b=>input+=b);
        process.stdin.on("end", ()=>console.log(JSON.parse(input).services.maintenance.volumes.find(v=>v.target==="/backups").source.replaceAll("\\", "/")));
    ')
    mkdir -p -- "$backup_dir"
    dc --profile maintenance run --rm --no-deps --pull never -T --user 0:0 --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --entrypoint sh maintenance -c 'chown 1000:1000 /backups && chmod 700 /backups'
}
ops() { dc --profile maintenance run --rm --no-deps --pull never -T maintenance node /opt/travel-diary/scripts/deployment-backup.js "$@"; }
new_backup_name() { echo "travel-diary-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"; }
backup_stopped() {
    prepare_backups
    latest_backup=$(new_backup_name)
    ops backup /var/lib/travel-diary "/backups/$latest_backup"
    echo "备份已校验 $backup_dir/$latest_backup"
}
valid_name() { [[ "$1" =~ ^travel-diary-[a-zA-Z0-9-]+$ ]] || fail '备份名称应为本工具生成的 travel-diary-* 目录名。'; }
app_running() { [[ -n "$(dc ps --status running -q app)" ]]; }

case "$command" in
    init)
        acquire_image
        if [[ "$offline" != 1 && "$deployment_mode" == standalone ]]; then
            dc pull caddy
            run_app node -e 'require("node:dns").promises.lookup(process.env.SITE_DOMAIN).then(v=>console.log("域名解析",v.address)).catch(e=>{console.error(e.message);process.exit(1)})'
        fi
        if [[ "$deployment_mode" == standalone ]]; then
            dc run --rm --no-deps --pull never -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
        fi
        run_app node -e 'require("/opt/travel-diary/js/server.js").ensureDataStructure("/var/lib/travel-diary").catch(e=>{console.error(e.message);process.exit(1)})'
        if run_app node -e 'process.exit(require("node:fs").existsSync("/var/lib/travel-diary/.secrets/auth.json")?0:1)'; then
            echo '已存在认证配置，继续保留。'
        else
            dc run --rm --no-deps --pull never app node /opt/travel-diary/scripts/set-auth-password.js --dir /var/lib/travel-diary
        fi
        config_check
        echo '初始化完成。需要远程编辑时将 .env 中 TRAVEL_WRITE_MODE 改为 remote，再执行 up。'
        ;;
    up) if [[ "$offline" == 1 ]]; then acquire_image; fi; config_check; wait_ready ;;
    down)
        if [[ "$deployment_mode" == portal ]]; then
            dc stop app
            dc rm -f app
        else dc down; fi
        ;;
    status) dc ps ;;
    logs) dc logs --tail 100 -f ;;
    backup)
        running=false; if app_running; then running=true; fi
        dc stop app
        # 失败时保持停机，保留诊断现场。
        backup_stopped
        if "$running"; then wait_ready; fi
        ;;
    verify)
        valid_name "${2:-}"
        prepare_backups
        ops verify "/backups/$2"
        ;;
    restore)
        valid_name "${2:-}"
        [[ -t 0 ]] || fail '恢复需要交互终端。'
        read -r -p "输入备份名称 $2 确认恢复 " confirmation
        [[ "$confirmation" == "$2" ]] || fail '已取消。'
        read -r -p '将替换日记、密码及回收站，输入 RESTORE 再次确认 ' confirmation
        [[ "$confirmation" == RESTORE ]] || fail '已取消。'
        prepare_backups
        ops verify "/backups/$2"
        dc stop app
        ops restore /var/lib/travel-diary "/backups/$2" "/backups/$(new_backup_name)" --confirm
        config_check
        wait_ready
        ;;
    update|rollback)
        old_image=$(docker inspect --format '{{.Image}}' "$(dc ps -a -q app)")
        if [[ "$command" == rollback ]]; then
            [[ -f "$previous_image_file" ]] || fail '缺少上次更新前的镜像记录。可用 update 指定历史 Release 版本。'
            target_image=$(cat -- "$previous_image_file")
            [[ "$target_image" =~ ^travel-diary:rollback-[a-zA-Z0-9-]+$ ]] || fail '回退镜像记录无效。'
            docker image inspect "$target_image" >/dev/null
            export TRAVEL_IMAGE="$target_image"
        elif [[ "${2:-}" == --bundle ]]; then
            [[ "$offline" == 1 && -n "${3:-}" ]] || fail 'update --bundle 需要离线模式及已解压的新包目录。'
            import_bundle "$3"
            export TRAVEL_IMAGE="$bundle_image"
        elif [[ -n "${2:-}" ]]; then
            target_image=$2
            if [[ "$target_image" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-._a-zA-Z0-9]*)$ ]]; then
                target_image="ghcr.io/double-cloth-studio/travel-diary:$target_image"
            fi
            [[ "$target_image" =~ ^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$ ]] || fail '镜像名称无效。'
            export TRAVEL_IMAGE="$target_image"
        fi
        # 先下载，拉取失败时当前服务继续运行。回退使用本机保留的镜像。
        if [[ "$command" == update ]]; then acquire_image; fi
        target_image=$(dc config --format json | TRAVEL_IMAGE="$old_image" run_app node -e '
            let input=""; process.stdin.on("data",b=>input+=b);
            process.stdin.on("end",()=>console.log(JSON.parse(input).services.app.image));
        ')
        rollback_tag="travel-diary:rollback-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"
        docker tag "$old_image" "$rollback_tag"
        dc stop app
        # 使用升级前程序备份，保证备份读取器与当前数据格式匹配。
        TRAVEL_IMAGE="$rollback_tag" backup_stopped
        echo "镜像回退标签 $rollback_tag"
        if config_check && wait_ready && save_image "$target_image" && printf '%s\n' "$rollback_tag" > "$previous_image_file"; then
            echo "更新完成，原镜像 $rollback_tag，升级前备份 $latest_backup"
        else
            echo '更新失败，正在恢复原镜像。数据变更可使用升级前备份恢复。' >&2
            save_image "$rollback_tag" || echo "配置保存失败，请将 $config_file 的 TRAVEL_IMAGE 手动设为 $rollback_tag。" >&2
            TRAVEL_IMAGE="$rollback_tag" dc up -d --no-build --pull never --force-recreate --wait --wait-timeout 180 "${services[@]}"
            exit 1
        fi
        ;;
    doctor)
        config_check
        docker inspect "$(dc ps -q app)" | run_app node -e '
            let input=""; process.stdin.on("data",b=>input+=b);
            process.stdin.on("end",()=>{
                const service=JSON.parse(input)[0];
                if(!service.Mounts.some(v=>v.Destination==="/var/lib/travel-diary" && v.RW)) throw new Error("缺少可写持久卷");
                if(service.NetworkSettings.Ports["9000/tcp"]?.length) throw new Error("应用端口被发布到宿主机");
                console.log("持久卷及内部端口检查通过");
            });
        '
        run_app node -e '
            const fs=require("node:fs"); const root="/var/lib/travel-diary";
            for(const dir of [root,root+"/data",root+"/.secrets",root+"/.cache"]) fs.accessSync(dir,fs.constants.R_OK|fs.constants.W_OK);
            if(process.getuid()===0) throw new Error("应用必须使用非 root 用户");
            console.log("持久卷权限检查通过");
        '
        dc ps
        dc exec -T app node -e 'fetch("http://127.0.0.1:9000/readyz").then(r=>{if(!r.ok)process.exit(1);console.log("readyz 正常")}).catch(()=>process.exit(1))'
        if [[ "$deployment_mode" == portal ]]; then
            dc config --format json | run_app node -e '
                let data="";process.stdin.on("data",b=>data+=b);process.stdin.on("end",async()=>{
                    const config=JSON.parse(data), network=config.networks.portal.name;
                    const alias=config.services.app.networks.portal.aliases[0];
                    console.log("共享网络",network,"应用 DNS",alias);
                    const response=await fetch("http://"+alias+":9000/readyz");
                    if(!response.ok) throw new Error("共享网络内应用不可达");
                    console.log("共享网络内应用可达");
                });
            '
            run_app node -e '
                const {server}=require("/opt/travel-diary/js/runtime-config.js").loadRuntimeConfig("/var/lib/travel-diary");
                const origin=server.publicOrigin || (process.env.SITE_SCHEME || "https")+"://"+process.env.SITE_DOMAIN;
                const address=origin+(server.basePath==="/"?"":server.basePath)+"/readyz";
                fetch(address,{redirect:"manual",signal:AbortSignal.timeout(15000)}).then(async r=>{
                    if(r.status!==200 || await r.text()!=="ok\n") throw new Error("入口返回 "+r.status+"，请检查前缀剥离、Host、隧道及网关路由");
                    console.log("公开子路径正常",address);
                }).catch(e=>{console.error("公开入口不可达",address,e.message,"请检查 SakuraFrp、TLS 端口、DNS 和共享 Caddy");process.exitCode=1});
            '
        elif [[ "$offline" == 1 ]]; then
            dc exec -T caddy wget -q -O - http://app:9000/readyz
            dc exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
            echo '离线代理及后端检查通过；请从客户端核对入口访问、域名解析和证书信任。'
        else
            run_app node -e 'require("node:dns").promises.lookup(process.env.SITE_DOMAIN,{all:true}).then(v=>console.log("DNS",v)).catch(e=>{console.error(e.message);process.exit(1)})'
            run_app node -e 'fetch("https://"+process.env.SITE_DOMAIN+"/readyz").then(r=>{if(!r.ok)process.exit(1);console.log("HTTPS 正常")}).catch(e=>{console.error(e.message);process.exit(1)})'
            echo '请同时确认域名指向本机公网入口，防火墙允许 TCP 80/443 和 UDP 443。'
        fi
        ;;
    *) help; exit 1 ;;
esac
