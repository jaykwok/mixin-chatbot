#!/usr/bin/env bash
# mixin-bot 运维工具（Linux / Docker）。
# 用法：./scripts/ops.sh <命令>；不带参数显示完整帮助。
set -uo pipefail

OPS_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="${MIXIN_OPS_PROJECT:-$OPS_SOURCE_DIR}"
# 与部署脚本共用校验、健康检查和生命周期函数。
COMMON_LIB="${OPS_SOURCE_DIR}/scripts/lib/common.sh"
if [ ! -f "$COMMON_LIB" ]; then
    echo "缺少 ${COMMON_LIB}；请从仓库完整获取脚本目录后重试。" >&2
    exit 1
fi
# shellcheck source=lib/common.sh
. "$COMMON_LIB"
. "${OPS_SOURCE_DIR}/scripts/lib/task-runtime.sh"
. "${OPS_SOURCE_DIR}/scripts/lib/ops-runtime.sh"
CONTAINER="mixin-bot"
ROLLBACK_CONTAINER="${CONTAINER}-rollback"
DATA_DIR="${PROJECT_DIR}/data"
CONFIG_DIR="${DATA_DIR}/config"
STATE_DIR="${DATA_DIR}/state"
MODELS_FILE="${CONFIG_DIR}/models.json"
APP_BOT_FILE="${CONFIG_DIR}/app-bot.json"
RELAY_CONFIG_FILE="${CONFIG_DIR}/relay.json"
BOT_PORT_FILE="${STATE_DIR}/bot-port"
# 已保存的本机端口和外置共享资料目录（空为默认 data/workspace）。普通操作再叠加 BOT_PORT 环境变量（见文件末尾的入口判断）；
# 升级、继续和回滚只用已保存设置或事务记录，升级结束后的体检也重新读取这里。
load_saved_settings() {
    PORT="1011"
    if [ -f "$BOT_PORT_FILE" ]; then PORT="$(tr -d '[:space:]' < "$BOT_PORT_FILE")"; fi
    DEPLOYED_WORKSPACE_ROOT="$(saved_workspace_root)"
}
load_saved_settings
# 普通操作使用已保存设置，入口处先校验。部署脚本自行校验并提供修正；
# 继续或回滚只使用事务记录（use_transaction_settings），普通设置损坏不能挡住恢复入口。
check_ordinary_settings() {
    if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
        echo "BOT_PORT/data/state/bot-port 中的端口无效：$PORT" >&2
        exit 1
    fi
}

# 未完成的部署事务：端口和共享资料目录取自记录（续做结束后的体检也用它们）。
# 记录无法读取时保持原值，由部署脚本报告原因。
use_transaction_settings() {
    [ -e "$STATE_DIR/deploy-transaction" ] && load_pending_transaction >/dev/null 2>&1 || return 0
    PORT="${TRANSACTION[bot_port]}"
    DEPLOYED_WORKSPACE_ROOT="${TRANSACTION[target_workspace_root]}"
}

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
P()  { echo -e "${BLUE}[*]${NC} $1"; operation_event info "$1"; }
OK() { echo -e "${GREEN}[+]${NC} $1"; operation_event info "$1"; }
WA() { echo -e "${YELLOW}[!]${NC} $1"; operation_event warn "$1"; }
ER() { echo -e "${RED}[x]${NC} $1"; operation_event error "$1"; }

ask_yes_no() {
    local prompt="$1" answer=""
    while true; do
        if ! IFS= read -r -p "$prompt" answer; then
            echo ""
            WA "输入已结束，按默认值“否”处理"
            return 1
        fi
        answer="$(printf '%s' "$answer" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        answer="${answer,,}"
        case "$answer" in
            ""|n|no|否) return 1 ;;
            y|yes|是) return 0 ;;
            *) WA "请输入 y 或 n（也可直接回车采用默认值）" ;;
        esac
    done
}

# doctor --json 让控制台复用同一套体检，而不是自己再实现一遍 docker/配置的判断。
# 逐项结果在 check() 里顺手攒起来，人类可读的输出一个字不改。
JSON_OUTPUT=0
JSON_ROWS=""

# 只处理 JSON 字符串里必须转义的字符：反斜杠、双引号和控制字符。
# 详情里带的是路径和 URL，出现反斜杠（Windows 路径）和引号都不稀奇。
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'
}

PASS=0; FAIL=0; CHECK_WARN=0
check() {
    local name="$1" ok="$2" detail="$3" fix="${4:-}"
    [ "$ok" = "1" ] && fix=""
    if [ "$JSON_OUTPUT" = "1" ]; then
        # status 用 pass/warn/fail 三态而不是布尔：Windows 那边的体检本来就分三档，
        # 两个平台吐同一个 schema，尚未验证的检查明确显示 warn。
        local row status
        case "$ok" in 1) status=pass ;; warn) status=warn ;; *) status=fail ;; esac
        row="{\"name\":\"$(json_escape "$name")\",\"status\":\"${status}\",\"detail\":\"$(json_escape "$detail")\",\"fix\":\"$(json_escape "$fix")\"}"
        JSON_ROWS="${JSON_ROWS:+${JSON_ROWS},}${row}"
    fi
    case "$ok" in 1) PASS=$((PASS+1)) ;; warn) CHECK_WARN=$((CHECK_WARN+1)) ;; *) FAIL=$((FAIL+1)) ;; esac
    [ "$JSON_OUTPUT" = "1" ] && return 0
    if [ "$ok" = "1" ]; then OK "$(printf '%-30s %s' "$name" "$detail")"
    elif [ "$ok" = "warn" ]; then WA "$(printf '%-30s %s' "$name" "$detail")"
    else ER "$(printf '%-30s %s' "$name" "$detail")"; fi
}

# JSON 模式下把提示类输出静音：stdout 必须是一份干净的 JSON，混进一行中文提示就没法解析了。
if [ "${1:-}" = "doctor" ] || [ "${1:-}" = "status" ]; then
    case "${2:-}" in
        --json)
            JSON_OUTPUT=1
            P()  { :; }
            OK() { :; }
            WA() { :; }
            ER() { :; }
            ;;
    esac
fi

wait_for_local() {
    local attempt
    for attempt in $(seq 1 10); do
        if bot_local_ready "$PORT" >/dev/null 2>&1; then return 0; fi
        [ "$attempt" -eq 10 ] || sleep 1
    done
    return 1
}

has_container() {
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"
}

has_rollback_container() {
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${ROLLBACK_CONTAINER}$"
}

# S3 credentials are never sent to curl or placed on the command line.
# Full configuration validation occurs in the runtime; this check is intentionally read-only.
check_relay() {
    [ -f "$RELAY_CONFIG_FILE" ] || return 0
    if ! command -v jq >/dev/null 2>&1; then
        check "S3 外链" "warn" "配置已存在；缺少 jq，尚未校验" "启动时执行完整格式校验；请用 relay-test 验收实际云端配置。"
        return 0
    fi
    if ! jq -e 'type == "object" and .provider == "s3" and
        ([.endpoint,.region,.bucket,.accessKeyId,.secretAccessKey] | all(type == "string" and length > 0))' "$RELAY_CONFIG_FILE" >/dev/null 2>&1; then
        check "data/config/relay.json" "0" "S3 必填项不全，请重新运行外链向导"
        return 0
    fi
    check "S3 外链配置必填项" "1" "必填项齐全；启动时执行完整格式校验" "此项不检测云端权限、私有访问和签名；云端设置变化后请用 relay-test 验收。"
}

doctor() {
    P "mixin-bot 健康检查（本机端口=$PORT）"
    PASS=0; FAIL=0; CHECK_WARN=0; JSON_ROWS=""

    # 外置资料目录缺失时服务拒绝启动（不会当成空资料目录）；默认目录由服务创建。
    local workspace_ok="1" workspace_detail="${DATA_DIR}/workspace（默认）"
    if [ -n "$DEPLOYED_WORKSPACE_ROOT" ]; then
        workspace_detail="$DEPLOYED_WORKSPACE_ROOT（只读挂载）"
        [ -d "$DEPLOYED_WORKSPACE_ROOT" ] || { workspace_ok="0"; workspace_detail="外置目录不存在：$DEPLOYED_WORKSPACE_ROOT"; }
    fi
    check "共享资料目录" "$workspace_ok" "$workspace_detail" "恢复该目录或挂载；改用其他目录请用 WORKSPACE_ROOT=<目录> $(ops_command_hint deploy)。"

    local cstate="缺少"
    if has_container; then
        cstate="$(docker container inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "?")"
    fi
    local cstate_label="$cstate"
    [ "$cstate" = "running" ] && cstate_label="运行中"
    [ "$cstate" = "exited" ] && cstate_label="已退出"
    check "容器" "$([ "$cstate" = "running" ] && echo 1 || echo 0)" "$cstate_label" \
        "使用 $(ops_command_hint start)；尚未部署时请使用 $(ops_command_hint deploy)。"
    check "部署回滚容器" "$(! has_rollback_container && echo 1 || echo 0)" \
        "$(! has_rollback_container && echo 无 || echo "发现 ${ROLLBACK_CONTAINER}，请确认后恢复或删除")"

    local health_status=0
    bot_local_ready "$PORT" >/dev/null 2>&1 || health_status=$?
    if [ "$health_status" = 0 ]; then check "本地机器人健康" 1 "就绪且实例身份匹配"
    elif [ "$health_status" = 3 ]; then check "本地机器人健康" 0 "只验证实例，不处理消息" "使用 $(ops_command_hint resume) 继续上次操作并完成提交。"
    else check "本地机器人健康" 0 "未就绪或实例身份不匹配" \
        "使用 $(ops_command_hint restart)，再到 $(ops_command_hint logs) 查看日志。"; fi

    # Stream 与通讯录状态只读运行中服务的 /health，不另开 Stream 连接（同一应用只能有一条）。
    if [ "$health_status" = 0 ]; then
        local row_status row_name row_detail row_fix rows
        if rows="$(service_bun ops/tools/directory-admin.ts doctor 2>/dev/null)"; then
            while IFS=$'\t' read -r row_status row_name row_detail; do
                [ -n "$row_name" ] || continue
                row_fix=""
                case "$row_name" in
                    事件\ Stream) row_fix="检查出站访问 imtwo.zdxlz.com 的 443 端口和应用凭据（$(ops_command_hint configure-app-bot)），再查看 $(ops_command_hint logs)。" ;;
                    通讯录同步) row_fix="服务会自动重试和复核；用 $(ops_command_hint directory) 查看范围状态和原因，长时间没有恢复时查看 $(ops_command_hint logs)。" ;;
                    运行状况) row_fix="在 $(ops_command_hint logs) 中查看对应记录（Durable 报告、交付超时放弃、统计累计值回退等）；停住的任务由成员用 /status 查看、/stop 或 /clear 结束。" ;;
                esac
                case "$row_status" in pass) row_status=1 ;; warn) ;; *) row_status=0 ;; esac
                check "$row_name" "$row_status" "$row_detail" "$row_fix"
            done <<< "$rows"
        else
            check "事件 Stream" warn "无法读取服务状态" "查看 $(ops_command_hint logs)。"
        fi
    fi
    # 版本取自运行中服务的 /health；服务未运行时取部署记录。本地代码不同于运行版本时另起一行说明。
    local version_rows version_name version_value health_body=""
    [ "$health_status" = 0 ] && health_body="$(curl --noproxy '*' --max-time 3 -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
    if version_rows="$(printf '%s' "$health_body" | service_bun ops/tools/version-info.ts --health-stdin 2>/dev/null)"; then
        while IFS=$'\t' read -r version_name version_value; do
            [ -n "$version_name" ] || continue
            case "$version_value" in
                未知：*) check "$version_name" 0 "$version_value" "部署记录无法读取；不要在此目录覆盖部署，参见 docs/data-migrations.md。" ;;
                *) check "$version_name" 1 "$version_value" ;;
            esac
        done <<< "$version_rows"
    else
        check "应用机器人" warn "无法读取版本信息"
    fi
    if [ -s "$APP_BOT_FILE" ]; then check "data/config/app-bot.json" 1 "已配置（不显示凭据）"
    else check "data/config/app-bot.json" 0 "缺少（服务拒绝启动）" "使用 $(ops_command_hint configure-app-bot) 填写 AppID 和 AppSecret。"; fi

    # 一次检查整套模型配置：models.json 的服务商与凭证，加上 Pi 设置里的选型。
    # 校验在一次性容器中按正式标签运行：部署、升级或未完成的事务期间标签可能是旧版本，跳过并说明。
    local models_ok="0" models_detail='缺少或无效'
    local models_fix="首次配置请使用 $(ops_command_hint deploy)；已有文件无效时，先修正 data/config/models.json 与 data/runtime/pi/settings.json。"
    if [ ! -s "$MODELS_FILE" ]; then :
    elif deployment_in_progress; then
        models_detail='部署或升级尚未完成，未检查'
        models_fix="完成或回滚上次操作（$(ops_command_hint resume) / $(ops_command_hint rollback)）后重新体检。"
    elif validate_model_configuration >/dev/null 2>&1; then models_ok="1"; models_detail='有效'; fi
    check "模型配置（models.json + Pi 设置）" "$models_ok" "$models_detail" "$models_fix"

    check_relay

    if [ "$JSON_OUTPUT" = "1" ]; then
        printf '{"pass":%s,"warn":%s,"fail":%s,"port":%s,"checks":[%s]}\n' \
            "$PASS" "$CHECK_WARN" "$FAIL" "$PORT" "$JSON_ROWS"
        [ "$FAIL" -gt 0 ] && return 1
        return 0
    fi

    echo ""
    echo -e "结果：${GREEN}${PASS} 项通过${NC}，${YELLOW}${CHECK_WARN} 项待核验${NC}，${RED}${FAIL} 项失败${NC}"
    if [ "$FAIL" -gt 0 ]; then
        [ "$workspace_ok" = "1" ] || WA "       共享资料目录失败 -> 恢复外置目录或挂载；"
        WA "       本地失败 -> 使用 $(ops_command_hint restart)；"
        WA "       应用凭据缺少 -> 使用 $(ops_command_hint configure-app-bot)"
        return 1
    else
        if [ "$CHECK_WARN" -gt 0 ]; then WA "基础检查完成，请处理待核验项"; else OK "全部检查通过"; fi
        return 0
    fi
}

# 结构化结果（W2 计划 §2 第 3 条）：调用方设置 MIXIN_OPS_RESULT_FILE 时，命令结束写一份 JSON（先写临时文件再改名），
# 人类可读的输出不变。用法：ops_result <outcome> <原来在运行 0|1> <最终状态> <退出码> <说明>。
ops_result() {
    [ -n "${MIXIN_OPS_RESULT_FILE:-}" ] || return 0
    local temporary="${MIXIN_OPS_RESULT_FILE}.$$.tmp" was_running=false
    [ "$2" != 1 ] || was_running=true
    if printf '{"protocol":"mixin-ops","version":1,"command":"%s","outcome":"%s","wasRunning":%s,"finalState":"%s","exitCode":%s,"message":"%s"}\n' \
        "$(json_escape "${OPS_COMMAND:-}")" "$1" "$was_running" "$3" "$4" "$(json_escape "$5")" > "$temporary" &&
        mv -f -- "$temporary" "$MIXIN_OPS_RESULT_FILE"; then return 0; fi
    rm -f -- "$temporary"
    ER "无法写入结构化结果：$MIXIN_OPS_RESULT_FILE"
    return 1
}

# 容器此刻的运行状态：running、stopped（不存在或没在运行），查询失败为 unknown。<就绪> 为 0 表示本次启动的就绪检查
# 没有通过，运行中的容器记为 start-requested。
final_run_state() {
    local state
    state="$(docker ps -a --filter "name=^/${CONTAINER}$" --format '{{.State}}' 2>/dev/null)" || { echo unknown; return; }
    if [ "$state" != running ]; then echo stopped
    elif [ "${1:-1}" = 0 ]; then echo start-requested
    else echo running; fi
}

# start、restart 先做与停机维护相同的检查（部署锁、未完成的事务、维护状态 service），再启动。stop 只在部署或升级正持锁
# 时拒绝，不查事务：停止总是安全的，事务未完成时也要能停。三者都写结构化结果。
service_command() {
    ops_core service "$@"
}

# 一次性容器按正式标签 mixin-bot 运行；部署或升级的事务期间它仍是旧镜像（数据提交后才指向新版本），用它处理
# 迁移中或已迁移的数据会出错。服务未运行、需要一次性容器时先非阻塞地取得部署锁（部署或升级正在进行就停止），再检查
# 未完成的事务。锁由调用的进程持有到一次性容器结束，检查之后不会出现新的事务。
guard_one_off_container() {
    acquire_deploy_lock || { [ $? = 2 ] || ER "部署或升级正在进行；服务未运行时不能用一次性容器执行，请等它结束后重试"; return 1; }
    if [ -e "$STATE_DIR/deploy-transaction" ]; then
        ER "有未完成的部署或升级，正式镜像可能与数据不一致；请先用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"
        return 1
    fi
}

# 只读检查（体检的模型校验）遇到部署、升级或未完成的事务时跳过，不持有锁：体检会被界面反复调用，不能挡住部署。
# 本进程自己持有的锁（升级结束后的体检）不算。
deployment_in_progress() {
    local lock_path
    [ ! -e "$STATE_DIR/deploy-transaction" ] || return 0
    lock_path="$(realpath -m -- "$STATE_DIR")/deploy.lock"
    [ "${BOT_DEPLOY_LOCK_HELD:-}" != "$lock_path" ] || return 1
    deploy_lock_busy "$lock_path"
}

# 外链运维交给容器里的 bun 脚本执行，shell 这边只负责把它跑起来。
#
# 对象签名和精确删除由 TypeScript 管理，shell 不接触凭据。
# src/integrations/relay.ts；在 shell 里抄一遍等于把它维护成两份，而且凭据会出现在命令行
# 参数里，同机器上任何用户都能从 /proc/<pid>/cmdline 读到。
#
# 外链的数据步骤、网络归属和中断回收交给共享核心。
relay_admin() {
    local action="$1"; shift
    [ "$action" != list ] || action=ls
    ops_core maintenance "relay-$action" "$@"
}

# 配置向导（模型、应用机器人凭据、外链）在服务继续运行时填写：在机器人容器的镜像（按 ID）中以服务身份运行，有网络（核对凭据、
# 列出模型），只读挂载 data/ 作为基准，回答写进私有暂存目录（含凭据，退出时删除）。确认后交给共用核心，与网页配置相同：停机前
# 预检，停机、写入，按原运行状态启动并核对就绪，失败时恢复原配置。取消时向导不写暂存，配置和服务保持原状。
# 用法：configure_with_wizard <说明> <ops/config 下的向导> <配置类型 models|app|relay>
configure_with_wizard() (
    local label="$1" wizard="$2" kind="$3" image='' user='' stage='' status=0
    command -v docker >/dev/null 2>&1 || { ER "找不到 docker"; return 1; }
    [ -t 0 ] && [ -t 1 ] || { ER "${label}需要在终端里运行向导；配置和服务保持原状"; return 1; }
    if [ -e "$STATE_DIR/deploy-transaction" ]; then
        ER "有未完成的部署或升级；请先用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"; return 1
    fi
    image="$(docker container inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null)" || { ER "机器人容器不存在，请先部署"; return 1; }
    user="$(service_container_user)" || return 1
    mkdir -p -- "$PROJECT_DIR/tmp" && stage="$(mktemp -d "$PROJECT_DIR/tmp/configure-stage-XXXXXXXX")" || { ER "无法创建配置暂存目录"; return 1; }
    trap 'rm -rf -- "$stage"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if [ "$(id -u)" = 0 ]; then chown -- "$user" "$stage" || return 1; fi
    docker run --rm -it --user "$user" -w /app -e HOME=/tmp -v "$PROJECT_DIR/data:/app/data:ro" -v "$stage:/preview" \
        "$image" bun run "ops/config/$wizard" --stage /preview || status=$?
    if [ ! -s "$stage/configuration-$kind.json" ]; then
        if [ "$status" = 0 ] || [ "$status" = 2 ]; then WA "${label}已取消；配置和服务保持原状"; return 0; fi
        ER "${label}未完成（原因见上方）；配置和服务保持原状"; return 1
    fi
    ops_core maintenance configuration-apply --stage "$stage/configuration-$kind.json"
)

# 读本机服务状态的 Bun 脚本：宿主机有 Bun 时直接运行，否则在运行中的容器里执行（与 bot_local_ready 一致）。
service_bun() {
    if command -v bun >/dev/null 2>&1; then (cd "$PROJECT_DIR" && bun run "$@")
    else docker exec "$CONTAINER" bun run "$@"; fi
}

# 修改通讯录同步范围，经运行中服务保存，保存即开始应用：all 为整个通讯录；不带参数时在终端里逐层勾选部门（与部署向导同一套
# 选择）。宿主机没有 Bun 或项目依赖（向导要用 @clack/prompts）时，向导在运行中的容器里交互执行（docker exec -it）。
# 参数原样交给 directory-admin.ts，由它拒绝部门 ID、多余的参数和没有终端的情况（不默认整个通讯录）。
directory_scope() {
    if [ "$#" = 0 ] && [ -t 0 ] && [ -t 1 ] && ! { command -v bun >/dev/null 2>&1 && [ -d "$PROJECT_DIR/node_modules" ]; }; then
        docker exec -it "$CONTAINER" bun run ops/tools/directory-admin.ts scope
    else
        service_bun ops/tools/directory-admin.ts scope "$@"
    fi
}

# 应用控制台已确认的运行参数草稿：由运维核心执行，整个停机、发布和恢复过程与部署互斥。
runtime_configure() {
    ops_core maintenance runtime-configure "$@"
}

# 已确认的网页配置草稿；秘密只经 stdin 进入服务身份，控制台目录不挂载给容器。
configuration_admin() {
    local action="$1"; shift
    ops_core maintenance "configuration-$action" "$@"
}

# 数据操作由 Bun 统一管理存储边界；一次性容器按部署时的规则只读挂载外置共享资料目录，
# 与服务看到的资料一致。
data_admin() {
    local script="$1"; shift
    if ! command -v docker >/dev/null 2>&1; then
        ER "找不到 docker"
        return 1
    fi
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
        docker exec "$CONTAINER" bun run "$script" "$@"
        return $?
    fi
    guard_one_off_container || return 1
    # 提示写到标准错误：脚本的标准输出可能是给调用方读取的结构化结果（--json）。
    WA "容器未在运行，改用一次性容器执行" >&2
    local user workspace_args=() TASK_RUNTIME_ARGS=() TASK_DOCKER_ENDPOINT='' TASK_DOCKER_ID='' task_rootless=0
    # 任务 socket 必须属于服务身份，先确定身份再核对。
    user="$(service_container_user)" || return 1
    if [ -f "$PROJECT_DIR/data/config/task-deployment.json" ]; then
        if docker_rootless; then task_rootless=1; fi
        task_runtime_read "$PROJECT_DIR/data/state/task-runtime" && task_runtime_check_endpoint "$user" "$task_rootless" || return 1
    fi
    if [ -n "$DEPLOYED_WORKSPACE_ROOT" ]; then
        [ -d "$DEPLOYED_WORKSPACE_ROOT" ] || { ER "共享资料目录不存在：$DEPLOYED_WORKSPACE_ROOT"; return 1; }
        workspace_args=(-v "$DEPLOYED_WORKSPACE_ROOT:/app/workspace:ro" -e WORKSPACE_ROOT=/app/workspace)
    fi
    docker run --rm \
        --user "$user" \
        -e HOME=/app/data/runtime/home \
        "${TASK_RUNTIME_ARGS[@]}" \
        "${workspace_args[@]}" \
        -v "${PROJECT_DIR}/data:/app/data" -v "${PROJECT_DIR}/backup:/app/backup" \
        mixin-bot bun run "$script" "$@"
}

# 清理清单始终落到宿主机 tmp/；运行中服务的只读容器没有该目录的可写挂载。
backup_admin() {
    local action="$1"; shift
    [ "$action" != apply ] || action=clean
    ops_core maintenance "backup-$action" "$@"
}

tmp_admin() {
    local action="$1"; shift
    [ "$action" != list ] || action=ls
    ops_core maintenance "tmp-$action" "$@"
}

# 清历史先停服务（运行中的机器人独占会话库）；共用核心在停机窗口中执行，完成后恢复调用前的运行或停止状态。
history_clear() {
    ops_core maintenance "history-${HISTORY_OPERATION:-clear}" "$@"
}

# 同一核心负责统计快照/WAL 复制、停机、导入、恢复和副本清理；脚本不另行解释范围。
stat_import() {
    ops_core maintenance stat-import "$@"
}

# 未完成的部署或升级只能继续或回滚；非交互调用必须用 resume / rollback 明确指定。已经开始回滚的事务由核心拒绝继续。
choose_pending_action() {
    local choice
    if [ ! -t 0 ]; then
        ER "发现未完成的部署或升级；请使用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"
        return 1
    fi
    while true; do
        IFS= read -r -p '1 继续上次操作  2 回滚到操作前  0 退出 [默认 0]：' choice || choice=0
        case "$(printf '%s' "$choice" | tr -d '[:space:]')" in
            1) PENDING_ACTION=continue; return 0 ;;
            2) PENDING_ACTION=rollback; return 0 ;;
            ''|0) WA '未处理上次操作，服务保持当前状态'; return 1 ;;
            *) WA '请输入 1、2 或 0' ;;
        esac
    done
}

# 继续或回滚中断的部署或升级：与 update 共用未完成事务的处理；都没有时说明无需处理。
transaction_command() {
    local action="$1"; shift
    local confirmation=''
    if [ "$#" -gt 0 ]; then
        [ "$#" = 2 ] && [ "$1" = --confirmed-transaction ] && [ -n "$2" ] || { ER '事务确认参数无效'; return 1; }
        confirmation="$2"
    fi
    UPDATE_TRANSACTION_ACTION="$action" UPDATE_TRANSACTION_CONFIRMATION="$confirmation" update
}

require_git_checkout() {
    if ! command -v git >/dev/null 2>&1; then
        ER "找不到 git；无法自动更新"
        return 1
    fi
    local refusal
    git_here rev-parse --is-inside-work-tree >/dev/null 2>&1 && return 0
    if refusal="$(git_ownership_refusal)"; then ER "$refusal"; return 1; fi
    ER "${PROJECT_DIR} 不是 git 仓库，无法自动更新"
    WA "这份部署可能是解压得到的；请改用 git clone 重新部署后再使用 update"
    return 1
}

remove_upgrade_stage() {
    local stage="${UPGRADE_STAGE:-}"
    UPGRADE_STAGE=''
    case "$stage" in "$PROJECT_DIR"/tmp/upgrade-????????) ;; *) return 0 ;; esac
    [ -d "$stage" ] && [ ! -L "$stage" ] || return 0
    rm -rf -- "$stage" || WA "升级导出目录清理失败，保留 $stage"
}

forward_to_upgrader() {
    [ -z "${UPGRADER_PID:-}" ] || kill -TERM "$UPGRADER_PID" 2>/dev/null || true
}

# 在后台运行升级器（或运维核心）并等它结束，以便转发中断：收到 INT/TERM/HUP（Ctrl+C、终止信号、断线）时让它按所处
# 阶段回滚。标准输入照常交给它（停机前要提问）。返回它的退出码。
run_forwarding() {
    local status=0 again=0
    trap forward_to_upgrader INT TERM HUP
    "$@" <&0 &
    UPGRADER_PID=$!
    while :; do
        if wait "$UPGRADER_PID"; then status=0; else status=$?; fi
        kill -0 "$UPGRADER_PID" 2>/dev/null || break
    done
    # 中断打断的 wait 返回 128+信号；它在那之后才结束时，它自己的退出码还在，再取一次。
    if [ "$status" -gt 128 ]; then
        wait "$UPGRADER_PID" 2>/dev/null || again=$?
        [ "$again" = 127 ] || status="$again"
    fi
    UPGRADER_PID=''
    trap - INT TERM HUP
    return "$status"
}

# 从目标提交导出升级器到 tmp/upgrade-*，在工作区外运行：停机前的准备由它负责，停机、切换代码、迁移和回滚由它交给目标
# 版本的运维核心。
run_target_upgrader() {
    local target="$1" action="${2:-}" status=0
    mkdir -p "$PROJECT_DIR/tmp" || return 1
    UPGRADE_STAGE="$(mktemp -d "$PROJECT_DIR/tmp/upgrade-XXXXXXXX")" || { ER '无法创建升级导出目录'; return 1; }
    operation_stage export-target-upgrader
    if ! git_here archive --format=tar "$target" "${UPGRADER_EXPORT_PATHS[@]}" | tar -x -C "$UPGRADE_STAGE"; then
        ER "无法从目标提交 ${target:0:7} 导出升级器"
        remove_upgrade_stage
        return 1
    fi
    operation_stage target-upgrader
    # 升级器结束后才清理导出目录：它导出的源码树和交给核心的准备记录都在其中。
    run_forwarding bash "$UPGRADE_STAGE/scripts/upgrade.sh" "$PROJECT_DIR" "$target" ${action:+"$action"} || status=$?
    remove_upgrade_stage
    return "$status"
}

# 运维核心已写入结构化结果（原运行状态、最终状态和就绪）。结果文件每个控制台任务一份，不会是旧的；核心在写入之前就被终止时，
# 由 finish_lifecycle_result 按实际状态报告。
core_reported() {
    [ -n "${MIXIN_OPS_RESULT_FILE:-}" ] && [ -e "$MIXIN_OPS_RESULT_FILE" ]
}

# 升级前运行的服务会被重新启动：再做一次完整体检；原先停止的保持停止。
# 升级按已保存设置或事务记录完成并写回：体检参数按持久化设置重新读取，不用当前终端的环境变量。
# 控制台任务的结果由运维核心写入，它交还前已核对新实例就绪；退出码要与那份结果一致，这里不再体检。
after_upgrade() {
    if core_reported; then return 0; fi
    load_saved_settings
    check_ordinary_settings
    if [ "$(docker container inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; then doctor; return $?; fi
    OK "保留原停止状态，使用 start 可启动新版本"
}

# 运维核心开始的升级在目标提交不在本地时，由事务固定的运行包回滚（它在开始时冻结了目标版本的运维核心）。运行包也不在
# 时无法回滚，保留现场。
rollback_with_pinned_core() {
    local core runtime
    core="$(ops_pinned_core "$TRANSACTION_SNAPSHOT")" || {
        ER "目标提交 ${TRANSACTION[target_sha]:0:7} 和事务固定的运维运行包都不在本地，无法回滚；请取回该提交（git fetch）后重试，服务和数据保持现状"; return 1; }
    runtime="$(ops_bun)" || return 1
    WA "目标提交 ${TRANSACTION[target_sha]:0:7} 在本地不存在；由事务固定的运维运行包回滚"
    run_forwarding "$runtime" --no-env-file "$core" deployment upgrade --project "$PROJECT_DIR" --original "${TRANSACTION[original_sha]}" \
        --target "${TRANSACTION[target_sha]}" --branch "${TRANSACTION[original_branch]}" --rollback </dev/null
}

# 未完成的部署：由事务固定的运维运行包按事务记录继续或回滚，不重新询问。运行包不在时用当前版本的核心，它只接受代码完全相同
# 的版本。
resume_recorded_deploy() {
    local action="$1" core runtime args=()
    core="$(ops_pinned_core "$TRANSACTION_SNAPSHOT")" || core="$OPS_SOURCE_DIR/ops/core/cli.ts"
    runtime="$(ops_bun)" || return 1
    [ "$action" != rollback ] || args=(--rollback)
    run_forwarding "$runtime" --no-env-file "$core" deployment deploy --project "$PROJECT_DIR" "${args[@]}" </dev/null
}

# 未完成的升级：从记录的目标提交（本地已有，不拉取）导出升级器继续或回滚。
# 目标提交在本地缺失时无法继续；此时代码必然尚未切换（或已经恢复），回滚交给事务固定的运维运行包。没有固定运行包记录的
# 事务是旧版本脚本开始的，本版本不接手。
resume_recorded_upgrade() {
    local action="$1" target="${TRANSACTION[target_sha]}"
    require_git_checkout || return 1
    [ -n "$target" ] || { ER '升级事务缺少目标提交，请人工检查 backup/snapshots'; return 1; }
    if git_here cat-file -e "${target}^{commit}" 2>/dev/null; then
        run_target_upgrader "$target" "$action" || return $?
        if [ "$action" = continue ]; then after_upgrade; fi
        return
    fi
    if [ "$action" = continue ]; then
        ER "事务记录的目标提交 ${target:0:7} 在本地不存在，无法继续；请使用 $(ops_command_hint rollback) 回滚"
        return 1
    fi
    if [ "$(git_here rev-parse HEAD 2>/dev/null)" != "${TRANSACTION[original_sha]}" ]; then
        ER "目标提交 ${target:0:7} 在本地不存在，当前代码也不是升级前的 ${TRANSACTION[original_sha]:0:7}；请人工检查 git 状态"
        return 1
    fi
    if [ -f "$TRANSACTION_SNAPSHOT/host-runtime" ]; then rollback_with_pinned_core; return; fi
    ER "这次升级不是由运维核心开始的（快照中没有固定运行包记录 host-runtime），本版本不能继续或回滚它；服务和数据保持现状，请人工检查 ${TRANSACTION_SNAPSHOT}"
    return 1
}

# 在主 shell 中运行（不是子 shell）：发给 ops.sh 的 TERM 才能由升级器转发处理，否则只杀掉父进程，升级在后台继续。
# 升级是 ops.sh 的最后一个命令，退出陷阱在脚本结束时运行。
finish_lifecycle_result() {
    local code="$1" was_running="$2" state outcome=failed message='操作未完成，请查看任务日志和恢复状态'
    [ -n "${MIXIN_OPS_RESULT_FILE:-}" ] || return "$code"
    # 运维核心执行的部署和升级自己写入结构化结果，退出码与它一致；不覆盖。
    ! core_reported || return "$code"
    state="$(final_run_state)"
    # No start/stop here: lifecycle scripts own recovery. Re-read saved state after their last mutation.
    if [ "$state" = running ]; then
        load_saved_settings
        if ! wait_for_local; then state=start-requested; [ "$code" != 0 ] || code=1; fi
    elif [ "$state" = unknown ]; then [ "$code" != 0 ] || code=1; fi
    # 没有取得部署锁（被占用、锁文件异常或计划复核未通过）：什么都没有执行。
    if [ -n "${DEPLOY_LOCK_REFUSAL:-}" ]; then
        outcome=refused; message="$DEPLOY_LOCK_REFUSAL"; [ "$code" != 0 ] || code=1
    elif [ -e "$STATE_DIR/deploy-transaction" ] || [ -e "$STATE_DIR/upgrade-transaction" ]; then
        [ "$code" != 0 ] || code=1
        message='事务尚未结束，请刷新维护页后继续或回滚'
    elif [ "$code" = 0 ]; then outcome=success; message='操作完成'; fi
    ops_result "$outcome" "$was_running" "$state" "$code" "$message" || [ "$code" != 0 ] || code=1
    return "$code"
}

finish_update() {
    local status=$?
    trap - EXIT
    remove_upgrade_stage
    if finish_lifecycle_result "$status" "${UPDATE_WAS_RUNNING:-0}"; then status=0; else status=$?; fi
    operation_finish "$status"
    exit "$status"
}

finish_deploy_command() {
    local status=$?
    trap - EXIT
    if finish_lifecycle_result "$status" "${DEPLOY_WAS_RUNNING:-0}"; then status=0; else status=$?; fi
    operation_finish "$status"
    exit "$status"
}

# The deployer owns commit and rollback. Keep this fixed wrapper alive to report its actual final state. The wrapper takes
# deploy.lock and rechecks the console plan first, so a refusal is reported as one; the deployer inherits the lock on fd 9.
deploy_command() {
    if [ "${MIXIN_OPS_CONSOLE:-}" != 1 ]; then exec bash "$PROJECT_DIR/scripts/deploy.sh" "$OPS_COMMAND"; fi
    operation_start deploy
    DEPLOY_WAS_RUNNING=0; UPGRADER_PID=''
    [ "$(final_run_state)" != running ] || DEPLOY_WAS_RUNNING=1
    trap finish_deploy_command EXIT
    assert_console_lifecycle deploy || return 1
    acquire_deploy_lock || { [ $? = 2 ] || ER "另一个部署、升级或维护操作正在进行；部署未开始"; return 1; }
    MIXIN_OPS_PROJECT="$PROJECT_DIR" run_forwarding bash "$OPS_SOURCE_DIR/scripts/deploy.sh" "$OPS_COMMAND" </dev/null
}

update() {
    local confirmed="${1:-}"
    if [ -n "$confirmed" ] && ! [[ "$confirmed" =~ ^[0-9a-f]{40}$ ]]; then
        ER '已确认的升级目标必须是完整提交 SHA；请重新检查版本'; return 1
    fi
    operation_start upgrade
    UPGRADE_STAGE=''
    UPGRADER_PID=''
    UPDATE_WAS_RUNNING=0
    if [ -n "${MIXIN_OPS_RESULT_FILE:-}" ] && [ "$(final_run_state)" = running ]; then UPDATE_WAS_RUNNING=1; fi
    trap finish_update EXIT
    acquire_deploy_lock || { [ $? = 2 ] || ER "另一个部署、升级或维护操作正在进行"; return 1; }
    local action="${UPDATE_TRANSACTION_ACTION:-}"
    # The lock remains held across dispatch and the child deployer.
    if [ -n "${UPDATE_TRANSACTION_CONFIRMATION:-}" ]; then
        local runtime
        runtime="$(ops_bun)" || return 1
        "$runtime" --no-env-file "$OPS_SOURCE_DIR/ops/lib/confirmed-transaction.ts" "$PROJECT_DIR" "$action" "$UPDATE_TRANSACTION_CONFIRMATION" || return 1
    fi
    # 未完成的事务最先处理，早于检查改动和拉取：继续固定使用记录的目标提交（本地已有），离线也能继续或回滚。
    if [ -e "$STATE_DIR/deploy-transaction" ]; then
        if [ -n "$confirmed" ]; then ER '预览后出现未完成的事务，请刷新后继续或回滚'; return 1; fi
        load_pending_transaction || { ER '未完成事务的记录无法读取（原因见上方），请人工检查 backup/snapshots'; return 1; }
        WA "$(describe_pending_transaction)"
        if [ -z "$action" ]; then choose_pending_action || return 1; action="$PENDING_ACTION"; fi
        # 仅恢复当前事务格式；后续脚本关闭标准输入，沿用已保存的决定。
        if [ "${TRANSACTION[operation]}" = upgrade ]; then resume_recorded_upgrade "$action"; else resume_recorded_deploy "$action"; fi
        return
    elif [ -n "$action" ]; then
        OK '没有未完成的部署或升级'
        return 0
    fi
    if [ "${MIXIN_OPS_CONSOLE:-}" = 1 ] && [ -z "$confirmed" ]; then
        ER '控制台升级缺少已确认目标，未拉取或停止服务'; return 1
    fi

    P "同步到 origin/main，由目标版本的升级器完成升级"
    require_git_checkout || return 1
    # 已跟踪文件的改动会被升级器的 checkout 冲掉，必须先拦下来。只看已跟踪文件：
    # 未跟踪文件不会被这些操作动到，拿它们挡住升级只会让这条命令永远跑不起来。
    # data/ 和 logs/ 都在 .gitignore 里，配置与数据本来就不算改动。
    local dirty target
    dirty="$(git_here status --porcelain --untracked-files=no 2>&1)"
    if [ -n "$dirty" ]; then
        ER "已跟踪文件有未提交的改动，已停止升级："
        printf '%s\n' "$dirty" | sed 's/^/      /'
        WA "请先提交、撤销（git restore <文件>）或备份这些改动，然后重试"
        return 1
    fi
    if [ -n "$confirmed" ]; then
        target="$(git_here rev-parse --verify --quiet "${confirmed}^{commit}")" || { ER '已确认的提交在本地不存在，请重新检查版本'; return 1; }
        [ "$target" = "$confirmed" ] || { ER '已确认的目标不是提交，请重新检查版本'; return 1; }
    else
        P "拉取 origin/main..."
        operation_stage fetch
        if ! operation_capture git_here fetch --prune origin refs/heads/main:refs/remotes/origin/main; then
            ER "git fetch 失败"
            return 1
        fi
        target="$(git_here rev-parse --verify --quiet 'origin/main^{commit}')" || { ER "无法解析 origin/main；请确认远端存在 main 分支"; return 1; }
    fi
    operation_event info "original=$(git_here rev-parse HEAD 2>/dev/null) target=$target"
    # 停机前的预检和预览由目标版本的升级器负责；停机、切换代码、迁移和回滚由它交给目标版本的运维核心。
    run_target_upgrader "$target" || return $?
    after_upgrade
}

show_logs() {
    if ! has_container; then ER "找不到容器 '$CONTAINER'"; return 1; fi
    P "持续查看 Docker 日志（Ctrl+C 退出）"
    docker logs -f --tail 50 "$CONTAINER"
}

uninstall() {
    P "卸载 mixin-bot"
    # 部署锁持有到卸载结束（fd 9），与部署、升级和运维任务互斥；核心在锁内拒绝仍需要本部署的未完成事务、运维任务和配置提交：
    # 升级中断时回滚容器就是原服务，data/ 里有事务记录，删掉或归档后都无法续做或回滚。
    acquire_deploy_lock || { [ $? = 2 ] || ER "部署、升级或另一个维护操作正在进行；卸载未开始"; return 1; }
    ops_core uninstall-check || { ER "卸载未开始（原因见上方）"; return 1; }
    if has_container; then
        if ! docker stop "$CONTAINER" >/dev/null 2>&1; then
            ER "容器停止失败；为避免删除仍在使用的数据，卸载已停止"
            return 1
        fi
        if ! docker rm "$CONTAINER" >/dev/null 2>&1; then
            ER "容器删除失败；卸载已停止"
            return 1
        fi
        OK "容器已删除"
    else
        WA "没有可删除的容器"
    fi
    if has_rollback_container; then
        if ! docker stop "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
            ER "回滚容器停止失败；卸载已停止"
            return 1
        fi
        if ! docker rm "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
            ER "回滚容器删除失败；卸载已停止"
            return 1
        fi
        OK "部署遗留回滚容器已删除"
    fi

    if ask_yes_no "是否删除 Docker 镜像 mixin-bot？[y/N] "; then
        if docker image inspect mixin-bot:previous >/dev/null 2>&1 && ! docker rmi mixin-bot:previous >/dev/null 2>&1; then WA "部署回滚标签 mixin-bot:previous 删除失败"; fi
        if docker rmi mixin-bot >/dev/null 2>&1; then OK "镜像已删除"; else WA "镜像删除失败"; fi
    fi

    if ask_yes_no "是否删除 data/（配置、部署状态、runtime、默认共享资料、会话、临时文件和统计）和 logs/？[y/N] "; then
        if archive_project_path "${PROJECT_DIR}/data" && archive_project_path "${PROJECT_DIR}/logs" &&
            [ ! -e "${PROJECT_DIR}/data" ] && [ ! -e "${PROJECT_DIR}/logs" ]; then
            OK "data/ 和 logs/ 已移入 backup/rm"
        else
            ER "data/ 或 logs/ 归档不完整；请检查权限后重试"
            return 1
        fi
    else
        OK "已保留 data/ 和 logs/（配置、状态、资料、会话与统计保留）"
    fi
    if [ -n "$DEPLOYED_WORKSPACE_ROOT" ]; then
        WA "外置共享资料目录不属于本项目，未删除：$DEPLOYED_WORKSPACE_ROOT"
    fi
    OK "卸载流程完成。"
}

# 升级、继续和回滚忽略当前终端的 BOT_PORT，入口也不校验普通设置：有未完成事务时用事务记录，
# 新升级由升级器在停机前校验已保存设置。部署脚本自行校验设置；其余操作采用环境变量并先校验。
case "${1:-}" in
    update|upgrade|resume|rollback) use_transaction_settings ;;
    deploy|repair|maintenance-recover) ;;
    *)
        if [ -n "${BOT_PORT:-}" ]; then PORT="$BOT_PORT"; fi
        check_ordinary_settings
        ;;
esac

# 结构化结果里的命令名（ops_result）。
OPS_COMMAND="${1:-}"
case "${1:-}" in
    deploy|repair) deploy_command ;;
    doctor|status) doctor ;;
    update|upgrade) update "${2:-}" ;;
    resume)    transaction_command continue "${@:2}" ;;
    rollback)  transaction_command rollback "${@:2}" ;;
    restart|stop|start) service_command "$@" ;;
    logs)      show_logs ;;
    relay-configure) configure_with_wizard 外链配置 configure-relay.ts relay ;;
    model-configure) configure_with_wizard 模型配置 configure.ts models ;;
    configure-app-bot) configure_with_wizard 应用机器人配置 configure-app-bot.ts app ;;
    directory) service_bun ops/tools/directory-admin.ts status ;;
    directory-scope) shift; directory_scope "$@" ;;
    runtime-configure) shift; runtime_configure "$@" ;;
    configuration-apply) shift; configuration_admin apply "$@" ;;
    configuration-restore) shift; configuration_admin restore "$@" ;;
    relay-ls)    shift; relay_admin list "$@" ;;
    relay-test)  shift; relay_admin test "$@" ;;
    relay-purge) shift; relay_admin purge "$@" ;;
    tmp-ls)      shift; tmp_admin list "$@" ;;
    tmp-purge)   shift; tmp_admin purge "$@" ;;
    tmp-preview) shift; tmp_admin preview "$@" ;;
    tmp-reclaim) shift; tmp_admin reclaim "$@" ;;
    tmp-discard) shift; tmp_admin discard "$@" ;;
    stat)          shift; data_admin ops/tools/stats-admin.ts "$@" ;;
    stat-import)   shift; stat_import "$@" ;;
    history-ls)    shift; data_admin ops/tools/history-admin.ts list "$@" ;;
    history-clear) shift; history_clear "$@" ;;
    history-compact) shift; HISTORY_OPERATION=compact history_clear "$@" ;;
    maintenance-recover) ops_core "$@" ;;
    # 历史归档清理：扫描只写清单；删除只按确认过的清单执行，工具在容器内逐条重新检查。
    backup-scan)   shift; backup_admin scan "$@" ;;
    backup-clean)  shift; backup_admin apply "$@" ;;
    uninstall) uninstall ;;
    *)
        # 空参和显式 help 是「我要看帮助」，退 0；其余都是打错了的命令，必须退非零。
        # 否则脚本或 CI 里少写一个字母（ops.sh restrat）会被当成执行成功。
        UNKNOWN=0
        case "${1:-}" in
            ""|help|-h|--help) ;;
            *) UNKNOWN=1; ER "无法识别的命令：$1" ;;
        esac
        echo -e "${CYAN}mixin-bot 运维工具（Linux/Docker）${NC}"
        echo "用法：./scripts/ops.sh <命令>"
        echo "运维控制台：在项目根目录运行 bun run console，在浏览器中打开；需宿主机安装 Bun（安装指引：https://bun.sh/docs/installation）。"
        echo ""
        echo "  doctor     健康检查：共享资料目录、容器、本机 :$PORT、版本、事件 Stream、通讯录同步、配置"
        echo "             加 --json 输出单行 JSON，供控制台使用"
        echo "  deploy     配置并部署当前代码；已有部署可用于重建修复，失败自动回滚"
        echo "  update     同步 origin/main，由目标版本的升级器在停机前检查部署记录与配置，"
        echo "             再停机重建并切换容器；提交前失败自动回滚。沿用现有端口、共享资料目录、"
        echo "             应用凭据和 AI 配置；改配置请用 deploy"
        echo "  resume     继续中断的部署或升级：使用事务记录中的目标提交和设置，不拉取新的 main"
        echo "  rollback   回滚中断的部署或升级：恢复数据、配置、代码和原运行状态；数据已提交时拒绝"
        echo "  restart    重启 Docker 容器"
        echo "  stop       停止 Docker 容器"
        echo "  start      启动 Docker 容器"
        echo "  logs       持续查看最近 50 行 Docker 日志"
        echo "  relay-configure 交互配置可选的大文件外链；填写期间机器人照常运行，确认后短暂停机应用并恢复原运行状态"
        echo "  model-configure 运行模型配置向导；填写期间机器人照常运行，确认后短暂停机应用并恢复原运行状态，失败时恢复原配置"
        echo "  runtime-configure <草稿名> 应用控制台「设置」中已确认的高级运行参数"
        echo "  configure-app-bot 填写应用机器人 AppID/AppSecret 并验证；之后与 model-configure 相同地应用"
        echo "  directory  查看事件 Stream 与通讯录同步状态（同步范围及是否生效、映射数、最近同步、待复核的缺席）"
        echo "  directory-scope [all]"
        echo "             修改同步范围并应用：不带参数时在终端里逐层勾选部门（每个部门含其全部子部门，宿主机没有 Bun 时在容器里运行），"
        echo "             带 all 时同步整个通讯录；不接受部门 ID。也可以在控制台的「通讯录」中勾选。"
        echo "             完整同步成功后一次切换，之前的名单在此前仍然生效"
        echo "  relay-ls   列出已发出、仍在册的大文件外链"
        echo "  relay-test 上传并删除一个随机测试文件，验收外链签名、私有访问和删除权限"
        echo "  relay-purge <关键字>|--all"
        echo "             删除匹配的外链对象并清掉索引记录"
        echo "  tmp-ls [--user <手机号>] [--group <群号>|direct]"
        echo "             列出各会话空间里各成员临时目录的占用（收到的文件、任务目录、中间产物）"
        echo "  tmp-purge --days <天数>|--all [--user <手机号>] [--group <群号>|direct]"
        echo "             清理用户临时目录；--days 只删这些天没改动过的条目"
        echo "  tmp-preview --days <天数>|--all  核对引用并保存归档清单（服务照常运行）"
        echo "  tmp-purge --plan <ID> --digest <摘要>  停机执行或继续归档清单，再恢复原状态"
        echo "  tmp-reclaim --days <天数>|--all  预览物理回收；核对后用 --plan/--digest 确认"
        echo "  tmp-discard  预览可永久删除的归档；核对后用 --plan/--digest 确认，释放磁盘空间"
        echo "             --user 与 --group 可组合，把范围限到某个群（direct 为单聊空间）里的某个成员"
        echo "  stat [群号|direct] [--period today|yesterday|week|last-week|month|last-month|7d|30d|all]"
        echo "              或 [--since <日期>] [--until <日期>]"
        echo "             使用统计：多少人用过、提问多少次、模型用了多少 token；日期格式 YYYY-MM-DD"
        echo "  stat-import <账本路径>  把已保存的统计账本恢复到空账本；停机导入后恢复原运行状态（也可在控制台「统计 → 导入统计」上传或填写路径）"
        echo "  history-ls 列出各会话空间（单聊与各群）的会话库占用和最后活动"
        echo "  history-clear <群号>|--direct"
        echo "             清空该群（或单聊空间）全部成员的上下文；自动停机、清理，再恢复原运行或停止状态"
        echo "             群选择可加 --group-id（原始群号）或 --storage-segment（目录段）"
        echo "  history-clear --all  清空单聊和所有群全部成员的上下文；一次停机完成，某个空间失败时其余照常清空"
        echo "  maintenance-recover 回收中断的维护写入者并恢复原运行状态；不重复数据动作"
        echo "  history-compact <群号>|--direct <成员号码>  停机登记压缩并恢复原运行状态（产生模型用量）"
        echo "  backup-scan 只读扫描 backup/rm 和 snapshots，分类后在 tmp/backup-cleanup 生成清单，不删除"
        echo "  backup-clean <报告名> [--confirm <确认码>]"
        echo "             不带确认码时预演并给出确认码；带确认码时按清单的精确路径删除，不可撤销"
        echo "  uninstall  删除容器（可选镜像、data/、logs/）"
        # 显式 exit：case 分支的退出码取决于最后一条命令，靠自然结束会把 [ ] 的结果漏出去。
        [ "$UNKNOWN" = "1" ] && exit 1
        exit 0
        ;;
esac
