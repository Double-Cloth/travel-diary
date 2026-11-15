#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

config_file=${TRAVEL_ENV_FILE:-.env}
dc() { docker compose --env-file "$config_file" "$@"; }
fail() { echo "$*" >&2; exit 1; }
help() {
    cat <<'EOF'
用法 bash scripts/deploy.sh 命令 [参数]
  init [域名]          创建 .env、构建镜像、初始化空数据并交互设置密码
  up / down           启动 / 停止服务，保留所有卷
  status / logs       查看状态 / 跟踪最近日志
  backup              短暂停写，生成并校验宿主机备份
  verify 备份名称      校验完整备份
  restore 备份名称     两次确认、停机、备份当前状态后恢复
  update              备份、构建当前检出的代码、验证配置并更新
  doctor              检查配置、DNS、持久卷写权限、健康状态和 HTTPS
  --help              显示帮助
备份目录通过 .env 的 BACKUP_DIR 设置。代码版本由操作者提前 git fetch/checkout。
EOF
}

command=${1:---help}
case "$command" in --help|-h|help) help; exit 0 ;; esac
case "$command" in
    init|up|down|backup|restore|update)
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
    sed "s/diary.example.com/$domain/" .env.example > "$config_file"
    chmod 600 "$config_file"
fi
[[ -f "$config_file" ]] || fail '缺少环境配置文件，请先执行 init 或复制 .env.example。'
dc config --quiet

run_app() { dc run --rm --no-deps -T app "$@"; }
config_check() { run_app node /opt/travel-diary/scripts/check-runtime-config.js --dir /var/lib/travel-diary; }
wait_ready() { dc up -d --wait --wait-timeout 180; }

# 不执行 .env 内容，由 Compose 解析变量并通过固定容器路径绑定专用备份目录。
prepare_backups() {
    # 从 Compose 的环境插值结果读取宿主机路径，不依赖宿主机 Node.js。
    backup_dir=$(dc --profile maintenance config --format json | run_app node -e '
        let input=""; process.stdin.on("data", b=>input+=b);
        process.stdin.on("end", ()=>console.log(JSON.parse(input).services.maintenance.volumes.find(v=>v.target==="/backups").source.replaceAll("\\", "/")));
    ')
    mkdir -p -- "$backup_dir"
    dc --profile maintenance run --rm --no-deps -T --user 0:0 --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --entrypoint sh maintenance -c 'chown 1000:1000 /backups && chmod 700 /backups'
}
ops() { dc --profile maintenance run --rm --no-deps -T maintenance node /opt/travel-diary/scripts/deployment-backup.js "$@"; }
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
        dc build app
        run_app node -e 'require("node:dns").promises.lookup(process.env.SITE_DOMAIN).then(v=>console.log("域名解析",v.address)).catch(e=>{console.error(e.message);process.exit(1)})'
        run_app node -e 'require("/opt/travel-diary/js/server.js").ensureDataStructure("/var/lib/travel-diary").catch(e=>{console.error(e.message);process.exit(1)})'
        if run_app node -e 'process.exit(require("node:fs").existsSync("/var/lib/travel-diary/.secrets/auth.json")?0:1)'; then
            echo '已存在认证配置，继续保留。'
        else
            dc run --rm --no-deps app node /opt/travel-diary/scripts/set-auth-password.js --dir /var/lib/travel-diary
        fi
        config_check
        echo '初始化完成。需要远程编辑时将 .env 中 TRAVEL_WRITE_MODE 改为 remote，再执行 up。'
        ;;
    up) config_check; wait_ready ;;
    down) dc down ;;
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
    update)
        old_image=$(docker inspect --format '{{.Image}}' "$(dc ps -a -q app)")
        rollback_tag="travel-diary:rollback-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"
        docker tag "$old_image" "$rollback_tag"
        dc stop app
        backup_stopped
        echo "镜像回退命令 TRAVEL_IMAGE=$rollback_tag docker compose up -d --no-build --force-recreate"
        # 构建操作者当前检出的版本，构建或健康检查失败则恢复原镜像。
        if dc build app && config_check && wait_ready; then
            echo "更新完成，原镜像 $rollback_tag，升级前备份 $latest_backup"
        else
            echo '更新失败，正在恢复原镜像。数据变更可使用升级前备份恢复。' >&2
            TRAVEL_IMAGE="$rollback_tag" dc up -d --no-build --force-recreate --wait --wait-timeout 180
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
            require("node:dns").promises.lookup(process.env.SITE_DOMAIN,{all:true}).then(v=>console.log("DNS",v)).catch(e=>{console.error(e.message);process.exit(1)});
        '
        dc ps
        dc exec -T app node -e 'fetch("http://127.0.0.1:9000/readyz").then(r=>{if(!r.ok)process.exit(1);console.log("readyz 正常")}).catch(()=>process.exit(1))'
        run_app node -e 'fetch("https://"+process.env.SITE_DOMAIN+"/readyz").then(r=>{if(!r.ok)process.exit(1);console.log("HTTPS 正常")}).catch(e=>{console.error(e.message);process.exit(1)})'
        echo '请同时确认域名指向本机公网入口，防火墙允许 TCP 80/443 和 UDP 443。'
        ;;
    *) help; exit 1 ;;
esac
