#!/usr/bin/env bash
# 部署与升级入口停机前的只读检查（空间、共享资料目录）。事务本身（停机、快照、提交、回滚）由共用核心
# ops/core 执行，入口经 core-handoff.sh 交给它。
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
. "$(dirname "${BASH_SOURCE[0]}")/candidate-image.sh"
. "$(dirname "${BASH_SOURCE[0]}")/service-user.sh"
. "$(dirname "${BASH_SOURCE[0]}")/task-runtime.sh"

# 事务结束（提交并发布正式标签，或回滚完成）后移除本次候选镜像的保留标签；被改指向的标签保留并报告。
release_transaction_candidate() {
    declare -p CANDIDATE >/dev/null 2>&1 && [ -n "${CANDIDATE[image_tag]:-}" ] || return 0
    release_candidate ||
        print_warning "候选镜像的保留标签 ${CANDIDATE[image_tag]} 未移除（原因见上方）；确认不再需要后可手动 docker image rm ${CANDIDATE[image_tag]}"
}

# 停机后写入 backup/ 的快照的预计大小（字节）：部署快照（配置和状态文件）与 data/state 中的数据库（含统计账本）。
# 只用来决定门槛，剩余空间以 df 实测为准。
snapshot_size_estimate() {
    local path files=()
    for path in "$PROJECT_DIR/data/config" "$PROJECT_DIR/data/runtime/pi/settings.json" "$PROJECT_DIR/data/runtime/models-store.json" \
        "$PROJECT_DIR/data/state/data-version.json" "$PROJECT_DIR"/data/state/*.sqlite*; do
        [ ! -e "$path" ] || files+=("$path")
    done
    if [ "${#files[@]}" -eq 0 ]; then echo 0; return 0; fi
    du -scb -- "${files[@]}" | tail -n 1 | cut -f1
}

# 停机前复核剩余空间：data/ 和参数中的路径（例如升级器的导出目录）所在文件系统各保留 CANDIDATE_DATA_RESERVE_BYTES，
# backup/ 再加上快照的预计大小；共享剩余空间的路径需求相加（见 check_free_space）。
check_stop_disk_space() {
    local backup="$PROJECT_DIR/backup" estimate path args=()
    estimate="$(snapshot_size_estimate)" || estimate=''
    [[ "$estimate" =~ ^[0-9]+$ ]] || { echo "无法估算快照的大小" >&2; return 1; }
    [ -e "$backup" ] || backup="$PROJECT_DIR"
    args=("$backup" $(( CANDIDATE_DATA_RESERVE_BYTES + estimate )) "$PROJECT_DIR/data" "$CANDIDATE_DATA_RESERVE_BYTES")
    for path in "$@"; do args+=("$path" "$CANDIDATE_DATA_RESERVE_BYTES"); done
    check_free_space "${args[@]}"
}

# 共享资料目录的边界在宿主路径空间核对：服务容器把外置资料目录改名挂到 /app/workspace，容器内看不出它在宿主上是否
# 包含 data/ 或位于 state、tmp、会话、配置、备份、日志之内。宿主上解析后的 data、backup、logs 和资料目录按原路径
# 只读挂进候选镜像（无网络、无权限提升），用与服务启动相同的规则（ops/tools/layout-check.ts）判断；只读，
# 不创建任何目录。依赖 IMAGE_ID、SERVICE_USER、PROJECT_DIR 和 HOST_WORKSPACE_ROOT（空 = data/workspace）。
check_workspace_layout() {
    local project data backup logs workspace path mounts=()
    project="$(realpath -e -- "$PROJECT_DIR")" && data="$(realpath -e -- "$PROJECT_DIR/data")" || {
        echo "无法解析项目或 data/ 目录" >&2; return 1; }
    backup="$(realpath -m -- "$PROJECT_DIR/backup")" && logs="$(realpath -m -- "$PROJECT_DIR/logs")" || return 1
    if [ -n "$HOST_WORKSPACE_ROOT" ]; then
        workspace="$(realpath -e -- "$HOST_WORKSPACE_ROOT" 2>/dev/null)" && [ -d "$workspace" ] || {
            echo "WORKSPACE_ROOT 不存在或不是目录：$HOST_WORKSPACE_ROOT" >&2; return 1; }
    else
        workspace="$data/workspace"
    fi
    # 同一路径只挂一次（默认资料目录随 data/ 挂入；资料目录与 data/ 相同时也只挂一次）。
    local seen=$'\n'
    for path in "$data" "$backup" "$logs" "$workspace"; do
        [ -e "$path" ] && [[ "$seen" != *$'\n'"$path"$'\n'* ]] || continue
        seen+="$path"$'\n'
        mounts+=(--mount "type=bind,source=$path,target=$path,readonly")
    done
    docker run --rm --network none --user "$SERVICE_USER" --read-only --tmpfs /tmp:size=8m -e HOME=/tmp -w /app \
      --cap-drop ALL --security-opt no-new-privileges:true "${mounts[@]}" \
      "$IMAGE_ID" bun ops/tools/layout-check.ts --project "$project" --data "$data" --backup "$backup" --logs "$logs" --workspace "$workspace"
}
