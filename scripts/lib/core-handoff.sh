#!/usr/bin/env bash
# 部署入口和升级器共用的停机前步骤与核心交接。两者都在服务运行时用候选镜像核对、预览和选择，全部确定后才把事务交给运维
# 核心（scripts/ops/core），由它在部署锁内复核、停机、提交或回滚；入口只保留引导和这些提问。
# 调用方已导入 deployment.sh，定义了 print_status 等输出函数，并设置 PROJECT_DIR、HOST_BUN、IMAGE_ID、SERVICE_USER、
# UNCHANGED（失败时说明现状的短语）和 PREVIEW_DIR（本次操作私有的目录，容器里是 /preview）。

PREVIEW_PID=''
PREVIEW_CONTAINER=''
CORE_PID=''
CORE_STATUS=1
DIRECTORY_SCOPE_PLAN=''

# 核心发布事务指针之前（构建、预览、复核、核心的锁内复核）收到中断：按信号退出，由 cleanup_before_pointer 收尾。
trap_preparation_signals() {
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
}

# 退出时收尾：删除预览容器和预览目录；事务指针不存在时（核心没有发布事务，或事务已经完成并由核心释放过）移除本次的保留
# 标签，标签已不在时什么也不做。指针存在时候选镜像属于事务，由核心在事务结束时释放。收尾期间再来的中断不打断它：终端
# Ctrl+C 发给整个前台进程组，ops.sh 还会把它转成 TERM 转发过来，所以删除容器和标签在独立的进程组中进行（run_shielded）。
cleanup_before_pointer() {
    local status=$?
    trap - EXIT
    trap : INT TERM HUP
    run_shielded discard_preparation || true
    stop_preview
    operation_finish "$status"
}

discard_preparation() {
    [ -z "$PREVIEW_PID" ] || docker rm -f "$PREVIEW_CONTAINER" >/dev/null 2>&1 || true
    [ -e "$PROJECT_DIR/data/state/deploy-transaction" ] || release_transaction_candidate
    [ -z "${PREVIEW_DIR:-}" ] || rm -rf -- "$PREVIEW_DIR"
}

# 预览容器已由 discard_preparation 删除：结束仍在等待它的 docker 客户端。
stop_preview() {
    [ -n "$PREVIEW_PID" ] || return 0
    kill "$PREVIEW_PID" 2>/dev/null || true
    wait "$PREVIEW_PID" 2>/dev/null || true
    PREVIEW_PID=''
    print_warning "数据预检已中断并清理；${UNCHANGED}"
}

# 停机前的一次性容器：以服务身份在候选镜像中运行，没有网络，有名称并在后台运行，入口等待它。中断（ops.sh 转发的 TERM、
# 终端 Ctrl+C、断线）时由 cleanup_before_pointer 先删除容器再退出；在前台运行时 docker CLI 会随入口退出变成孤儿，容器一直
# 留着。参数接在 docker run 之后：挂载、镜像和命令。
run_preview() {
    local status=0
    PREVIEW_CONTAINER="mixin-chatbot-preview-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    docker run --rm --name "$PREVIEW_CONTAINER" --network none --user "$SERVICE_USER" -w /app -e HOME=/tmp "$@" </dev/null &
    PREVIEW_PID=$!
    wait "$PREVIEW_PID" || status=$?
    PREVIEW_PID=''
    return "$status"
}

# 在候选镜像中核对数据版本（data-current.ts）。data/ 只读挂载，计划写到 /preview；它要写入的预览目录和本次操作日志由调用方
# 交给服务身份。没有程序版本的旧版（webhook）数据在这里被拒绝，旧服务不受影响。
preview_data() {
    local action="$1"
    shift
    run_preview -e BOT_OPERATION_LOG -v "$PROJECT_DIR/data:/app/data:ro" -v "$PROJECT_DIR/logs:/app/logs" -v "$PREVIEW_DIR:/preview" \
        "$IMAGE_ID" bun run scripts/runtime/data-current.ts "$action" --project /app "$@"
}

# 修订整理的预览与数据预检相同：只读挂载 data/、没有网络、可中断。说明写到终端，--shell 结果写到预览目录；随后决定停机后
# 整理或跳过（revision_cleanup_decide）。维护状态不允许结束整理时（要求从备份恢复、收缩未完成、日志格式不受支持）预览即拒绝。
preview_revision_cleanup() {
    local status=0 output="$PREVIEW_DIR/revision-cleanup"
    print_status "在目标版本的镜像中预览会话库的旧修订链（只读，服务尚未停止）..."
    run_preview -v "$PROJECT_DIR/data:/app/data:ro" "$IMAGE_ID" bun run scripts/runtime/revision-cleanup.ts preview --project /app --shell > "$output" || status=$?
    if [ "$status" != 0 ] || ! revision_cleanup_read_preview < "$output"; then
        print_error "修订整理预览失败或被拒绝（原因见上方）；${UNCHANGED}"
        exit 1
    fi
    revision_cleanup_decide || { print_error "$UNCHANGED"; exit 1; }
}

# 通讯录同步范围必须明确选择：没有 data/config/directory.json（首次部署，或 1.0.1 及更早版本的整个通讯录）时在停机前选择，
# 计划写到预览目录，由核心存入快照并在停机后写入。设置了 BOT_DIRECTORY_SCOPE 时不交互，否则在终端里运行向导（前台运行，不是
# 终端时失败并提示设置它）。容器以服务身份运行，只读挂载 data/（读取应用凭据），有网络（向平台核对部门）。参数接在
# directory-scope.ts choose 之后：首次部署的应用凭据还在预览目录里。
choose_directory_scope() {
    local terminal=-i status=0 value="${BOT_DIRECTORY_SCOPE:-}"
    [ ! -f "$PROJECT_DIR/data/config/directory.json" ] || return 0
    print_status "选择通讯录同步范围（服务尚未停止）..."
    if [ -t 0 ] && [ -t 1 ] && [ -z "${value//[[:space:]]/}" ]; then terminal=-it; fi
    docker run --rm "$terminal" --user "$SERVICE_USER" -w /app -e HOME=/tmp -e BOT_DIRECTORY_SCOPE \
        -e MIXIN_OPS_CONSOLE -e MIXIN_OPS_TASK_ID -e MIXIN_OPS_DIRECTORY -e MIXIN_OPS_DIRECTORY_INPUT -e MIXIN_OPS_DIRECTORY_APP \
        -v "$PROJECT_DIR/data:/app/data:ro" -v "$PREVIEW_DIR:/preview" \
        "$IMAGE_ID" bun run scripts/config/directory-scope.ts choose --plan /preview/directory-scope-plan.json --project /app "$@" || status=$?
    if [ "$status" = 2 ]; then print_warning "已取消选择通讯录同步范围；${UNCHANGED}"; exit 1; fi
    [ "$status" = 0 ] && [ -s "$PREVIEW_DIR/directory-scope-plan.json" ] ||
        { print_error "没有选定通讯录同步范围（原因见上方）；${UNCHANGED}"; exit 1; }
    DIRECTORY_SCOPE_PLAN="$PREVIEW_DIR/directory-scope-plan.json"
}

forward_to_core() {
    [ -z "$CORE_PID" ] || kill -TERM "$CORE_PID" 2>/dev/null || true
}

# 核心在后台运行以便转发中断：收到 INT/TERM/HUP（Ctrl+C、ops.sh 转发的终止、断线）时由它按所处阶段停止或回滚，入口等它结束，
# 退出码与它相同（控制台按退出码核对核心写入的结构化结果）。核心沿用本进程的部署锁（描述符 9 和 BOT_DEPLOY_LOCK_HELD）。
# 用法：run_core <核心入口> <参数…>
run_core() {
    local core="$1" interrupted=0 again=0
    shift
    trap 'interrupted=1; forward_to_core' INT TERM HUP
    "$HOST_BUN" --no-env-file "$core" "$@" </dev/null &
    CORE_PID=$!
    [ "$interrupted" = 0 ] || forward_to_core
    while :; do
        if wait "$CORE_PID"; then CORE_STATUS=0; else CORE_STATUS=$?; fi
        kill -0 "$CORE_PID" 2>/dev/null || break
    done
    # 中断打断的 wait 返回 128+信号；核心在那之后才结束时，它自己的退出码还在，再取一次。
    if [ "$CORE_STATUS" -gt 128 ]; then
        wait "$CORE_PID" 2>/dev/null || again=$?
        [ "$again" = 127 ] || CORE_STATUS="$again"
    fi
    CORE_PID=''
    # 之后只剩说明和收尾，再来的中断不打断它们。
    trap : INT TERM HUP
}
