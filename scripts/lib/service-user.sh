#!/usr/bin/env bash
# 服务容器的运行身份（数值 UID:GID）。部署和升级沿用原容器的身份：停机前从原容器读取并核对，写入事务快照中的
# service-user 文件（transaction 保持 format 1，按名读取，旧版代码忽略它）；预览、迁移、验证实例、正式实例和续做都用它。
# 已有数据的属主不批量改动，只给本次新建的目录和文件设置属主。
#
# rootful Docker 由 root 运行部署，容器身份就是宿主机上的属主；rootless Docker 由它所属的普通用户运行，容器里的 0:0
# 映射为这个用户，本次新建的文件本来就属于它，不需要改属主（见 require_deploy_operator）。
# 用法：. scripts/lib/service-user.sh（调用方已导入 common.sh）

SERVICE_USER_KEYS=(format user source)
# 真正首次部署的默认身份：rootful 下是镜像中的 appuser，rootless 下是映射为部署用户的容器 root。
DEFAULT_ROOTFUL_SERVICE_USER=1001:1001

service_user_value_valid() {
    local key="$1" value="$2"
    [[ ! "$value" =~ [[:cntrl:]] ]] || return 1
    case "$key" in
        format) [ "$value" = 1 ] ;;
        user) [[ "$value" =~ ^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$ ]] && (( ${value%%:*} < 4294967295 && ${value##*:} < 4294967295 )) ;;
        # container：读自原容器；default：真正首次部署的默认值；confirmed：原容器不在时由操作者按数据目录属主确认。
        source) [[ "$value" =~ ^(container|default|confirmed)$ ]] ;;
        *) return 1 ;;
    esac
}

# 身份与 Docker 的模式相符：rootless 只能是映射为属主的 0:0；rootful 下本项目从不让服务以宿主机 root 运行。
service_user_fits_daemon() {
    local user="$1" rootless="$2"
    if [ "$rootless" = 1 ]; then
        [ "$user" = 0:0 ] || { echo "rootless Docker 下服务应以映射为部署用户的 0:0 运行，记录的是 ${user}；其他 UID 映射到从属 ID 区间，读写不了部署用户的数据" >&2; return 1; }
    else
        [ "${user%%:*}" != 0 ] || { echo "rootful Docker 下服务不应以 root（${user}）运行，本项目的部署不会这样启动它" >&2; return 1; }
    fi
}

# rootful Docker 的部署和升级要求 root：只有 root 能完整查看镜像存储所在的磁盘（见 docker_storage_paths），并按服务
# 原来的身份给新建文件设置属主。rootless Docker 由它所属的普通用户运行；root 不是任何 rootless daemon 的属主。
# 在任何提问、构建和停机之前调用，不自动 sudo。设置 DOCKER_ROOTLESS。调用方已确认能连接 Docker。
require_deploy_operator() {
    local uid command="${1:-deploy}"
    uid="$(id -u)"
    if docker_rootless; then
        DOCKER_ROOTLESS=1
        [ "$uid" != 0 ] && return 0
        echo "当前 Docker 是 rootless 模式，属于运行它的普通用户，root 不是它的属主（容器身份的映射也不同）；请以该用户运行 $(ops_command_hint "$command")，不要用 sudo" >&2
        return 1
    fi
    DOCKER_ROOTLESS=0
    [ "$uid" = 0 ] && return 0
    echo "Docker 以 root 身份运行（rootful）：部署和升级需要 root 才能检查镜像存储所在磁盘的剩余空间，并沿用服务原来的运行身份准备文件。当前用户（UID ${uid}）请改用 root 运行，例如 sudo $(ops_command_hint "$command")；脚本不会自动 sudo" >&2
    return 1
}

default_service_user() {
    if [ "$1" = 1 ]; then echo 0:0; else echo "$DEFAULT_ROOTFUL_SERVICE_USER"; fi
}

# 原服务容器 mixin-chatbot（运行或停止）：ORIGINAL_CONTAINER_ID、_USER（--user 的值）、_IMAGE、_DATA 和 _GROUPS
# （/app/data、/app/group-data 挂载的来源，没有时为空）。返回 0 找到；2 不存在；1 其他错误（原因写到标准错误）。
original_service_container() {
    local output
    ORIGINAL_CONTAINER_ID='' ORIGINAL_CONTAINER_USER='' ORIGINAL_CONTAINER_IMAGE='' ORIGINAL_CONTAINER_DATA='' ORIGINAL_CONTAINER_GROUPS=''
    if ! output="$(docker container inspect --format '{{.Id}}|{{.Config.User}}|{{.Image}}|{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}|{{range .Mounts}}{{if eq .Destination "/app/group-data"}}{{.Source}}{{end}}{{end}}' mixin-chatbot 2>&1)"; then
        [[ "$output" != *"No such container"* ]] || return 2
        printf '无法读取原容器 mixin-chatbot：%s\n' "$output" >&2
        return 1
    fi
    IFS='|' read -r ORIGINAL_CONTAINER_ID ORIGINAL_CONTAINER_USER ORIGINAL_CONTAINER_IMAGE ORIGINAL_CONTAINER_DATA ORIGINAL_CONTAINER_GROUPS <<< "$output"
}

# 从原容器取服务身份并核对：数据挂载属于本项目、--user 是数值 UID:GID 且与 Docker 的模式相符。设置 SERVICE_USER。
# 调用方先执行 original_service_container。身份不能可靠确定时返回 1，不猜测。
service_user_from_container() {
    local rootless="$1" data
    data="$(realpath -m -- "$PROJECT_DIR/data")"
    if [ -z "$ORIGINAL_CONTAINER_DATA" ] || [ "$(realpath -m -- "$ORIGINAL_CONTAINER_DATA")" != "$data" ]; then
        echo "容器 mixin-chatbot 的数据目录（${ORIGINAL_CONTAINER_DATA:-未挂载}）不是本项目的 ${data}，无法确认它是本项目的服务" >&2
        return 1
    fi
    service_user_value_valid user "$ORIGINAL_CONTAINER_USER" ||
        { echo "原容器 mixin-chatbot 的运行身份不是数值 UID:GID（${ORIGINAL_CONTAINER_USER:-镜像默认用户}），无法可靠确定" >&2; return 1; }
    service_user_fits_daemon "$ORIGINAL_CONTAINER_USER" "$rootless" || return 1
    SERVICE_USER="$ORIGINAL_CONTAINER_USER"
    SERVICE_USER_SOURCE=container
}

# 是否已提交过部署：这些设置只在部署提交时写入。
deployment_recorded() {
    local name
    for name in bot-port deploy-mode group-data-root; do
        [ ! -e "$PROJECT_DIR/data/state/$name" ] || return 0
    done
    return 1
}

# 原容器不在时供操作者确认的身份：data/state 的属主（rootless 下必须是部署用户本人，对应容器里的 0:0）。
service_user_from_data() {
    local rootless="$1" owner
    owner="$(stat -c '%u:%g' -- "$PROJECT_DIR/data/state" 2>/dev/null)" || { echo "读不到 data/state 的属主" >&2; return 1; }
    if [ "$rootless" = 1 ]; then
        [ "${owner%%:*}" = "$(id -u)" ] || { echo "data/state 属于 ${owner}，不是运行 rootless Docker 的当前用户" >&2; return 1; }
        echo 0:0
        return 0
    fi
    service_user_fits_daemon "$owner" 0 || return 1
    echo "$owner"
}

# 在发布事务指针之前调用：逐项校验后写临时文件并落盘，再改名。
write_service_user_record() {
    local directory="$1" temporary="$1/service-user.tmp" content
    service_user_value_valid user "${SERVICE_USER:-}" && service_user_value_valid source "${SERVICE_USER_SOURCE:-}" ||
        { echo "服务身份无效：${SERVICE_USER:-空}（${SERVICE_USER_SOURCE:-未知来源}）" >&2; return 1; }
    content="format=1"$'\n'"user=${SERVICE_USER}"$'\n'"source=${SERVICE_USER_SOURCE}"$'\n'
    if ! (umask 077 && printf '%s' "$content" | dd of="$temporary" conv=fsync status=none); then
        rm -f -- "$temporary"
        return 1
    fi
    mv -- "$temporary" "$directory/service-user"
}

# 读取快照中的服务身份到 SERVICE_USER、SERVICE_USER_SOURCE。缺失、重复或未知的键、任何一项无效都拒绝。
read_service_user_record() {
    local file="$1/service-user" line key value
    local -A record=()
    SERVICE_USER='' SERVICE_USER_SOURCE=''
    if [ ! -e "$file" ] && [ ! -L "$file" ]; then echo "缺少服务身份记录：$file" >&2; return 1; fi
    [ -f "$file" ] && [ ! -L "$file" ] || { echo "服务身份记录不是普通文件：$file" >&2; return 1; }
    while IFS= read -r line || [ -n "$line" ]; do
        key="${line%%=*}"
        value="${line#*=}"
        if [ "$key" = "$line" ] || ! service_user_value_valid "$key" "$value" || [ -n "${record[$key]+set}" ]; then
            echo "服务身份记录无效：${key}" >&2
            return 1
        fi
        record[$key]="$value"
    done < "$file"
    for key in "${SERVICE_USER_KEYS[@]}"; do
        [ -n "${record[$key]+set}" ] || { echo "服务身份记录缺少：$key" >&2; return 1; }
    done
    SERVICE_USER="${record[user]}"
    SERVICE_USER_SOURCE="${record[source]}"
}

# 让服务身份能访问本次新建的文件或目录（不递归）：rootful 下由 root 改属主；rootless 下文件已属于部署用户，不需要改。
grant_service_access() {
    [ "$(id -u)" = 0 ] || return 0
    chown -- "$SERVICE_USER" "$@"
}

# 运维日志：logs/ 和 logs/operations 由部署用户的 operation_start 按需创建（root 运行时属于 root），服务身份要在其中
# 写入本次操作日志和服务启动时的诊断日志。只交出这两级目录和本次的日志文件（不递归、不跟随链接），其他日志的属主不变。
grant_operation_log_access() {
    local path existing=()
    for path in "$PROJECT_DIR/logs" "$PROJECT_DIR/logs/operations" ${BOT_OPERATION_LOG_PATH:+"$BOT_OPERATION_LOG_PATH"}; do
        [ ! -e "$path" ] || [ -L "$path" ] || existing+=("$path")
    done
    [ "${#existing[@]}" -eq 0 ] || grant_service_access "${existing[@]}"
}

# 创建缺少的目录，只把本次新建的各级目录交给服务身份；已有目录（及其中的数据）的属主不变。
make_service_directories() {
    local directory top
    for directory in "$@"; do
        [ ! -d "$directory" ] || continue
        top="$directory"
        while [ ! -e "$(dirname -- "$top")" ] && [ "$(dirname -- "$top")" != "$top" ]; do top="$(dirname -- "$top")"; done
        mkdir -p -- "$directory" || return 1
        if [ "$(id -u)" = 0 ]; then chown -R -- "$SERVICE_USER" "$top" || return 1; fi
    done
}
