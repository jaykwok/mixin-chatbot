#!/bin/bash

# 量子密信群聊协作机器人部署入口 (Debian + Docker, Bun)
# 服务运行时完成全部准备：确认运行身份、端口和共享资料目录，从工作区构建候选镜像（按 image ID 固定），在这个镜像中核对权限和
# 数据版本，运行配置向导（回答写进本次的暂存目录，不改项目文件），预览旧修订链，选择通讯录同步范围，算出运行参数；再把这些
# 交给共享运维核心（scripts/ops/core，由宿主机的 Bun 运行）。核心沿用本进程持有的部署锁，在锁内逐项复核后记录事务、停机、写入
# 配置、迁移、验证并提交；提交前失败自动回滚，首次部署的回滚不留服务。部署不移动代码。未完成的事务由 ops resume / rollback 处理。
# 应用机器人凭据（data/config/app-bot.json）和 AI 配置（data/config/models.json）由容器内的配置向导生成，通讯录同步范围
# （data/config/directory.json）由向导或 BOT_DIRECTORY_SCOPE 选定；无必需 .env/config.json。消息经平台事件 Stream 主动连出接收，不需要入站端口：HTTP 只监听本机回环，
# 供控制台、/health 和 /_admin/shutdown 使用。出站需能访问 imtwo.zdxlz.com 与 imfl.zdxlz.com 的 443 端口。
#
# 用法：bash scripts/deploy/deploy.sh [deploy|repair]

set -euo pipefail
DEPLOY_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_DIR="$(cd "${MIXIN_OPS_PROJECT:-$DEPLOY_SOURCE_DIR}" && pwd)"
DEPLOY_COMMAND="${1:-deploy}"
case "$DEPLOY_COMMAND" in
    deploy|repair) ;;
    *) echo "用法：bash scripts/deploy/deploy.sh [deploy|repair]" >&2; exit 2 ;;
esac
# 与 deploy.sh / ops.sh 共用的纯辅助函数（主机名校验与规范化）。
COMMON_LIB="${DEPLOY_SOURCE_DIR}/scripts/lib/common.sh"
if [ ! -f "$COMMON_LIB" ]; then
    echo "缺少 ${COMMON_LIB}；请从仓库完整获取脚本目录后重试。" >&2
    exit 1
fi
# shellcheck source=../lib/common.sh
. "$COMMON_LIB"
. "${DEPLOY_SOURCE_DIR}/scripts/lib/deployment.sh"
. "${DEPLOY_SOURCE_DIR}/scripts/lib/ops-runtime.sh"
. "${DEPLOY_SOURCE_DIR}/scripts/lib/core-handoff.sh"
operation_start deploy
trap 'operation_finish "$?"' EXIT
cd "$PROJECT_DIR"
LEGACY_REUSE_REQUEST="${DEPLOY_REUSE_SETTINGS:-0}"
unset DEPLOY_REUSE_SETTINGS
# 旧版（webhook）运维脚本的升级先停机，再以 DEPLOY_REUSE_SETTINGS=1 调用部署脚本。旧版不支持升级到应用机器人版本：
# 在改动任何状态之前拒绝，旧脚本随后恢复原代码和原运行状态。
if [ "$LEGACY_REUSE_REQUEST" = 1 ]; then
    operation_event error "legacy upgrade entry refused"
    {
        echo "[-] 旧版（webhook）部署不支持升级到应用机器人版本，请在新目录全新部署（见 docs/data-migrations.md）。"
        echo "    本次未改动数据和配置；旧脚本将恢复原代码和原运行状态。"
    } >&2
    exit 1
fi
DATA_DIR="${PROJECT_DIR}/data"
CONFIG_DIR="${DATA_DIR}/config"
STATE_DIR="${DATA_DIR}/state"
RUNTIME_DIR="${DATA_DIR}/runtime"
RUNTIME_HOME_DIR="${RUNTIME_DIR}/home"
LOG_DIR="${PROJECT_DIR}/logs"
MODELS_FILE="${CONFIG_DIR}/models.json"
SETTINGS_FILE="${RUNTIME_DIR}/pi/settings.json"
APP_BOT_FILE="${CONFIG_DIR}/app-bot.json"
BOT_PORT_FILE="${STATE_DIR}/bot-port"
PENDING_POINTER="${STATE_DIR}/deploy-transaction"
UNCHANGED='服务尚未停止，未做任何改动'
# 本次部署的镜像和服务身份：构建后固定 image ID、沿用原容器的数值 UID:GID（见 determine_service_user）；核心在部署锁内复核后
# 写入事务快照，续做和回滚只读那里的记录。
IMAGE_ID=''
SERVICE_USER=''
SERVICE_USER_SOURCE=''
HOST_BUN=''
PREVIEW_DIR=''

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
    if [ "${MIXIN_OPS_CONSOLE:-}" = 1 ]; then
        print_error '控制台操作遇到未提供的交互选择，请重新预览；未自动采用默认值'; exit 2
    fi
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

# 共享资料默认在 data/workspace（随 data 挂载）；外置资料目录只读挂到 /app/workspace，从不改属主。
workspace_mount() {
    WORKSPACE_ARGS=()
    if [ -n "$1" ]; then WORKSPACE_ARGS+=(-v "$1:/app/workspace:ro" -e WORKSPACE_ROOT=/app/workspace); fi
}

# 新部署的服务身份，在任何改动之前确定：有原容器就沿用它的数值 UID:GID（不因改由 root 部署而迁移到 1001，也不改已有数据的
# 属主）；真正的首次部署用默认身份；原容器不在但已部署过时身份不明，显示 data/state 的属主请操作者确认，不猜测。
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

# 从工作区构建本次镜像：构建前检查磁盘空间，构建后按 image ID 固定（来源记为 workspace），之后的预检、迁移、验证实例和
# 正式实例都用这个 ID；正式标签 mixin-chatbot 到数据提交后才指向它。失败或中断时只移除本次的保留标签。
build_workspace_candidate() {
    local previous head status=0 path paths=()
    previous="$(docker container inspect --format '{{.Image}}' mixin-chatbot 2>/dev/null)" || previous=''
    for path in "$DATA_DIR" "$PROJECT_DIR/backup"; do [ ! -e "$path" ] || paths+=("$path"); done
    print_status "检查构建所需的磁盘空间..."
    check_build_disk_space "$previous" "${paths[@]}" ||
        { print_error "磁盘空间不足或无法确认镜像存储位置（原因见上方）；${UNCHANGED}"; exit 1; }
    head="$(git -C "$PROJECT_DIR" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null)" || head=''
    print_status "构建 Docker 镜像..."
    prepare_candidate_image "$PROJECT_DIR" "$head" workspace "$PROJECT_DIR" || status=$?
    if [ "$status" != 0 ]; then
        if [ "$status" -ge 128 ]; then print_warning "镜像构建已中断；${UNCHANGED}"
        else print_error "镜像构建失败（原因见上方）；${UNCHANGED}"; status=1; fi
        exit "$status"
    fi
    IMAGE_ID="${CANDIDATE[image_id]}"
    print_success "镜像构建成功：${IMAGE_ID}"
}

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

# 停机前的回答、计划和记录都写进这个私有目录（容器里是 /preview），它含应用凭据：核心在部署锁内读一次后存入事务快照，入口退出
# 时删除。容器以服务身份写入，所以目录交给服务身份；服务容器不挂载 tmp/，运行中的服务碰不到它。
make_stage() {
    mkdir -p -- "$PROJECT_DIR/tmp" && PREVIEW_DIR="$(mktemp -d "$PROJECT_DIR/tmp/deploy-stage-XXXXXXXX")" && grant_service_access "$PREVIEW_DIR" ||
        { print_error "无法创建部署暂存目录；${UNCHANGED}"; exit 1; }
}

# 配置齐全时在停机前校验它，计划中的版本标记摘要用于停机后的 apply；首次部署（或缺少要由向导补上的配置）这里只核对数据版本
# （有数据但没有有效版本标记时拒绝），配置写入之后才预检。
preview_current_data() {
    if [ ! -f "$MODELS_FILE" ] || [ ! -f "$SETTINGS_FILE" ] || [ ! -f "$APP_BOT_FILE" ]; then
        preview_data check || { print_error "数据版本核对未通过（原因见上方）；${UNCHANGED}"; exit 1; }
        return 0
    fi
    print_status "在本次镜像中核对数据版本并校验配置（只读挂载数据，服务尚未停止）..."
    preview_data preview --plan /preview/data-plan.json || { print_error "数据版本或配置校验未通过（原因见上方）；${UNCHANGED}"; exit 1; }
    [ -s "$PREVIEW_DIR/data-plan.json" ] || { print_error "数据预检没有生成计划；${UNCHANGED}"; exit 1; }
}

# 配置向导在候选镜像中运行，有网络（核对凭据、列模型），只读挂载 data/ 作为基准，回答写进暂存目录，停止服务后由核心写入。
# 取消时向导不写暂存文件。用法：run_configuration_wizard <说明> <scripts/config 下的向导> <它暂存的文件>
run_configuration_wizard() {
    local label="$1" wizard="$2" staged="$PREVIEW_DIR/$3" status=0
    [ -t 0 ] && [ -t 1 ] || { print_error "${label}需要在终端里运行向导；${UNCHANGED}"; exit 1; }
    print_status "${label}（回答先暂存，停止服务后写入）..."
    docker run --rm -it --user "$SERVICE_USER" -w /app -e HOME=/tmp -v "$PROJECT_DIR/data:/app/data:ro" -v "$PREVIEW_DIR:/preview" \
        "$IMAGE_ID" bun run "scripts/config/$wizard" --stage /preview || status=$?
    [ "$status" = 0 ] && [ -s "$staged" ] || { print_error "配置未完成（取消或失败，原因见上方）；${UNCHANGED}"; exit 1; }
}

# 停机前的交互选择：只读取和校验，全部答完才交给核心。控制台部署沿用网页确认的配置，不运行向导（控制台要求配置齐全）。
choose_configuration() {
    if [ "${MIXIN_OPS_CONSOLE:-}" = 1 ]; then
        print_status "沿用网页确认的模型与机器人配置"
        return 0
    fi
    if [ ! -f "$MODELS_FILE" ] || [ ! -f "$SETTINGS_FILE" ]; then
        # 没有应用机器人配置时，这个向导先问它。
        run_configuration_wizard "首次配置 AI（provider/key/model）" configure.ts configuration-models.json
    else
        [ -f "$APP_BOT_FILE" ] || run_configuration_wizard "配置应用机器人凭据（AppID/AppSecret）" configure-app-bot.ts configuration-app.json
        print_status "检测到已有 data/config/models.json"
        if ask_yes_no "是否重新配置 AI（provider/key/model）？[y/N]：" "n"; then
            run_configuration_wizard "重新配置 AI（provider/key/model）" configure.ts configuration-models.json
        fi
    fi
    [ -f "$APP_BOT_FILE" ] || [ -s "$PREVIEW_DIR/configuration-app.json" ] ||
        { print_error "没有得到应用机器人凭据（AppID/AppSecret）；${UNCHANGED}"; exit 1; }
}

# 部署要写入的 runtime.json：现有文件加上环境中设置的受支持键，停机后安装；容器路径由部署计算。取哪些键、怎样校验由目标
# 版本的 RUNTIME_KEYS 决定，这里只按名称模式转交已导出的非空 BOT_* 和 PI_CACHE_RETENTION；端口和监听地址用本次确定的值。
stage_runtime_values() {
    local key args=()
    while IFS= read -r key; do
        case "$key" in
            BOT_PORT|BOT_HOST) ;;
            BOT_*|PI_CACHE_RETENTION) [ -z "${!key:-}" ] || args+=(-e "$key") ;;
        esac
    done < <(compgen -e)
    args+=(-e "BOT_PORT=$BOT_PORT" -e "BOT_HOST=$LOOPBACK_HOST")
    run_preview "${args[@]}" -v "$PROJECT_DIR/data:/app/data:ro" -v "$PREVIEW_DIR:/preview" \
        "$IMAGE_ID" bun run scripts/config/runtime-settings.ts --prepare-values /preview/runtime-values.json --deployment docker ||
        { print_error "运行参数校验未通过（原因见上方）；${UNCHANGED}"; exit 1; }
}

# 停机前确认的事实交给核心：候选镜像、服务身份、任务 daemon、原容器（首次部署时全空）和本次的选择。核心在部署锁内逐项复核，
# 不符时在停机之前拒绝。
write_stage_records() {
    local workspace="${HOST_WORKSPACE_ROOT//\\/\\\\}"
    workspace="${workspace//\"/\\\"}"
    write_candidate_record "$PREVIEW_DIR" && write_service_user_record "$PREVIEW_DIR" && task_runtime_record "$PREVIEW_DIR/task-runtime" || return 1
    (
        umask 077
        printf 'format=1\ncontainer=%s\nimage=%s\ndata=%s\n' "$ORIGINAL_CONTAINER_ID" "$ORIGINAL_CONTAINER_IMAGE" "$ORIGINAL_CONTAINER_DATA" > "$PREVIEW_DIR/facts"
        printf '{"format":1,"target":"%s","port":%s,"workspace":"%s","cleanup":"%s"}\n' \
            "${CANDIDATE[target_sha]}" "$BOT_PORT" "$workspace" "$REVISION_CLEANUP_CHOICE" > "$PREVIEW_DIR/deployment.json"
    )
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
acquire_deploy_lock || { [ $? = 2 ] || print_error "另一个部署、升级或维护操作正在进行；部署未开始"; exit 1; }
if [ -e "$PENDING_POINTER" ]; then
    load_pending_transaction || { print_error "未完成事务的记录无法读取（原因见上方）；保持现状，请人工检查 backup/snapshots"; exit 1; }
    print_warning "$(describe_pending_transaction)"
    print_error "续做和回滚只使用事务记录，不重新部署；请使用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚"
    exit 1
fi
assert_console_lifecycle deploy || exit 1
# 机器人只监听本机回环（运行参数里的 BOT_HOST）；rootless 下的端口发布由核心创建容器时配置。不改写调用方环境里的 BOT_HOST：
# 控制台任务导出的环境原样传给核心，由它在部署锁内逐项核对，改写过的值会被当作“部署选择未完整传递”拒绝。
LOOPBACK_HOST=127.0.0.1
# 持锁时没有别的部署在运行：上次被强行终止时留下的暂存（含应用凭据）不再有用。
rm -rf -- "$PROJECT_DIR"/tmp/deploy-stage-????????
HOST_BUN="$(ops_bun)" || { print_error "宿主机没有可用的 Bun（原因见上方）；${UNCHANGED}"; exit 1; }
# 部署锁之外的运维任务和回滚容器先由核心只读检查一次，构建之前就能拒绝；交接后它在锁内再查。
"$HOST_BUN" --no-env-file "$DEPLOY_SOURCE_DIR/scripts/ops/core/cli.ts" deployment deploy --project "$PROJECT_DIR" --preflight </dev/null ||
    { print_error "部署预检未通过（原因见上方）；${UNCHANGED}"; exit 1; }
ORIGINAL_WORKSPACE_ROOT="$(saved_workspace_root)"
determine_service_user || exit 1
grant_operation_log_access || true
print_warning "转换数据前先预览；应用变更时保持停机，提交前失败恢复数据、配置和原运行状态。"
# 容器挂载的目录都先由部署脚本创建：不存在的 bind mount 源会被 Docker 以 root 身份创建，服务身份随后无法在其中写入
# （全新克隆没有 backup/）。snapshots/ 和 rm/ 也在这里建好：成功的部署会删掉空的 snapshots/，迁移容器要在其中写备份；
# 修订整理以服务身份在 revision-cleanup/ 中写会话库的备份。只有本次新建的目录交给服务身份，已有目录和数据的属主不变。
make_service_directories "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_HOME_DIR" "$LOG_DIR" "$PROJECT_DIR/backup/snapshots" "$PROJECT_DIR/backup/rm" \
    "$PROJECT_DIR/backup/revision-cleanup" ||
    { print_error "无法创建数据目录"; exit 1; }
# 本机管理端口不再询问：依次取显式 BOT_PORT（高级覆盖）、已保存端口、默认 1011。
# rootless Docker 通常不能发布 1024 以下的端口（见 rootless_port_publishable），这时默认改用 11011。
# 无效、发布不了或被其他程序占用的端口在停机前停止并说明改法，不自动换成别的端口。
FALLBACK_PORT=1011
if [ "$DOCKER_ROOTLESS" = 1 ] && ! rootless_port_publishable "$FALLBACK_PORT"; then FALLBACK_PORT=11011; fi
SAVED_PORT=""
[ ! -f "$BOT_PORT_FILE" ] || SAVED_PORT="$(tr -d '[:space:]' < "$BOT_PORT_FILE")"
if [ -n "$(trim_input "${BOT_PORT:-}")" ]; then
    PORT_SOURCE="BOT_PORT"
    BOT_PORT="$(trim_input "$BOT_PORT")"
elif [ -f "$BOT_PORT_FILE" ]; then
    PORT_SOURCE="data/state/bot-port"
    BOT_PORT="$SAVED_PORT"
else
    PORT_SOURCE=""
    BOT_PORT="$FALLBACK_PORT"
fi
PORT_FIX="改端口：设置环境变量 BOT_PORT=<端口> 后重新部署（$(ops_command_hint deploy)）；服务尚未停止"
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
if [ "$BOT_PORT" != "$SAVED_PORT" ] && local_port_in_use "$BOT_PORT"; then
    print_error "本机端口 ${BOT_PORT} 已被其他程序占用；${PORT_FIX}"
    exit 1
fi
print_success "本机管理端口：127.0.0.1:$BOT_PORT${PORT_SOURCE:+（来自 ${PORT_SOURCE}）}"

# ---- 共享资料目录（WORKSPACE_ROOT；默认 data/workspace）----
# 取 WORKSPACE_ROOT 环境变量（设为空恢复默认），未设置时沿用已保存设置。
# 外置目录必须已存在：只读挂到容器 /app/workspace，部署不创建、不改属主；服务身份需能读取其中的资料。
HOST_WORKSPACE_ROOT="$(trim_input "${WORKSPACE_ROOT-$ORIGINAL_WORKSPACE_ROOT}")"
if [ -n "$HOST_WORKSPACE_ROOT" ]; then
    if ! HOST_WORKSPACE_ROOT="$(realpath -e -- "$HOST_WORKSPACE_ROOT" 2>/dev/null)" || [ ! -d "$HOST_WORKSPACE_ROOT" ]; then
        print_error "WORKSPACE_ROOT 不存在或不是目录：${WORKSPACE_ROOT-$ORIGINAL_WORKSPACE_ROOT}；服务尚未停止"
        exit 1
    fi
fi
workspace_mount "$HOST_WORKSPACE_ROOT"
print_status "共享资料目录：${HOST_WORKSPACE_ROOT:-$DATA_DIR/workspace}${HOST_WORKSPACE_ROOT:+（只读挂到容器 /app/workspace）}"
echo ""

# ---- 目录 ----

print_status "设置目录权限..."
prepare_service_directories
print_success "目录就绪（服务身份 ${SERVICE_USER}）"

# ---- 构建镜像 ----

# 此后到核心发布事务指针之前，失败、取消或中断只清理本次的暂存、预览容器和保留标签。
trap cleanup_before_pointer EXIT
trap_preparation_signals
build_workspace_candidate

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

# ---- 停机前的准备：只读取和校验，全部确定才交给核心 ----

make_stage
preview_current_data
choose_configuration
preview_revision_cleanup
# 首次部署的应用凭据还在暂存里，向平台核对部门时用它。
if [ -s "$PREVIEW_DIR/configuration-app.json" ]; then choose_directory_scope --app /preview/configuration-app.json; else choose_directory_scope; fi
stage_runtime_values
write_stage_records || { print_error "无法写入停机前的准备记录；${UNCHANGED}"; exit 1; }
print_status "停机前复核剩余空间..."
check_stop_disk_space ||
    { print_error "剩余空间不够写入停机后的快照和修订整理的备份（原因见上方）；${UNCHANGED}"; exit 1; }

print_status "交给运维核心：在部署锁内复核后记录事务并停止机器人服务；此后写入配置、迁移和验证期间服务保持停止，不再构建镜像"
run_core "$DEPLOY_SOURCE_DIR/scripts/ops/core/cli.ts" deployment deploy --project "$PROJECT_DIR" --stage "$PREVIEW_DIR" --command "$DEPLOY_COMMAND"
if [ "$CORE_STATUS" != 0 ]; then
    if [ -e "$PENDING_POINTER" ]; then
        print_error "部署未完成，事务已保留（原因见上方）；处理后可用 $(ops_command_hint resume) 继续，或 $(ops_command_hint rollback) 回滚（数据已提交时只能继续）"
    fi
    exit "$CORE_STATUS"
fi

# ---- 输出信息 ----

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
echo "  可选外链:  $(ops_command_hint relay-configure)"
echo "  本机管理:  $LOOPBACK_HOST:$BOT_PORT"
echo ""
echo "  内存限制: 512MB | CPU: 1核"
echo ""
echo "  常用操作（带健康检查和失败回滚）:"
echo "    体检: $(ops_command_hint doctor)"
echo "    日志: $(ops_command_hint logs)"
echo "    重启: $(ops_command_hint restart)"
echo "    升级: $(ops_command_hint update)（沿用现有配置，停机前完成全部确认；改配置请重新部署）"
echo ""
if [ "${MIXIN_OPS_UI:-}" != "console" ]; then
    echo "  底层命令（ops.sh 不适用时排障用）:"
    echo "    docker logs -f mixin-chatbot                         # 容器层日志"
    echo "    docker restart mixin-chatbot                         # 直接重启容器"
    echo "    bash scripts/deploy/deploy.sh                        # 重配 AI 并验证新实例，失败回滚"
    echo ""
fi

print_status "最近日志:"
docker logs --tail 10 mixin-chatbot 2>&1 || true
