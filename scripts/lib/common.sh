#!/usr/bin/env bash
# Linux 脚本共用的主机名、实例健康、模型校验、部署互斥和生命周期操作。
#
# lifecycle 函数在调用时读取 PROJECT_DIR 与 TUNNEL_PID_FILE；导入不操作外部状态。
#
# 用法：. "${PROJECT_DIR}/scripts/lib/common.sh"
. "$(dirname "${BASH_SOURCE[0]}")/lifecycle.sh"
. "$(dirname "${BASH_SOURCE[0]}")/tunnel-logging.sh"
. "$(dirname "${BASH_SOURCE[0]}")/operation-log.sh"
. "$(dirname "${BASH_SOURCE[0]}")/transaction.sh"

# 量子密信平台出口 IP（webhook 来源；UFW/WAF 按此放行）。部署可用 PLATFORM_IP 覆盖，确认值写入事务记录。
DEFAULT_PLATFORM_IP=223.244.14.237

# TUI 中显示菜单路径；命令行调用仍显示可直接执行的命令。
ops_command_hint() {
    local command="$1" path=""
    if [ "${MIXIN_OPS_TUI:-}" = "1" ]; then
        case "$command" in
            deploy) path='系统 → 服务部署 → 部署 / 修改设置' ;;
            update) path='系统 → 服务部署 → 升级（保留设置）' ;;
            resume) path='系统 → 服务部署 → 继续上次操作' ;;
            rollback) path='系统 → 服务部署 → 回滚上次操作' ;;
            start) path='系统 → 服务部署 → 启动' ;;
            stop) path='系统 → 服务部署 → 停止' ;;
            restart) path='系统 → 服务部署 → 重启' ;;
            tunnel-update) path='系统 → 服务部署 → 更新 cloudflared' ;;
            uninstall) path='系统 → 服务部署 → 卸载' ;;
            doctor) path='监控 → 体检（按 r 刷新）' ;;
            logs) path='监控 → 日志' ;;
        esac
        if [ -n "$path" ]; then printf '「%s」' "$path"; return; fi
    fi
    printf 'scripts/ops/ops.sh %s' "$command"
}

is_valid_hostname() {
    local hostname="$1"
    [ -n "$hostname" ] && [ "${#hostname}" -le 253 ] || return 1
    [[ "$hostname" != .* && "$hostname" != *. && "$hostname" != *..* ]] || return 1
    local labels=()
    IFS='.' read -r -a labels <<< "$hostname"
    local label
    for label in "${labels[@]}"; do
        [ -n "$label" ] && [ "${#label}" -le 63 ] || return 1
        [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || return 1
    done
}

# 把用户输入规范化成裸 hostname。允许直接填 https://bot.example.com 这种整段 URL——
# 从浏览器地址栏复制粘贴是最自然的动作——但只接受不带端口、路径、查询的根地址，其余
# 一律判为无效，免得把一段面目不清的输入写进部署状态。
normalize_hostname_input() {
    local value host
    value="$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if is_valid_hostname "$value"; then
        printf '%s' "${value,,}"
        return 0
    fi
    if [[ "$value" =~ ^[Hh][Tt][Tt][Pp][Ss]?://([^/:?#]+)(/)?$ ]]; then
        host="${BASH_REMATCH[1]}"
        if is_valid_hostname "$host"; then
            printf '%s' "${host,,}"
            return 0
        fi
    fi
    return 1
}

# Host-port response must identify this project's current instance. Docker provides Bun when the host does not.
# Pass --allow-verification only when a deployment deliberately checks its verification-only instance.
bot_local_ready() {
    local port="$1" body
    shift
    body="$(curl --noproxy '*' --max-time 3 -fsS "http://127.0.0.1:$port/health")" || return 1
    if command -v bun >/dev/null 2>&1; then
        (cd "$PROJECT_DIR" && printf '%s' "$body" | BOT_PORT="$port" bun run scripts/ops/health-check.ts --stdin "$@")
    else
        printf '%s' "$body" | docker exec -i -e BOT_PORT="$port" mixin-chatbot bun run scripts/ops/health-check.ts --stdin "$@"
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

# Docker 部署的工作区没有依赖（node_modules 只在镜像里）：此时用镜像自带的检查脚本和依赖，只读挂载 data/。
# 部署传入本次的 image ID 和服务身份；运维入口用正式标签和 service_container_user（服务身份才能读取 600 权限的配置文件）。
validate_model_configuration() {
    local image="${1:-mixin-chatbot}" user="${2:-}"
    if command -v bun >/dev/null 2>&1 && [ -d "$PROJECT_DIR/node_modules" ]; then
        bun run "$PROJECT_DIR/scripts/config/validate-models.ts" "$PROJECT_DIR"
    else
        [ -n "$user" ] || user="$(service_container_user)" || return 1
        docker run --rm --network none --user "$user" -v "$PROJECT_DIR/data:/app/data:ro" "$image" bun run scripts/config/validate-models.ts /app
    fi
}

# 运维入口的一次性容器使用的身份：服务容器 mixin-chatbot 记录的数值 UID:GID；没有容器时按 data/config 的属主。
service_container_user() {
    local user owner
    user="$(docker container inspect --format '{{.Config.User}}' mixin-chatbot 2>/dev/null)" || user=''
    if [[ "$user" =~ ^[0-9]+:[0-9]+$ ]]; then echo "$user"; return 0; fi
    owner="$(stat -c '%u:%g' -- "$PROJECT_DIR/data/config")" || return 1
    container_user "$owner"
}

# A pinned official release keeps Windows and Linux downloads reproducible without a JSON parser.
# Run in a subshell so temporary-file cleanup does not replace a deployment's traps.
ensure_cloudflared() (
    local PROJECT_DIR="$1" executable="$1/cloudflared" version asset checksum actual download output
    if [ -x "$executable" ] && output="$("$executable" --version 2>/dev/null)" && [[ "$output" =~ ^cloudflared[[:space:]]+version ]]; then
        printf '%s\n' "$executable"
        return 0
    fi
    if [ -e "$executable" ] && [ ! -f "$executable" ]; then
        echo "cloudflared 路径不是文件：$executable" >&2
        return 1
    fi
    case "$(uname -m)" in
        x86_64|amd64) asset=cloudflared-linux-amd64 ;;
        aarch64|arm64) asset=cloudflared-linux-arm64 ;;
        armv6*|armv7*) asset=cloudflared-linux-arm ;;
        i?86) asset=cloudflared-linux-386 ;;
        *) echo '当前 Linux 架构没有自动下载项，请将可用的 cloudflared 放在项目根目录。' >&2; return 1 ;;
    esac
    read -r version _ checksum < <(awk -v asset="$asset" '$2 == asset { print; exit }' "$PROJECT_DIR/scripts/tunnel/cloudflared-release.txt") || return 1
    checksum="${checksum%$'\r'}"
    if ! [[ "$version" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+$ && "$checksum" =~ ^[a-fA-F0-9]{64}$ ]]; then
        echo "cloudflared 下载清单无效：$asset" >&2
        return 1
    fi
    download="$(mktemp "$executable.download-XXXXXX")" || return 1
    trap 'rm -f -- "$download"' EXIT
    echo "[*] 正在从 Cloudflare 官方发布下载 cloudflared $version 到项目根目录..." >&2
    curl --proto '=https' --tlsv1.2 --fail --location --show-error --silent --connect-timeout 15 --max-time 180 \
        --output "$download" "https://github.com/cloudflare/cloudflared/releases/download/$version/$asset" || return 1
    actual="$(sha256sum < "$download")" || return 1
    if [ "${actual%% *}" != "${checksum,,}" ]; then
        echo 'cloudflared 下载文件 SHA-256 校验失败' >&2
        return 1
    fi
    chmod 755 "$download" || return 1
    if ! output="$("$download" --version 2>/dev/null)" || ! [[ "$output" =~ ^cloudflared[[:space:]]+version ]]; then
        echo '下载的 cloudflared 无法运行或版本检查失败' >&2
        return 1
    fi
    archive_project_path "$executable" || return 1
    mv -- "$download" "$executable" || return 1
    printf '%s\n' "$executable"
)

show_tunnel_token_help() {
    echo 'token 获取：Cloudflare 控制台 → Networking → Tunnels → 创建 Cloudflared 隧道，或选择已有隧道 → Add a replica（添加副本）。'
    echo '控制台入口：https://dash.cloudflare.com/?to=/:account/tunnels'
    echo '复制安装命令中 eyJ 开头的完整 token，可直接粘贴，或保存到 data/config/cloudflared-token。'
    echo '部署时可输入 token 或文件路径；留空读取 data/config/cloudflared-token，已设置的 TUNNEL_TOKEN_FILE / TUNNEL_TOKEN 环境变量优先。'
    echo '默认文件直接用于运行；直接粘贴的 token 也保存到 data/config/cloudflared-token。'
}

normalize_tunnel_token() {
    local value
    value="$(printf '%s' "$1" | sed $'s/\xef\xbb\xbf//g' | tr -d "[:space:]\"'")"
    [[ "$value" =~ ^eyJ[A-Za-z0-9+/_-]{17,}={0,2}$ ]] || return 1
    printf '%s' "$value"
}

read_tunnel_token_file() {
    local content assignment
    content="$(cat -- "$1")" || return 1
    # Keep "=" padding on bare base64 tokens; only TUNNEL_TOKEN= is an assignment.
    assignment="$(printf '%s\n' "$content" | sed $'s/^\xef\xbb\xbf//' |
        sed -nE 's/^[[:blank:]]*(export[[:blank:]]+)?TUNNEL_TOKEN[[:blank:]]*=(.*)$/\2/p' | head -n 1)"
    if printf '%s\n' "$content" | sed $'s/^\xef\xbb\xbf//' | grep -qE '^[[:blank:]]*(export[[:blank:]]+)?TUNNEL_TOKEN[[:blank:]]*='; then
        normalize_tunnel_token "$assignment"
    else
        normalize_tunnel_token "$content"
    fi
}

# Resolve without printing credentials or changing files. Explicit input wins over the environment.
load_tunnel_token() {
    local selection="${1:-}" path="" value=""
    TUNNEL_TOKEN_VALUE=""
    TUNNEL_TOKEN_SOURCE=""
    selection="$(printf '%s' "$selection" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']$//")"
    if [ -n "$selection" ]; then
        case "$selection" in /*) path="$selection" ;; *) path="$PROJECT_DIR/$selection" ;; esac
        if [ ! -f "$path" ]; then
            if ! value="$(normalize_tunnel_token "$selection")"; then
                echo '未找到 token 文件或输入格式无效；请输入文件路径或 eyJ 开头的完整 token。' >&2
                return 1
            fi
            path=""
            TUNNEL_TOKEN_SOURCE='直接输入（值已隐藏）'
        fi
    elif [ -n "${TUNNEL_TOKEN_FILE:-}" ]; then
        selection="$TUNNEL_TOKEN_FILE"
        case "$selection" in /*) path="$selection" ;; *) path="$PROJECT_DIR/$selection" ;; esac
    elif [ -n "${TUNNEL_TOKEN:-}" ]; then
        value="$(normalize_tunnel_token "$TUNNEL_TOKEN")" || {
            echo 'TUNNEL_TOKEN 格式无效，需要 eyJ 开头的完整 token。' >&2; return 1;
        }
        TUNNEL_TOKEN_SOURCE='env:TUNNEL_TOKEN（值已隐藏）'
    else
        path="$PROJECT_DIR/data/config/cloudflared-token"
    fi
    if [ -n "$path" ]; then
        if [ ! -f "$path" ]; then
            echo '找不到隧道 token 文件；请检查 TUNNEL_TOKEN_FILE，或保存到 data/config/cloudflared-token。' >&2
            return 1
        fi
        value="$(read_tunnel_token_file "$path")" || {
            echo 'token 文件为空、无法读取或格式无效；.env 文件需包含 TUNNEL_TOKEN。' >&2; return 1;
        }
        TUNNEL_TOKEN_SOURCE="$path"
    fi
    TUNNEL_TOKEN_VALUE="$value"
}

save_project_tunnel_token() {
    local value token_path="$PROJECT_DIR/data/config/cloudflared-token"
    value="$(normalize_tunnel_token "$1")" || return 1
    mkdir -p "$PROJECT_DIR/data/config" || return 1
    if [ ! -f "$token_path" ] || ! cmp -s "$token_path" <(printf '%s' "$value"); then
        (umask 077 && printf '%s' "$value" > "$token_path") || return 1
    fi
    chmod 600 "$token_path" || return 1
    printf '%s' "$token_path"
}

acquire_deploy_lock() {
    mkdir -p "$PROJECT_DIR/data/state"
    local lock_path
    lock_path="$(realpath "$PROJECT_DIR/data/state")/deploy.lock"
    if [ "${BOT_DEPLOY_LOCK_HELD:-}" = "$lock_path" ] && [ "$(readlink /proc/self/fd/9 2>/dev/null)" = "$lock_path" ]; then
        flock -n 9
        return $?
    fi
    exec 9>"$lock_path"
    flock -n 9 || return 1
    export BOT_DEPLOY_LOCK_HELD="$lock_path"
}

# 部署时从环境写入 runtime.json 的运行参数。升级、续做和回滚沿用 runtime.json，不采用当前终端的这些值。
RUNTIME_ENV_KEYS=(BOT_DEBUG BOT_MAX_ACTIVE_REQUESTS BOT_BASH_TIMEOUT BOT_INDEX_TTL_MINUTES BOT_INDEX_MAX_FILES BOT_INDEX_MAX_DEPTH BOT_RUN_TIMEOUT_SECONDS BOT_MODEL_IDLE_TIMEOUT_SECONDS BOT_MODEL_RESPONSE_TIMEOUT_SECONDS BOT_SHUTDOWN_TIMEOUT_SECONDS BOT_DELIVERY_TIMEOUT_SECONDS BOT_DOCUMENT_ENV BOT_DOCUMENT_WORK_ENABLED PI_CACHE_RETENTION BOT_ATTACHMENT_CONCURRENCY)

# 升级器从目标提交导出的文件。旧版运维脚本按它自己的这份列表导出新版升级器，所以列表只增不减；当前升级器只用
# upgrade.sh 和 scripts/lib，镜像另从目标提交完整导出构建上下文（见 candidate_export_context）。
UPGRADER_EXPORT_PATHS=(scripts/deploy/upgrade.sh scripts/lib scripts/migrations src/core/data-version.ts Dockerfile)

# 旧版运维脚本升级到新版时需在项目目录运行一次的引导命令；之后 ops.sh update 自行导出目标升级器。
upgrade_bootstrap_command() {
    printf '%s\n' 'git fetch origin main' \
        'rm -rf tmp/upgrade-bootstrap && mkdir -p tmp/upgrade-bootstrap' \
        "git archive origin/main ${UPGRADER_EXPORT_PATHS[*]} | tar -x -C tmp/upgrade-bootstrap" \
        'bash tmp/upgrade-bootstrap/scripts/deploy/upgrade.sh "$PWD" origin/main' \
        'rm -rf tmp/upgrade-bootstrap'
}

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

# 把工作区退回升级前那个提交（升级器和旧版升级记录的回滚共用）。
#
# 升级前是 detached HEAD 时（rev-parse --abbrev-ref 返回字面量 "HEAD"）绝不能用 reset：
# 升级过程中已经 checkout 到 main 了，reset --hard 会把 main 这个分支指针拖回那个游离
# 提交，等于用一次回滚顺手毁掉 main。这种情况直接 checkout 回那个提交，恢复原本的
# detached 状态，分支指针一个都不动。
restore_checkout() {
    local branch="$1" sha="$2" failure=''
    if [ -z "$branch" ] || [ "$branch" = HEAD ]; then
        if git_here checkout --force "$sha" >/dev/null 2>&1; then
            echo "已恢复到升级前的游离 HEAD（${sha:0:7}）；分支指针未改动"
            operation_event warn "restored detached HEAD ${sha}"
            return 0
        fi
        failure="回滚到游离提交 ${sha} 失败"
    elif ! git_here checkout "$branch" >/dev/null 2>&1; then failure="切回分支 ${branch} 失败"
    elif ! git_here reset --hard "$sha" >/dev/null 2>&1; then failure="回滚到 ${sha} 失败"
    else return 0; fi
    echo "$failure" >&2
    operation_event error "$failure"
    return 1
}

# restore_checkout 会丢弃工作区的改动（reset --hard / checkout --force）：恢复前检查升级后的人工改动。
# 当前提交和要重置的原分支只能停在升级前或目标提交；已跟踪文件不能有改动。升级前有、当前提交没有的路径由恢复重建：
# 路径本身已有的内容只能是目标版本跟踪的目录，且其中没有未跟踪或忽略的文件；各级父路径只能是目录、不存在，
# 或目标版本跟踪的文件（含链接），否则 git 会删掉占位的文件或链接再建目录（或经链接写到别处）。有冲突时逐项列出并返回 1，调用方保留事务并停止。
code_restore_safe() {
    local branch="$1" original="$2" target="$3" head ref line conflicts=()
    head="$(git_here rev-parse --verify --quiet 'HEAD^{commit}')" || head=''
    [ "$head" = "$original" ] || [ "$head" = "$target" ] ||
        conflicts+=("当前提交 ${head:0:7} 既不是升级前的 ${original:0:7}，也不是目标 ${target:0:7}：升级后有新的提交或切换")
    if [ -n "$branch" ] && [ "$branch" != HEAD ]; then
        ref="$(git_here rev-parse --verify --quiet "refs/heads/${branch}^{commit}")" || ref=''
        [ "$ref" = "$original" ] || [ "$ref" = "$target" ] ||
            conflicts+=("分支 ${branch} 指向 ${ref:0:7}，不是升级前或目标提交：回滚会把它重置到 ${original:0:7}")
    fi
    while IFS= read -r line; do
        [ -z "$line" ] || conflicts+=("未提交的改动：$line")
    done < <(git_here status --porcelain --untracked-files=no 2>&1)
    if [ -n "$head" ] && git_here cat-file -e "${original}^{commit}" 2>/dev/null; then
        untracked_switch_conflicts conflicts "$head" "$head" "$original" 升级前的版本 升级前版本
    fi
    [ "${#conflicts[@]}" -gt 0 ] || return 0
    echo "恢复升级前的代码会丢弃以下内容：" >&2
    printf '  - %s\n' "${conflicts[@]}" >&2
    operation_event error "code restore blocked by ${#conflicts[@]} local change(s)"
    return 1
}

# 把检出从 <from> 切换到 <to> 时会被覆盖或删除的未跟踪内容（包括被忽略的文件：git 切换时直接覆盖或随目录删除它们）
# 追加到数组 <out>；<label> 是 <to> 在说明中的名称，<owner> 是“占着……的目录位置”中的写法（默认同 <label>）。
# 只看 <from> 到 <to> 新增的路径：路径本身已有的内容只能是当前提交 <basis> 跟踪的文件或目录，目录中也不能有未跟踪
# 或忽略的文件；各级父路径只能是目录、不存在，或 <basis> 跟踪的文件（含链接），否则 git 会删掉占位的文件或链接再建目录
# （或经链接写到别处）。<basis> 跟踪的文件由调用方确认没有改动，经中间提交切换时（<from> 不是 <basis>），它们在
# 前一步被删除或替换，不算冲突。父路径由外向内检查，第一个不是目录的父路径之下不再检查：工作区里没有这些路径，
# 经链接看到的是别处的内容，git 删掉这个父路径再建目录，不经它写入。只读取工作区和对象库。
untracked_switch_conflicts() {
    local -n switch_conflicts="$1"
    local basis="$2" from="$3" to="$4" label="$5" owner="${6:-$5}" path parent rest line kind
    local -A occupied=()
    while IFS= read -r -d '' path; do
        parent='' rest="$path"
        while [[ "$rest" == */* ]]; do
            parent+="${parent:+/}${rest%%/*}" rest="${rest#*/}"
            if [ -z "${occupied[$parent]:-}" ]; then
                occupied[$parent]=no
                if [ -L "$PROJECT_DIR/$parent" ] || { [ -e "$PROJECT_DIR/$parent" ] && [ ! -d "$PROJECT_DIR/$parent" ]; }; then
                    occupied[$parent]=yes
                    [ "$(git_here cat-file -t "$basis:$parent" 2>/dev/null)" = blob ] ||
                        switch_conflicts+=("未跟踪的文件或链接占着${owner}的目录位置：$parent")
                fi
            fi
            [ "${occupied[$parent]}" = no ] || continue 2
        done
        if [ -e "$PROJECT_DIR/$path" ] || [ -L "$PROJECT_DIR/$path" ]; then
            kind="$(git_here cat-file -t "$basis:$path" 2>/dev/null)" || kind=''
            if [ ! -L "$PROJECT_DIR/$path" ] && [ -d "$PROJECT_DIR/$path" ] && [ "$kind" = tree ]; then
                while IFS= read -r -d '' line; do
                    switch_conflicts+=("未跟踪的文件会随目录删除（${label}在 $path 是文件）：$line")
                done < <(git_here --literal-pathspecs ls-files -z --others -- "$path" 2>/dev/null)
            elif [ "$kind" != blob ]; then
                switch_conflicts+=("未跟踪的文件会被${label}覆盖：$path")
            fi
        fi
    done < <(git_here diff --name-only --no-renames -z --diff-filter=A "$from" "$to" 2>/dev/null)
}

# 升级切换代码的实际路径：当前提交 <head> -> main <main>（checkout），再快进到目标 <target>。停机前预演这两步，会被
# 覆盖或删除的未跟踪内容逐项列出并返回 1；操作者移走后重试，脚本不移动、不删除它们。调用方已确认已跟踪文件没有
# 改动、main 能快进到目标。规则之外再用 git 试运行能直接预演的两次切换（当前 -> main，当前 -> 目标：目标经 main
# 新增的路径都在其中），git 拒绝而规则没有列出时同样停止。试运行用 <scratch> 中的索引副本：工作区的索引、
# index.lock 和文件都不改动。
switch_preflight() {
    local head="$1" main="$2" target="$3" scratch="$4" output route conflicts=()
    [ "$head" = "$main" ] || untracked_switch_conflicts conflicts "$head" "$head" "$main" '切换途经的 main 分支'
    [ "$main" = "$target" ] || untracked_switch_conflicts conflicts "$head" "$main" "$target" 目标版本
    if [ "${#conflicts[@]}" = 0 ]; then
        if [ "$head" != "$main" ] && ! output="$(switch_dry_run "$head" "$main" "$scratch")"; then
            conflicts+=("git 试运行切换到 main 失败：${output//$'\n'/ }")
        elif [ "$head" != "$target" ] && ! output="$(switch_dry_run "$head" "$target" "$scratch")"; then
            conflicts+=("git 试运行切换到目标提交失败：${output//$'\n'/ }")
        fi
    fi
    [ "${#conflicts[@]}" -gt 0 ] || return 0
    route="当前 ${head:0:7}"
    [ "$head" = "$main" ] || route+=" -> main ${main:0:7}"
    echo "切换代码（${route} -> 目标 ${target:0:7}）会覆盖或删除以下未跟踪的内容（包括被 .gitignore 忽略的文件），或因它们失败：" >&2
    printf '  - %s\n' "${conflicts[@]}" >&2
    echo "升级不移动、不删除这些文件；请把它们移出工作区（或提交到其他分支）后重试" >&2
    operation_event error "code switch blocked by ${#conflicts[@]} untracked path(s)"
    return 1
}

# git read-tree -n -m -u：检查从 <from> 切换到 <to> 会不会失败，不写入。它把被忽略的文件也当作会被覆盖的未跟踪文件。
switch_dry_run() {
    local from="$1" to="$2" index="$3/switch-index" real status=0
    real="$(git_here rev-parse --git-path index)" || return 1
    [[ "$real" == /* ]] || real="$PROJECT_DIR/$real"
    rm -f -- "$index" "$index.lock" && cp -- "$real" "$index" || { echo "无法复制索引 $real"; return 1; }
    GIT_INDEX_FILE="$index" git_here read-tree -n -m -u "$from" "$to" 2>&1 || status=$?
    rm -f -- "$index" "$index.lock"
    return "$status"
}
