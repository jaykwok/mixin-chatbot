#!/usr/bin/env bash
# Linux 脚本共用的实例健康、模型校验、部署互斥和生命周期操作。
#
# lifecycle 函数在调用时读取 PROJECT_DIR；导入不操作外部状态。
#
# 用法：. "${PROJECT_DIR}/scripts/lib/common.sh"
. "$(dirname "${BASH_SOURCE[0]}")/lifecycle.sh"
. "$(dirname "${BASH_SOURCE[0]}")/operation-log.sh"
. "$(dirname "${BASH_SOURCE[0]}")/transaction.sh"
. "$(dirname "${BASH_SOURCE[0]}")/console-plan.sh"

# 管理界面中显示对应页面；命令行调用仍显示可直接执行的命令。
ops_command_hint() {
    local command="$1" path=""
    if [ "${MIXIN_OPS_UI:-}" = "console" ]; then
        case "$command" in
            deploy) path='维护 → 重新部署' ;;
            update) path='维护 → 升级' ;;
            resume) path='维护 → 继续上次操作' ;;
            rollback) path='维护 → 回滚上次操作' ;;
            start) path='维护 → 启动' ;;
            stop) path='维护 → 停止' ;;
            restart) path='维护 → 重启' ;;
            repair) path='维护 → 修复部署' ;;
            doctor) path='体检 → 刷新' ;;
            status) path='总览 → 刷新' ;;
            logs) path='日志' ;;
            configure-app-bot) path='设置 → 应用机器人凭据' ;;
            relay-configure) path='设置 → 外链配置' ;;
            directory) path='通讯录' ;;
        esac
        if [ -n "$path" ]; then printf '「%s」' "$path"; return; fi
    fi
    printf 'scripts/ops.sh %s' "$command"
}

# Host-port response must identify this project's current instance. Docker provides Bun when the host does not.
# Pass --allow-verification only when a deployment deliberately checks its verification-only instance.
bot_local_ready() {
    local port="$1" body
    shift
    body="$(curl --noproxy '*' --max-time 3 -fsS "http://127.0.0.1:$port/health")" || return 1
    if command -v bun >/dev/null 2>&1; then
        (cd "$PROJECT_DIR" && printf '%s' "$body" | BOT_PORT="$port" bun --no-env-file run ops/tools/health-check.ts --stdin "$@")
    else
        printf '%s' "$body" | docker exec -i -e BOT_PORT="$port" mixin-bot bun run ops/tools/health-check.ts --stdin "$@"
    fi
}

# rootless Docker 把容器里的 root 映射为运行守护进程的宿主机用户，其他 UID 映射到 subuid 区间，
# 读写不了部署用户拥有的 bind mount；此时容器以 0:0 运行，在宿主机上仍是这个普通用户。
docker_rootless() {
    local options
    options="$(docker info --format '{{.SecurityOptions}}' 2>/dev/null)" || return 1
    [[ "$options" == *name=rootless* ]]
}

# 访问宿主机上属于 owner（uid:gid）的挂载目录时，容器进程使用的身份。
container_user() {
    if docker_rootless; then echo 0:0; else echo "$1"; fi
}

# rootless Docker 发布的端口由 rootlesskit 父进程（默认 builtin 端口驱动）以部署用户身份在宿主机上监听：
# 低于 net.ipv4.ip_unprivileged_port_start（通常 1024）的端口要求它有 CAP_NET_BIND_SERVICE，
# 否则要到停机后启动容器时才报 cannot expose privileged port。
unprivileged_port_start() {
    local start
    start="$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null)" || start=1024
    [[ "$start" =~ ^[0-9]+$ ]] || start=1024
    echo "$start"
}

rootless_port_publishable() {
    local port="$1" pid caps
    [ "$port" -lt "$(unprivileged_port_start)" ] || return 0
    # 父进程名为 rootlesskit（重新执行的子进程叫 exe）。带文件能力的进程不可转储，读不到它的 user namespace，
    # 所以按能力区分：父进程只有被授予的 CAP_NET_BIND_SERVICE（第 10 位）；自己 user namespace 里的子进程拥有全部能力，
    # 包括 CAP_SYS_ADMIN（第 21 位），不算。
    for pid in $(pgrep -u "$(id -u)" -x rootlesskit 2>/dev/null); do
        caps="$(sed -n 's/^CapEff:[[:space:]]*//p' "/proc/$pid/status" 2>/dev/null)"
        [[ "$caps" =~ ^[0-9a-fA-F]+$ ]] || continue
        (( (16#$caps >> 10) & 1 && !((16#$caps >> 21) & 1) )) && return 0
    done
    return 1
}

rootless_port_hint() {
    local port="$1" start
    start="$(unprivileged_port_start)"
    printf '%s%s%s\n' "rootless Docker 不能发布低于 ${start} 的端口 ${port}：请改用 ${start}–65535 的端口；或放开低端口后重试：" \
        "sudo sysctl -w net.ipv4.ip_unprivileged_port_start=${port}（写入 /etc/sysctl.d/ 持久化），" \
        "或 sudo setcap cap_net_bind_service=ep \"\$(command -v rootlesskit)\" 后运行 systemctl --user restart docker"
}

# 本机 127.0.0.1:$1 是否已有程序在监听（能连上即占用）。回环连接立即被接受或拒绝，不会挂起。
local_port_in_use() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# 运维入口的模型配置检查。Docker 部署的工作区没有依赖（node_modules 只在镜像里）：此时用正式镜像自带的检查脚本和依赖，
# 只读挂载 data/，以 service_container_user 运行（服务身份才能读取 600 权限的配置文件）。
validate_model_configuration() {
    local user
    if command -v bun >/dev/null 2>&1 && [ -d "$PROJECT_DIR/node_modules" ]; then
        bun --no-env-file run "$PROJECT_DIR/ops/config/validate-models.ts" "$PROJECT_DIR"
    else
        user="$(service_container_user)" || return 1
        docker run --rm --network none --user "$user" -v "$PROJECT_DIR/data:/app/data:ro" mixin-bot bun run ops/config/validate-models.ts /app
    fi
}

# 运维入口的一次性容器使用的身份：服务容器 mixin-bot 记录的数值 UID:GID；没有容器时按 data/config 的属主。
service_container_user() {
    local user owner
    user="$(docker container inspect --format '{{.Config.User}}' mixin-bot 2>/dev/null)" || user=''
    if [[ "$user" =~ ^[0-9]+:[0-9]+$ ]]; then echo "$user"; return 0; fi
    owner="$(stat -c '%u:%g' -- "$PROJECT_DIR/data/config")" || return 1
    container_user "$owner"
}

# 在描述符 9 上打开部署锁。rootful 部署把 data/state 交给服务身份，以 root 运行的入口不能按路径写它：不存在时用 noclobber
# 新建（O_EXCL，路径上已有任何条目都失败，不经链接创建），之后只读打开（不截断、不创建）；打开的必须正是这个路径上的
# 普通文件。打开前确认是普通文件，免得对换进来的 FIFO 只读打开时一直挂起。
open_deploy_lock() {
    local path="$1"
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then (set -C; umask 077; : > "$path") 2>/dev/null || true; fi
    if [ -L "$path" ] || [ ! -f "$path" ]; then
        echo "部署锁 $path 不是普通文件，未执行操作；请人工检查（它不应是链接或其他类型的文件），删除后重试" >&2; return 1
    fi
    exec 9<"$path" || return 1
    if [ "$(readlink /proc/self/fd/9 2>/dev/null)" != "$path" ] || [ ! -f /proc/self/fd/9 ]; then
        exec 9<&-; echo "部署锁 $path 在打开时被替换，未执行操作；请人工检查" >&2; return 1
    fi
}

# 返回 0 取得锁；1 锁被占用（调用方按自己的操作说明）；2 拒绝：锁文件异常或控制台计划复核未通过，原因已经打印。
# 不是 0 时 DEPLOY_LOCK_REFUSAL 是结构化结果的说明：什么都没有执行，记为 refused。
acquire_deploy_lock() {
    DEPLOY_LOCK_REFUSAL=''
    mkdir -p "$PROJECT_DIR/data/state"
    local lock_path
    lock_path="$(realpath "$PROJECT_DIR/data/state")/deploy.lock"
    if [ "${BOT_DEPLOY_LOCK_HELD:-}" = "$lock_path" ] && [ "$(readlink /proc/self/fd/9 2>/dev/null)" = "$lock_path" ]; then
        flock -n 9
        return $?
    fi
    open_deploy_lock "$lock_path" || { DEPLOY_LOCK_REFUSAL='部署锁文件异常，未执行操作（原因见任务输出）'; return 2; }
    flock -n 9 || { exec 9<&-; DEPLOY_LOCK_REFUSAL='部署、升级或另一个维护操作正在进行；未执行操作'; return 1; }
    if ! check_console_plan; then
        exec 9<&-; DEPLOY_LOCK_REFUSAL='控制台计划复核未通过（原因见任务输出），未执行操作；请重新预览'; return 2
    fi
    export BOT_DEPLOY_LOCK_HELD="$lock_path"
}

# 部署锁此刻是否被别的进程持有（只读探测，不持有）。锁文件异常时按“正在进行”处理。
deploy_lock_busy() {
    local path="$1"
    [ -e "$path" ] || [ -L "$path" ] || return 1
    ( open_deploy_lock "$path" 2>/dev/null || exit 0; ! flock -n 9 )
}

# 部署时可从环境写入 runtime.json 的运行参数（端口和共享资料目录之外，与 runtime-schema.ts 的 ADVANCED_RUNTIME_KEYS
# 相同，用例对照）。升级、续做和回滚沿用 runtime.json，不采用当前终端的这些值。
RUNTIME_ENV_KEYS=(BOT_MAX_ACTIVE_REQUESTS BOT_ACKNOWLEDGE_IDLE_MINUTES BOT_BASH_TIMEOUT BOT_INDEX_TTL_MINUTES BOT_INDEX_MAX_FILES BOT_INDEX_MAX_DEPTH BOT_RUN_TIMEOUT_SECONDS
    BOT_MODEL_IDLE_TIMEOUT_SECONDS BOT_MODEL_RESPONSE_TIMEOUT_SECONDS BOT_CLOSEOUT_SECONDS BOT_DELIVERY_RESERVE_SECONDS BOT_FALLBACK_SEND_SECONDS
    BOT_SHUTDOWN_TIMEOUT_SECONDS BOT_DOCUMENT_ENV BOT_DOCUMENT_WORK_ENABLED BOT_DOCUMENT_PPTX_TEMPLATE BOT_DOCUMENT_DOCX_TEMPLATE
    BOT_DOCUMENT_OFFICE_PATH PI_CACHE_RETENTION BOT_ATTACHMENT_CONCURRENCY BOT_TASK_IMAGE BOT_TASK_CONTROL_ROOT)

# 当前升级器的引导依赖：ops.sh update 从目标提交导出这些路径，再运行其中的升级器。
# 镜像另从目标提交完整导出构建上下文（见 candidate_export_context）。
UPGRADER_EXPORT_PATHS=(scripts/upgrade.sh scripts/lib ops/tools Dockerfile)

# git 只经这里调用：GIT_TERMINAL_PROMPT=0 让缺凭证时立刻失败，而不是挂在无人应答的提示上。
git_here() {
    GIT_TERMINAL_PROMPT=0 git -C "$PROJECT_DIR" "$@"
}

# root 升级由 docker 组用户部署的实例时，检出属于那个用户：git 拒绝以 root 使用它，因为仓库中的钩子和配置会以 root
# 运行。是否信任由操作者决定，脚本不代为加入 safe.directory。git 因此拒绝时输出说明并返回 0，否则返回 1。
git_ownership_refusal() {
    local output owner
    output="$(LC_ALL=C git_here rev-parse --is-inside-work-tree 2>&1 >/dev/null)" && return 1
    [[ "$output" == *"dubious ownership"* ]] || return 1
    owner="$(stat -c %U -- "$PROJECT_DIR" 2>/dev/null)" || owner='其他用户'
    printf '%s 的 git 仓库属于 %s，git 拒绝以当前用户操作它（仓库中的钩子和配置会以当前用户运行）。确认信任这份检出后执行 git config --global --add safe.directory %s，再重试\n' \
        "$PROJECT_DIR" "$owner" "$PROJECT_DIR"
}
