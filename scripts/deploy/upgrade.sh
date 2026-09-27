#!/usr/bin/env bash
# 目标版本升级器（Linux / Docker）。ops.sh update 把它连同共用脚本从目标提交导出到 tmp/upgrade-*
# （见 UPGRADER_EXPORT_PATHS）后运行；它不在工作区内执行，切换代码不会改动正在运行的脚本。
#
# 新升级：停机前完成全部确认——预检、未托管 connector 的归属和缺失的隧道 token、在目标版本 Dockerfile 的
# Bun 基础镜像中只读预览迁移——再写入事务记录并把迁移计划存入快照；随后停机、切换代码，交给目标版本的
# deploy.sh 按记录继续，标准输入接 /dev/null，执行阶段不再交互。提交前失败自动回滚数据、配置、容器和代码。
# 未完成的升级：按事务记录继续或回滚，不重新询问。
#
# 用法：bash <导出目录>/scripts/deploy/upgrade.sh <项目目录> <目标提交> [continue|rollback]
set -euo pipefail
UPGRADER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "用法：bash <导出目录>/scripts/deploy/upgrade.sh <项目目录> <目标提交> [continue|rollback]" >&2
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
cd "$PROJECT_DIR"
DATA_DIR="$PROJECT_DIR/data"
CONFIG_DIR="$DATA_DIR/config"
STATE_DIR="$DATA_DIR/state"
DEFAULT_GROUP_DATA_ROOT="$DATA_DIR/groups"
MODELS_FILE="$CONFIG_DIR/models.json"
LOG_DIR="$PROJECT_DIR/logs"
TUNNEL_PID_FILE="$STATE_DIR/cloudflared.pid"
PENDING_POINTER="$STATE_DIR/deploy-transaction"
if [ "$(id -u)" -eq 0 ]; then
    CONTAINER_UID=1001
    CONTAINER_GID=1001
else
    # 与 deploy.sh 相同：普通 Docker 用户由容器沿用当前 UID/GID；rootless Docker 下是容器里的 root，连上 Docker 后判定。
    CONTAINER_UID="$(id -u)"
    CONTAINER_GID="$(id -g)"
fi
ORIGINAL_SHA=''
ORIGINAL_BRANCH=''
TARGET_SHA=''
TUNNEL_INPUT=''
DEPLOY_PID=''
PREVIEW_PID=''
PREVIEW_CONTAINER=''
DEPLOY_STATUS=0
DEPLOY_RECEIPT="$UPGRADER_DIR/commit-receipt"
INTERRUPTED=0

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

# 未完成的升级只能继续或回滚；非交互调用必须明确指定。只剩代码待恢复时只能完成回滚。
choose_pending_action() {
    local choice menu='1 继续上次操作  2 回滚到操作前  0 退出 [默认 0]：' restore_only=0
    if transaction_code_restore_pending; then restore_only=1; menu='2 完成回滚（只恢复代码）  0 退出 [默认 0]：'; fi
    if [ ! -t 0 ]; then
        if [ "$restore_only" = 1 ]; then print_error "上次升级只剩代码待恢复；请使用 $(ops_command_hint rollback) 完成回滚"
        else print_error "发现未完成的升级；请使用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"; fi
        exit 1
    fi
    while true; do
        IFS= read -r -p "$menu" choice || choice=0
        case "$(printf '%s' "$choice" | tr -d '[:space:]')" in
            1) if [ "$restore_only" = 1 ]; then print_warning '数据、配置和容器已经回滚，不能继续；请输入 2 或 0'; else ACTION=continue; return; fi ;;
            2) ACTION=rollback; return ;;
            ''|0) print_warning '未处理上次操作，服务保持当前状态'; exit 1 ;;
            *) print_warning '请输入 1、2 或 0' ;;
        esac
    done
}

checkout_target() {
    operation_stage checkout
    operation_capture_quiet git_here checkout --quiet main || return 1
    operation_capture_quiet git_here merge --ff-only --quiet "$TARGET_SHA" || return 1
    [ "$(git_here rev-parse HEAD)" = "$TARGET_SHA" ]
}

# 数据、配置、容器和原运行状态已由部署脚本恢复（事务处于“待恢复代码”阶段），再恢复升级前的代码。
# 代码恢复后才清除事务指针；失败或工作区有人工改动时保留该阶段，处理后重试回滚只恢复代码。
complete_code_restore() {
    if [ "$(git_here rev-parse HEAD 2>/dev/null)" != "$ORIGINAL_SHA" ]; then
        operation_stage rollback-code
        code_restore_safe "$ORIGINAL_BRANCH" "$ORIGINAL_SHA" "$TARGET_SHA" || {
            print_error "代码没有恢复：升级后的工作区改动（见上方）会被覆盖；数据、配置和原运行状态已恢复。把改动提交到其他分支、备份或撤销后运行 $(ops_command_hint rollback)，只恢复代码"
            exit 1
        }
        restore_checkout "$ORIGINAL_BRANCH" "$ORIGINAL_SHA" || {
            print_error "代码未能恢复到升级前的 ${ORIGINAL_SHA:0:7}（原因见上方）；数据、配置和原运行状态已恢复。处理 git 问题（如残留的 .git/index.lock）后运行 $(ops_command_hint rollback)，只恢复代码"
            exit 1
        }
    fi
    rm -f -- "$PENDING_POINTER" || { print_error "代码已恢复，但事务指针 ${PENDING_POINTER} 清除失败；请重试 $(ops_command_hint rollback)"; exit 1; }
}

forward_signal() {
    [ -z "$DEPLOY_PID" ] || kill -TERM "$DEPLOY_PID" 2>/dev/null || true
}

# 交给工作区（目标版本）的部署脚本按事务记录执行。它在后台运行以便转发中断：收到 TERM 后由它自行回滚。
# 隧道 token 只经子进程环境交接，交接标记（快照名）只在同一次升级中传入。
run_deploy() {
    local action="$1" handoff="${2:-}"
    : > "$DEPLOY_RECEIPT"
    INTERRUPTED=0
    trap 'INTERRUPTED=130; forward_signal' INT
    trap 'INTERRUPTED=143; forward_signal' TERM
    DEPLOY_TRANSACTION_ACTION="$action" DEPLOY_TRANSACTION_HANDOFF="$handoff" DEPLOY_TUNNEL_TOKEN_INPUT="$TUNNEL_INPUT" \
        BOT_UPDATE_COMMIT_FILE="$DEPLOY_RECEIPT" bash "$PROJECT_DIR/scripts/deploy/deploy.sh" </dev/null &
    DEPLOY_PID=$!
    TUNNEL_INPUT=''
    # 部署脚本已接手事务：之后的失败由它回滚，升级器只按结果处理代码。
    trap 'operation_finish "$?"' EXIT
    [ "$INTERRUPTED" = 0 ] || forward_signal
    while :; do
        if wait "$DEPLOY_PID"; then DEPLOY_STATUS=0; else DEPLOY_STATUS=$?; fi
        kill -0 "$DEPLOY_PID" 2>/dev/null || break
    done
    DEPLOY_PID=''
}

receipt_committed() { [ "$(cat "$DEPLOY_RECEIPT" 2>/dev/null)" = committed ]; }

# 部署脚本结束后按事务状态收尾：事务仍在则保留目标代码并说明下一步；已提交则保留新版本；
# 数据等已回滚（只剩代码待恢复）则恢复升级前的代码。同一次升级失败且数据未提交时先自动回滚。
finish_after_deploy() {
    local mode="$1" code=1
    [ "$INTERRUPTED" = 0 ] || code="$INTERRUPTED"
    if [ "$mode" != rollback ] && [ "$DEPLOY_STATUS" = 0 ]; then
        print_success "升级完成：${ORIGINAL_SHA:0:7} -> ${TARGET_SHA:0:7}"
        exit 0
    fi
    if [ "$mode" = fresh ] && [ -e "$PENDING_POINTER" ] && ! transaction_code_restore_pending && ! receipt_committed; then
        print_warning "升级未完成（原因见上方），正在回滚到升级前的版本..."
        run_deploy rollback
        mode=failed-rollback
    fi
    if [ -e "$PENDING_POINTER" ] && ! transaction_code_restore_pending; then
        if [ "$mode" = continue ]; then
            print_error "升级未完成（原因见上方）；保留目标代码和停机状态。处理后可用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"
        else
            print_error "升级未能回滚（原因见上方）；保留目标代码和停机状态。处理后可重试 $(ops_command_hint rollback)；数据已提交时只能 $(ops_command_hint resume)"
        fi
        exit "$code"
    fi
    if receipt_committed; then
        print_error "数据已经提交，新版本已启用，但后续步骤未完成（原因见上方）；保留新代码，请用 $(ops_command_hint doctor) 检查"
        exit "$code"
    fi
    complete_code_restore
    if [ "$mode" = rollback ] && [ "$DEPLOY_STATUS" = 0 ]; then
        print_success "升级已回滚：代码恢复到 ${ORIGINAL_SHA:0:7}，数据、配置和原运行状态已恢复"
        exit 0
    fi
    print_error "升级失败，已回滚：代码恢复到 ${ORIGINAL_SHA:0:7}，数据、配置和原运行状态已恢复"
    exit "$code"
}

# ---- 未完成的升级：按事务记录继续或回滚 ----

# 代码尚未切换：部署脚本从未接手，只需恢复升级器开始事务时停止并改名的原容器。
rollback_before_checkout() {
    if [ -f "$STATE_DIR/migration.json" ] && grep -q "\"deployment\": \"${TRANSACTION[snapshot]}\"" "$STATE_DIR/migration.json"; then
        print_error "本次升级的数据迁移已经开始，但当前代码不是目标提交；请先切换到目标提交 ${TARGET_SHA:0:7} 后重试回滚"
        exit 1
    fi
    [ -d "${TRANSACTION[original_group_root]}" ] || {
        print_error "原群数据总根不存在：${TRANSACTION[original_group_root]}；旧容器依赖它，请恢复原挂载后再回滚"; exit 1; }
    print_status "回滚上次升级：代码尚未切换，恢复原容器、网络入口和原运行状态"
    HOST_GROUP_DATA_ROOT="${TRANSACTION[target_group_root]}"
    ROLLBACK_REQUESTED=1
    begin_deployment
    # begin_deployment 安装的 EXIT 处理恢复快照并报告结果。
    exit 1
}

resume_upgrade() {
    local head
    TARGET_SHA="${TRANSACTION[target_sha]}"
    ORIGINAL_SHA="${TRANSACTION[original_sha]}"
    ORIGINAL_BRANCH="${TRANSACTION[original_branch]}"
    [ -n "$TARGET_SHA" ] && [ -n "$ORIGINAL_SHA" ] || { print_error "升级事务缺少原提交或目标提交；请人工检查 backup/snapshots/${TRANSACTION[snapshot]}"; exit 1; }
    if transaction_code_restore_pending; then
        if [ "$ACTION" = continue ]; then
            print_error "上次升级的数据、配置和容器已经回滚，只剩代码待恢复，不能继续；请使用 $(ops_command_hint rollback) 完成回滚后重新升级"
            exit 1
        fi
        print_status "完成上次升级的回滚：数据、配置、容器和原运行状态已经恢复，只恢复代码到 ${ORIGINAL_SHA:0:7}"
        complete_code_restore
        print_success "升级已回滚：代码恢复到 ${ORIGINAL_SHA:0:7}，数据、配置和原运行状态已恢复"
        exit 0
    fi
    head="$(git_here rev-parse HEAD)"
    if [ "$head" != "$TARGET_SHA" ] && [ "$head" != "$ORIGINAL_SHA" ]; then
        print_error "当前代码 ${head:0:7} 既不是升级前的 ${ORIGINAL_SHA:0:7}，也不是目标 ${TARGET_SHA:0:7}；请切回其中之一后重试"
        exit 1
    fi
    if [ "$ACTION" = rollback ]; then
        [ "$head" = "$TARGET_SHA" ] || rollback_before_checkout
        # 回滚最后要恢复代码：工作区有升级后的人工改动时，在恢复任何内容之前停止。
        code_restore_safe "$ORIGINAL_BRANCH" "$ORIGINAL_SHA" "$TARGET_SHA" || {
            print_error "没有回滚：恢复升级前的代码会覆盖升级后的工作区改动（见上方），数据、配置和容器保持现状。把改动提交到其他分支、备份或撤销后重试 $(ops_command_hint rollback)"
            exit 1
        }
        # 代码已切换：由目标版本的部署脚本恢复数据、配置、容器和网络入口，再恢复升级前的代码。
        print_status "回滚上次升级：恢复数据、配置、容器、网络入口、代码和原运行状态"
        run_deploy rollback
        finish_after_deploy rollback
    fi
    if [ "$head" != "$TARGET_SHA" ]; then
        # 中断发生在停机完成之前时服务可能仍在运行；切换代码前先停止。
        if [ "$(docker container inspect --format '{{.State.Running}}' mixin-chatbot 2>/dev/null || true)" = true ]; then
            print_status "停止机器人服务后再切换代码..."
            operation_capture docker stop --time 30 mixin-chatbot || { print_error "旧容器停止失败，未切换代码；可重试继续，或 $(ops_command_hint rollback) 回滚"; exit 1; }
        fi
        git_here cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null && checkout_target || {
            print_error "无法切换到目标提交 ${TARGET_SHA:0:7}；服务保持停止，处理后可重试继续，或 $(ops_command_hint rollback) 回滚"; exit 1; }
        print_success "代码已更新：${ORIGINAL_SHA:0:7} -> ${TARGET_SHA:0:7}"
    fi
    print_status "继续上次升级 ${ORIGINAL_SHA:0:7} -> ${TARGET_SHA:0:7}：设置和迁移计划取自事务记录，不再询问"
    run_deploy continue
    finish_after_deploy continue
}

# ---- 新升级：停机前完成全部确认 ----

# 升级沿用已保存的设置；无效时在停机前停止，由部署脚本修正。
read_saved_settings() {
    local raw hint="升级沿用现有配置，请先用 $(ops_command_hint deploy) 修正（服务尚未停止）"
    BOT_PORT=1011
    DEPLOY_MODE=direct
    PUBLIC_DOMAIN=''
    DOMAIN_ACTION=keep
    if [ -f "$STATE_DIR/bot-port" ]; then BOT_PORT="$(tr -d '[:space:]' < "$STATE_DIR/bot-port")"; fi
    if [ -f "$STATE_DIR/deploy-mode" ]; then DEPLOY_MODE="$(tr '[:upper:]' '[:lower:]' < "$STATE_DIR/deploy-mode" | tr -d '[:space:]')"; fi
    transaction_value_valid bot_port "$BOT_PORT" || { print_error "data/state/bot-port 中的端口无效：${BOT_PORT}；${hint}"; exit 1; }
    transaction_value_valid deploy_mode "$DEPLOY_MODE" || { print_error "data/state/deploy-mode 中的部署模式无效：${DEPLOY_MODE}；${hint}"; exit 1; }
    if [ -f "$STATE_DIR/bot-domain" ]; then
        raw="$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$STATE_DIR/bot-domain")"
        # 与部署脚本一致：需要规范化的写回规范值，无效域名在提交时清除。
        if [ -z "$raw" ]; then :
        elif PUBLIC_DOMAIN="$(normalize_hostname_input "$raw")"; then
            [ "$PUBLIC_DOMAIN" = "$raw" ] || DOMAIN_ACTION=persist
        else
            PUBLIC_DOMAIN=''
            DOMAIN_ACTION=clear
            print_warning "data/state/bot-domain 中的域名无效，升级提交时清除：$raw"
        fi
    fi
    GROUP_ROOT="$(saved_group_data_root)"
    # 已登记的群根（包括默认的 data/groups）缺失时在停机前停止：绝不创建空目录，掩盖丢失的历史。
    # 从未登记过时才按首次部署创建默认目录。
    if [ -s "$STATE_DIR/group-data-root" ]; then
        [ -d "$GROUP_ROOT" ] || {
            print_error "已部署的群数据总根不存在：$GROUP_ROOT；请恢复原目录或挂载后重试（服务尚未停止）"; exit 1; }
    else
        mkdir -p -- "$GROUP_ROOT"
    fi
}

# 运行参数沿用 runtime.json；当前终端的设置类环境变量不采用，与续做一致。
check_upgrade_environment() {
    local key ignored=()
    if [ -n "${BOT_MODEL_CACHE_RETENTION:-}" ]; then
        print_error 'BOT_MODEL_CACHE_RETENTION 已移除；请先迁移配置并移除旧环境变量，再升级（服务尚未停止）。'
        exit 1
    fi
    # 直连防火墙放行的来源写入事务记录；默认值见 scripts/lib/common.sh，可用 PLATFORM_IP 覆盖。
    PLATFORM_IP="${PLATFORM_IP:-$DEFAULT_PLATFORM_IP}"
    transaction_value_valid platform_ip "$PLATFORM_IP" || {
        print_error "PLATFORM_IP 无效：$PLATFORM_IP（需要 IPv4 或 IPv6 地址，可带前缀长度；服务尚未停止）"; exit 1; }
    for key in BOT_PORT DEPLOY_MODE GROUP_DATA_ROOT BOT_DOMAIN "${RUNTIME_ENV_KEYS[@]}"; do
        [ -z "${!key:-}" ] || ignored+=("$key")
    done
    if [ "${#ignored[@]}" -gt 0 ]; then
        print_warning "升级沿用已保存的设置和 runtime.json，忽略当前终端的环境变量：${ignored[*]}；修改请用 $(ops_command_hint deploy)"
    fi
    unset BOT_PORT DEPLOY_MODE GROUP_DATA_ROOT BOT_DOMAIN "${RUNTIME_ENV_KEYS[@]}"
}

# 未托管 connector 的归属和缺失的 token 在停机前确认；token 只在内存中交给部署脚本。
confirm_tunnel() {
    UNMANAGED_MODE=''
    local pid
    if ! managed_cloudflared_pid >/dev/null 2>&1 && pgrep -x cloudflared >/dev/null 2>&1; then
        pid="$(pgrep -x cloudflared | head -n1)"
        if [ "$DEPLOY_MODE" = cloudflare ]; then
            print_warning "检测到未由本项目记录的 cloudflared（pid ${pid}），无法自动确认它连接的是当前隧道"
            ask_yes_no "确认该 connector 正在服务本项目，继续升级？[y/N] " || { print_warning '已取消升级；代码和配置未改动'; exit 1; }
        else
            print_warning "系统有未由本项目记录的 cloudflared（pid ${pid}）；不会自动停止，以免影响其他隧道"
            ask_yes_no "确认该 connector 与本项目无关或其入口仍受保护，继续升级？[y/N] " || { print_warning '已取消升级；代码和配置未改动'; exit 1; }
        fi
        UNMANAGED_MODE="$DEPLOY_MODE"
    elif [ "$DEPLOY_MODE" = cloudflare ] && ! managed_cloudflared_pid >/dev/null 2>&1 && ! (load_tunnel_token) >/dev/null 2>&1; then
        print_status '未运行 cloudflared 且没有可用的已保存 token；请先提供，升级验证实例就绪后启动'
        show_tunnel_token_help
        while true; do
            if ! IFS= read -r -s -p '隧道 token 或文件路径（输入隐藏）：' TUNNEL_INPUT; then
                echo ""; print_warning '输入已结束，已取消升级；代码和配置未改动'; exit 1
            fi
            echo ""
            if (load_tunnel_token "$TUNNEL_INPUT"); then break; fi
        done
    fi
}

# 在目标版本 Dockerfile 的 Bun 基础镜像中预览迁移：只运行 run.ts preview --decisions-only（只用内置模块），
# 目标依赖相关的完整校验留到停机后在目标镜像中进行。data/ 和群根只读挂载，容器内路径与正式迁移相同，
# 计划中的输入摘要可直接用于停机后的 apply；暂存目录和计划写在导出目录的 preview/ 下。
stop_preview() {
    [ -n "$PREVIEW_PID" ] || return 0
    docker rm -f "$PREVIEW_CONTAINER" >/dev/null 2>&1 || true
    kill "$PREVIEW_PID" 2>/dev/null || true
    wait "$PREVIEW_PID" 2>/dev/null || true
    PREVIEW_PID=''
    print_warning '迁移预览已中断并清理；服务尚未停止，代码和数据未改动'
}

preview_migration() {
    local image preview_dir="$UPGRADER_DIR/preview" groups mounts=() mode=() status=0
    image="$(sed -n 's#^FROM[[:space:]][[:space:]]*\(oven/bun:[^[:space:]]*\).*#\1#p' "$UPGRADER_DIR/Dockerfile" | head -n 1)"
    [ -n "$image" ] || { print_error "目标版本的 Dockerfile 中找不到 oven/bun 基础镜像，无法预览迁移；服务尚未停止"; exit 1; }
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        print_status "获取迁移预览使用的基础镜像 ${image}..."
        operation_capture docker pull "$image" || { print_error "无法获取 ${image}；服务尚未停止，代码和数据未改动"; exit 1; }
    fi
    rm -rf -- "$preview_dir"
    mkdir -p -- "$preview_dir" "$LOG_DIR"
    # 容器用户需要读取导出的脚本，写入暂存目录、计划和本次操作日志（与 deploy.sh 相同，root 部署降权到 UID 1001）。
    chmod 755 "$UPGRADER_DIR"
    chmod 700 "$preview_dir"
    if [ "$(id -u)" -eq 0 ]; then chown "$CONTAINER_UID:$CONTAINER_GID" "$preview_dir" && chown -R "$CONTAINER_UID:$CONTAINER_GID" "$LOG_DIR"; fi
    if [ "$GROUP_ROOT" = "$DEFAULT_GROUP_DATA_ROOT" ]; then
        groups=/app/data/groups
    else
        groups=/app/group-data
        mounts=(-v "$GROUP_ROOT:/app/group-data:ro")
    fi
    [ ! -t 0 ] || mode=(--interactive)
    print_status "在目标版本中预览迁移（只读挂载数据，服务尚未停止）..."
    # 预览容器有名称并在后台运行，升级器等待它：中断（ops.sh 转发的 TERM、终端 Ctrl+C、断线）时先删除容器再退出。
    # 在前台运行时 docker CLI 会随升级器退出变成孤儿，容器（例如正在等待迁移确认）一直留着。
    PREVIEW_CONTAINER="mixin-chatbot-preview-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    trap 'stop_preview; exit 130' INT
    trap 'stop_preview; exit 143' TERM
    trap 'stop_preview; exit 129' HUP
    docker run --rm -i --name "$PREVIEW_CONTAINER" --user "$CONTAINER_UID:$CONTAINER_GID" -w /app -e HOME=/tmp -e BOT_OPERATION_LOG -e GROUP_DATA_ROOT="$groups" \
        -v "$PROJECT_DIR/data:/app/data:ro" "${mounts[@]}" -v "$PROJECT_DIR/logs:/app/logs" \
        -v "$UPGRADER_DIR:/upgrade:ro" -v "$preview_dir:/preview" \
        "$image" bun --no-install /upgrade/scripts/migrations/run.ts preview --decisions-only "${mode[@]}" \
        --project /app --groups "$groups" --scratch /preview --plan /preview/migration-plan.json <&0 &
    PREVIEW_PID=$!
    wait "$PREVIEW_PID" || status=$?
    PREVIEW_PID=''
    trap - INT TERM HUP
    if [ "$status" != 0 ]; then
        print_error "迁移预览未完成（原因见上方）；服务尚未停止，代码和数据未改动"
        # 退出码 2：有需要确认的迁移选择。升级不接受命令行确认参数，只能在交互终端中回答。
        if [ "$status" = 2 ] && [ ! -t 0 ]; then print_warning "迁移选择需要在交互终端中确认；请在终端中运行 $(ops_command_hint update)"; fi
        exit 1
    fi
    PREVIEW_PLAN="$preview_dir/migration-plan.json"
    [ -s "$PREVIEW_PLAN" ] || { print_error "迁移预览没有生成计划；服务尚未停止，代码和数据未改动"; exit 1; }
}

# begin_deployment 在发布事务指针前调用：记录停机前确认的全部选择，并把迁移计划存入快照。
record_deployment_transaction() {
    local snapshot="$1"
    declare -gA TRANSACTION=([format]=1 [operation]=upgrade [snapshot]="$(basename -- "$snapshot")" [target_sha]="$TARGET_SHA"
        [original_sha]="$ORIGINAL_SHA" [original_branch]="$ORIGINAL_BRANCH" [original_group_root]="$GROUP_ROOT" [target_group_root]="$GROUP_ROOT"
        [was_running]="$PREVIOUS_RUNNING" [bot_port]="$BOT_PORT" [deploy_mode]="$DEPLOY_MODE" [bot_domain]="$PUBLIC_DOMAIN"
        [domain_action]="$DOMAIN_ACTION" [unmanaged_tunnel]="$UNMANAGED_MODE" [platform_ip]="$PLATFORM_IP" [reconfigure_ai]=0)
    write_transaction_record "$snapshot" || return 1
    cp -- "$PREVIEW_PLAN" "$snapshot/migration-plan.json"
}

# 部署脚本接手之前失败：恢复升级前的代码，再由事务恢复原容器、网络入口和原运行状态。
abort_before_handoff() {
    local status=$?
    set +e
    trap - EXIT
    if [ "$(git_here rev-parse HEAD 2>/dev/null)" != "$ORIGINAL_SHA" ]; then
        # 失败时事务保留“待恢复代码”阶段（见 rollback_deployment），处理后重试回滚只恢复代码。
        { code_restore_safe "$ORIGINAL_BRANCH" "$ORIGINAL_SHA" "$TARGET_SHA" && restore_checkout "$ORIGINAL_BRANCH" "$ORIGINAL_SHA"; } ||
            print_error "代码未能恢复到升级前的 ${ORIGINAL_SHA:0:7}（原因见上方）；恢复数据和服务后，处理 git 问题或工作区改动再运行 $(ops_command_hint rollback)，只恢复代码"
    fi
    (exit "$status")
    rollback_deployment
}

fresh_upgrade() {
    local dirty
    TARGET_SHA="$(git_here rev-parse --verify --quiet "${TARGET_REF}^{commit}")" || {
        print_error "目标提交 ${TARGET_REF} 在本地不存在；请先 git fetch origin main"; exit 1; }
    ORIGINAL_SHA="$(git_here rev-parse HEAD)"
    ORIGINAL_BRANCH="$(git_here rev-parse --abbrev-ref HEAD)"
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
        ask_yes_no "切换到 main 并继续升级？[y/N] " || { print_warning "已取消升级"; exit 1; }
    fi
    # 只接受快进。本地有未推送的提交时停下来，而不是替用户决定怎么合并。
    git_here show-ref --verify --quiet refs/heads/main || { print_error "本地 main 分支不存在，请先建立 main 后重试"; exit 1; }
    if ! git_here merge-base --is-ancestor main "$TARGET_SHA"; then
        print_error "本地 main 无法快进到目标提交 ${TARGET_SHA:0:7}"
        print_warning "本地独有的提交："
        git_here log --oneline "$TARGET_SHA..main" | sed 's/^/      /'
        print_warning "请先推送或丢弃这些提交后重试"
        exit 1
    fi
    if [ "$ORIGINAL_SHA" = "$TARGET_SHA" ]; then
        print_success "代码已经最新，仍检查数据版本并完成必要迁移"
    else
        echo ""
        echo -e "${CYAN}将要应用的提交：${NC}"
        git_here log --oneline "main..$TARGET_SHA" | sed 's/^/      /'
        echo ""
    fi
    docker info >/dev/null 2>&1 || { print_error '无法连接 Docker，尚未应用升级'; exit 1; }
    if [ "$(id -u)" -ne 0 ]; then IFS=: read -r CONTAINER_UID CONTAINER_GID <<< "$(container_user "$CONTAINER_UID:$CONTAINER_GID")"; fi
    # 升级沿用现有 AI 配置；缺少时需要交互向导，应先通过部署完成。
    [ -f "$MODELS_FILE" ] || { print_error "缺少 data/config/models.json；升级沿用现有 AI 配置，请先使用 $(ops_command_hint deploy) 完成配置"; exit 1; }
    check_upgrade_environment
    read_saved_settings
    print_status "升级沿用现有设置：端口 ${BOT_PORT}；入口 ${DEPLOY_MODE}；群数据总根 ${GROUP_ROOT}；域名 ${PUBLIC_DOMAIN:-未设置}"
    # rootless Docker 要到停机后启动容器时才拒绝发布低端口：沿用的端口发布不了就在这里停止。
    if docker_rootless && ! rootless_port_publishable "$BOT_PORT"; then
        print_error "$(rootless_port_hint "$BOT_PORT")"
        print_error "升级沿用已保存的端口 ${BOT_PORT}；改端口请用 $(ops_command_hint deploy)（服务尚未停止）"
        exit 1
    fi
    confirm_tunnel
    preview_migration

    print_status "记录升级事务并停止机器人服务；此后切换代码、重建镜像和迁移期间服务保持停止"
    HOST_GROUP_DATA_ROOT="$GROUP_ROOT"
    begin_deployment "$TARGET_SHA"
    trap abort_before_handoff EXIT
    if [ "$PREVIOUS_RUNNING" = 0 ]; then print_status "机器人服务升级前未运行，升级后保持停止"; fi
    checkout_target || { print_error "切换到目标提交 ${TARGET_SHA:0:7} 失败，正在恢复升级前的状态"; exit 1; }
    [ "$ORIGINAL_SHA" = "$TARGET_SHA" ] || print_success "代码已更新：${ORIGINAL_SHA:0:7} -> ${TARGET_SHA:0:7}"
    print_status "交给目标版本的部署脚本：按事务记录重建镜像、迁移并验证新实例，不再询问"
    run_deploy continue "$(basename -- "$DEPLOY_SNAPSHOT")"
    finish_after_deploy fresh
}

operation_start upgrade
trap 'operation_finish "$?"' EXIT
command -v flock >/dev/null || { print_error "需要 util-linux flock"; exit 1; }
acquire_deploy_lock || { print_error "另一个部署或升级正在进行"; exit 1; }
git_here rev-parse --is-inside-work-tree >/dev/null 2>&1 || { print_error "${PROJECT_DIR} 不是 git 仓库，无法升级"; exit 1; }
if [ -e "$STATE_DIR/update-transaction" ]; then
    print_error "发现旧版升级留下的停机记录 data/state/update-transaction；请先用 $(ops_command_hint update) 完成或回滚上次升级，再重新运行"
    exit 1
fi
if [ -e "$PENDING_POINTER" ]; then
    load_pending_transaction || { print_error "未完成事务的记录无法读取（原因见上方）；保持现状，请人工检查 backup/snapshots"; exit 1; }
    print_warning "$(describe_pending_transaction)"
    if [ "${TRANSACTION[operation]}" != upgrade ]; then
        print_error "未完成的是部署而不是升级；请先运行 $(ops_command_hint deploy) 继续或回滚上次部署，再升级"
        exit 1
    fi
    [ -n "$ACTION" ] || choose_pending_action
    resume_upgrade
fi
if [ -n "$ACTION" ]; then
    print_success "没有未完成的升级"
    exit 0
fi
fresh_upgrade
