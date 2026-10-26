#!/bin/bash

# 量子密信群聊协作机器人部署脚本 (Debian + Docker, Bun)
# 应用机器人凭据（data/config/app-bot.json）和 AI 配置（data/config/models.json）由容器内的配置向导生成；
# 无必需 .env/config.json。消息经平台事件 Stream 主动连出接收，不需要入站端口：HTTP 只监听本机回环，
# 供 TUI、/health 和 /_admin/shutdown 使用。出站需能访问 imtwo.zdxlz.com 与 imfl.zdxlz.com 的 443 端口。

set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 与 deploy.sh / ops.sh 共用的纯辅助函数（主机名校验与规范化）。
COMMON_LIB="${PROJECT_DIR}/scripts/lib/common.sh"
if [ ! -f "$COMMON_LIB" ]; then
    echo "缺少 ${COMMON_LIB}；请从仓库完整获取脚本目录后重试。" >&2
    exit 1
fi
# shellcheck source=../lib/common.sh
. "$COMMON_LIB"
. "${PROJECT_DIR}/scripts/lib/deployment.sh"
operation_start deploy
trap 'operation_finish "$?"' EXIT
cd "$PROJECT_DIR"
LEGACY_REUSE_REQUEST="${DEPLOY_REUSE_SETTINGS:-0}"
unset DEPLOY_REUSE_SETTINGS
# 未完成事务的处理方式（ops resume / rollback 和升级器指定，否则下方询问）；续做和回滚只使用事务记录中的设置。
TRANSACTION_ACTION="${DEPLOY_TRANSACTION_ACTION:-}"
unset DEPLOY_TRANSACTION_ACTION
case "$TRANSACTION_ACTION" in
    ''|continue|rollback) ;;
    *) echo "DEPLOY_TRANSACTION_ACTION 只能是 continue 或 rollback" >&2; exit 1 ;;
esac
# 旧版（webhook）运维脚本的升级先停机，再以 DEPLOY_REUSE_SETTINGS=1 调用部署脚本。旧版不支持升级到应用机器人版本：
# 在改动任何状态之前拒绝，旧脚本随后恢复原代码和原运行状态。
if [ "$LEGACY_REUSE_REQUEST" = 1 ] && [ -z "$TRANSACTION_ACTION" ]; then
    operation_event error "legacy upgrade entry refused"
    {
        echo "[-] 旧版（webhook）部署不支持升级到应用机器人版本，请在新目录全新部署（见 docs/data-migrations.md）。"
        echo "    本次未改动数据和配置；旧脚本将恢复原代码和原运行状态。"
    } >&2
    exit 1
fi
RECORDED=0
# 只有升级的续做保持原停止状态（续做分支设置）；部署完成后总是启动。
DEPLOY_PRESERVE_STOPPED=0
DATA_DIR="${PROJECT_DIR}/data"
CONFIG_DIR="${DATA_DIR}/config"
STATE_DIR="${DATA_DIR}/state"
RUNTIME_DIR="${DATA_DIR}/runtime"
RUNTIME_HOME_DIR="${RUNTIME_DIR}/home"
LOG_DIR="${PROJECT_DIR}/logs"
MODELS_FILE="${CONFIG_DIR}/models.json"
APP_BOT_FILE="${CONFIG_DIR}/app-bot.json"
BOT_PORT_FILE="${STATE_DIR}/bot-port"
WORKSPACE_ROOT_FILE="${STATE_DIR}/workspace-root"
# HTTP 只供本机管理；rootless Docker 另见启动容器处的端口发布。
BOT_HOST=127.0.0.1
# 本次事务的镜像和服务身份：新部署在构建后固定 image ID、沿用原容器的数值 UID:GID（见 determine_service_user）；
# 续做和回滚取自事务快照（load_transaction_runtime）。事务内的容器都只按它们运行，不按 mixin-chatbot 标签选择。
IMAGE_ID=''
SERVICE_USER=''
SERVICE_USER_SOURCE=''
CANDIDATE_PRESENT=1

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
print_prompt() { echo -e "${CYAN}?> $1${NC}"; }

trim_input() {
    printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# 续做不能提问：说明设置来源和失败后的下一步。
settings_fixed_hint() {
    printf '续做只使用事务记录中的设置，服务保持停止；处理后可重试继续，或回滚（%s）后重新部署' "$(ops_command_hint rollback)"
}

read_input() {
    local prompt="$1" output_name="$2" input_value="" hidden="${3:-0}"
    local read_options=(-r)
    if [ "$hidden" = "1" ]; then read_options+=(-s); fi
    print_prompt "$prompt"
    if ! IFS= read "${read_options[@]}" input_value; then
        echo ""
        print_warning "输入已结束，部署已取消"
        exit 130
    fi
    if [ "$hidden" = "1" ]; then printf '\n'; fi
    printf -v "$output_name" '%s' "$input_value"
}

ask_yes_no() {
    local prompt="$1" default_answer="${2:-n}" answer
    while true; do
        read_input "$prompt" answer
        answer="$(trim_input "$answer")"
        answer="${answer,,}"
        if [ -z "$answer" ]; then
            if [ "$default_answer" = "y" ]; then
                return 0
            fi
            return 1
        fi
        case "$answer" in
            y|yes|是) return 0 ;;
            n|no|否) return 1 ;;
            *) print_warning "请输入 y 或 n（也可直接回车采用默认值）" ;;
        esac
    done
}

# 未完成事务只能继续或回滚；不选择则保持现状退出，不开始新的部署。
choose_transaction_action() {
    local choice
    while true; do
        read_input "1 继续上次操作  2 回滚到操作前  0 退出 [默认 0]：" choice
        case "$(trim_input "$choice")" in
            1) TRANSACTION_ACTION=continue; return ;;
            2) TRANSACTION_ACTION=rollback; return ;;
            ''|0) print_warning "未处理上次操作，服务保持当前状态"; exit 1 ;;
            *) print_warning "请输入 1、2 或 0" ;;
        esac
    done
}

# The deployment transaction is shared in scripts/lib/deployment.sh.

# 共享资料默认在 data/workspace（随 data 挂载）；外置资料目录只读挂到 /app/workspace，从不改属主。
workspace_mount() {
    WORKSPACE_ARGS=()
    if [ -n "$1" ]; then WORKSPACE_ARGS+=(-v "$1:/app/workspace:ro" -e WORKSPACE_ROOT=/app/workspace); fi
}

# The target image owns data_preparation semantics (data-current.ts of that release).
data_preparation_docker() {
    # 候选镜像已不存在时只允许回滚本事务从未开始迁移的操作（见 rollback_pending_deployment）：没有本事务的迁移可查或撤销。
    if [ "$CANDIDATE_PRESENT" = 0 ]; then
        case "$1" in
            committed) return 1 ;;
            rollback) return 0 ;;
            *) print_error "候选镜像已不存在，不能运行迁移 $1"; return 1 ;;
        esac
    fi
    docker run --rm -i --user "$SERVICE_USER" \
      -e HOME=/app/data/runtime/home -e BOT_DEPLOY_BACKUP_ID -e BOT_OPERATION_LOG -e PI_CACHE_RETENTION \
      -v "$PROJECT_DIR/data:/app/data" -v "$PROJECT_DIR/backup:/app/backup" -v "$PROJECT_DIR/logs:/app/logs" \
      "$IMAGE_ID" bun run scripts/runtime/data-current.ts "$@"
}
DATA_PREPARATION_APPLY_ATTEMPTED=0
DATA_PREPARATION_PLAN=/app/data/state/data-plan.json
rollback_current_data() {
    [ "$DATA_PREPARATION_APPLY_ATTEMPTED" = 1 ] || return 0
    # Without a journal there is nothing to restore, and the image may never have been built.
    [ -e "$STATE_DIR/release-data.json" ] || return 0
    local result=0
    data_preparation_docker rollback --deployment "$BOT_DEPLOY_BACKUP_ID" || result=$?
    if [ "$result" = 42 ]; then
        commit_deployment
        print_error "数据已经提交，保留新代码；请检查服务状态后启动。"
    fi
    return "$result"
}

# begin_deployment 发布事务指针前调用：记录停机前确认的全部选择，以及固定的镜像和服务身份（独立文件，事务记录保持
# format 1）；续做和回滚只读这些记录。
record_deployment_transaction() {
    local snapshot="$1"
    write_candidate_record "$snapshot" && write_service_user_record "$snapshot" || return 1
    task_runtime_record "$snapshot/task-runtime" || return 1
    task_runtime_record_previous "$snapshot" || return 1
    declare -gA TRANSACTION=([format]=2 [operation]=deploy [snapshot]="$(basename -- "$snapshot")"
        [target_sha]="$(cat "$snapshot/target-sha")" [original_sha]='' [original_branch]=''
        [original_workspace_root]="$ORIGINAL_WORKSPACE_ROOT" [target_workspace_root]="$HOST_WORKSPACE_ROOT" [was_running]="$PREVIOUS_RUNNING"
        [bot_port]="$BOT_PORT" [reconfigure_ai]="$RECONFIGURE_AI")
    write_transaction_record "$snapshot" || return 1
    if [ "$DATA_PREPARATION_PLANNED" = 1 ]; then cp -- "$STATE_DIR/data-plan.json" "$snapshot/data-plan.json" || return 1; fi
}

# 回滚未完成的事务。数据已提交时拒绝，只能继续完成新实例启动；判定在改动任何容器之前。
rollback_pending_deployment() {
    local original="${TRANSACTION[original_workspace_root]}" target="${TRANSACTION[target_workspace_root]}"
    [ -z "$original" ] || [ -d "$original" ] || { print_error "原共享资料目录不存在：$original；旧容器依赖它，请恢复原挂载后再回滚"; exit 1; }
    workspace_mount "$target"
    # 候选镜像已不存在：本事务从未开始迁移时不需要撤销数据，用原容器回滚；否则需要完全相同的镜像，不能重新构建代替。
    if [ "$CANDIDATE_PRESENT" = 0 ] && data_preparation_mentions_deployment "${TRANSACTION[snapshot]}"; then
        print_error "上次操作的数据迁移已经开始，查看或撤销它需要记录的候选镜像 ${IMAGE_ID}，但它已不存在；请恢复完全相同的镜像（同一 image ID）后重试，重新构建的镜像不能代替；服务和数据保持现状"
        exit 1
    fi
    if [ -e "$STATE_DIR/release-data.json" ]; then
        if data_preparation_docker committed --deployment "${TRANSACTION[snapshot]}"; then
            print_error "上次操作的数据已经提交，不能回滚；请选择继续（$(ops_command_hint resume)）完成新实例启动"
            exit 1
        fi
    fi
    HOST_WORKSPACE_ROOT="$target"
    ROLLBACK_REQUESTED=1
    print_status "回滚上次操作：恢复数据、配置、容器、网络入口和原运行状态"
    begin_deployment
    # The EXIT trap installed by begin_deployment restores the snapshot and reports the result.
    exit 1
}

# 数据提交后启动正式实例（原本停止的升级保持停止），把正式标签 mixin-chatbot 指向本次镜像并核对，之后才清理事务、
# 旧回滚容器和临时标签：停机状态下的运维命令按这个标签运行。实例未就绪或标签发布失败时保留事务指针，可再次继续。
activate_committed_deployment() {
    if [ -f "$PROJECT_DIR/data/config/task-deployment.json" ]; then
        task_runtime_retire_previous "$DEPLOY_SNAPSHOT" || {
            print_error "数据已提交，但旧写者撤销未确认；保留事务并保持业务实例停止，请修复后继续"; exit 1;
        }
        PREVIOUS_CONTAINER_SAVED=0
    fi
    rm -f -- "$PROJECT_DIR/data/state/verify-only" "$PROJECT_DIR/data/state/data-plan.json"
    if [ "${DEPLOY_PRESERVE_STOPPED:-0}" != 1 ] || [ "$PREVIOUS_RUNNING" = 1 ]; then
        print_status "启动机器人并等待健康检查..."
        docker start mixin-chatbot >/dev/null
        local normal_ready=0 attempt
        for attempt in $(seq 1 18); do
            if docker exec mixin-chatbot bun run scripts/ops/health-check.ts; then normal_ready=1; break; fi
            sleep 5
        done
        if [ "$normal_ready" != 1 ]; then
            print_error "数据已经提交，但业务实例未就绪；保留新版本，请检查日志后使用 $(ops_command_hint resume) 继续"
            exit 1
        fi
        downtime_ends 'new version healthy'
    fi
    candidate_publish "$IMAGE_ID" mixin-chatbot || {
        print_error "数据已经提交，新版本已启用，但正式标签 mixin-chatbot 未能指向 ${IMAGE_ID}（原因见上方）；保留事务，处理后使用 $(ops_command_hint resume) 重试"
        exit 1
    }
    rm -f -- "$PROJECT_DIR/data/state/deploy-transaction"
    release_transaction_candidate
    cleanup_completed_backup "$DEPLOY_SNAPSHOT" keep-root || print_warning "部署已完成，但备份清理未完成，请检查 $DEPLOY_SNAPSHOT 和 $PROJECT_DIR/backup/rm"
    # Let process exit close descriptor 9. Explicit unlock would also unlock an update parent's inherited descriptor.
    if [ "$PREVIOUS_CONTAINER_SAVED" = "1" ]; then
        if docker rm "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
            print_success "部署已提交，旧容器回滚版本已清理"
        else
            print_warning "部署已成功，但旧回滚容器 ${ROLLBACK_CONTAINER} 清理失败；可确认后手动 docker rm"
            return 0
        fi
    fi
    release_previous_image
    task_runtime_cleanup_images || print_warning '部署已完成，但独立任务 daemon 的旧镜像清理未完成；下次成功部署会重试（原因见上方）'
}

# 数据已在中断前提交：配置、网络入口和状态文件都已写入，旧数据不能再用。
# 只停止验证实例并启动正式实例；不重新创建事务、构建镜像或执行迁移。
finish_committed_transaction() {
    DEPLOY_SNAPSHOT="$TRANSACTION_SNAPSHOT"
    PREVIOUS_RUNNING="${TRANSACTION[was_running]}"
    ROLLBACK_CONTAINER=mixin-chatbot-rollback
    PREVIOUS_CONTAINER_SAVED=0
    if docker container inspect "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then PREVIOUS_CONTAINER_SAVED=1; fi
    local image
    if ! image="$(docker container inspect --format '{{.Image}}' mixin-chatbot 2>/dev/null)"; then
        print_error "上次操作的数据已经提交，但新容器 mixin-chatbot 不存在；请用 docker ps -a 检查后处理，不能回滚"
        exit 1
    fi
    [ "$image" = "$IMAGE_ID" ] || {
        print_error "上次操作的数据已经提交，但容器 mixin-chatbot 使用的镜像 ${image} 不是记录的候选镜像 ${IMAGE_ID}；请用 docker ps -a 检查后处理，不能回滚"
        exit 1
    }
    print_status "上次操作的数据已经提交：启动新实例，不再迁移或重建"
    docker stop --time 30 mixin-chatbot >/dev/null
    commit_deployment
    activate_committed_deployment
    if [ "${DEPLOY_PRESERVE_STOPPED:-0}" = 1 ] && [ "$PREVIOUS_RUNNING" = 0 ]; then
        print_success "上次操作已完成，机器人服务保持停止（操作前未运行）"
    else
        print_success "上次操作已完成，机器人已启动"
    fi
    exit 0
}

# 普通部署读取的环境变量，只在没有未完成的事务时校验。续做和回滚只使用事务记录和已保存的 runtime.json，
# 新终端里的这些变量既不能挡住恢复，也不会被采用。
check_deploy_environment() {
    local active="${BOT_MAX_ACTIVE_REQUESTS:-32}"
    if ! [[ "$active" =~ ^[0-9]+$ ]] || [ "$active" -lt 1 ] || [ "$active" -gt 1000 ]; then
        print_error 'BOT_MAX_ACTIVE_REQUESTS 必须是 1–1000 的整数'
        exit 1
    fi
}

# 新部署的服务身份，在停机和任何改动之前确定：有原容器就沿用它的数值 UID:GID（不因改由 root 部署而迁移到 1001，
# 也不改已有数据的属主）；真正的首次部署用默认身份；原容器不在但已部署过时身份不明，显示 data/state 的属主请操作者
# 确认，不猜测。
determine_service_user() {
    local status=0 proposed
    original_service_container || status=$?
    if [ "$status" = 0 ]; then
        service_user_from_container "$DOCKER_ROOTLESS" ||
            { print_error "无法可靠确定原服务的运行身份（原因见上方）；部署已停止，服务和数据未改动"; return 1; }
        print_status "沿用原容器的运行身份 ${SERVICE_USER}"
        return 0
    fi
    [ "$status" = 2 ] || { print_error "无法读取原容器（原因见上方）；部署已停止，服务和数据未改动"; return 1; }
    if docker container inspect mixin-chatbot-rollback >/dev/null 2>&1; then
        print_error "发现旧回滚容器 mixin-chatbot-rollback，请先确认其状态"
        return 1
    fi
    if ! deployment_recorded; then
        SERVICE_USER="$(default_service_user "$DOCKER_ROOTLESS")"
        SERVICE_USER_SOURCE=default
        return 0
    fi
    proposed="$(service_user_from_data "$DOCKER_ROOTLESS")" ||
        { print_error "找不到原容器 mixin-chatbot，也无法按 data/state 的属主确定服务身份（原因见上方）；部署已停止，服务和数据未改动"; return 1; }
    print_warning "找不到原容器 mixin-chatbot，无法读取服务原来的运行身份；按 data/state 的属主，服务应以 ${proposed} 运行"
    if ! ask_yes_no "确认服务以 ${proposed} 运行（已有数据的属主不变）？[y/N]：" n; then
        print_error "未确认服务的运行身份；部署已取消，服务和数据未改动"
        return 1
    fi
    SERVICE_USER="$proposed"
    SERVICE_USER_SOURCE=confirmed
}

# 独立部署从工作区构建本次镜像：构建前检查磁盘空间，构建后按 image ID 固定（来源记为 workspace），之后的预检、迁移、
# 验证实例和正式实例都用这个 ID；正式标签 mixin-chatbot 到数据提交后才指向它。失败或中断时只移除本次的保留标签。
build_workspace_candidate() {
    local previous head status=0 path paths=()
    previous="$(docker container inspect --format '{{.Image}}' mixin-chatbot 2>/dev/null)" || previous=''
    for path in "$DATA_DIR" "$PROJECT_DIR/backup"; do [ ! -e "$path" ] || paths+=("$path"); done
    print_status "检查构建所需的磁盘空间..."
    check_build_disk_space "$previous" "${paths[@]}" ||
        { print_error "磁盘空间不足或无法确认镜像存储位置（原因见上方）；服务尚未停止，未做任何改动"; exit 1; }
    head="$(git -C "$PROJECT_DIR" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null)" || head=''
    trap release_before_pointer EXIT
    print_status "构建 Docker 镜像..."
    prepare_candidate_image "$PROJECT_DIR" "$head" workspace "$PROJECT_DIR" || status=$?
    if [ "$status" != 0 ]; then
        if [ "$status" -ge 128 ]; then print_warning "镜像构建已中断；服务尚未停止，未做任何改动"
        else print_error "镜像构建失败（原因见上方）；服务尚未停止，未做任何改动"; status=1; fi
        exit "$status"
    fi
    IMAGE_ID="${CANDIDATE[image_id]}"
    print_success "镜像构建成功：${IMAGE_ID}"
}

# 事务指针发布之前的失败、取消或中断（从构建开始）只移除本次的保留标签；指针发布后由事务的提交或回滚处理。
# 移除在独立的进程组中进行（run_shielded），收尾期间再来的中断打断不了它。
release_before_pointer() {
    local status=$?
    trap - EXIT
    trap : INT TERM HUP
    [ -e "$STATE_DIR/deploy-transaction" ] || run_shielded release_transaction_candidate || true
    operation_finish "$status"
}

# ---- 前置检查 ----

print_status "检查运行环境..."

if ! docker info > /dev/null 2>&1; then
    print_error "无法连接 Docker，请确保 Docker 已安装且当前用户有权限"
    echo "  rootful Docker 请用 root 运行部署；rootless Docker 请以运行它的用户部署"
    exit 1
fi
# rootful Docker 要求 root，rootless Docker 要求它所属的普通用户（设置 DOCKER_ROOTLESS）；在任何提问之前。
# rootless 下容器里的 root 就是宿主机上的部署用户，host 网络只是 rootlesskit 的命名空间。
require_deploy_operator deploy || exit 1

required_files=("package.json" "src/server/index.ts" "scripts/config/configure.ts")
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        print_error "缺少必要文件: $file"
        exit 1
    fi
done

print_success "环境检查通过"

# ---- 目录 + 监听端口 ----

command -v flock >/dev/null || { print_error "需要 util-linux flock"; exit 1; }
acquire_deploy_lock || { print_error "另一个部署或升级正在进行"; exit 1; }
# 先处理未完成的事务，再读取普通部署设置：续做和回滚只使用事务记录，不重新读取默认值或环境变量。
ORIGINAL_WORKSPACE_ROOT="$(saved_workspace_root)"
if [ -e "$STATE_DIR/deploy-transaction" ]; then
    load_pending_transaction || { print_error "未完成部署的事务记录无法读取（原因见上方）；保持现状，请人工检查 backup/snapshots"; exit 1; }
    print_warning "$(describe_pending_transaction)"
    # 升级的继续和回滚还要切换或恢复代码，由升级器处理；部署脚本只执行升级器或运维入口转交的明确动作。
    if [ -z "$TRANSACTION_ACTION" ] && [ "${TRANSACTION[operation]}" = upgrade ]; then
        print_error "未完成的是升级：继续或回滚还需要切换或恢复代码，请使用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"
        exit 1
    fi
    # 数据、配置和容器已经回滚、只剩代码待恢复的升级由升级器完成，这里不再重复回滚或继续。
    if transaction_code_restore_pending; then
        print_error "上次升级只剩代码待恢复；请使用 $(ops_command_hint rollback) 完成回滚"
        exit 1
    fi
    # 先读记录的镜像和服务身份，再做 committed 检查、回滚或任何运行容器的操作。
    load_transaction_runtime || exit 1
    if [ -z "$TRANSACTION_ACTION" ]; then
        if [ -t 0 ]; then
            choose_transaction_action
        else
            print_error "发现未完成的部署；请使用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"
            exit 1
        fi
    fi
    if [ "$TRANSACTION_ACTION" = continue ] && [ "$CANDIDATE_PRESENT" = 0 ]; then
        print_error "继续需要记录的候选镜像 ${IMAGE_ID}，但它已不存在；请恢复完全相同的镜像（同一 image ID）后重试，重新构建的镜像不能代替。本次操作尚未开始迁移时也可以用 $(ops_command_hint rollback) 回滚"
        exit 1
    fi
    # 容器以记录的身份写入本次操作日志（由部署用户创建）。
    grant_operation_log_access || true
    RECORDED=1
    [ "$TRANSACTION_ACTION" != rollback ] || rollback_pending_deployment
    if [ -n "${TRANSACTION[target_sha]}" ] && [ "$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)" != "${TRANSACTION[target_sha]}" ]; then
        print_error "当前代码不是上次操作的目标提交 ${TRANSACTION[target_sha]:0:7}；请切回该提交后继续，或回滚"
        exit 1
    fi
    # 挂载缺失时明确停止：Docker 会把不存在的挂载源建成 root 所有的空目录。
    HOST_WORKSPACE_ROOT="${TRANSACTION[target_workspace_root]}"
    [ -z "$HOST_WORKSPACE_ROOT" ] || [ -d "$HOST_WORKSPACE_ROOT" ] || {
        print_error "事务记录的共享资料目录不存在：$HOST_WORKSPACE_ROOT；请恢复挂载后重试继续，或回滚"; exit 1; }
    BOT_PORT="${TRANSACTION[bot_port]}"
    # 运行参数沿用 runtime.json；当前终端的环境变量不校验，也不写入。
    unset "${RUNTIME_ENV_KEYS[@]}"
    # 升级沿用原运行状态；部署完成后总是启动。
    [ "${TRANSACTION[operation]}" != upgrade ] || DEPLOY_PRESERVE_STOPPED=1
    workspace_mount "$HOST_WORKSPACE_ROOT"
    if [ -e "$STATE_DIR/release-data.json" ] && data_preparation_docker committed --deployment "${TRANSACTION[snapshot]}"; then
        finish_committed_transaction
    fi
    print_status "继续上次操作：端口和共享资料目录取自事务记录，运行参数沿用 runtime.json"
elif [ -n "$TRANSACTION_ACTION" ]; then
    print_success "没有未完成的部署或升级"
    exit 0
else
    check_deploy_environment
    determine_service_user || exit 1
    grant_operation_log_access || true
fi
print_warning "转换数据前先预览；应用变更时保持停机，提交前失败恢复数据、配置和原运行状态。"
# 容器挂载的目录都先由部署脚本创建：不存在的 bind mount 源会被 Docker 以 root 身份创建，服务身份随后无法在其中写入
# （全新克隆没有 backup/）。snapshots/ 和 rm/ 也在这里建好：成功的部署会删掉空的 snapshots/，迁移容器要在其中写备份。
# 只有本次新建的目录交给服务身份，已有目录和数据的属主不变。
make_service_directories "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_HOME_DIR" "$LOG_DIR" "$PROJECT_DIR/backup/snapshots" "$PROJECT_DIR/backup/rm" ||
    { print_error "无法创建数据目录"; exit 1; }
# 本机管理端口不再询问：续做用事务记录，其余依次取显式 BOT_PORT（高级覆盖）、已保存端口、默认 1011。
# rootless Docker 通常不能发布 1024 以下的端口（见 rootless_port_publishable），这时默认改用 11011。
# 无效、发布不了或被其他程序占用的端口在停机前停止并说明改法，不自动换成别的端口。
FALLBACK_PORT=1011
if [ "$DOCKER_ROOTLESS" = 1 ] && ! rootless_port_publishable "$FALLBACK_PORT"; then FALLBACK_PORT=11011; fi
SAVED_PORT=""
[ ! -f "$BOT_PORT_FILE" ] || SAVED_PORT="$(tr -d '[:space:]' < "$BOT_PORT_FILE")"
if [ "$RECORDED" = 1 ]; then
    PORT_SOURCE="事务记录"
elif [ -n "$(trim_input "${BOT_PORT:-}")" ]; then
    PORT_SOURCE="BOT_PORT"
    BOT_PORT="$(trim_input "$BOT_PORT")"
elif [ -f "$BOT_PORT_FILE" ]; then
    PORT_SOURCE="data/state/bot-port"
    BOT_PORT="$SAVED_PORT"
else
    PORT_SOURCE=""
    BOT_PORT="$FALLBACK_PORT"
fi
if [ "$RECORDED" = 1 ]; then
    PORT_FIX="续做沿用事务记录的端口 ${BOT_PORT}：放开低端口后重试继续，或用 $(ops_command_hint rollback) 回滚后再设置 BOT_PORT 重新部署改端口"
else
    PORT_FIX="改端口：设置环境变量 BOT_PORT=<端口> 后重新部署（$(ops_command_hint deploy)）；服务尚未停止"
fi
if ! [[ "$BOT_PORT" =~ ^[0-9]+$ ]] || [ "$BOT_PORT" -lt 1 ] || [ "$BOT_PORT" -gt 65535 ]; then
    print_error "${PORT_SOURCE} 中的端口无效（应为 1–65535 的整数）：${BOT_PORT}；${PORT_FIX}"
    exit 1
fi
if [ "$DOCKER_ROOTLESS" = 1 ] && ! rootless_port_publishable "$BOT_PORT"; then
    print_error "$(rootless_port_hint "$BOT_PORT")"
    print_error "$PORT_FIX"
    exit 1
fi
# 沿用的端口可能正由原服务监听，不探测；新端口（含首次部署）要先确认没有其他程序占用。
if [ "$RECORDED" != 1 ] && [ "$BOT_PORT" != "$SAVED_PORT" ] && local_port_in_use "$BOT_PORT"; then
    print_error "本机端口 ${BOT_PORT} 已被其他程序占用；${PORT_FIX}"
    exit 1
fi
print_success "本机管理端口：127.0.0.1:$BOT_PORT${PORT_SOURCE:+（来自 ${PORT_SOURCE}）}"

# ---- 共享资料目录（WORKSPACE_ROOT；默认 data/workspace）----
# 续做沿用事务记录；否则取 WORKSPACE_ROOT 环境变量（设为空恢复默认），未设置时沿用已保存设置。
# 外置目录必须已存在：只读挂到容器 /app/workspace，部署不创建、不改属主；服务身份需能读取其中的资料。
if [ "$RECORDED" != 1 ]; then
    HOST_WORKSPACE_ROOT="$(trim_input "${WORKSPACE_ROOT-$ORIGINAL_WORKSPACE_ROOT}")"
    if [ -n "$HOST_WORKSPACE_ROOT" ]; then
        if ! HOST_WORKSPACE_ROOT="$(realpath -e -- "$HOST_WORKSPACE_ROOT" 2>/dev/null)" || [ ! -d "$HOST_WORKSPACE_ROOT" ]; then
            print_error "WORKSPACE_ROOT 不存在或不是目录：${WORKSPACE_ROOT-$ORIGINAL_WORKSPACE_ROOT}；服务尚未停止"
            exit 1
        fi
    fi
fi
workspace_mount "$HOST_WORKSPACE_ROOT"
print_status "共享资料目录：${HOST_WORKSPACE_ROOT:-$DATA_DIR/workspace}${HOST_WORKSPACE_ROOT:+（只读挂到容器 /app/workspace）}"
echo ""

# ---- 目录 ----

# 真正的首次部署沿用原有做法：root 部署把刚建立的目录整体交给默认身份 appuser(1001)。data/ 只交出本身（不递归）：
# 任务隔离预检以服务身份在其顶层建文件，data/ 可能在部署前已由 root 建立。沿用原容器身份时不批量改属主，
# 已有数据本来就属于这个身份，本次新建的目录已在创建时交出。
prepare_service_directories() {
    if [ "$SERVICE_USER_SOURCE" = default ] && [ "$(id -u)" -eq 0 ]; then
        chown -R "$SERVICE_USER" "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_DIR" "$LOG_DIR" "$PROJECT_DIR/backup" || return 1
        chown "$SERVICE_USER" "$DATA_DIR" || return 1
    fi
    chmod 755 "$DATA_DIR" "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_DIR" "$RUNTIME_HOME_DIR" "$LOG_DIR"
}

print_status "设置目录权限..."
prepare_service_directories
print_success "目录就绪（服务身份 ${SERVICE_USER}）"

# ---- 构建镜像 ----

if [ "$RECORDED" = 1 ]; then
    # 续做只用事务记录的镜像：不重新构建或拉取。
    print_status "沿用事务记录的镜像 ${IMAGE_ID}，不重新构建"
else
    build_workspace_candidate
fi

verify_container_storage() {
    docker run --rm \
      --user "$SERVICE_USER" \
      -e HOME=/app/data/runtime/home \
      "${WORKSPACE_ARGS[@]}" \
      -v "$(pwd)/logs:/app/logs" \
      -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" \
      --entrypoint sh \
      "$IMAGE_ID" \
      -c 'for directory in /app/data /app/data/config /app/data/state /app/data/runtime /app/data/runtime/home /app/logs; do
              [ -d "$directory" ] && [ -w "$directory" ] || { echo "容器用户不可写: $directory" >&2; exit 1; }
          done
          [ -z "${WORKSPACE_ROOT:-}" ] || { [ -d "$WORKSPACE_ROOT" ] && [ -r "$WORKSPACE_ROOT" ] && [ -x "$WORKSPACE_ROOT" ]; } ||
              { echo "容器用户不可读: $WORKSPACE_ROOT" >&2; exit 1; }
          for file in /app/data/config/models.json /app/data/runtime/pi/settings.json /app/data/config/app-bot.json; do
              [ ! -e "$file" ] || { [ -r "$file" ] && [ -w "$file" ]; } || { echo "容器用户不可读写: $file" >&2; exit 1; }
          done'
}

print_status "验证容器用户对持久化目录的权限..."
if ! verify_container_storage; then
    print_error "服务身份（${SERVICE_USER}）无法读写持久化目录；服务尚未停止"
    echo "  部署沿用原容器的运行身份，不批量改已有数据的属主；请让 data/、logs/ 可被该身份读写、外置资料目录可被它读取后重试。"
    exit 1
fi
print_success "持久化目录权限正常"

print_status "验证任务隔离、固定镜像与宿主目录映射..."
task_runtime_prepare || { print_error "任务隔离预检失败，原服务未因本次预检停止"; exit 1; }

print_status "按宿主路径核对共享资料目录的边界..."
check_workspace_layout || { print_error "共享资料目录不能使用（原因见上方）；服务尚未停止"; exit 1; }

# 数据版本在停机前核对：有数据但没有有效版本标记（含旧版 webhook 数据）时拒绝，原服务不受影响。
if [ "$RECORDED" = 0 ]; then
    data_preparation_docker check || { print_error "数据版本核对未通过（原因见上方）；服务尚未停止"; exit 1; }
fi
DATA_PREPARATION_PLANNED=0
if [ "$RECORDED" = 1 ] && [ -f "$TRANSACTION_SNAPSHOT/data-plan.json" ]; then
    # 续做沿用停机前的数据预检计划；apply 会重新核对版本标记，变化即中止。
    # 快照目录仅部署用户可读，计划复制回容器可读的状态目录。
    cp -- "$TRANSACTION_SNAPSHOT/data-plan.json" "$STATE_DIR/data-plan.json" || { print_error "无法恢复停机前的数据预检计划"; exit 1; }
    # root 复制出的文件属 root；数据准备容器以服务身份读取它。
    grant_service_access "$STATE_DIR/data-plan.json"
    DATA_PREPARATION_PLANNED=1
elif [ -f "$MODELS_FILE" ] && [ -f "$RUNTIME_DIR/pi/settings.json" ]; then
    if ! data_preparation_docker preview --plan "$DATA_PREPARATION_PLAN"; then
        if [ "$RECORDED" = 1 ]; then print_error "续做无法沿用数据预检（原因见上方）；$(settings_fixed_hint)"; fi
        exit 1
    fi
    DATA_PREPARATION_PLANNED=1
fi
# ---- 停机前的交互选择：只读取和校验，全部答完才停止机器人服务 ----
RECONFIGURE_AI=0
if [ "$RECORDED" = 1 ]; then
    # 配置向导需要交互；续做从不运行向导，缺少模型配置时停止。
    if [ ! -f "$MODELS_FILE" ] || [ ! -f "$APP_BOT_FILE" ]; then
        print_error "缺少 data/config/models.json 或 data/config/app-bot.json；$(settings_fixed_hint)"
        exit 1
    fi
    print_status "续做沿用现有 AI 配置"
    if [ "${TRANSACTION[reconfigure_ai]}" = 1 ]; then print_warning "上次选择的 AI 重新配置不会在续做中运行；需要时请在部署完成后重新部署修改"; fi
elif [ -f "$MODELS_FILE" ]; then
    print_status "检测到已有 data/config/models.json"
    if ask_yes_no "是否重新配置 AI（provider/key/model）？[y/N]：" "n"; then
        RECONFIGURE_AI=1
        print_status "将在停止机器人服务后运行 AI 配置向导"
    fi
fi

# Decisions precede persistent changes; a continued transaction reopens its original snapshot.
if [ "$RECORDED" != 1 ]; then
    print_status "停机前复核剩余空间..."
    check_stop_disk_space "$DATA_DIR" ||
        { print_error "剩余空间不够写入停机后的快照（原因见上方）；服务尚未停止，未做任何改动"; exit 1; }
fi
begin_deployment
if [ ! -f "$DEPLOY_SNAPSHOT/task-runtime" ]; then task_runtime_record "$DEPLOY_SNAPSHOT/task-runtime"; fi
if [ "$DATA_PREPARATION_PLANNED" = 1 ]; then
    # The upgrader keeps the target code on this receipt after abrupt termination;
    # a completed rollback clears it before the upgrader restores the original code.
    if [ -n "${BOT_UPDATE_COMMIT_FILE:-}" ]; then printf 'committed\n' > "$BOT_UPDATE_COMMIT_FILE"; fi
    DATA_PREPARATION_APPLY_ATTEMPTED=1
    data_preparation_docker apply --plan "$DATA_PREPARATION_PLAN"
fi

# ---- 应用机器人凭据与 AI 配置（容器内向导写 data/config/app-bot.json 和 models.json）----
# 首次必须配置（configure 缺应用机器人配置时先问它）；已存在时按停机前的选择决定是否重配 AI。

if [ ! -f "$MODELS_FILE" ]; then
    print_status "首次配置应用机器人凭据和 AI（provider/key/model）..."
    if ! docker run --rm -it --user "$SERVICE_USER" -e HOME=/app/data/runtime/home -e BOT_DEPLOY_BACKUP_ID -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" "$IMAGE_ID" bun run configure; then
        print_error "配置命令执行失败"
        exit 1
    fi
    if [ ! -f "$MODELS_FILE" ]; then
        print_error "未生成 data/config/models.json，已中止"
        exit 1
    fi
elif [ ! -f "$APP_BOT_FILE" ]; then
    print_status "配置应用机器人凭据（AppID/AppSecret）..."
    if ! docker run --rm -it --user "$SERVICE_USER" -e HOME=/app/data/runtime/home -e BOT_DEPLOY_BACKUP_ID -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" "$IMAGE_ID" bun run configure-app-bot; then
        print_error "应用机器人配置命令执行失败"
        exit 1
    fi
fi
if [ "$RECONFIGURE_AI" = 1 ]; then
    print_status "重新配置 AI（provider/key/model）..."
    if ! docker run --rm -it --user "$SERVICE_USER" -e HOME=/app/data/runtime/home -e BOT_DEPLOY_BACKUP_ID -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" "$IMAGE_ID" bun run configure; then
        print_error "AI 配置命令执行失败"
        exit 1
    fi
fi
validate_model_configuration "$IMAGE_ID" "$SERVICE_USER" || { print_error "模型配置无效，正在恢复原部署"; exit 1; }
grant_service_access "$MODELS_FILE"
chmod 600 "$MODELS_FILE"
if [ ! -f "$APP_BOT_FILE" ]; then
    print_error "未生成 data/config/app-bot.json（应用机器人凭据），正在恢复原部署"
    exit 1
fi
grant_service_access "$APP_BOT_FILE"
chmod 600 "$APP_BOT_FILE"
if ! verify_container_storage; then
    print_error "models.json 或 app-bot.json 对服务身份（${SERVICE_USER}）不可读写；请修复目录/文件权限后重试"
    exit 1
fi

# 旧容器和配置已在 begin_deployment 中保存。

if [ "$DATA_PREPARATION_PLANNED" = 0 ]; then
    data_preparation_docker preview --plan "$DATA_PREPARATION_PLAN"
    if [ -n "${BOT_UPDATE_COMMIT_FILE:-}" ]; then printf 'committed\n' > "$BOT_UPDATE_COMMIT_FILE"; fi
    DATA_PREPARATION_APPLY_ATTEMPTED=1
    data_preparation_docker apply --plan "$DATA_PREPARATION_PLAN"
fi
# The scheduled/container entry reads this flag; readiness cannot accept messages.
printf 'verify\n' > "$PROJECT_DIR/data/state/verify-only"

# 持久化受支持的显式环境配置；容器路径由部署计算，其他值沿用 runtime.json。
runtime_env_args=()
for runtime_key in "${RUNTIME_ENV_KEYS[@]}"; do
    if [ -n "${!runtime_key:-}" ]; then runtime_env_args+=(-e "$runtime_key"); fi
done
docker run --rm --user "$SERVICE_USER" \
  -e BOT_PORT="$BOT_PORT" -e BOT_HOST="$BOT_HOST" \
  -e BOT_DEPLOY_BACKUP_ID "${runtime_env_args[@]}" -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" \
  "$IMAGE_ID" bun run scripts/config/runtime-settings.ts

# ---- 启动容器 ----

task_runtime_manifest write
task_runtime_record "$STATE_DIR/task-runtime"
grant_service_access "$STATE_DIR/task-runtime"
print_status "启动容器..."
# rootless Docker 的 host 网络是独立的命名空间，宿主机上的 TUI 和健康检查连不到容器的回环地址：
# 改为只把端口发布到宿主机 127.0.0.1，容器内监听所有接口（BOT_CONTAINER_BIND_ALL，不来自用户配置）。
network_args=(--network host)
if [ "$DOCKER_ROOTLESS" = 1 ]; then
    network_args=(-p "127.0.0.1:$BOT_PORT:$BOT_PORT" -e BOT_CONTAINER_BIND_ALL=1)
fi
NEW_CONTAINER_ATTEMPTED=1
if docker run -d \
  --init \
  --user "$SERVICE_USER" \
  "${TASK_RUNTIME_ARGS[@]}" \
  "${network_args[@]}" \
  -e HOME=/app/data/runtime/home \
  -e BOT_PORT="$BOT_PORT" \
  -e BOT_HOST="$BOT_HOST" \
  "${WORKSPACE_ARGS[@]}" \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" \
  --restart unless-stopped \
  --stop-timeout 30 \
  --name mixin-chatbot \
  --memory="512m" \
  --memory-swap="768m" \
  --cpus="1.0" \
  --pids-limit=256 \
  --read-only \
  --tmpfs /tmp:size=64m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --log-driver json-file \
  --log-opt max-size=5m \
  --log-opt max-file=2 \
  "$IMAGE_ID"; then
    print_success "容器启动成功"
else
    print_error "容器启动失败"
    docker logs mixin-chatbot 2>/dev/null
    exit 1
fi

# ---- 等待健康检查 ----

print_status "等待部署预检通过..."
for i in $(seq 1 18); do
    if docker exec mixin-chatbot bun run scripts/ops/health-check.ts --allow-verification; then
        print_success "部署预检通过"
        break
    fi
    if [ "$(docker container inspect --format='{{.State.Running}}' mixin-chatbot 2>/dev/null || echo false)" != true ]; then
        print_error "部署预检失败，请查看日志: $(ops_command_hint logs)"
        docker logs --tail 50 mixin-chatbot 2>&1 || true
        exit 1
    fi
    if [ $i -eq 18 ]; then
        print_error "部署预检超时（90s），请查看日志: $(ops_command_hint logs)"
        docker logs --tail 50 mixin-chatbot 2>&1 || true
        exit 1
    fi
    sleep 5
done

# 只有部署预检通过后才提交状态，避免运维脚本读取到半完成配置。
print_status "提交部署..."
printf '%s' "$BOT_PORT" > "$BOT_PORT_FILE"
printf '%s' "$HOST_WORKSPACE_ROOT" > "$WORKSPACE_ROOT_FILE"

# Stop the verification-only process before committing. Normal work starts after commit.
docker stop --time 30 mixin-chatbot >/dev/null
# 预检之后资料目录可能被替换或改挂：提交前按宿主路径再核对一次，失败时按未提交的事务回滚。
check_workspace_layout || { print_error "共享资料目录在预检后发生变化（原因见上方），部署未提交，正在恢复原部署"; exit 1; }
data_preparation_docker commit
commit_deployment
activate_committed_deployment

# ---- 输出信息 ----

if [ "${DEPLOY_PRESERVE_STOPPED:-0}" = 1 ] && [ "$PREVIOUS_RUNNING" = 0 ]; then
    print_success '升级完成，已恢复原停止状态。'
elif docker ps --format '{{.Names}}' | grep -q '^mixin-chatbot$'; then
    print_success "机器人已启动"

    echo ""
    echo "=========================================="
    echo "  量子密信群聊协作机器人部署完成"
    echo "=========================================="
    echo ""
    echo "  消息接收:  平台事件 Stream（主动连出，不需要入站端口；出站需访问 imtwo.zdxlz.com、imfl.zdxlz.com 的 443）"
    echo "  应用凭据:  $(pwd)/data/config/app-bot.json（改凭据：$(ops_command_hint configure-app-bot)）"
    echo "  AI 配置:   $(pwd)/data/config/models.json"
    echo "  日志:      $(pwd)/logs/"
    echo "  数据:      $(pwd)/data/"
    echo "  共享资料:  ${HOST_WORKSPACE_ROOT:-$(pwd)/data/workspace}"
    echo "  可选外链:  bun run tui → 系统 → 设置 → 外链配置"
    echo "  本机管理:  $BOT_HOST:$BOT_PORT"
    echo ""
    echo "  内存限制: 512MB | CPU: 1核"
    echo ""
    echo "  常用操作（带健康检查和失败回滚）:"
    echo "    体检: $(ops_command_hint doctor)"
    echo "    日志: $(ops_command_hint logs)"
    echo "    重启: $(ops_command_hint restart)"
    echo "    升级: $(ops_command_hint update)（沿用现有配置，停机前完成全部确认；改配置请重新部署）"
    echo ""
    if [ "${MIXIN_OPS_TUI:-}" != "1" ]; then
        echo "  底层命令（ops.sh 不适用时排障用）:"
        echo "    docker logs -f mixin-chatbot                         # 容器层日志"
        echo "    docker restart mixin-chatbot                         # 直接重启容器"
        echo "    bash scripts/deploy/deploy.sh                        # 重配 AI 并验证新实例，失败回滚"
        echo ""
    fi

    print_status "最近日志:"
    docker logs --tail 10 mixin-chatbot 2>&1
else
    print_error "服务启动失败"
    docker logs mixin-chatbot 2>&1
    exit 1
fi
