#!/usr/bin/env bash
# Trusted service control plane -> same-owner rootless task daemon. Never give workers a socket.

task_runtime_read() {
    local record="$1" key value count=0
    TASK_DOCKER_ENDPOINT='' TASK_DOCKER_ID=''
    [ -f "$record" ] && [ ! -L "$record" ] || { echo "任务部署记录缺失或为链接：$record" >&2; return 1; }
    while IFS='=' read -r key value; do
        case "$key" in
            endpoint) [ -z "$TASK_DOCKER_ENDPOINT" ] || return 1; TASK_DOCKER_ENDPOINT="$value" ;;
            daemon) [ -z "$TASK_DOCKER_ID" ] || return 1; TASK_DOCKER_ID="$value" ;;
            *) echo "任务部署记录含未知字段：$key" >&2; return 1 ;;
        esac
        count=$((count+1))
    done < "$record"
    [ "$count" = 2 ] && [[ "$TASK_DOCKER_ENDPOINT" = unix:///* ]] &&
        [[ "$TASK_DOCKER_ID" =~ ^[a-zA-Z0-9:._-]+$ ]] &&
        [[ ! "$TASK_DOCKER_ENDPOINT" =~ [[:cntrl:],] ]] || { echo "任务部署记录无效：$record" >&2; return 1; }
}

task_runtime_record() {
    local record="$1" temporary="$1.tmp"
    (umask 077; printf 'endpoint=%s\ndaemon=%s\n' "$TASK_DOCKER_ENDPOINT" "$TASK_DOCKER_ID" > "$temporary") &&
        sync -f "$temporary" && mv -f -- "$temporary" "$record"
}

task_runtime_check_endpoint() {
    local user="$1" rootless="$2" expected_uid socket daemon options
    if [ "$rootless" = 1 ]; then expected_uid="$(id -u)"; else expected_uid="${user%%:*}"; fi
    socket="${TASK_DOCKER_ENDPOINT#unix://}"
    [[ "$TASK_DOCKER_ENDPOINT" = unix:///* ]] && [[ ! "$socket" =~ [[:cntrl:],] ]] &&
        [ -S "$socket" ] && [ ! -L "$socket" ] && [ "$(stat -c %u -- "$socket")" = "$expected_uid" ] || {
        echo "需要属于宿主 UID ${expected_uid} 的本机 rootless Docker socket：${socket}" >&2
        echo '请先为现有服务身份配置 rootless Docker；不会改动服务 UID/GID、安装 daemon 或自动 sudo。' >&2
        return 1
    }
    daemon="$(docker --host "$TASK_DOCKER_ENDPOINT" info --format '{{.ID}}')" || return 1
    options="$(docker --host "$TASK_DOCKER_ENDPOINT" info --format '{{json .SecurityOptions}}')" || return 1
    [[ "$daemon" =~ ^[a-zA-Z0-9:._-]+$ ]] && [[ "$options" = *'"name=rootless"'* ]] || {
        echo '任务 daemon 没有报告 rootless 隔离能力' >&2; return 1;
    }
    [ -z "${TASK_DOCKER_ID:-}" ] || [ "$TASK_DOCKER_ID" = "$daemon" ] || {
        echo '任务 daemon 与部署记录不同；保留旧回执，拒绝切换 daemon' >&2; return 1;
    }
    TASK_DOCKER_ID="$daemon"
    TASK_RUNTIME_ARGS=(-e DOCKER_HOST=unix:///run/mixin-task/docker.sock
        -e MIXIN_TASK_DEPLOYMENT=/app/data/config/task-deployment.json
        --mount "type=bind,src=${socket},dst=/run/mixin-task/docker.sock")
}

task_runtime_prepare() {
    local expected_uid image
    if [ "${RECORDED:-0}" = 1 ]; then
        task_runtime_read "$TRANSACTION_SNAPSHOT/task-runtime" || return 1
    elif [ -f "$PROJECT_DIR/data/state/task-runtime" ]; then
        task_runtime_read "$PROJECT_DIR/data/state/task-runtime" || return 1
    else
        if [ "$DOCKER_ROOTLESS" = 1 ]; then expected_uid="$(id -u)"; else expected_uid="${SERVICE_USER%%:*}"; fi
        TASK_DOCKER_ENDPOINT="${BOT_TASK_DOCKER_HOST:-unix:///run/user/${expected_uid}/docker.sock}" TASK_DOCKER_ID=''
    fi
    task_runtime_check_endpoint "$SERVICE_USER" "$DOCKER_ROOTLESS" || return 1
    image="$(docker --host "$TASK_DOCKER_ENDPOINT" image inspect --format '{{.Id}}' "$IMAGE_ID" 2>/dev/null)" || image=''
    if [ "$image" != "$IMAGE_ID" ]; then
        # Same immutable image on both daemons; never rebuild or pull a mutable tag for workers.
        (set -o pipefail; docker image save "$IMAGE_ID" | docker --host "$TASK_DOCKER_ENDPOINT" image load) || return 1
        [ "$(docker --host "$TASK_DOCKER_ENDPOINT" image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID" ] || return 1
    fi
    task_runtime_manifest check
}

task_runtime_record_previous() {
    local snapshot="$1" cid="${ORIGINAL_CONTAINER_ID:-}"
    [ -z "$cid" ] || [[ "$cid" =~ ^[a-f0-9]{64}$ ]] || { echo '原容器身份无效' >&2; return 1; }
    printf '%s\n' "$cid" > "$snapshot/task-previous-cid"
    sync -f "$snapshot/task-previous-cid"
}

# A stopped/renamed container can still accept a previously queued start. Retire the recorded
# immutable CID after the migration commits and before any business process can grant removal permits.
task_runtime_retire_previous() {
    local snapshot="$1" cid facts expected output
    [ -f "$snapshot/task-previous-cid" ] && [ ! -L "$snapshot/task-previous-cid" ] || {
        echo '缺少旧容器撤销记录，拒绝启动业务实例；请检查部署事务' >&2; return 1;
    }
    cid="$(cat "$snapshot/task-previous-cid")"
    [ -n "$cid" ] || return 0
    [[ "$cid" =~ ^[a-f0-9]{64}$ ]] || return 1
    if ! facts="$(docker container inspect --format '{{.Id}}|{{.Image}}|{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' "$cid" 2>&1)"; then
        [[ "$facts" = *"No such container: $cid"* || "$facts" = *"No such object: $cid"* ]] && return 0
        printf '无法确认旧容器状态：%s\n' "$facts" >&2; return 1
    fi
    expected="$cid|$(cat "$snapshot/previous-image")|$(realpath -- "$PROJECT_DIR/data")"
    [ "$facts" = "$expected" ] || { echo '旧容器的固定身份、镜像或数据挂载与事务不符' >&2; return 1; }
    docker container rm --force "$cid" || return 1
    if output="$(docker container inspect "$cid" 2>&1)"; then
        echo '旧容器撤销未确认，拒绝启动业务实例' >&2; return 1
    fi
    [[ "$output" = *"No such container: $cid"* || "$output" = *"No such object: $cid"* ]] || {
        printf '旧容器撤销查询失败：%s\n' "$output" >&2; return 1;
    }
}

task_runtime_manifest() {
    local command="$1" extra=()
    if [ "$HOST_GROUP_DATA_ROOT" != "$DEFAULT_GROUP_DATA_ROOT" ]; then extra=(--groups "$HOST_GROUP_DATA_ROOT"); fi
    # check does not change the active manifest or take the old controller's lock.
    docker run --rm --user "$SERVICE_USER" --read-only --network none --cap-drop ALL --security-opt no-new-privileges \
        --tmpfs /tmp:rw,nosuid,nodev,size=16m -e HOME=/tmp \
        "${TASK_RUNTIME_ARGS[@]}" "${GROUP_ROOT_ARGS[@]}" -v "$PROJECT_DIR/data:/app/data" \
        "$IMAGE_ID" bun run scripts/runtime/task-deployment.ts "$command" --image "$IMAGE_ID" \
        --data "$(realpath -- "$PROJECT_DIR/data")" "${extra[@]}"
}
