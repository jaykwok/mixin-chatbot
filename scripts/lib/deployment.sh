#!/usr/bin/env bash
# 部署与升级入口停机前的只读检查（空间、共享资料目录、修订整理的选择）。事务本身（停机、快照、提交、回滚）由共用核心
# scripts/ops/core 执行，入口经 core-handoff.sh 交给它。
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
. "$(dirname "${BASH_SOURCE[0]}")/candidate-image.sh"
. "$(dirname "${BASH_SOURCE[0]}")/service-user.sh"
. "$(dirname "${BASH_SOURCE[0]}")/task-runtime.sh"
# 停机后的修订整理：停机前决定的方式与要计入停机前空间检查的字节数（见 revision_cleanup_decide）。
REVISION_CLEANUP_CHOICE=apply
REVISION_CLEANUP_BACKUP_BYTES=0
REVISION_CLEANUP_WAL_BYTES=0

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

# 跳过修订整理的办法：控制台任务不能设置环境变量，要在升级或重新部署的表单里重新预览并选择跳过。
revision_cleanup_skip_hint() {
    if [ "${MIXIN_OPS_CONSOLE:-}" = 1 ]; then printf '%s' '重新预览并选择“跳过整理”'
    else printf '%s' '设置 BOT_REVISION_CLEANUP=skip 跳过整理'; fi
}

# 停机前复核剩余空间：data/ 和参数中的路径（例如升级器的导出目录）所在文件系统各保留 CANDIDATE_DATA_RESERVE_BYTES，
# backup/ 再加上快照的预计大小；共享剩余空间的路径需求相加（见 check_free_space）。决定停机后整理修订链时
# （revision_cleanup_decide），backup/ 另加会话库的备份，data/ 另加最大一次删除的 WAL。
check_stop_disk_space() {
    local backup="$PROJECT_DIR/backup" estimate path args=()
    estimate="$(snapshot_size_estimate)" || estimate=''
    [[ "$estimate" =~ ^[0-9]+$ ]] || { echo "无法估算快照的大小" >&2; return 1; }
    [ -e "$backup" ] || backup="$PROJECT_DIR"
    args=("$backup" $(( CANDIDATE_DATA_RESERVE_BYTES + estimate + REVISION_CLEANUP_BACKUP_BYTES ))
        "$PROJECT_DIR/data" $(( CANDIDATE_DATA_RESERVE_BYTES + REVISION_CLEANUP_WAL_BYTES )))
    for path in "$@"; do args+=("$path" "$CANDIDATE_DATA_RESERVE_BYTES"); done
    check_free_space "${args[@]}" && return 0
    [ $(( REVISION_CLEANUP_BACKUP_BYTES + REVISION_CLEANUP_WAL_BYTES )) = 0 ] ||
        echo "其中修订整理需要备份 $(human_bytes "$REVISION_CLEANUP_BACKUP_BYTES")、WAL $(human_bytes "$REVISION_CLEANUP_WAL_BYTES")；可以释放空间后重试，或$(revision_cleanup_skip_hint)（不会自动省略备份）" >&2
    return 1
}

# 共享资料目录的边界在宿主路径空间核对：服务容器把外置资料目录改名挂到 /app/workspace，容器内看不出它在宿主上是否
# 包含 data/ 或位于 state、tmp、会话、配置、备份、日志之内。宿主上解析后的 data、backup、logs 和资料目录按原路径
# 只读挂进候选镜像（无网络、无权限提升），用与服务启动相同的规则（scripts/runtime/layout-check.ts）判断；只读，
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
      "$IMAGE_ID" bun scripts/runtime/layout-check.ts --project "$project" --data "$data" --backup "$backup" --logs "$logs" --workspace "$workspace"
}

# ---- 修订链首次整理（revision-chain plan §4、§8）----
# 停机前在目标版本的代码里只读预览（revision-cleanup.ts preview --shell），决定停机后整理（先备份）或跳过
# （BOT_REVISION_CLEANUP=apply|skip；不设置时终端交互询问，默认整理，非交互也整理）。空间不足时停机前拒绝，由用户
# 释放空间或显式选择跳过，不自动改变整理方式。选择交给共用核心记入事务，续做沿用；整理本身由核心在停机后、数据准备
# 之后、验证实例之前运行。

# 预览的 --shell 结果（标准输入）读入 REVISION_CLEANUP；结果不完整、不是成功或缺项时返回 1（原因已写到标准错误）。
revision_cleanup_read_preview() {
    local key
    if ! maintenance_result_read preview documents revisions longest legacy backup_bytes wal_bytes seconds run_state; then
        echo "修订整理预览的结果不完整或无法识别" >&2
        return 1
    fi
    [ "${MAINTENANCE_RESULT[outcome]}" = success ] || return 1
    declare -gA REVISION_CLEANUP=()
    for key in documents revisions longest legacy backup_bytes wal_bytes seconds; do
        [[ "${MAINTENANCE_RESULT[$key]}" =~ ^[0-9]+$ ]] || { echo "修订整理预览的 $key 无效" >&2; return 1; }
        REVISION_CLEANUP[$key]="${MAINTENANCE_RESULT[$key]}"
    done
    [[ "${MAINTENANCE_RESULT[run_state]}" =~ ^(none|running|stopped)$ ]] || { echo "修订整理预览的 run_state 无效" >&2; return 1; }
    REVISION_CLEANUP[run_state]="${MAINTENANCE_RESULT[run_state]}"
}

# 按预览决定本次的整理方式（REVISION_CLEANUP_CHOICE），以及停机前空间检查要计入的备份和 WAL 字节数。在停机之前调用。
revision_cleanup_decide() {
    local choice="${BOT_REVISION_CLEANUP:-}" minutes answer
    case "$choice" in
        ''|apply|skip) ;;
        *) print_error "BOT_REVISION_CLEANUP 只能是 apply（默认）或 skip"; return 1 ;;
    esac
    REVISION_CLEANUP_BACKUP_BYTES=0
    REVISION_CLEANUP_WAL_BYTES=0
    if [ "${REVISION_CLEANUP[run_state]}" = stopped ] && [ "$choice" != skip ]; then
        print_error "上次修订整理已停止，只能跳过剩余整理或回滚，不能续做；请先用 $(ops_command_hint revision-cleanup) skip 结束它，或$(revision_cleanup_skip_hint)"
        return 1
    fi
    if [ "${REVISION_CLEANUP[documents]}" = 0 ] && [ "${REVISION_CLEANUP[run_state]}" = none ]; then
        REVISION_CLEANUP_CHOICE="${choice:-apply}"
        return 0
    fi
    minutes=$(( (${REVISION_CLEANUP[seconds]} + 59) / 60 ))
    [ "$minutes" -gt 0 ] || minutes=1
    if [ -z "$choice" ]; then
        choice=apply
        if [ -t 0 ]; then
            while true; do
                echo -en "${CYAN}?> 停机后整理这些文档的旧修订链？停机约延长 ${minutes} 分钟，跳过请输入 n [Y/n] ${NC}"
                if ! IFS= read -r answer; then echo ""; print_warning "输入已结束，按默认值“整理”处理"; break; fi
                case "$(printf '%s' "$answer" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in
                    ''|y|yes|是) break ;;
                    n|no|否) choice=skip; break ;;
                    *) print_warning "请输入 y 或 n（也可直接回车采用默认值）" ;;
                esac
            done
        fi
    fi
    REVISION_CLEANUP_CHOICE="$choice"
    if [ "$choice" = skip ]; then
        print_warning "跳过修订整理：其中 ${REVISION_CLEANUP[legacy]} 份超过上限的旧长链在服务运行中保持现状（读入较慢，链继续变长），其余的由服务在下次变更时整理；之后可停机用 $(ops_command_hint revision-cleanup) apply 整理"
        return 0
    fi
    REVISION_CLEANUP_WAL_BYTES="${REVISION_CLEANUP[wal_bytes]}"
    # 续做的整理沿用已验证的备份（预览已按它计算）。
    REVISION_CLEANUP_BACKUP_BYTES="${REVISION_CLEANUP[backup_bytes]}"
    if [ "$REVISION_CLEANUP_BACKUP_BYTES" != 0 ]; then
        print_status "停机后整理旧修订链，约 ${minutes} 分钟；先备份要修改的会话库（$(human_bytes "$REVISION_CLEANUP_BACKUP_BYTES")，备份留在 backup/revision-cleanup，确认后再删除）"
    else
        print_status "停机后续做上次的修订整理，约 ${minutes} 分钟"
    fi
}
