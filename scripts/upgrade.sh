#!/usr/bin/env bash
# 目标版本升级器（Linux / Docker）的终端部分。ops.sh update 把它连同共用脚本从目标提交导出到 tmp/upgrade-*
# （见 UPGRADER_EXPORT_PATHS）后运行；它不在工作区内执行，切换代码不会改动正在运行的脚本。
#
# 新升级：停机前完成全部准备——预检、确认原服务的运行身份、从目标提交导出完整源码树并构建候选镜像（按 image ID
# 固定）、在这个镜像中只读核对数据版本并校验配置、选择通讯录同步范围、停机前
# 复核——再把这些事实、选择和计划交给源码树中的共享运维核心（ops/core，由宿主机的 Bun 运行）。核心沿用本进程
# 持有的部署锁，在锁内逐项复核后记录事务、停机、切换代码、迁移、验证并提交；提交前失败自动回滚数据、配置、容器和
# 代码。执行阶段标准输入接 /dev/null，不再交互。
# 未完成的升级：由核心按事务记录继续或回滚（改用事务固定的运维运行包），不重新询问，只用记录的镜像和身份。
#
# 用法：bash <导出目录>/scripts/upgrade.sh <项目目录> <目标提交> [continue|rollback]
# macOS：交给 bash 3.2 也能运行的引导，升级器由导出树中的 TypeScript 入口执行（scripts/lib/macos-entry.sh）。
if [ "$(uname -s)" = Darwin ]; then exec /bin/bash "$(dirname "${BASH_SOURCE[0]}")/lib/macos-entry.sh" upgrade "$@"; fi
set -euo pipefail
UPGRADER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "用法：bash <导出目录>/scripts/upgrade.sh <项目目录> <目标提交> [continue|rollback]" >&2
    exit 2
fi
PROJECT_DIR="$(cd "$1" && pwd)"
TARGET_REF="$2"
ACTION="${3:-}"
case "$ACTION" in
    ''|continue|rollback) ;;
    *) echo "升级动作只能是 continue 或 rollback" >&2; exit 2 ;;
esac
if [ "$UPGRADER_DIR" = "$PROJECT_DIR" ]; then
    echo "升级器需要从目标提交导出后运行（ops.sh update 会自动导出），不能在工作区内直接执行" >&2
    exit 2
fi
# 共用脚本取自导出的目标版本；它们在调用时读取 PROJECT_DIR，操作的是工作区。
. "$UPGRADER_DIR/scripts/lib/deployment.sh"
. "$UPGRADER_DIR/scripts/lib/ops-runtime.sh"
. "$UPGRADER_DIR/scripts/lib/core-handoff.sh"
cd "$PROJECT_DIR"
DATA_DIR="$PROJECT_DIR/data"
CONFIG_DIR="$DATA_DIR/config"
STATE_DIR="$DATA_DIR/state"
MODELS_FILE="$CONFIG_DIR/models.json"
PENDING_POINTER="$STATE_DIR/deploy-transaction"
# 目标提交的完整源码树（见 prepare_core）：新升级用它构建候选镜像，停机后的升级由其中的运维核心执行。
TARGET_TREE="$UPGRADER_DIR/target"
PREVIEW_DIR="$UPGRADER_DIR/preview"
UNCHANGED='服务尚未停止，代码和数据未改动'
# 本次升级的镜像和服务身份：停机前构建并按 image ID 固定、沿用原容器的数值 UID:GID；核心在部署锁内复核后写入事务快照。
IMAGE_ID=''
SERVICE_USER=''
SERVICE_USER_SOURCE=''
ORIGINAL_CONTAINER_FACTS=''
PREPARED_INPUTS=''
ORIGINAL_SHA=''
ORIGINAL_BRANCH=''
ORIGINAL_MAIN=''
TARGET_SHA=''
HOST_BUN=''

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
print_status() { echo -e "${BLUE}[*] $1${NC}"; operation_stage "$1"; }
print_success() { echo -e "${GREEN}[+] $1${NC}"; operation_event info "$1"; }
print_warning() { echo -e "${YELLOW}[!] $1${NC}"; operation_event warn "$1"; }
print_error() { echo -e "${RED}[-] $1${NC}"; operation_event error "$1"; }

ask_yes_no() {
    if [ "${MIXIN_OPS_CONSOLE:-}" = 1 ]; then
        print_error '控制台操作遇到未提供的交互选择，请重新预览；未自动采用默认值'; exit 2
    fi
    local answer
    while true; do
        echo -en "${CYAN}?> $1${NC}"
        if ! IFS= read -r answer; then
            echo ""
            print_warning "输入已结束，按默认值“否”处理"
            return 1
        fi
        answer="$(printf '%s' "$answer" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        case "${answer,,}" in
            ''|n|no|否) return 1 ;;
            y|yes|是) return 0 ;;
            *) print_warning "请输入 y 或 n（也可直接回车采用默认值）" ;;
        esac
    done
}

# 未完成的升级只能继续或回滚；非交互调用必须明确指定。
choose_pending_action() {
    local choice
    if [ ! -t 0 ]; then
        print_error "发现未完成的升级；请使用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"
        exit 1
    fi
    while true; do
        IFS= read -r -p '1 继续上次操作  2 回滚到操作前  0 退出 [默认 0]：' choice || choice=0
        case "$(printf '%s' "$choice" | tr -d '[:space:]')" in
            1) ACTION=continue; return ;;
            2) ACTION=rollback; return ;;
            ''|0) print_warning '未处理上次操作，服务保持当前状态'; exit 1 ;;
            *) print_warning '请输入 1、2 或 0' ;;
        esac
    done
}

# 停机后的升级由目标提交中的共享运维核心执行，宿主机的 Bun 运行它（没有可用的 Bun 时下载固定版本并核对摘要）。
# 源码树从提交导出（保留该提交的 .dockerignore），不读工作区：未跟踪文件、本地改动和之后的 fetch 都进不了它。
prepare_core() {
    local unchanged="$1"
    HOST_BUN="$(ops_bun)" || { print_error "宿主机没有可用的 Bun（原因见上方）；${unchanged}"; return 1; }
    rm -rf -- "$TARGET_TREE"
    candidate_export_context "$PROJECT_DIR" "$TARGET_SHA" "$TARGET_TREE" &&
        [ -f "$TARGET_TREE/ops/core/cli.ts" ] && [ ! -L "$TARGET_TREE/ops/core/cli.ts" ] ||
        { print_error "无法从目标提交 ${TARGET_SHA:0:7} 导出运维核心（原因见上方）；${unchanged}"; return 1; }
}

run_target_core() { run_core "$TARGET_TREE/ops/core/cli.ts" deployment upgrade --project "$PROJECT_DIR" "$@"; }

# 核心已在上方报告结果（升级含原提交和目标提交）；这里只补充未完成时的下一步，退出码与核心相同。
finish_core() {
    if [ "$CORE_STATUS" != 0 ] && [ -e "$PENDING_POINTER" ]; then
        print_error "升级未完成，事务已保留（原因见上方）；处理后可用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚（数据已提交时只能继续）"
    fi
    exit "$CORE_STATUS"
}

# ---- 未完成的升级：按事务记录继续或回滚 ----

resume_upgrade() {
    local args
    ORIGINAL_SHA="${TRANSACTION[original_sha]}"
    ORIGINAL_BRANCH="${TRANSACTION[original_branch]}"
    [ "${TRANSACTION[target_sha]}" = "$TARGET_SHA" ] || {
        print_error "事务记录的目标提交 ${TRANSACTION[target_sha]:0:7} 不是本升级器的版本 ${TARGET_SHA:0:7}；请用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"; exit 1; }
    [ -f "$TRANSACTION_SNAPSHOT/host-runtime" ] || {
        print_error "这次升级不是由运维核心开始的（快照中没有固定运行包记录 host-runtime），本版本不能继续或回滚它；服务和数据保持现状，请人工检查 ${TRANSACTION_SNAPSHOT}"; exit 1; }
    prepare_core "服务和数据保持现状" || exit 1
    args=(--original "$ORIGINAL_SHA" --target "$TARGET_SHA" --branch "$ORIGINAL_BRANCH")
    if [ "$ACTION" = rollback ]; then
        print_status "回滚上次升级：恢复数据、配置、容器、代码和原运行状态"
        args+=(--rollback)
    else
        print_status "继续上次升级 ${ORIGINAL_SHA:0:7} -> ${TARGET_SHA:0:7}：设置和数据预检计划取自事务记录，不再询问"
    fi
    run_target_core "${args[@]}"
    finish_core
}

# ---- 新升级：停机前完成全部确认 ----

# 升级沿用已保存的设置；无效时在停机前停止，由部署脚本修正。
read_saved_settings() {
    local hint="升级沿用现有配置，请先用 $(ops_command_hint deploy) 修正（服务尚未停止）"
    BOT_PORT=10000
    if [ -f "$STATE_DIR/bot-port" ]; then BOT_PORT="$(tr -d '[:space:]' < "$STATE_DIR/bot-port")"; fi
    transaction_value_valid bot_port "$BOT_PORT" || { print_error "data/state/bot-port 中的端口无效：${BOT_PORT}；${hint}"; exit 1; }
    WORKSPACE_ROOT_SAVED="$(saved_workspace_root)"
    # 外置共享资料目录缺失时在停机前停止：Docker 会把缺失的挂载源建成空目录。
    [ -z "$WORKSPACE_ROOT_SAVED" ] || [ -d "$WORKSPACE_ROOT_SAVED" ] || {
        print_error "已部署的共享资料目录不存在：$WORKSPACE_ROOT_SAVED；请恢复原目录或挂载后重试（服务尚未停止）"; exit 1; }
}

# 运行参数沿用 runtime.json；当前终端的设置类环境变量不采用，与续做一致。
check_upgrade_environment() {
    local key ignored=()
    for key in BOT_PORT WORKSPACE_ROOT "${RUNTIME_ENV_KEYS[@]}"; do
        [ -z "${!key:-}" ] || ignored+=("$key")
    done
    if [ "${#ignored[@]}" -gt 0 ]; then
        print_warning "升级沿用已保存的设置和 runtime.json，忽略当前终端的环境变量：${ignored[*]}；修改请用 $(ops_command_hint deploy)"
    fi
    unset BOT_PORT WORKSPACE_ROOT "${RUNTIME_ENV_KEYS[@]}"
}

# 原服务的运行身份：停机前从原容器（运行或停止）读取并核对，之后由核心写入事务快照的 service-user；预览、迁移、
# 验证实例、正式实例和续做都沿用它。找不到原容器或身份不明时在任何改动之前拒绝，不猜成默认值，也不改已有数据的属主。
determine_service_user() {
    local status=0
    original_service_container || status=$?
    case "$status" in
        0) ;;
        2) print_error "找不到原容器 mixin-bot，无法确认服务原来的运行身份；升级沿用原服务，请先用 $(ops_command_hint deploy) 部署（服务和数据未改动）"; exit 1 ;;
        *) print_error "无法读取原容器（原因见上方）；尚未应用升级，服务和数据未改动"; exit 1 ;;
    esac
    service_user_from_container "$DOCKER_ROOTLESS" ||
        { print_error "无法可靠确定原服务的运行身份（原因见上方）；尚未应用升级，服务和数据未改动"; exit 1; }
    ORIGINAL_CONTAINER_FACTS="${ORIGINAL_CONTAINER_ID}|${ORIGINAL_CONTAINER_USER}|${ORIGINAL_CONTAINER_IMAGE}|${ORIGINAL_CONTAINER_DATA}"
    print_status "沿用原容器的运行身份 ${SERVICE_USER}"
}

# 停机前用目标提交的源码树构建一次候选镜像：先检查磁盘空间，构建后按 image ID 固定。此后预览、迁移、验证实例和
# 正式实例都只用这个 ID，停机后不再构建；正式标签 mixin-bot 到数据提交后才指向它。
build_candidate() {
    local status=0 path paths=()
    for path in "$DATA_DIR" "$PROJECT_DIR/backup" "$UPGRADER_DIR"; do [ ! -e "$path" ] || paths+=("$path"); done
    print_status "检查构建所需的磁盘空间..."
    check_build_disk_space "$ORIGINAL_CONTAINER_IMAGE" "${paths[@]}" ||
        { print_error "磁盘空间不足或无法确认镜像存储位置（原因见上方）；服务尚未停止，代码和数据未改动"; exit 1; }
    print_status "构建目标版本 ${TARGET_SHA:0:7} 的镜像（服务尚未停止）..."
    prepare_candidate_image "$TARGET_TREE" "$TARGET_SHA" commit "$PROJECT_DIR" || status=$?
    if [ "$status" -ge 128 ]; then print_warning "镜像构建已中断；服务尚未停止，代码和数据未改动"; exit "$status"; fi
    [ "$status" = 0 ] || { print_error "镜像构建失败（原因见上方）；服务尚未停止，代码和数据未改动"; exit 1; }
    IMAGE_ID="${CANDIDATE[image_id]}"
    print_success "镜像构建成功：${IMAGE_ID}"
}

# 在候选镜像中核对数据版本，并校验目标版本的配置（data-current.ts preview）。计划中的版本标记摘要用于停机后的 apply，
# 计划写在导出目录的 preview/ 下；这个目录和本次操作日志交给服务身份，已有数据的属主不变。
preview_data_preparation() {
    rm -rf -- "$PREVIEW_DIR"
    (umask 077 && mkdir -- "$PREVIEW_DIR") && grant_service_access "$PREVIEW_DIR" && grant_operation_log_access ||
        { print_error "无法准备数据预检目录或操作日志；服务尚未停止，代码和数据未改动"; exit 1; }
    if [ ! -f "$CONFIG_DIR/app-bot.json" ]; then
        print_error "缺少 data/config/app-bot.json；升级沿用现有应用机器人凭据，请先使用 $(ops_command_hint deploy) 完成配置（服务尚未停止）"; exit 1
    fi
    print_status "在目标版本的镜像中核对数据版本并校验配置（只读挂载数据，服务尚未停止）..."
    preview_data preview --plan /preview/data-plan.json --upgrade ||
        { print_error "数据版本或配置校验未通过（原因见上方）；服务尚未停止，代码和数据未改动"; exit 1; }
    PREVIEW_PLAN="$PREVIEW_DIR/data-plan.json"
    [ -s "$PREVIEW_PLAN" ] || { print_error "数据预检没有生成计划；服务尚未停止，代码和数据未改动"; exit 1; }
}

# 停机前复核的依据：数据预检的输入（配置和版本标记）和通讯录同步范围的摘要，在预览之前取得。
prepared_inputs() {
    local path
    for path in "$CONFIG_DIR/runtime.json" "$MODELS_FILE" "$DATA_DIR/runtime/pi/settings.json" "$DATA_DIR/runtime/models-store.json" \
        "$STATE_DIR/data-version.json" "$STATE_DIR/workspace-root" "$CONFIG_DIR/directory.json"; do
        if [ -e "$path" ] || [ -L "$path" ]; then printf '%s %s\n' "$(sha256sum < "$path" | cut -d' ' -f1)" "$path"
        else printf 'absent %s\n' "$path"; fi
    done
}

# 检出仍是升级开始时核对过的样子：同一提交和分支，main 没有移动，已跟踪文件没有改动。构建、预览和等待确认期间
# 检出可能被改动；快进会保留目标提交没有改动的文件上的改动，停机后执行的就不是目标版本。
checkout_as_checked() {
    local dirty
    [ "$(git_here rev-parse HEAD 2>/dev/null)" = "$ORIGINAL_SHA" ] &&
        [ "$(git_here rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$ORIGINAL_BRANCH" ] &&
        [ "$(git_here rev-parse --verify --quiet refs/heads/main 2>/dev/null)" = "$ORIGINAL_MAIN" ] &&
        dirty="$(git_here status --porcelain --untracked-files=no 2>&1)" && [ -z "$dirty" ]
}

# 预览之后、交给核心之前再核对一次：检出和输入未变、原容器未被替换、候选镜像仍在且未被改动、剩余空间够写快照。
# 任何一项不符都在停机之前停止，重新运行升级即可。核心在部署锁内再复核检出、代码切换会覆盖的未跟踪内容（构建期间
# 出现的也在内）、原容器、候选镜像和任务 daemon。
recheck_before_stop() {
    local status=0
    print_status "停机前复核：代码、配置、原容器、候选镜像和剩余空间..."
    if ! checkout_as_checked; then
        print_error "升级开始后检出发生了变化（提交、分支、main 或已跟踪文件的改动）；服务尚未停止，请处理后重新运行升级"
        git_here status --short --branch --untracked-files=no 2>&1 | sed 's/^/      /' || true
        exit 1
    fi
    [ "$(prepared_inputs)" = "$PREPARED_INPUTS" ] ||
        { print_error "预览之后配置或版本标记发生了变化；服务尚未停止，请重新运行升级"; exit 1; }
    original_service_container || status=$?
    [ "$status" = 0 ] && [ "${ORIGINAL_CONTAINER_ID}|${ORIGINAL_CONTAINER_USER}|${ORIGINAL_CONTAINER_IMAGE}|${ORIGINAL_CONTAINER_DATA}" = "$ORIGINAL_CONTAINER_FACTS" ] ||
        { print_error "原容器 mixin-bot 在准备期间被删除、替换或改动；服务和数据未改动，请重新运行升级"; exit 1; }
    status=0
    candidate_verify || status=$?
    [ "$status" = 0 ] || { print_error "候选镜像核对未通过（原因见上方）；服务尚未停止，请重新运行升级"; exit 1; }
    check_stop_disk_space "$UPGRADER_DIR" ||
        { print_error "剩余空间不够写入停机后的快照（原因见上方）；服务尚未停止，代码和数据未改动"; exit 1; }
}

# 停机前确认的事实交给核心：候选镜像记录（与事务快照中的格式相同），以及原容器（ID、运行身份、镜像、数据挂载）、
# main 和任务 daemon。核心在部署锁内逐项复核，不符时在停机之前拒绝。
write_upgrade_records() {
    local facts="$UPGRADER_DIR/upgrade-facts"
    write_candidate_record "$UPGRADER_DIR" || return 1
    (umask 077 && printf 'format=1\ncontainer=%s\nuser=%s\nimage=%s\ndata=%s\nmain=%s\nendpoint=%s\ndaemon=%s\n' \
        "$ORIGINAL_CONTAINER_ID" "$ORIGINAL_CONTAINER_USER" "$ORIGINAL_CONTAINER_IMAGE" "$ORIGINAL_CONTAINER_DATA" \
        "$ORIGINAL_MAIN" "$TASK_DOCKER_ENDPOINT" "$TASK_DOCKER_ID" > "$facts.tmp") && mv -f -- "$facts.tmp" "$facts"
}

fresh_upgrade() {
    local dirty args
    ORIGINAL_SHA="$(git_here rev-parse HEAD)"
    ORIGINAL_BRANCH="$(git_here rev-parse --abbrev-ref HEAD)"
    assert_console_lifecycle update "$ORIGINAL_BRANCH" || exit 1
    operation_event info "original=$ORIGINAL_SHA target=$TARGET_SHA"
    operation_stage upgrade-preflight
    # 已跟踪文件的改动会被切换代码冲掉；未跟踪文件和 data/、logs/ 不受影响。
    dirty="$(git_here status --porcelain --untracked-files=no 2>&1)"
    if [ -n "$dirty" ]; then
        print_error "已跟踪文件有未提交的改动，已停止升级："
        printf '%s\n' "$dirty" | sed 's/^/      /'
        print_warning "请先提交、撤销（git restore <文件>）或备份这些改动，然后重试"
        exit 1
    fi
    if [ "$ORIGINAL_BRANCH" != main ]; then
        if [ "$ORIGINAL_BRANCH" = HEAD ]; then print_warning "当前是游离 HEAD（${ORIGINAL_SHA:0:7}），不在任何分支上"
        else print_warning "当前在分支 ${ORIGINAL_BRANCH}，不是 main"; fi
        if [ "${MIXIN_OPS_CONSOLE:-}" != 1 ]; then
            ask_yes_no "切换到 main 并继续升级？[y/N] " || { print_warning "已取消升级"; exit 1; }
        fi
    fi
    # 只接受快进。本地有未推送的提交时停下来，而不是替用户决定怎么合并。
    ORIGINAL_MAIN="$(git_here rev-parse --verify --quiet refs/heads/main)" || { print_error "本地 main 分支不存在，请先建立 main 后重试"; exit 1; }
    if ! git_here merge-base --is-ancestor "$ORIGINAL_MAIN" "$TARGET_SHA"; then
        print_error "本地 main 无法快进到目标提交 ${TARGET_SHA:0:7}"
        print_warning "本地独有的提交："
        git_here log --oneline "$TARGET_SHA..main" | sed 's/^/      /'
        print_warning "请先推送或丢弃这些提交后重试"
        exit 1
    fi
    if [ "$ORIGINAL_SHA" = "$TARGET_SHA" ]; then
        print_success "代码已经最新，仍检查数据版本并重新部署"
    else
        echo ""
        echo -e "${CYAN}将要应用的提交：${NC}"
        git_here log --oneline "main..$TARGET_SHA" | sed 's/^/      /'
        echo ""
    fi
    # 升级沿用现有 AI 配置；缺少时需要交互向导，应先通过部署完成。
    [ -f "$MODELS_FILE" ] || { print_error "缺少 data/config/models.json；升级沿用现有 AI 配置，请先使用 $(ops_command_hint deploy) 完成配置"; exit 1; }
    check_upgrade_environment
    determine_service_user
    read_saved_settings
    print_status "升级沿用现有设置：本机管理端口 ${BOT_PORT}；共享资料目录 ${WORKSPACE_ROOT_SAVED:-$DATA_DIR/workspace}"
    # rootless Docker 要到停机后启动容器时才拒绝发布低端口：沿用的端口发布不了就在这里停止。
    if [ "$DOCKER_ROOTLESS" = 1 ] && ! rootless_port_publishable "$BOT_PORT"; then
        print_error "$(rootless_port_hint "$BOT_PORT")"
        print_error "升级沿用已保存的端口 ${BOT_PORT}；改端口请用 $(ops_command_hint deploy)（服务尚未停止）"
        exit 1
    fi
    # 此后到核心发布事务指针之前，失败、取消或中断只清理本次的预览容器和保留标签。
    trap cleanup_before_pointer EXIT
    trap_preparation_signals
    prepare_core "服务尚未停止，代码和数据未改动" || exit 1
    # 部署锁、未完成的事务或运维任务、main、原容器和代码切换先由核心只读检查一次，构建之前就能拒绝；交接后它在锁内再查。
    # git 要到切换时才拒绝覆盖未跟踪的文件（被忽略的文件则直接覆盖），那时服务已经停止，所以切换途经的冲突在这里预演。
    "$HOST_BUN" --no-env-file "$TARGET_TREE/ops/core/cli.ts" deployment upgrade --project "$PROJECT_DIR" \
        --original "$ORIGINAL_SHA" --target "$TARGET_SHA" --branch "$ORIGINAL_BRANCH" --preflight </dev/null ||
        { print_error "升级预检未通过（原因见上方）；服务尚未停止，代码和数据未改动"; exit 1; }
    build_candidate
    HOST_WORKSPACE_ROOT="$WORKSPACE_ROOT_SAVED"
    WORKSPACE_ARGS=()
    if [ -n "$HOST_WORKSPACE_ROOT" ]; then WORKSPACE_ARGS=(-v "$HOST_WORKSPACE_ROOT:/app/workspace:ro" -e WORKSPACE_ROOT=/app/workspace); fi
    task_runtime_prepare || { print_error "任务隔离预检失败，原服务保持运行状态"; exit 1; }
    check_workspace_layout || { print_error "共享资料目录不能使用（原因见上方）；服务尚未停止，代码和数据未改动"; exit 1; }
    PREPARED_INPUTS="$(prepared_inputs)"
    preview_data_preparation
    choose_directory_scope
    recheck_before_stop
    write_upgrade_records || { print_error "无法写入停机前的准备记录；服务尚未停止，代码和数据未改动"; exit 1; }
    if [ "$(docker container inspect --format '{{.State.Running}}' mixin-bot 2>/dev/null || true)" != true ]; then
        print_status "机器人服务升级前未运行，升级后保持停止"
    fi
    print_status "交给运维核心：在部署锁内复核后记录事务并停止机器人服务；此后切换代码、迁移和验证期间服务保持停止，不再构建镜像"
    args=(--original "$ORIGINAL_SHA" --target "$TARGET_SHA" --branch "$ORIGINAL_BRANCH" --plan "$PREVIEW_PLAN"
        --candidate "$UPGRADER_DIR/candidate-image" --facts "$UPGRADER_DIR/upgrade-facts")
    [ -z "$DIRECTORY_SCOPE_PLAN" ] || args+=(--directory-plan "$DIRECTORY_SCOPE_PLAN")
    run_target_core "${args[@]}"
    finish_core
}

operation_start upgrade
trap 'operation_finish "$?"' EXIT
command -v flock >/dev/null || { print_error "需要 util-linux flock"; exit 1; }
acquire_deploy_lock || { [ $? = 2 ] || print_error "另一个部署、升级或维护操作正在进行"; exit 1; }
if ! git_here rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if refusal="$(git_ownership_refusal)"; then print_error "$refusal"; else print_error "${PROJECT_DIR} 不是 git 仓库，无法升级"; fi
    exit 1
fi
TARGET_SHA="$(git_here rev-parse --verify --quiet "${TARGET_REF}^{commit}")" || {
    print_error "目标提交 ${TARGET_REF} 在本地不存在；请先 git fetch origin main"; exit 1; }
# rootful Docker 要求 root，rootless Docker 要求它所属的普通用户（设置 DOCKER_ROOTLESS）：在任何提问、构建和停机之前。
require_docker_operator() {
    local command=update
    case "$ACTION" in continue) command=resume ;; rollback) command=rollback ;; esac
    docker info >/dev/null 2>&1 || { print_error '无法连接 Docker；服务和数据未改动'; exit 1; }
    require_deploy_operator "$command" || exit 1
}
if [ -e "$PENDING_POINTER" ]; then
    load_pending_transaction || { print_error "未完成事务的记录无法读取（原因见上方）；保持现状，请人工检查 backup/snapshots"; exit 1; }
    print_warning "$(describe_pending_transaction)"
    if [ "${TRANSACTION[operation]}" != upgrade ]; then
        print_error "未完成的是部署而不是升级；请先用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚上次部署，再升级"
        exit 1
    fi
    require_docker_operator
    [ -n "$ACTION" ] || choose_pending_action
    resume_upgrade
fi
if [ -n "$ACTION" ]; then
    print_success "没有未完成的升级"
    exit 0
fi
require_docker_operator
fresh_upgrade
