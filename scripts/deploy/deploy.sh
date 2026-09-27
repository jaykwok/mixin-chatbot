#!/bin/bash

# 量子密信群聊协作机器人部署脚本 (Debian + Docker, Bun)
# AI 配置（provider/key/model）由 data/config/models.json 承载，容器内 TUI 生成；
# 无必需 .env/config.json。访问控制由应用 secret + 网络层（直连=UFW / Cloudflare=WAF）共同承担。
# 两种部署模式：直连（公网 IP + UFW 限平台 IP）/ Cloudflare（cloudflared 隧道 + WAF）。

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
# 升级器在同一次升级中交接的隧道 token 和交接标记（事务快照名）。只有标记与事务记录一致时才采用该 token，
# 见续做分支；读入后立即移出环境，避免 token 传给后续子进程。
PREPARED_TUNNEL_INPUT="${DEPLOY_TUNNEL_TOKEN_INPUT:-}"
TRANSACTION_HANDOFF="${DEPLOY_TRANSACTION_HANDOFF:-}"
LEGACY_REUSE_REQUEST="${DEPLOY_REUSE_SETTINGS:-0}"
unset DEPLOY_TUNNEL_TOKEN_INPUT DEPLOY_TRANSACTION_HANDOFF DEPLOY_REUSE_SETTINGS
# 未完成事务的处理方式（ops resume / rollback 和升级器指定，否则下方询问）；续做和回滚只使用事务记录中的设置。
TRANSACTION_ACTION="${DEPLOY_TRANSACTION_ACTION:-}"
unset DEPLOY_TRANSACTION_ACTION
case "$TRANSACTION_ACTION" in
    ''|continue|rollback) ;;
    *) echo "DEPLOY_TRANSACTION_ACTION 只能是 continue 或 rollback" >&2; exit 1 ;;
esac
# 旧版运维脚本的升级先停机，再以 DEPLOY_REUSE_SETTINGS=1 调用部署脚本；它不写事务记录，也没有停机前的迁移预览。
# 在改动任何状态之前拒绝，旧脚本随后恢复原代码和原运行状态；新版升级器需要引导一次。
if [ "$LEGACY_REUSE_REQUEST" = 1 ] && [ -z "$TRANSACTION_ACTION" ]; then
    operation_event error "legacy upgrade entry refused"
    {
        echo "[-] 旧版运维脚本不能直接升级到此版本：新版升级在停机前预览迁移并记录全部设置，需由新版升级器执行。"
        echo "    本次未改动数据和配置；旧脚本将恢复原代码和原运行状态。请在项目目录运行一次以下引导命令，之后照常使用 ops.sh update："
        echo "      cd '$PROJECT_DIR'"
        upgrade_bootstrap_command | sed 's/^/      /'
    } >&2
    exit 1
fi
RECORDED=0
PREPARED_UNMANAGED_MODE=""
# 只有升级的续做保持原停止状态（续做分支设置）；部署完成后总是启动。
DEPLOY_PRESERVE_STOPPED=0
DATA_DIR="${PROJECT_DIR}/data"
CONFIG_DIR="${DATA_DIR}/config"
STATE_DIR="${DATA_DIR}/state"
RUNTIME_DIR="${DATA_DIR}/runtime"
RUNTIME_HOME_DIR="${RUNTIME_DIR}/home"
DEFAULT_GROUP_DATA_ROOT="${DATA_DIR}/groups"
LOG_DIR="${PROJECT_DIR}/logs"
MODELS_FILE="${CONFIG_DIR}/models.json"
WEBHOOK_SECRET_FILE="${CONFIG_DIR}/webhook-secret"
BOT_PORT_FILE="${STATE_DIR}/bot-port"
DEPLOY_MODE_FILE="${STATE_DIR}/deploy-mode"
BOT_DOMAIN_FILE="${STATE_DIR}/bot-domain"
GROUP_DATA_ROOT_FILE="${STATE_DIR}/group-data-root"
TUNNEL_PID_FILE="${STATE_DIR}/cloudflared.pid"
if [ "$(id -u)" -eq 0 ]; then
    CONTAINER_UID=1001
    CONTAINER_GID=1001
else
    # bind mount 由当前部署用户拥有；用同一非 root 身份运行可同时保证主机与容器可维护。
    CONTAINER_UID="$(id -u)"
    CONTAINER_GID="$(id -g)"
fi

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

# Project UFW helpers and the deployment transaction are shared in scripts/lib/deployment.sh.
# Connector identity and bounded stop are shared in scripts/lib/lifecycle.sh.

# 项目内群根使用 data 挂载，项目外群根单独挂到 /app/group-data。
group_root_mount() {
    GROUP_ROOT_ARGS=()
    if [ "$1" = "$DEFAULT_GROUP_DATA_ROOT" ]; then
        GROUP_ROOT_ENV_VAL="/app/data/groups"
    else
        GROUP_ROOT_ARGS+=(-v "$1:/app/group-data")
        GROUP_ROOT_ENV_VAL="/app/group-data"
    fi
}

# The target image owns migration semantics, including the first unversioned upgrade.
migration_docker() {
    docker run --rm -i --user "$CONTAINER_UID:$CONTAINER_GID" \
      -e HOME=/app/data/runtime/home -e BOT_DEPLOY_BACKUP_ID -e BOT_OPERATION_LOG -e PI_CACHE_RETENTION -e GROUP_DATA_ROOT="$GROUP_ROOT_ENV_VAL" \
      "${GROUP_ROOT_ARGS[@]}" -v "$PROJECT_DIR/data:/app/data" -v "$PROJECT_DIR/backup:/app/backup" -v "$PROJECT_DIR/logs:/app/logs" \
      mixin-chatbot bun run scripts/migrations/run.ts "$@" --groups "$GROUP_ROOT_ENV_VAL"
}
MIGRATION_APPLY_ATTEMPTED=0
MIGRATION_PLAN=/app/data/state/migration-plan.json
MIGRATION_PREVIEW_MODE=(--interactive)
rollback_data_migration() {
    [ "$MIGRATION_APPLY_ATTEMPTED" = 1 ] || return 0
    # Without a journal there is nothing to restore, and the image may never have been built.
    [ -e "$STATE_DIR/migration.json" ] || return 0
    local result=0
    migration_docker rollback --deployment "$BOT_DEPLOY_BACKUP_ID" || result=$?
    if [ "$result" = 42 ]; then
        commit_deployment
        print_error "数据已经提交，保留新代码；请检查服务状态后启动。"
    fi
    return "$result"
}

# begin_deployment 发布事务指针前调用：记录停机前确认的全部选择，续做和回滚只读这份记录。
record_deployment_transaction() {
    local snapshot="$1" domain_action=keep unmanaged=''
    if [ "$PERSIST_BOT_DOMAIN" = 1 ]; then domain_action=persist
    elif [ "$CLEAR_PERSISTED_BOT_DOMAIN" = 1 ]; then domain_action=clear; fi
    if [ "$UNMANAGED_TUNNEL_CONFIRMED" = 1 ]; then unmanaged="$DEPLOY_MODE"; fi
    declare -gA TRANSACTION=([format]=1 [operation]=deploy [snapshot]="$(basename -- "$snapshot")"
        [target_sha]="$(cat "$snapshot/target-sha")" [original_sha]='' [original_branch]=''
        [original_group_root]="$ORIGINAL_GROUP_DATA_ROOT" [target_group_root]="$HOST_GROUP_DATA_ROOT" [was_running]="$PREVIOUS_RUNNING"
        [bot_port]="$BOT_PORT" [deploy_mode]="$DEPLOY_MODE" [bot_domain]="$PUBLIC_DOMAIN" [domain_action]="$domain_action"
        [unmanaged_tunnel]="$unmanaged" [platform_ip]="$PLATFORM_IP" [reconfigure_ai]="$RECONFIGURE_AI")
    write_transaction_record "$snapshot" || return 1
    if [ "$MIGRATION_PLANNED" = 1 ]; then cp -- "$STATE_DIR/migration-plan.json" "$snapshot/migration-plan.json" || return 1; fi
}

# 回滚未完成的事务。数据已提交时拒绝，只能继续完成新实例启动；判定在改动任何容器之前。
rollback_pending_deployment() {
    local original="${TRANSACTION[original_group_root]}" target="${TRANSACTION[target_group_root]}"
    case "$original" in
        "$PROJECT_DIR"/*) ;;
        *) [ -d "$original" ] || { print_error "原群数据总根不存在：$original；旧容器依赖它，请恢复原挂载后再回滚"; exit 1; } ;;
    esac
    group_root_mount "$target"
    if [ -e "$STATE_DIR/migration.json" ]; then
        [ -d "$target" ] || { print_error "本次操作的群数据总根不存在：$target；恢复迁移前的数据需要它，请恢复挂载后再回滚"; exit 1; }
        if migration_docker committed --deployment "${TRANSACTION[snapshot]}"; then
            print_error "上次操作的数据已经提交，不能回滚；请选择继续（$(ops_command_hint resume)）完成新实例启动"
            exit 1
        fi
    fi
    HOST_GROUP_DATA_ROOT="$target"
    ROLLBACK_REQUESTED=1
    print_status "回滚上次操作：恢复数据、配置、容器、网络入口和原运行状态"
    begin_deployment
    # The EXIT trap installed by begin_deployment restores the snapshot and reports the result.
    exit 1
}

# 数据提交后启动正式实例，再清理事务和旧回滚容器。实例未就绪时保留事务指针，可再次继续。
activate_committed_deployment() {
    rm -f -- "$PROJECT_DIR/data/state/verify-only" "$PROJECT_DIR/data/state/migration-plan.json"
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
    fi
    rm -f -- "$PROJECT_DIR/data/state/deploy-transaction"
    cleanup_completed_backup "$DEPLOY_SNAPSHOT" keep-root || print_warning "部署已完成，但备份清理未完成，请检查 $DEPLOY_SNAPSHOT 和 $PROJECT_DIR/backup/rm"
    # Let process exit close descriptor 9. Explicit unlock would also unlock an update parent's inherited descriptor.
    if [ "$PREVIOUS_CONTAINER_SAVED" = "1" ]; then
        if docker rm "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
            print_success "部署已提交，旧容器回滚版本已清理"
        else
            print_warning "部署已成功，但旧回滚容器 ${ROLLBACK_CONTAINER} 清理失败；可确认后手动 docker rm"
        fi
    fi
}

# 数据已在中断前提交：配置、网络入口和状态文件都已写入，旧数据不能再用。
# 只停止验证实例并启动正式实例；不重新创建事务、构建镜像或执行迁移。
finish_committed_transaction() {
    DEPLOY_SNAPSHOT="$TRANSACTION_SNAPSHOT"
    PREVIOUS_RUNNING="${TRANSACTION[was_running]}"
    ROLLBACK_CONTAINER=mixin-chatbot-rollback
    PREVIOUS_CONTAINER_SAVED=0
    if docker inspect "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then PREVIOUS_CONTAINER_SAVED=1; fi
    if ! docker inspect mixin-chatbot >/dev/null 2>&1; then
        print_error "上次操作的数据已经提交，但新容器 mixin-chatbot 不存在；请用 docker ps -a 检查后处理，不能回滚"
        exit 1
    fi
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
    if [ -n "${BOT_MODEL_CACHE_RETENTION:-}" ]; then
        print_error 'BOT_MODEL_CACHE_RETENTION 已移除；请先迁移配置并移除旧环境变量，再部署。'
        exit 1
    fi
    # 量子密信平台出口 IP（webhook 来源；UFW/WAF 按此放行）：默认值见 scripts/lib/common.sh，可用环境变量覆盖。
    PLATFORM_IP="${PLATFORM_IP:-$DEFAULT_PLATFORM_IP}"
    if ! transaction_value_valid platform_ip "$PLATFORM_IP"; then
        print_error "PLATFORM_IP 无效：$PLATFORM_IP（需要 IPv4 或 IPv6 地址，可带前缀长度）"
        exit 1
    fi
    local debug="${BOT_DEBUG:-0}" active="${BOT_MAX_ACTIVE_REQUESTS:-32}"
    if [ "$debug" != 0 ] && [ "$debug" != 1 ]; then
        print_error 'BOT_DEBUG 只能是 0 或 1'
        exit 1
    fi
    if ! [[ "$active" =~ ^[0-9]+$ ]] || [ "$active" -lt 1 ] || [ "$active" -gt 1000 ]; then
        print_error 'BOT_MAX_ACTIVE_REQUESTS 必须是 1–1000 的整数'
        exit 1
    fi
}

# ---- 前置检查 ----

print_status "检查运行环境..."

if ! docker info > /dev/null 2>&1; then
    print_error "无法连接 Docker，请确保 Docker 已安装且当前用户有权限"
    echo "  提示: sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
fi

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
ORIGINAL_GROUP_DATA_ROOT="$(saved_group_data_root)"
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
    if [ -z "$TRANSACTION_ACTION" ]; then
        if [ -t 0 ]; then
            choose_transaction_action
        else
            print_error "发现未完成的部署；请使用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"
            exit 1
        fi
    fi
    RECORDED=1
    [ "$TRANSACTION_ACTION" != rollback ] || rollback_pending_deployment
    if [ -n "${TRANSACTION[target_sha]}" ] && [ "$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)" != "${TRANSACTION[target_sha]}" ]; then
        print_error "当前代码不是上次操作的目标提交 ${TRANSACTION[target_sha]:0:7}；请切回该提交后继续，或回滚"
        exit 1
    fi
    # 挂载缺失时明确停止，绝不在续做中重新创建空的群数据总根。
    [ -d "${TRANSACTION[target_group_root]}" ] || {
        print_error "事务记录的群数据总根不存在：${TRANSACTION[target_group_root]}；请恢复挂载后重试继续，或回滚"; exit 1; }
    BOT_PORT="${TRANSACTION[bot_port]}"
    DEPLOY_MODE="${TRANSACTION[deploy_mode]}"
    GROUP_DATA_ROOT="${TRANSACTION[target_group_root]}"
    PLATFORM_IP="${TRANSACTION[platform_ip]}"
    # 运行参数沿用 runtime.json；当前终端的环境变量不校验，也不写入。
    unset "${RUNTIME_ENV_KEYS[@]}" BOT_MODEL_CACHE_RETENTION
    PREPARED_UNMANAGED_MODE="${TRANSACTION[unmanaged_tunnel]}"
    # 只有同一次升级的升级器知道快照名：交接标记一致才采用它在停机前确认的 token。
    # 重启后的续做（ops resume、新终端）没有标记，只接受已保存的 token 来源。
    if [ -z "$TRANSACTION_HANDOFF" ] || [ "$TRANSACTION_HANDOFF" != "${TRANSACTION[snapshot]}" ]; then PREPARED_TUNNEL_INPUT=""; fi
    MIGRATION_PREVIEW_MODE=()
    # 升级沿用原运行状态；部署完成后总是启动。
    [ "${TRANSACTION[operation]}" != upgrade ] || DEPLOY_PRESERVE_STOPPED=1
    group_root_mount "${TRANSACTION[target_group_root]}"
    if [ -e "$STATE_DIR/migration.json" ] && migration_docker committed --deployment "${TRANSACTION[snapshot]}"; then
        finish_committed_transaction
    fi
    print_status "继续上次操作：端口、入口模式、群数据总根、域名、平台 IP 和隧道确认均取自事务记录，运行参数沿用 runtime.json"
elif [ -n "$TRANSACTION_ACTION" ]; then
    print_success "没有未完成的部署或升级"
    exit 0
else
    # 新部署在下方询问隧道 token；环境中残留的交接值一律不用。
    PREPARED_TUNNEL_INPUT=""
    check_deploy_environment
    verify_deployed_group_root
fi
print_warning "转换数据前先预览；应用变更时保持停机，提交前失败恢复数据、配置和原运行状态。"
mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_HOME_DIR" "$DEFAULT_GROUP_DATA_ROOT" "$LOG_DIR"
if [ -n "${BOT_PORT:-}" ]; then
    PORT_DEFAULT_SOURCE="BOT_PORT"
    PORT_DEFAULT="$(trim_input "$BOT_PORT")"
elif [ -f "$BOT_PORT_FILE" ]; then
    PORT_DEFAULT_SOURCE="data/state/bot-port"
    PORT_DEFAULT="$(tr -d '[:space:]' < "$BOT_PORT_FILE")"
else
    PORT_DEFAULT_SOURCE=""
    PORT_DEFAULT="1011"
fi
if ! [[ "$PORT_DEFAULT" =~ ^[0-9]+$ ]] || [ "$PORT_DEFAULT" -lt 1 ] || [ "$PORT_DEFAULT" -gt 65535 ]; then
    print_warning "${PORT_DEFAULT_SOURCE} 中的端口无效，已改用安全默认值 1011：${PORT_DEFAULT}"
    PORT_DEFAULT="1011"
fi
if [ "$RECORDED" = 1 ]; then
    BOT_PORT="$PORT_DEFAULT"
else
    while true; do
        read_input "机器人监听端口 [默认 ${PORT_DEFAULT}]：" port_in
        port_in="$(trim_input "$port_in")"
        BOT_PORT="${port_in:-$PORT_DEFAULT}"
        if [[ "$BOT_PORT" =~ ^[0-9]+$ ]] && [ "$BOT_PORT" -ge 1 ] && [ "$BOT_PORT" -le 65535 ]; then
            break
        fi
        print_warning "端口必须是 1–65535 的整数，请重新输入"
    done
fi
print_success "监听端口：$BOT_PORT"

# ---- 部署模式 ----

# 上次成功部署记录的模式，只用于判断是否可能遗留直连防火墙规则。
PREVIOUS_DEPLOY_MODE=""
if [ -f "$DEPLOY_MODE_FILE" ]; then PREVIOUS_DEPLOY_MODE="$(tr '[:upper:]' '[:lower:]' < "$DEPLOY_MODE_FILE" | tr -d '[:space:]')"; fi
if [ -n "${DEPLOY_MODE:-}" ]; then
    DEPLOY_MODE_DEFAULT_SOURCE="DEPLOY_MODE"
    DEPLOY_MODE_DEFAULT="$(trim_input "${DEPLOY_MODE,,}")"
elif [ -f "$DEPLOY_MODE_FILE" ]; then
    DEPLOY_MODE_DEFAULT_SOURCE="data/state/deploy-mode"
    DEPLOY_MODE_DEFAULT="$(tr '[:upper:]' '[:lower:]' < "$DEPLOY_MODE_FILE" | tr -d '[:space:]')"
else
    DEPLOY_MODE_DEFAULT_SOURCE=""
    DEPLOY_MODE_DEFAULT="direct"
fi
if [ "$DEPLOY_MODE_DEFAULT" != "direct" ] && [ "$DEPLOY_MODE_DEFAULT" != "cloudflare" ]; then
    print_warning "${DEPLOY_MODE_DEFAULT_SOURCE} 中的部署模式无效，已改用安全默认值 direct：${DEPLOY_MODE_DEFAULT}"
    DEPLOY_MODE_DEFAULT="direct"
fi
if [ "$DEPLOY_MODE_DEFAULT" = "cloudflare" ]; then
    DEPLOY_MODE_DEFAULT_CHOICE="2"
    DEPLOY_MODE_DEFAULT_LABEL="Cloudflare"
else
    DEPLOY_MODE_DEFAULT_CHOICE="1"
    DEPLOY_MODE_DEFAULT_LABEL="直连"
fi

if [ "$RECORDED" = 1 ]; then
    DEPLOY_MODE="$DEPLOY_MODE_DEFAULT"
else
    echo ""
    print_prompt "选择部署模式："
    echo "  1) 直连模式 — 服务器有公网 IP，直接暴露 :${BOT_PORT}（UFW 只放行平台 IP）"
    echo "  2) Cloudflare 模式 — 经 cloudflared 隧道 + WAF（无公网 IP / 想要边缘防护）"
    while true; do
        read_input "输入 1 或 2 [默认 ${DEPLOY_MODE_DEFAULT_CHOICE} / ${DEPLOY_MODE_DEFAULT_LABEL}]：" mode_choice
        mode_choice="$(trim_input "$mode_choice")"
        mode_choice="${mode_choice:-$DEPLOY_MODE_DEFAULT_CHOICE}"
        case "$mode_choice" in
            1) DEPLOY_MODE="direct"; break ;;
            2) DEPLOY_MODE="cloudflare"; break ;;
            *) print_warning "请输入 1 或 2" ;;
        esac
    done
fi
if [ "$DEPLOY_MODE" = "cloudflare" ]; then
    BOT_HOST="127.0.0.1"
    DEPLOY_MODE_LABEL="Cloudflare"
else
    BOT_HOST="0.0.0.0"
    DEPLOY_MODE_LABEL="直连"
fi
print_status "部署模式：$DEPLOY_MODE_LABEL"
if [ "$DEPLOY_MODE" = "cloudflare" ]; then
    print_warning "请把 Cloudflare Tunnel 的 Published application 服务地址设为 http://127.0.0.1:${BOT_PORT}"
fi

# ---- Pi 群数据总根（<group>/workspace + <group>/users/<phone>/{tmp,session.jsonl}）----
GROUP_DATA_ROOT_ENV="$(trim_input "${GROUP_DATA_ROOT:-}")"
if [ -n "$GROUP_DATA_ROOT_ENV" ]; then
    GROUP_DATA_ROOT_DEFAULT="$GROUP_DATA_ROOT_ENV"
elif [ -s "$GROUP_DATA_ROOT_FILE" ]; then
    GROUP_DATA_ROOT_DEFAULT="$(trim_input "$(tr -d '\r\n' < "$GROUP_DATA_ROOT_FILE")")"
else
    GROUP_DATA_ROOT_DEFAULT="$DEFAULT_GROUP_DATA_ROOT"
fi
GROUP_DATA_ROOT="$GROUP_DATA_ROOT_DEFAULT"
GROUP_ROOT_CHECKED=0
while true; do
    # 沿用的群数据根只检查一次；不可用时停止，而不是在停机期间反复询问。
    if [ "$RECORDED" = 1 ] && [ "$GROUP_ROOT_CHECKED" = 1 ]; then
        print_error "群数据总根不可用（原因见上方）；$(settings_fixed_hint)"
        exit 1
    fi
    GROUP_ROOT_CHECKED=1
    cwd_in=""
    if [ "$RECORDED" != 1 ]; then
        read_input "Pi 群数据总根 [默认 ${GROUP_DATA_ROOT_DEFAULT}；首次为 ${DEFAULT_GROUP_DATA_ROOT}]：" cwd_in
    fi
    cwd_in="$(trim_input "$cwd_in")"
    GROUP_DATA_ROOT="${cwd_in:-$GROUP_DATA_ROOT_DEFAULT}"
    if ! HOST_GROUP_DATA_ROOT="$(realpath -m -- "$GROUP_DATA_ROOT")"; then
        print_warning "群数据总根路径无效：$GROUP_DATA_ROOT"
        continue
    fi
    if [ "$HOST_GROUP_DATA_ROOT" = "/" ] || [ "$HOST_GROUP_DATA_ROOT" = "$PROJECT_DIR" ]; then
        print_warning "群数据总根不能是文件系统根目录或项目根目录：$HOST_GROUP_DATA_ROOT"
        continue
    fi
    case "$HOST_GROUP_DATA_ROOT" in
        "$PROJECT_DIR"/*)
            if [ "$HOST_GROUP_DATA_ROOT" != "$DEFAULT_GROUP_DATA_ROOT" ]; then
                print_warning "项目内群数据目录固定为 data/groups；如需自定义，请选择项目外的路径：$HOST_GROUP_DATA_ROOT"
                continue
            fi
            ;;
    esac
    if [ -e "$HOST_GROUP_DATA_ROOT" ] && [ ! -d "$HOST_GROUP_DATA_ROOT" ]; then
        print_warning "群数据总根不是目录：$HOST_GROUP_DATA_ROOT"
        continue
    fi
    if ! mkdir -p -- "$HOST_GROUP_DATA_ROOT"; then
        print_warning "无法创建群数据总根：$HOST_GROUP_DATA_ROOT"
        continue
    fi
    HOST_GROUP_DATA_ROOT="$(realpath -- "$HOST_GROUP_DATA_ROOT")"
    if ! chmod 755 "$HOST_GROUP_DATA_ROOT"; then
        print_warning "无法设置群数据总根权限：$HOST_GROUP_DATA_ROOT"
        continue
    fi
    [ -w "$HOST_GROUP_DATA_ROOT" ] || { print_warning '群数据根不可写'; continue; }
    break
done
group_root_mount "$HOST_GROUP_DATA_ROOT"
if [ "$HOST_GROUP_DATA_ROOT" != "$DEFAULT_GROUP_DATA_ROOT" ]; then
    if [ "$(id -u)" -eq 0 ]; then
        chown "$CONTAINER_UID:$CONTAINER_GID" "$HOST_GROUP_DATA_ROOT"
    fi
    print_warning "主机群数据目录挂到容器 /app/group-data"
fi
print_status "Pi 群数据总根：$HOST_GROUP_DATA_ROOT（容器内：$GROUP_ROOT_ENV_VAL）"
echo ""

# ---- 目录 ----

print_status "设置目录权限..."
# root 部署固定降权到 appuser(1001)；普通 Docker 用户则由容器沿用当前 UID/GID。
if [ "$(id -u)" -eq 0 ]; then
    chown -R "$CONTAINER_UID:$CONTAINER_GID" "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_DIR" "$LOG_DIR" "$PROJECT_DIR/backup"
    chown "$CONTAINER_UID:$CONTAINER_GID" "$HOST_GROUP_DATA_ROOT"
fi
chmod 755 "$DATA_DIR" "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_DIR" "$RUNTIME_HOME_DIR" "$DEFAULT_GROUP_DATA_ROOT" "$LOG_DIR"
print_success "目录就绪"

# ---- 构建镜像 ----

print_status "构建 Docker 镜像..."
if operation_capture docker build -t mixin-chatbot .; then
    print_success "镜像构建成功"
else
    print_error "镜像构建失败"
    exit 1
fi

verify_container_storage() {
    docker run --rm \
      --user "$CONTAINER_UID:$CONTAINER_GID" \
      -e HOME=/app/data/runtime/home \
      -e GROUP_DATA_ROOT="$GROUP_ROOT_ENV_VAL" \
      "${GROUP_ROOT_ARGS[@]}" \
      -v "$(pwd)/logs:/app/logs" \
      -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" \
      --entrypoint sh \
      mixin-chatbot \
      -c 'for directory in /app/data/config /app/data/state /app/data/runtime /app/data/runtime/home /app/logs "$GROUP_DATA_ROOT"; do
              [ -d "$directory" ] && [ -w "$directory" ] || { echo "容器用户不可写: $directory" >&2; exit 1; }
          done
          for file in /app/data/config/models.json /app/data/runtime/pi/settings.json /app/data/config/webhook-secret; do
              [ ! -e "$file" ] || { [ -r "$file" ] && [ -w "$file" ]; } || { echo "容器用户不可读写: $file" >&2; exit 1; }
          done'
}

print_status "验证容器用户对持久化目录的权限..."
if ! verify_container_storage; then
    print_error "容器运行用户（UID ${CONTAINER_UID}）无法读写持久化目录"
    echo "  请修复 data/、logs/ 与群数据根的属主/权限后重试；也可用 sudo 运行部署，让容器固定降权到 UID 1001。"
    exit 1
fi
print_success "持久化目录权限正常"

MIGRATION_PLANNED=0
if [ "$RECORDED" = 1 ] && [ -f "$TRANSACTION_SNAPSHOT/migration-plan.json" ]; then
    # 续做沿用停机前确认的迁移计划；apply 会重新核对配置和版本标记，变化即中止。
    # 快照目录仅部署用户可读，计划复制回容器可读的状态目录。
    cp -- "$TRANSACTION_SNAPSHOT/migration-plan.json" "$STATE_DIR/migration-plan.json" || { print_error "无法恢复停机前确认的迁移计划"; exit 1; }
    # root 复制出的文件属 root；迁移容器以 UID ${CONTAINER_UID} 读取它。
    if [ "$(id -u)" -eq 0 ]; then chown "$CONTAINER_UID:$CONTAINER_GID" "$STATE_DIR/migration-plan.json"; fi
    MIGRATION_PLANNED=1
elif [ -f "$MODELS_FILE" ] && [ -f "$RUNTIME_DIR/pi/settings.json" ]; then
    if ! migration_docker preview "${MIGRATION_PREVIEW_MODE[@]}" --plan "$MIGRATION_PLAN"; then
        if [ "$RECORDED" = 1 ]; then print_error "续做无法沿用迁移确认（原因见上方）；$(settings_fixed_hint)"; fi
        exit 1
    fi
    MIGRATION_PLANNED=1
fi
# ---- 停机前的交互选择：只读取和校验，全部答完才停止机器人服务 ----
RECONFIGURE_AI=0
if [ "$RECORDED" = 1 ]; then
    # 配置向导需要交互；续做从不运行向导，缺少模型配置时停止。
    if [ ! -f "$MODELS_FILE" ]; then
        print_error "缺少 data/config/models.json；$(settings_fixed_hint)"
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

# 域名接受 hostname 或仅含 hostname 的 http(s) 根 URL，并统一规范化为 hostname。
# 显式环境变量会在部署成功后持久化，方便 ops 脚本在后续 shell 中继续做公网健康检查。
PERSIST_BOT_DOMAIN=0
CLEAR_PERSISTED_BOT_DOMAIN=0
INVALID_CONFIGURED_DOMAIN=""
DOMAIN_SOURCE=""
if [ -n "${BOT_DOMAIN:-}" ]; then
    RAW_PUBLIC_DOMAIN="$BOT_DOMAIN"
    DOMAIN_SOURCE="BOT_DOMAIN"
elif [ -f "$BOT_DOMAIN_FILE" ]; then
    RAW_PUBLIC_DOMAIN="$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$BOT_DOMAIN_FILE")"
    DOMAIN_SOURCE="data/state/bot-domain"
else
    RAW_PUBLIC_DOMAIN=""
fi
PUBLIC_DOMAIN=""
if [ -n "$RAW_PUBLIC_DOMAIN" ]; then
    if PUBLIC_DOMAIN="$(normalize_hostname_input "$RAW_PUBLIC_DOMAIN")"; then
        if [ "$DOMAIN_SOURCE" = "BOT_DOMAIN" ] || [ "$PUBLIC_DOMAIN" != "$RAW_PUBLIC_DOMAIN" ]; then
            PERSIST_BOT_DOMAIN=1
        fi
    else
        INVALID_CONFIGURED_DOMAIN="$RAW_PUBLIC_DOMAIN"
        PUBLIC_DOMAIN=""
        if [ "$DOMAIN_SOURCE" = "data/state/bot-domain" ]; then
            CLEAR_PERSISTED_BOT_DOMAIN=1
        fi
    fi
fi
if [ "$RECORDED" = 1 ]; then
    # 续做使用停机前确认的域名及其写回方式。
    PUBLIC_DOMAIN="${TRANSACTION[bot_domain]}"
    PERSIST_BOT_DOMAIN=0
    CLEAR_PERSISTED_BOT_DOMAIN=0
    case "${TRANSACTION[domain_action]}" in
        persist) PERSIST_BOT_DOMAIN=1 ;;
        clear) CLEAR_PERSISTED_BOT_DOMAIN=1 ;;
    esac
elif [ -n "$INVALID_CONFIGURED_DOMAIN" ]; then
    print_warning "$DOMAIN_SOURCE 中的域名无效，已忽略：$INVALID_CONFIGURED_DOMAIN"
fi
if [ "$DEPLOY_MODE" = "cloudflare" ] && [ "$RECORDED" != 1 ]; then
    echo "Cloudflare 公网域名准备："
    echo "  1) 将根域名（如 example.com）添加到 Cloudflare，按指引在域名注册商修改 NS，等待状态变为 Active（已激活）。域名无需转移注册商，但 DNS 需托管到 Cloudflare。"
    echo "  2) 下面填写机器人使用的子域名，例如 bot.example.com。"
    echo "  3) 在同一 Cloudflare 账户的 Networking → Tunnels 中创建或选择 Cloudflared 隧道；Published application 路由填相同子域名，服务地址设为 http://127.0.0.1:${BOT_PORT}。"
    echo "DNS 接入和公开路由需在控制台完成；此处填写域名不会自动创建它们。可留空稍后配置，公网回调需配置完成后才能使用。"
    DOMAIN_DEFAULT="$PUBLIC_DOMAIN"
    while true; do
        if [ -n "$DOMAIN_DEFAULT" ]; then
            read_input "Cloudflare 公网域名 [默认 ${DOMAIN_DEFAULT}；支持完整根 URL]：" domain_in
        else
            read_input "Cloudflare 公网域名（可留空；支持 im-bot.example.com 或 https://im-bot.example.com）：" domain_in
        fi
        if [ -z "$domain_in" ]; then
            PUBLIC_DOMAIN="$DOMAIN_DEFAULT"
            break
        fi
        if PUBLIC_DOMAIN="$(normalize_hostname_input "$domain_in")"; then
            PERSIST_BOT_DOMAIN=1
            if [ "$PUBLIC_DOMAIN" != "$domain_in" ]; then
                print_success "已规范化公网域名：$PUBLIC_DOMAIN"
            fi
            break
        fi
        print_warning "域名格式无效；请输入纯 hostname，或只含 hostname 的 http(s) URL（不能带端口、路径、查询参数）"
    done
fi

# 外部 connector 不能仅凭进程名认领；此时尚未停止服务，拒绝不会改动部署。
UNMANAGED_TUNNEL_CONFIRMED=0
if ! managed_cloudflared_pid >/dev/null 2>&1 && pgrep -x cloudflared >/dev/null 2>&1; then
    unmanaged_pid="$(pgrep -x cloudflared | head -n1)"
    if [ "$PREPARED_UNMANAGED_MODE" = "$DEPLOY_MODE" ]; then
        # 事务记录中已有停机前按同一模式确认的归属。
        print_status "沿用停机前对未托管 cloudflared（pid ${unmanaged_pid}）的确认"
    elif [ "$DEPLOY_MODE" = "cloudflare" ]; then
        print_warning "检测到未由本项目记录的 cloudflared（pid ${unmanaged_pid}），无法自动确认它连接的是当前隧道"
        unmanaged_prompt="确认该 connector 正在服务本项目，继续沿用？[y/N]："
    else
        print_warning "系统有未由本项目记录的 cloudflared（pid ${unmanaged_pid}）；不会自动停止，以免影响其他隧道"
        unmanaged_prompt="确认该 connector 与本项目无关或其入口仍受保护，继续直连部署？[y/N]："
    fi
    if [ "$PREPARED_UNMANAGED_MODE" != "$DEPLOY_MODE" ]; then
        # 续做不提问：停机前没有确认过的 connector 只能处理后重试，或回滚。
        if [ "$RECORDED" = 1 ]; then print_error "停机前没有确认过这个 cloudflared；$(settings_fixed_hint)"; exit 1; fi
        if ! ask_yes_no "$unmanaged_prompt" "n"; then
            print_error "未确认未托管 cloudflared 的安全边界；部署已取消，配置未改动"
            exit 1
        fi
    fi
    UNMANAGED_TUNNEL_CONFIRMED=1
fi

# 缺少 connector 时在停机前确定 token 来源（输入隐藏）；部署验证实例就绪后只启动一次。
TUNNEL_TOKEN_INPUT=""
if [ "$DEPLOY_MODE" = "cloudflare" ] && ! managed_cloudflared_pid >/dev/null 2>&1 && ! pgrep -x cloudflared >/dev/null 2>&1; then
    if [ -n "$PREPARED_TUNNEL_INPUT" ] && (load_tunnel_token "$PREPARED_TUNNEL_INPUT") >/dev/null 2>&1; then
        TUNNEL_TOKEN_INPUT="$PREPARED_TUNNEL_INPUT"
        print_status "未运行 cloudflared；沿用升级器在停机前确认的隧道 token，部署验证实例就绪后启动"
    elif (load_tunnel_token) >/dev/null 2>&1; then
        print_status "未运行 cloudflared；将使用已保存的隧道 token，部署验证实例就绪后启动"
    elif [ "$RECORDED" = 1 ]; then
        # 停机前输入的 token 不写入事务记录；重启后的续做只能使用已保存的来源。
        print_error "续做需要隧道 token，但没有可用的已保存 token；请保存到 data/config/cloudflared-token 后重试继续，或回滚（$(ops_command_hint rollback)）"
        exit 1
    else
        print_status "未运行 cloudflared；请先提供隧道 token，部署验证实例就绪后启动"
        show_tunnel_token_help
        while true; do
            read_input "隧道 token 或文件路径（输入隐藏；留空自动读取，默认 data/config/cloudflared-token）：" TUNNEL_TOKEN_INPUT 1
            if (load_tunnel_token "$TUNNEL_TOKEN_INPUT"); then break; fi
        done
    fi
fi
PREPARED_TUNNEL_INPUT=""

# Decisions precede persistent changes; a continued transaction reopens its original snapshot.
begin_deployment
if [ "$MIGRATION_PLANNED" = 1 ]; then
    # The upgrader keeps the target code on this receipt after abrupt termination;
    # a completed rollback clears it before the upgrader restores the original code.
    if [ -n "${BOT_UPDATE_COMMIT_FILE:-}" ]; then printf 'committed\n' > "$BOT_UPDATE_COMMIT_FILE"; fi
    MIGRATION_APPLY_ATTEMPTED=1
    migration_docker apply --plan "$MIGRATION_PLAN"
fi

# ---- AI 配置（容器内 TUI 写 data/config/models.json）----
# 首次必须配置；已存在时按停机前的选择决定是否重配。

if [ ! -f "$MODELS_FILE" ]; then
    print_status "首次配置 AI（provider/key/model）..."
    if ! docker run --rm -it --user "$CONTAINER_UID:$CONTAINER_GID" -e HOME=/app/data/runtime/home -e BOT_DEPLOY_BACKUP_ID -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" mixin-chatbot bun run configure; then
        print_error "AI 配置命令执行失败"
        exit 1
    fi
    if [ ! -f "$MODELS_FILE" ]; then
        print_error "未生成 data/config/models.json，已中止"
        exit 1
    fi
elif [ "$RECONFIGURE_AI" = 1 ]; then
    print_status "重新配置 AI（provider/key/model）..."
    if ! docker run --rm -it --user "$CONTAINER_UID:$CONTAINER_GID" -e HOME=/app/data/runtime/home -e BOT_DEPLOY_BACKUP_ID -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" mixin-chatbot bun run configure; then
        print_error "AI 配置命令执行失败"
        exit 1
    fi
fi
validate_model_configuration || { print_error "模型配置无效，正在恢复原部署"; exit 1; }
if [ "$(id -u)" -eq 0 ]; then
    chown "$CONTAINER_UID:$CONTAINER_GID" "$MODELS_FILE"
fi
chmod 600 "$MODELS_FILE"

# ---- Webhook 随机密钥路径（两模式共用，应用层鉴权）----
# data/config/webhook-secret 存 64hex（256bit）；应用启动读它，存在则启用 /webhook/<secret>。
if [ ! -f "$WEBHOOK_SECRET_FILE" ]; then
    print_status "生成 webhook 随机密钥路径..."
    if SECRET=$(openssl rand -hex 32 2>/dev/null) && [ -n "$SECRET" ]; then
        : # openssl 可用
    else
        SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n') # 回退
    fi
    printf '%s' "$SECRET" > "$WEBHOOK_SECRET_FILE"
    if [ "$(id -u)" -eq 0 ]; then
        chown "$CONTAINER_UID:$CONTAINER_GID" "$WEBHOOK_SECRET_FILE"
    fi
    chmod 600 "$WEBHOOK_SECRET_FILE"
    print_success "已生成 webhook 密钥"
    SHOW_SECRET=1
else
    SECRET="$(tr -d '[:space:]' < "$WEBHOOK_SECRET_FILE")"
    if ! [[ "$SECRET" =~ ^[0-9a-fA-F]{64}$ ]]; then
        print_error "data/config/webhook-secret 格式无效（应为 64 位十六进制）；请停机并将该文件移入 backup/rm 后重新部署"
        exit 1
    fi
    SHOW_SECRET=0
    print_status "检测到已有 data/config/webhook-secret（沿用）"
fi
if ! verify_container_storage; then
    print_error "models.json 或 webhook-secret 对容器用户（UID ${CONTAINER_UID}）不可读写；请修复目录/文件权限后重试"
    exit 1
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
SERVER_IP="${SERVER_IP:-<服务器IP>}"

echo ""
print_prompt "把回调地址填到 IM 平台（webhook URL）："
if [ "$DEPLOY_MODE" = "direct" ]; then
    if [ "$SHOW_SECRET" = "1" ]; then
        echo "    http://${SERVER_IP}:${BOT_PORT}/webhook/$SECRET"
    else
        echo "    http://${SERVER_IP}:${BOT_PORT}/webhook/<secret>（密钥未变；忘记可 cat data/config/webhook-secret）"
    fi
    echo ""
    print_warning "直连走 HTTP：secret 在 URL 里明文经「平台→服务器」传输，网络层必须只允许配置的回调来源访问"
    if [ "${ALLOW_UNMANAGED_FIREWALL:-0}" = "1" ]; then
        print_warning "已显式跳过 UFW 安全基线；请确认云防火墙/其他系统防火墙已限制 TCP ${BOT_PORT}"
    else
        print_warning "确认 UFW：sudo ufw status（应仅允许配置的回调来源访问 TCP ${BOT_PORT}）"
    fi
    print_warning "有域名想加密可自行套 nginx/caddy + 证书反代到 :${BOT_PORT}（URL 改 https://<域名>/webhook/<secret>）"
else
    PUBLIC_DOMAIN_DISPLAY="${PUBLIC_DOMAIN:-<你的域名>}"
    if [ "$SHOW_SECRET" = "1" ]; then
        echo "    https://${PUBLIC_DOMAIN_DISPLAY}/webhook/$SECRET"
    else
        echo "    https://${PUBLIC_DOMAIN_DISPLAY}/webhook/<secret>（密钥未变；忘记可 cat data/config/webhook-secret）"
    fi
    echo ""
    print_status "Cloudflare 模式仅监听 127.0.0.1:${BOT_PORT}，不会直接暴露公网端口"
    print_warning "部署末尾会启动 cloudflared connector；远程管理隧道的源站端口需在 Cloudflare 控制台配置为 http://127.0.0.1:${BOT_PORT}"
    print_warning "WAF 应只限制 /webhook/ 前缀：平台 IP + POST 放行，其他 webhook 请求 Block；可保留 /favicon.svg 供健康检查"
fi
if [ "$SHOW_SECRET" = "1" ]; then
    print_warning "密钥仅本次显示、不进容器日志；轮换时停机并将 data/config/webhook-secret 移入 backup/rm 后重新部署"
fi
echo ""

# ---- 切换网络入口 ----
# 旧容器已在修改配置之前停止并备份，后续失败由部署事务恢复。
if [ "$DEPLOY_MODE" = "direct" ]; then
    if command -v ufw >/dev/null 2>&1 && can_manage_ufw; then
        print_status "同步 UFW 规则到端口 ${BOT_PORT}..."
        # 先写入新入口；旧规则到新部署提交时才删除，失败回滚仍保留原入口。
        UFW_RULE_WRITTEN=0
        if run_ufw allow from "$PLATFORM_IP" to any port "$BOT_PORT" proto tcp comment 'Mixin-Chatbot (平台IP)'; then
            UFW_RULE_WRITTEN=1
        else
            if [ "${ALLOW_UNMANAGED_FIREWALL:-0}" != "1" ]; then
                print_error "无法写入 UFW 规则；直连模式拒绝在 0.0.0.0 上启动"
                echo "  修复 UFW/sudo，或确认已有等效云防火墙后显式设置 ALLOW_UNMANAGED_FIREWALL=1。"
                exit 1
            fi
            print_warning "ALLOW_UNMANAGED_FIREWALL=1：UFW 规则写入失败，依赖你已配置的外部防火墙"
        fi
        if [ "$UFW_RULE_WRITTEN" = "1" ]; then
            # 旧入口保留到新容器健康且模式切换完成，便于失败时恢复旧容器。
            CLEANUP_UFW_AFTER_HEALTH=1
        fi
        if [ "$UFW_RULE_WRITTEN" = "1" ] && run_ufw status | grep -q "Status: active"; then
            print_success "UFW 已确认允许配置的回调来源访问 TCP ${BOT_PORT}"
        elif [ "${ALLOW_UNMANAGED_FIREWALL:-0}" = "1" ]; then
            print_warning "ALLOW_UNMANAGED_FIREWALL=1：UFW 未启用，依赖你已配置的外部防火墙"
        else
            print_error "UFW 未启用；直连模式拒绝在 0.0.0.0 上启动"
            echo "  请按主机运维策略配置防火墙，或确认已有等效云防火墙后设置 ALLOW_UNMANAGED_FIREWALL=1。"
            exit 1
        fi
    elif [ "${ALLOW_UNMANAGED_FIREWALL:-0}" = "1" ]; then
        print_warning "ALLOW_UNMANAGED_FIREWALL=1：UFW 不可管理，依赖你已配置的外部防火墙"
    else
        print_error "UFW 不可用或当前用户没有 root/sudo 权限；直连模式拒绝在 0.0.0.0 上启动"
        echo "  修复 UFW/sudo，或确认已有等效云防火墙后显式设置 ALLOW_UNMANAGED_FIREWALL=1。"
        exit 1
    fi
else
    if command -v ufw >/dev/null 2>&1 && can_manage_ufw; then
        CLEANUP_UFW_AFTER_HEALTH=1
    elif [ "$PREVIOUS_DEPLOY_MODE" = direct ]; then
        # 只有从直连模式切换过来时才可能遗留本项目的直连规则。
        print_warning "UFW 不可用或当前用户没有 root/sudo 权限；无法自动清理原直连模式的防火墙规则"
    fi
fi

# 旧容器和配置已在 begin_deployment 中保存。

if [ "$MIGRATION_PLANNED" = 0 ]; then
    migration_docker preview "${MIGRATION_PREVIEW_MODE[@]}" --plan "$MIGRATION_PLAN"
    if [ -n "${BOT_UPDATE_COMMIT_FILE:-}" ]; then printf 'committed\n' > "$BOT_UPDATE_COMMIT_FILE"; fi
    MIGRATION_APPLY_ATTEMPTED=1
    migration_docker apply --plan "$MIGRATION_PLAN"
fi
# The scheduled/container entry reads this flag; readiness cannot accept messages.
printf 'verify\n' > "$PROJECT_DIR/data/state/verify-only"

# 持久化受支持的显式环境配置；容器路径由部署计算，其他值沿用 runtime.json。
runtime_env_args=()
for runtime_key in "${RUNTIME_ENV_KEYS[@]}"; do
    if [ -n "${!runtime_key:-}" ]; then runtime_env_args+=(-e "$runtime_key"); fi
done
docker run --rm --user "$CONTAINER_UID:$CONTAINER_GID" \
  -e GROUP_DATA_ROOT="$GROUP_ROOT_ENV_VAL" -e BOT_PORT="$BOT_PORT" -e BOT_HOST="$BOT_HOST" \
  -e BOT_DEPLOY_BACKUP_ID "${runtime_env_args[@]}" -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" \
  mixin-chatbot bun run scripts/config/runtime-settings.ts

# ---- 启动容器 ----

print_status "启动容器..."
NEW_CONTAINER_ATTEMPTED=1
if docker run -d \
  --init \
  --user "$CONTAINER_UID:$CONTAINER_GID" \
  --network host \
  -e HOME=/app/data/runtime/home \
  -e GROUP_DATA_ROOT="$GROUP_ROOT_ENV_VAL" \
  -e BOT_PORT="$BOT_PORT" \
  -e BOT_HOST="$BOT_HOST" \
  "${GROUP_ROOT_ARGS[@]}" \
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
  mixin-chatbot; then
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
    if [ "$(docker inspect --format='{{.State.Running}}' mixin-chatbot 2>/dev/null || echo false)" != true ]; then
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

# ---- Cloudflare 模式：确保 cloudflared 在线 ----
# 停机后不再询问：token 已在停机前确认，connector 只启动一次，失败或出现未确认的 connector 即回滚。
if [ "$DEPLOY_MODE" = "cloudflare" ]; then
    print_status "Cloudflare 模式：确保 cloudflared 隧道在线..."
    if managed_pid="$(managed_cloudflared_pid)"; then
        print_success "本项目 cloudflared 已在运行（pid ${managed_pid}）"
    elif pgrep -x cloudflared >/dev/null 2>&1; then
        unmanaged_pid="$(pgrep -x cloudflared | head -n1)"
        if [ "$UNMANAGED_TUNNEL_CONFIRMED" != "1" ]; then
            print_error "部署期间出现未托管的 cloudflared（pid ${unmanaged_pid}），无法确认它连接的是当前隧道；部署将回滚。确认其归属后重新部署。"
            exit 1
        fi
    elif [ -f scripts/tunnel/start-tunnel.sh ]; then
        mkdir -p "$LOG_DIR"
        # 下载在前台完成，不占用后台连接器的 30 秒启动等待窗口。
        ensure_cloudflared "$PROJECT_DIR" >/dev/null
        print_status "启动 cloudflared 隧道连接器（使用停机前确认的 token 来源）..."
        tunnel_startup_log="$(mktemp "$STATE_DIR/cloudflared-start-XXXXXX")"
        # 提交前运行的是验证实例；连接器启动检查需要明确放行它，否则会判定为本机没有机器人。
        CLOUDFLARED_BACKGROUND=1 MIXIN_TUNNEL_ALLOW_VERIFICATION=1 MIXIN_TUNNEL_TOKEN_INPUT="$TUNNEL_TOKEN_INPUT" BOT_PORT="$BOT_PORT" nohup bash ./scripts/tunnel/start-tunnel.sh >"$tunnel_startup_log" 2>&1 9>&- &
        tunnel_launcher_pid=$!
        TUNNEL_TOKEN_INPUT=""
        tunnel_launcher_start="$(process_start_identity "$tunnel_launcher_pid")"
        TUNNEL_STARTED_BY_DEPLOY=1
        for attempt in $(seq 1 30); do
            managed_cloudflared_pid >/dev/null 2>&1 && break
            kill -0 "$tunnel_launcher_pid" 2>/dev/null || break
            sleep 1
        done
        if ! managed_pid="$(managed_cloudflared_pid)"; then
            stop_tunnel_launcher || { print_error "无法结束连接器启动进程"; exit 1; }
            tunnel_launcher_pid=""
            print_warning "cloudflared 未能启动，启动检查输出："
            tail -n 10 "$tunnel_startup_log" 2>/dev/null || true
            rm -f -- "$tunnel_startup_log"
            tunnel_startup_log=""
            if [ "$(cloudflared_logging)" = on ]; then tail -n 10 "$LOG_DIR/cloudflared.log" 2>/dev/null || true; fi
            print_error "cloudflared 未能启动（见上方输出）；部署将回滚。确认 token 后重新部署或升级。"
            exit 1
        fi
        rm -f -- "$tunnel_startup_log"
        tunnel_startup_log=""
        print_success "cloudflared 已后台启动（pid ${managed_pid}）"
        if [ "$(cloudflared_logging)" = on ]; then
            print_success "隧道日志：logs/cloudflared.log（自动轮转）"
        else
            print_status "隧道文件日志已关闭，可在 TUI「系统 → 设置」开启"
        fi
        print_warning "持久化建议：配 systemd 服务（开机自启 + 崩溃重启）；当前 nohup 仅本次运行"
    else
        print_error "未找到 scripts/tunnel/start-tunnel.sh，无法启动 Cloudflare 隧道"
        exit 1
    fi
else
    if managed_pid="$(managed_cloudflared_pid)"; then
        print_status "直连模式：停止本项目记录的 cloudflared（pid ${managed_pid}）..."
        if stop_managed_cloudflared; then
            print_success "本项目 cloudflared 已停止，旧隧道入口不再由本机 connector 提供"
        else
            print_error "无法停止本项目 cloudflared（pid ${managed_pid}）；为避免保留旧隧道入口，部署未完成"
            exit 1
        fi
    elif pgrep -x cloudflared >/dev/null 2>&1; then
        unmanaged_pid="$(pgrep -x cloudflared | head -n1)"
        if [ "$UNMANAGED_TUNNEL_CONFIRMED" != "1" ]; then
            print_error "部署期间出现未由本项目记录的 cloudflared（pid ${unmanaged_pid}），无法确认遗留隧道的安全边界；部署将回滚。确认其归属后重新部署。"
            exit 1
        fi
    fi
fi

if [ "${CLEANUP_UFW_AFTER_HEALTH:-0}" = "1" ]; then
    if [ "$DEPLOY_MODE" = "direct" ]; then
        remove_managed_ufw_rules "$BOT_PORT" "$PLATFORM_IP"
        if [ "$REMOVED_UFW_RULES" -gt 0 ]; then print_success "已删除 ${REMOVED_UFW_RULES} 条本项目旧 UFW 规则，只保留当前机器人入口"; fi
    else
        remove_managed_ufw_rules
        if [ "$REMOVED_UFW_RULES" -gt 0 ]; then print_success "Cloudflare 模式已删除 ${REMOVED_UFW_RULES} 条本项目旧直连 UFW 规则"; fi
    fi
fi

# 只有部署预检通过且部署模式切换完成后才提交状态，避免运维脚本读取到半完成配置。
print_status "提交部署..."
printf '%s' "$BOT_PORT" > "$BOT_PORT_FILE"
printf '%s' "$DEPLOY_MODE" > "$DEPLOY_MODE_FILE"
printf '%s' "$HOST_GROUP_DATA_ROOT" > "$GROUP_DATA_ROOT_FILE"
if [ "$PERSIST_BOT_DOMAIN" = "1" ]; then
    printf '%s' "$PUBLIC_DOMAIN" > "$BOT_DOMAIN_FILE"
elif [ "$CLEAR_PERSISTED_BOT_DOMAIN" = "1" ]; then
    archive_project_path "$BOT_DOMAIN_FILE"
fi

# Stop the verification-only process before committing. Normal work starts after commit.
docker stop --time 30 mixin-chatbot >/dev/null
migration_docker commit
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
    if [ "$DEPLOY_MODE" = "direct" ]; then
        echo "  模式:      直连（来源 IP 闸门）"
        echo "  回调地址:   http://${SERVER_IP}:${BOT_PORT}/webhook/<secret>"
    else
        echo "  模式:      Cloudflare（隧道 + WAF）"
        echo "  回调地址:   https://${PUBLIC_DOMAIN_DISPLAY}/webhook/<secret>"
    fi
    echo "  AI 配置:   $(pwd)/data/config/models.json"
    echo "  日志:      $(pwd)/logs/"
    echo "  数据:      $(pwd)/data/"
    echo "  群数据根:  $HOST_GROUP_DATA_ROOT"
    echo "  可选外链:  bun run tui → 系统 → 设置 → 外链配置"
    echo "  监听:      $BOT_HOST:$BOT_PORT"
    echo ""
    echo "  内存限制: 512MB | CPU: 1核"
    echo ""
    echo "  常用操作（带健康检查、隧道判断和失败回滚）:"
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
