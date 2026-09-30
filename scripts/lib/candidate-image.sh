#!/usr/bin/env bash
# 候选镜像：升级在停机前从固定的目标提交构建一次镜像，之后预览、迁移、验证实例和正式实例都按 image ID 运行，
# 不再按可变的 mixin-chatbot 标签选择。镜像身份写在事务快照的 candidate-image 文件中；事务记录（transaction）
# 保持 format 1，因为恢复入口用当前检出的代码读取它，首次过渡时旧版入口必须仍能读懂。
#
# 函数只操作参数给出的路径和 Docker；出错时把原因写到标准错误并返回非零，由调用方决定如何报告。
# 用法：. scripts/lib/candidate-image.sh

CANDIDATE_RECORD_KEYS=(format source target_sha image_id image_tag daemon_id project_id operation_id)
CANDIDATE_LABEL_REVISION=org.opencontainers.image.revision
CANDIDATE_LABEL_PROJECT=org.mixin-chatbot.project
CANDIDATE_LABEL_OPERATION=org.mixin-chatbot.operation
CANDIDATE_LABEL_SOURCE=org.mixin-chatbot.source
# 读取本机进程、文件锁和挂载信息的位置，以及当前的有效用户（测试替换为 fixture）。
PROC_ROOT=/proc
MOUNTINFO_FILE=/proc/self/mountinfo
EFFECTIVE_UID="$EUID"
# 数据放在 root_path（默认在 containerd 根目录下）、能用 df 衡量的内置快照器；devmapper、blockfile 和代理插件不在此列。
CONTAINERD_DIRECTORY_SNAPSHOTTERS=(overlayfs native btrfs zfs)
# 挂在存储目录内部、不占额外磁盘的挂载类型：容器运行时的根文件系统、共享内存和命名空间等。
RUNTIME_MOUNT_TYPES='overlay|tmpfs|ramfs|nsfs|proc|sysfs|devpts|mqueue|cgroup|cgroup2|fuse.fuse-overlayfs'
# 磁盘预检门槛（字节）：原镜像解压后大小与下限取大，乘 1.5 再加余量；数据所在文件系统另外保留。估算只决定门槛，
# 剩余空间以 df 实测为准。
CANDIDATE_IMAGE_MIN_BYTES=2000000000
CANDIDATE_BUILD_MARGIN_BYTES=1073741824
CANDIDATE_DATA_RESERVE_BYTES=1073741824

candidate_value_valid() {
    local key="$1" value="$2"
    [[ ! "$value" =~ [[:cntrl:]] ]] || return 1
    case "$key" in
        format) [ "$value" = 1 ] ;;
        source) [[ "$value" =~ ^(commit|workspace)$ ]] ;;
        # 独立部署可以从不是 git 仓库的解压目录构建，这时没有提交（只有 source=workspace 允许为空）。
        target_sha) [[ "$value" =~ ^([0-9a-f]{40}|[0-9a-f]{64})?$ ]] ;;
        image_id) [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]] ;;
        image_tag) [[ "$value" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*:candidate-[0-9a-f]{12}-[0-9a-f]{16}$ ]] ;;
        daemon_id) [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9:-]{7,127}$ ]] ;;
        project_id) [[ "$value" =~ ^[0-9a-f]{12}$ ]] ;;
        operation_id) [[ "$value" =~ ^[0-9a-f]{16}$ ]] ;;
        *) return 1 ;;
    esac
}

# CANDIDATE 中每一项都存在且有效，保留标签的后缀与项目标识、操作 ID 一致。
candidate_record_consistent() {
    local key
    declare -p CANDIDATE >/dev/null 2>&1 || { echo "候选镜像记录为空" >&2; return 1; }
    for key in "${CANDIDATE_RECORD_KEYS[@]}"; do
        [ -n "${CANDIDATE[$key]+set}" ] || { echo "候选镜像记录缺少：$key" >&2; return 1; }
        candidate_value_valid "$key" "${CANDIDATE[$key]}" || { echo "候选镜像记录值无效：${key}=${CANDIDATE[$key]}" >&2; return 1; }
    done
    [[ "${CANDIDATE[image_tag]}" == *":candidate-${CANDIDATE[project_id]}-${CANDIDATE[operation_id]}" ]] ||
        { echo "候选镜像的保留标签与项目标识、操作 ID 不一致：${CANDIDATE[image_tag]}" >&2; return 1; }
    [ "${CANDIDATE[source]}" = workspace ] || [ -n "${CANDIDATE[target_sha]}" ] ||
        { echo "从提交构建的候选镜像记录缺少提交" >&2; return 1; }
}

# 在发布事务指针之前调用：逐项校验后写临时文件并落盘（dd 用写入句柄 fsync），再改名；读者要么看不到文件，
# 要么看到完整的一份。
write_candidate_record() {
    local directory="$1" key content='' temporary="$1/candidate-image.tmp"
    candidate_record_consistent || return 1
    for key in "${CANDIDATE_RECORD_KEYS[@]}"; do content+="${key}=${CANDIDATE[$key]}"$'\n'; done
    if ! (umask 077 && printf '%s' "$content" | dd of="$temporary" conv=fsync status=none); then
        rm -f -- "$temporary"
        return 1
    fi
    mv -- "$temporary" "$directory/candidate-image"
}

# 读取快照中的候选镜像记录到 CANDIDATE。缺失、不是普通文件、重复或未知的键、任何一项无效都拒绝整份记录。
read_candidate_record() {
    local file="$1/candidate-image" line key value
    declare -gA CANDIDATE=()
    if [ ! -e "$file" ] && [ ! -L "$file" ]; then echo "缺少候选镜像记录：$file" >&2; return 1; fi
    [ -f "$file" ] && [ ! -L "$file" ] || { echo "候选镜像记录不是普通文件：$file" >&2; return 1; }
    while IFS= read -r line || [ -n "$line" ]; do
        key="${line%%=*}"
        value="${line#*=}"
        # 先按已知键校验，再查重：未知的键不会用作数组下标。
        if [ "$key" = "$line" ] || ! candidate_value_valid "$key" "$value" || [ -n "${CANDIDATE[$key]+set}" ]; then
            CANDIDATE=()
            echo "候选镜像记录无效：${key}" >&2
            return 1
        fi
        CANDIDATE[$key]="$value"
    done < "$file"
    candidate_record_consistent || { CANDIDATE=(); return 1; }
}

# 项目路径的摘要：同一台 Docker 上的多份部署各用各的候选标签。
candidate_project_id() {
    local path
    path="$(realpath -m -- "$1")" || return 1
    printf '%s' "$path" | sha256sum | cut -c1-12
}

candidate_operation_id() {
    od -An -N8 -tx1 /dev/urandom | tr -d ' \n'
}

candidate_tag() {
    printf '%s:candidate-%s-%s\n' "$1" "$2" "$3"
}

# 从固定提交导出完整构建上下文（保留该提交的 .dockerignore）；不读工作区，未跟踪文件、本地改动和之后的 fetch
# 都进不了镜像。目录必须尚不存在；失败时留下的部分内容由调用方随导出目录一起删除。
candidate_export_context() {
    local project="$1" sha="$2" directory="$3"
    [ -n "$sha" ] && candidate_value_valid target_sha "$sha" || { echo "构建提交无效：${sha:-空}" >&2; return 1; }
    if [ -e "$directory" ] || [ -L "$directory" ]; then echo "构建目录已存在：$directory" >&2; return 1; fi
    (umask 077 && mkdir -- "$directory") || return 1
    if ! (set -o pipefail; GIT_TERMINAL_PROMPT=0 git -C "$project" archive --format=tar "$sha" | tar -x --no-same-owner -C "$directory"); then
        echo "无法从提交 ${sha:0:7} 导出构建上下文" >&2
        return 1
    fi
    [ -f "$directory/Dockerfile" ] && [ ! -L "$directory/Dockerfile" ] || { echo "提交 ${sha:0:7} 中没有 Dockerfile" >&2; return 1; }
}

# 用本次独占的标签构建，按 --iidfile 取得完整 image ID（CANDIDATE_IMAGE_ID）；构建期间不动正式标签。
candidate_build() {
    local context="$1" tag="$2" sha="$3" project_id="$4" operation_id="$5" source="$6" iidfile id status=0
    local runner=()
    CANDIDATE_IMAGE_ID=''
    if declare -F operation_capture >/dev/null; then runner=(operation_capture); fi
    iidfile="$(mktemp)" || return 1
    ${runner[@]+"${runner[@]}"} docker build --iidfile "$iidfile" --tag "$tag" \
        --label "$CANDIDATE_LABEL_REVISION=$sha" --label "$CANDIDATE_LABEL_PROJECT=$project_id" \
        --label "$CANDIDATE_LABEL_OPERATION=$operation_id" --label "$CANDIDATE_LABEL_SOURCE=$source" "$context" || status=$?
    id="$(tr -d '[:space:]' < "$iidfile" 2>/dev/null)" || id=''
    rm -f -- "$iidfile"
    [ "$status" = 0 ] || { echo "候选镜像构建失败（退出码 ${status}）" >&2; return 1; }
    candidate_value_valid image_id "$id" || { echo "构建没有给出有效的镜像 ID：${id:-空}" >&2; return 1; }
    CANDIDATE_IMAGE_ID="$id"
}

candidate_daemon_id() {
    local id
    if id="$(docker info --format '{{.ID}}' 2>/dev/null)" && candidate_value_valid daemon_id "$id"; then
        printf '%s\n' "$id"
        return 0
    fi
    echo "无法读取 Docker daemon 的 ID" >&2
    return 1
}

# 镜像引用（标签或 ID）当前指向的 image ID。返回 0 找到；2 不存在；1 其他错误（原因写到标准错误）。
candidate_reference_id() {
    local output
    if output="$(docker image inspect --format '{{.Id}}' "$1" 2>&1)"; then
        printf '%s\n' "$output"
        return 0
    fi
    [[ "$output" != *"No such image"* ]] || return 2
    printf '%s\n' "$output" >&2
    return 1
}

# 核对 CANDIDATE 记录的候选镜像：同一个 daemon、按 ID 存在、平台与 daemon 一致、归属标签相符、保留标签仍指向它。
# 返回 0 通过；3 daemon 已切换；4 镜像不存在；5 不是本次构建的镜像；6 保留标签被改指向或丢失（执行仍只按 ID）；1 其他错误。
candidate_verify() {
    local daemon facts id os arch revision project operation source server_arch tagged status=0
    daemon="$(candidate_daemon_id)" || return 1
    [ "$daemon" = "${CANDIDATE[daemon_id]}" ] ||
        { echo "Docker daemon 已切换（构建时 ${CANDIDATE[daemon_id]}，当前 ${daemon}）；请回到构建时的 Docker 后重试" >&2; return 3; }
    facts="$(docker image inspect --format "{{.Id}}|{{.Os}}|{{.Architecture}}|{{index .Config.Labels \"$CANDIDATE_LABEL_REVISION\"}}|{{index .Config.Labels \"$CANDIDATE_LABEL_PROJECT\"}}|{{index .Config.Labels \"$CANDIDATE_LABEL_OPERATION\"}}|{{index .Config.Labels \"$CANDIDATE_LABEL_SOURCE\"}}" "${CANDIDATE[image_id]}" 2>/dev/null)" ||
        { echo "候选镜像 ${CANDIDATE[image_id]} 已不存在" >&2; return 4; }
    IFS='|' read -r id os arch revision project operation source <<< "$facts"
    [ "$id" = "${CANDIDATE[image_id]}" ] || { echo "候选镜像 ${CANDIDATE[image_id]} 已不存在" >&2; return 4; }
    server_arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null)" || { echo "无法读取 Docker daemon 的架构" >&2; return 1; }
    if [ "$os" != linux ] || [ "$arch" != "$server_arch" ] || [ "$revision" != "${CANDIDATE[target_sha]}" ] ||
        [ "$project" != "${CANDIDATE[project_id]}" ] || [ "$operation" != "${CANDIDATE[operation_id]}" ] || [ "$source" != "${CANDIDATE[source]}" ]; then
        echo "镜像 ${CANDIDATE[image_id]} 不是本次构建的候选镜像（平台 ${os}/${arch}，提交 ${revision:-无}，操作 ${operation:-无}）" >&2
        return 5
    fi
    tagged="$(candidate_reference_id "${CANDIDATE[image_tag]}")" || status=$?
    [ "$status" != 1 ] || return 1
    [ "$status" = 0 ] && [ "$tagged" = "${CANDIDATE[image_id]}" ] ||
        { echo "保留标签 ${CANDIDATE[image_tag]} 已被改指向或删除；执行仍只按记录的 ID" >&2; return 6; }
}

# 正式标签（例如 mixin-chatbot）改指向候选镜像，并核对结果。
candidate_publish() {
    local image_id="$1" reference="$2" tagged
    docker tag "$image_id" "$reference" >/dev/null || { echo "无法把 ${reference} 指向候选镜像" >&2; return 1; }
    tagged="$(candidate_reference_id "$reference")" || tagged=''
    [ "$tagged" = "$image_id" ] || { echo "${reference} 没有指向候选镜像 ${image_id}（当前 ${tagged:-不存在}）" >&2; return 1; }
}

# 移除本次的保留标签：只在它仍指向记录的 ID 时移除，且只删这个引用，不按 ID 删除镜像（仍有其他标签时镜像保留）。
# 标签已不存在返回 0；被改指向其他镜像时保留并返回 2。
candidate_release_tag() {
    local tag="$1" image_id="$2" tagged status=0
    tagged="$(candidate_reference_id "$tag")" || status=$?
    [ "$status" != 2 ] || return 0
    [ "$status" = 0 ] || return 1
    [ "$tagged" = "$image_id" ] || { echo "保留标签 ${tag} 已指向其他镜像（${tagged}），不移除" >&2; return 2; }
    docker image rm --force "$tag" >/dev/null || { echo "保留标签 ${tag} 移除失败" >&2; return 1; }
}

# 在独立进程组中后台运行命令并等待它结束。收到 INT/TERM/HUP 时终止这个进程组（本次的 docker 客户端和输出记录），
# 等组内进程都退出后返回 128+信号值，由调用方收尾；不向共享的 Docker daemon 或其他构建发送信号。
# 返回前恢复调用方原有的处理。启动时就被忽略的信号（ops.sh 在后台启动的升级器忽略 INT，中断由 ops.sh 转成 TERM
# 转发）不设处理：开启过作业控制后，bash 会让这种信号的处理生效，trap - 再把它变成默认处理，而不是恢复忽略。
run_interruptible() {
    local pid status=0 signal=0 saved name handled=()
    saved="$(trap -p INT TERM HUP)"
    set -m
    "$@" &
    pid=$!
    set +m
    for name in INT TERM HUP; do
        [[ $'\n'"$saved"$'\n' == *$'\n'"trap -- '' SIG$name"$'\n'* ]] || handled+=("$name")
    done
    for name in "${handled[@]}"; do
        case "$name" in INT) trap 'signal=130' INT ;; TERM) trap 'signal=143' TERM ;; HUP) trap 'signal=129' HUP ;; esac
    done
    while :; do
        if wait "$pid"; then status=0; else status=$?; fi
        [ "$signal" = 0 ] || kill -TERM -- "-$pid" 2>/dev/null || true
        kill -0 "$pid" 2>/dev/null || break
    done
    if [ "$signal" != 0 ]; then
        while kill -0 -- "-$pid" 2>/dev/null; do sleep 0.2; done
    fi
    [ "${#handled[@]}" = 0 ] || trap - "${handled[@]}"
    eval "$saved"
    [ "$signal" = 0 ] || return "$signal"
    return "$status"
}

candidate_build_to() {
    local idfile="$1"
    shift
    candidate_build "$@" && printf '%s\n' "$CANDIDATE_IMAGE_ID" > "$idfile"
}

# 构建本次的候选镜像并固定身份，结果放在 CANDIDATE（尚未写入快照）：保留标签带项目标识和随机操作 ID，构建前记下
# daemon，构建后按 ID 核对。source 为 commit（升级，context 是从 sha 导出的目录）或 workspace（独立部署）。
# 构建被 INT/TERM/HUP 中断时返回 128+信号值；失败或中断后由调用方执行 release_candidate。
prepare_candidate_image() {
    local context="$1" sha="$2" source="$3" project="$4" project_id operation_id daemon tag idfile id status=0
    project_id="$(candidate_project_id "$project")" && operation_id="$(candidate_operation_id)" || return 1
    daemon="$(candidate_daemon_id)" || return 1
    tag="$(candidate_tag mixin-chatbot "$project_id" "$operation_id")"
    declare -gA CANDIDATE=([format]=1 [source]="$source" [target_sha]="$sha" [image_id]='' [image_tag]="$tag"
        [daemon_id]="$daemon" [project_id]="$project_id" [operation_id]="$operation_id")
    idfile="$(mktemp)" || return 1
    run_interruptible candidate_build_to "$idfile" "$context" "$tag" "$sha" "$project_id" "$operation_id" "$source" || status=$?
    id="$(tr -d '[:space:]' < "$idfile" 2>/dev/null)" || id=''
    rm -f -- "$idfile"
    [ "$status" = 0 ] || return "$status"
    CANDIDATE[image_id]="$id"
    candidate_record_consistent || return 1
    candidate_verify
}

# 移除本次的保留标签（没有发布事务指针时的失败或取消，或事务结束后）：只移除仍指向本次镜像的标签；被改指向的保留并
# 报告（返回 2）。构建被中断时还不知道 ID，按镜像上的操作 ID 认领。标签本来不存在返回 0。
release_candidate() {
    local tag="${CANDIDATE[image_tag]:-}" id="${CANDIDATE[image_id]:-}" operation status=0
    [ -n "$tag" ] || return 0
    if [ -z "$id" ]; then
        id="$(candidate_reference_id "$tag")" || status=$?
        [ "$status" != 2 ] || return 0
        [ "$status" = 0 ] || return 1
        operation="$(docker image inspect --format "{{index .Config.Labels \"$CANDIDATE_LABEL_OPERATION\"}}" "$id" 2>/dev/null)" || return 1
        [ "$operation" = "${CANDIDATE[operation_id]}" ] || { echo "保留标签 ${tag} 指向的不是本次构建的镜像，不移除" >&2; return 2; }
    fi
    candidate_release_tag "$tag" "$id"
}

# 路径所在的挂载（路径本身需要能 stat，不读取其内部）：MOUNT_TARGET 挂载点，MOUNT_DEVICE 超级块设备号
# （major:minor，与 /proc/locks 一致），MOUNT_TYPE 文件系统类型，MOUNT_POOL 共享剩余空间的单位。btrfs 的各子卷
# 同属一个超级块，stat 报告的设备号却各不相同，所以按 mountinfo 的设备号归组；ZFS 的数据集各有超级块但共用存储池，
# 按池名归组。
mount_facts() {
    local target line source
    MOUNT_TARGET='' MOUNT_DEVICE='' MOUNT_TYPE='' MOUNT_POOL=''
    target="$(df --output=target -- "$1" 2>/dev/null)" || return 1
    [[ "$target" == *$'\n'* ]] || return 1
    target="${target#*$'\n'}"
    [ -n "$target" ] || return 1
    line="$(mountinfo_entry target "$target")" || return 1
    read -r MOUNT_DEVICE MOUNT_TYPE source <<< "$line"
    MOUNT_TARGET="$target"
    if [ "$MOUNT_TYPE" = zfs ]; then MOUNT_POOL="zfs:${source%%/*}"; else MOUNT_POOL="$MOUNT_DEVICE"; fi
}

# mountinfo 中的“设备号 类型 来源”：按挂载点（target）取最后一条，即叠在最上面的挂载；按设备号（device）取第一条。
mountinfo_entry() {
    awk -v by="$1" -v wanted="$2" '
        function unescape(s) { gsub(/\\040/, " ", s); gsub(/\\011/, "\t", s); gsub(/\\012/, "\n", s); gsub(/\\134/, "\\\\", s); return s }
        {
            for (i = 7; i <= NF && $i != "-"; i++) ;
            if (i + 2 > NF) next
            if ((by == "target" && unescape($5) == wanted) || (by == "device" && $3 == wanted)) {
                found = $3 " " $(i + 1) " " $(i + 2)
                if (by == "device") exit
            }
        }
        END { if (found == "") exit 1; print found }' "$MOUNTINFO_FILE"
}

# 进程持有的文件锁，每行“设备号:inode”（设备号为十进制 major:minor）。
process_locks() {
    local fields index
    while read -r -a fields; do
        for (( index = 1; index < ${#fields[@]}; index++ )); do
            if [ "${fields[index - 1]}" = "$1" ] && [[ "${fields[index]}" =~ ^([0-9a-f]+):([0-9a-f]+):([0-9]+)$ ]]; then
                printf '%d:%d:%s\n' "$((16#${BASH_REMATCH[1]}))" "$((16#${BASH_REMATCH[2]}))" "${BASH_REMATCH[3]}"
            fi
        done
    done < "$PROC_ROOT/locks"
}

# containerd 按自身规则合并 imports 后的有效配置。
containerd_config_dump() {
    if [ -n "$2" ]; then "$1" --config "$2" config dump; else "$1" config dump; fi
}

# 从 config dump 中取四行：顶层 root、[grpc] 的 address、快照器 $1 的段是否存在（yes 或空）、该段的 root_path。
# 只接受单行字符串；其他写法取值为控制字符，之后按无效路径拒绝。
containerd_dump_values() {
    awk -v plugin="plugins.io.containerd.snapshotter.v1.$1" -v q="'" '
        function text(line,   value) {
            value = line; sub(/^[^=]*=[ \t]*/, "", value); sub(/[ \t]+$/, "", value)
            if (value ~ ("^" q "[^" q "]*" q "$") || value ~ /^"[^"\\]*"$/) return substr(value, 2, length(value) - 2)
            return "\001"
        }
        /^[ \t]*\[/ { section = $0; gsub(/[][ \t"]/, "", section); gsub(q, "", section); if (section == plugin) found = "yes"; next }
        /=/ {
            key = $0; sub(/=.*/, "", key); gsub(/[ \t]/, "", key)
            if (section == "" && key == "root") root = text($0)
            else if (section == "grpc" && key == "address") address = text($0)
            else if (section == plugin && key == "root_path") path = text($0)
        }
        END { print root; print address; print found; print path }'
}

# 进程的有效 UID。
process_owner() {
    { awk '$1 == "Uid:" { print $3; found = 1; exit } END { exit !found }' "$PROC_ROOT/$1/status"; } 2>/dev/null
}

# 可以用当前身份执行的程序：解析符号链接后的文件和它的各级目录都属于 root 或当前用户，组和其他用户不可写
# （带粘滞位的目录除外：其他用户删不掉、也换不了其中不属于他们的条目）。其他用户能替换的程序一律不执行。
trusted_executable() {
    local path uid mode kind count=0 facts
    local -a chain=()
    path="$(realpath -e -- "$1" 2>/dev/null)" && [ -f "$path" ] && [ -x "$path" ] || return 1
    while [ -n "$path" ]; do chain+=("$path"); path="${path%/*}"; done
    chain+=(/)
    facts="$(stat -c '%u %a %F' -- "${chain[@]}" 2>/dev/null)" || return 1
    while read -r uid mode kind; do
        count=$((count + 1))
        [ "$uid" = 0 ] || [ "$uid" = "$EFFECTIVE_UID" ] || return 1
        [[ "$mode" =~ ^[0-7]+$ ]] || return 1
        if (( (8#$mode & 8#022) != 0 )) && { [ "$kind" != directory ] || (( (8#$mode & 8#1000) == 0 )); }; then return 1; fi
    done <<< "$facts"
    [ "$count" = "${#chain[@]}" ]
}

# 挂在目录 $1 内部、可能占用其他磁盘的挂载点，每行一个（容器运行时的挂载不计）；其余参数是不计的子目录（相对 $1）。
nested_mounts() {
    local base
    base="$(realpath -m -- "$1")"
    shift
    awk -v base="${base%/}/" -v runtime="^($RUNTIME_MOUNT_TYPES)\$" -v skip="$(printf '%s\n' "$@")" '
        function unescape(s) { gsub(/\\040/, " ", s); gsub(/\\011/, "\t", s); gsub(/\\012/, "\n", s); gsub(/\\134/, "\\\\", s); return s }
        BEGIN { count = split(skip, names, "\n"); for (n = 1; n <= count; n++) if (names[n] != "") excluded[base names[n] "/"] = 1 }
        {
            for (i = 7; i <= NF && $i != "-"; i++) ;
            if (i + 2 > NF) next
            point = unescape($5)
            if (substr(point, 1, length(base)) != base || $(i + 1) ~ runtime) next
            for (prefix in excluded) if (substr(point "/", 1, length(prefix)) == prefix) next
            print point
        }' "$MOUNTINFO_FILE"
}

# 目录 $1 和挂在它内部的其他文件系统，追加到数组 STORAGE_FOUND；其余参数是不计的子目录。内部挂载点当前用户
# 进不去时无法衡量它的剩余空间，把原因放在 LOCATION_PROBLEM 并返回 1。
add_storage_directory() {
    local directory="$1" point
    shift
    STORAGE_FOUND+=("$directory")
    while IFS= read -r point; do
        [ -n "$point" ] || continue
        [ -d "$point" ] || {
            LOCATION_PROBLEM="当前用户无法进入 ${point}（挂在 ${directory} 内部的另一个文件系统），无法检查它的剩余空间；请用 root 运行"
            return 1
        }
        STORAGE_FOUND+=("$point")
    done < <(nested_mounts "$directory" "$@")
}

# containerd 实际存放数据的位置，追加到 STORAGE_FOUND：根目录 $1、自定义快照目录 $2（可为空）、被符号链接指到
# 根目录以外的内容存储和快照目录（$3 为快照器），以及挂在这些目录内部的其他文件系统。当前用户进不去根目录时
# 看不到其中的符号链接：docker_storage_paths 只让 root 查看 rootful daemon，其余情况由 containerd_holds_storage
# 读不到元数据库而拒绝。
add_containerd_locations() {
    local root="$1" custom="$2" base path resolved
    local -a directories=("$1") inner=("$1/io.containerd.content.v1.content")
    base="$(realpath -e -- "$root" 2>/dev/null)" || { LOCATION_PROBLEM="无法解析根目录 ${root}"; return 1; }
    if [ -n "$custom" ]; then directories+=("$custom"); else inner+=("$root/io.containerd.snapshotter.v1.$3"); fi
    for path in "${inner[@]}"; do
        resolved="$(realpath -e -- "$path" 2>/dev/null)" || continue
        [[ "$resolved/" == "$base/"* ]] || directories+=("$resolved")
    done
    for path in "${directories[@]}"; do add_storage_directory "$path" || return 1; done
}

# 核对进程 $1 就是在这些位置存放数据的 containerd：它持有根目录 $2 中元数据库（io.containerd.metadata.v1.bolt/meta.db）
# 和自定义快照目录 $3（可为空）中 metadata.db 的锁，按设备号和 inode 核对；读不到数据库文件就无法核对，拒绝。
# 其余参数是全部存储位置：锁只用来确认进程身份，不用来推断位置；但它在这些位置以外的磁盘文件系统上持有锁，
# 说明还有没识别出的位置，同样拒绝（tmpfs 上的锁是状态目录）。不通过时把原因写到标准输出。
containerd_holds_storage() {
    local pid="$1" root="$2" custom="$3" locks directory database inode covered=' ' device line fstype major minor
    shift 3
    locks="$(process_locks "$pid")"
    for directory in "$@"; do
        mount_facts "$directory" || { echo "无法确定 ${directory} 所在的文件系统"; return 1; }
        covered+="$MOUNT_DEVICE "
    done
    for directory in "$root" "$custom"; do
        [ -n "$directory" ] || continue
        if [ "$directory" = "$root" ]; then database=io.containerd.metadata.v1.bolt/meta.db; else database=metadata.db; fi
        inode="$(stat -c %i -- "$directory/$database" 2>/dev/null)" || { echo "读不到 ${directory}/${database}，无法核对"; return 1; }
        mount_facts "$(dirname -- "$directory/$database")" || { echo "无法确定 ${directory} 所在的文件系统"; return 1; }
        [[ $'\n'"$locks"$'\n' == *$'\n'"$MOUNT_DEVICE:$inode"$'\n'* ]] || { echo "没有锁定 ${directory}/${database}"; return 1; }
    done
    while IFS=: read -r major minor inode; do
        [ -n "$major" ] || continue
        device="$major:$minor"
        [[ "$covered" != *" $device "* ]] || continue
        line="$(mountinfo_entry device "$device")" || { echo "在本机看不到的文件系统（${device}）上持有锁"; return 1; }
        read -r _ fstype _ <<< "$line"
        case "$fstype" in
            tmpfs|ramfs) ;;
            *) echo "还在另一个文件系统（${device}，${fstype}）上保存数据"; return 1 ;;
        esac
    done <<< "$locks"
}

# 为 Docker 服务的 containerd 的存储位置（CONTAINERD_STORAGE_PATHS）。$1 是 Docker 报告的 containerd 地址，
# $2 是 Docker 使用的快照器。只看属于 root 或当前用户的 containerd 进程，且只执行 trusted_executable 认可的程序：
# 其他用户的进程和程序在核对之前就可能以部署者身份运行，一律不碰。按进程的启动参数（--config、--root、--address）
# 和有效配置找出 gRPC 地址相同的进程，由 add_containerd_locations 列出位置，再用 containerd_holds_storage 核对；
# 只接受唯一一组核对通过的位置。目录存在不能证明它正被使用，任何一步确定不了都返回 1。
containerd_storage_paths() {
    local address="$1" driver="$2" entry pid name arguments=() index argument executable config root_override address_override
    local dump values=() root root_path served reason problems=() found='' owner
    local -a locations=()
    CONTAINERD_STORAGE_PATHS=()
    [[ " ${CONTAINERD_DIRECTORY_SNAPSHOTTERS[*]} " == *" $driver "* ]] ||
        { echo "Docker 使用的快照器 ${driver:-未知} 不把数据放在可用 df 衡量的目录中，无法检查镜像存储的剩余空间" >&2; return 1; }
    [[ "$address" == /* ]] || { echo "Docker 没有报告 containerd 的地址，确定不了镜像存储的位置" >&2; return 1; }
    address="$(realpath -m -- "$address")"
    for entry in "$PROC_ROOT"/[0-9]*; do
        pid="${entry##*/}"
        # 进程随时可能退出：读不到就跳过（重定向失败的提示要在外层丢弃）。
        { read -r name < "$entry/comm"; } 2>/dev/null && [ "$name" = containerd ] || continue
        owner="$(process_owner "$pid")" || continue
        if [ "$owner" != 0 ] && [ "$owner" != "$EFFECTIVE_UID" ]; then
            problems+=("PID ${pid}：属于用户 ${owner}，不是 root 或当前用户，不检查")
            continue
        fi
        { mapfile -d '' -t arguments < "$entry/cmdline"; } 2>/dev/null && [ "${#arguments[@]}" -gt 0 ] || continue
        config='' root_override='' address_override=''
        for (( index = 1; index < ${#arguments[@]}; index++ )); do
            argument="${arguments[index]}"
            case "$argument" in
                --config=*|-config=*|-c=*) config="${argument#*=}" ;;
                --config|-config|-c) index=$((index + 1)); config="${arguments[index]-}" ;;
                --root=*|-root=*) root_override="${argument#*=}" ;;
                --root|-root) index=$((index + 1)); root_override="${arguments[index]-}" ;;
                --address=*|-address=*|-a=*) address_override="${argument#*=}" ;;
                --address|-address|-a) index=$((index + 1)); address_override="${arguments[index]-}" ;;
            esac
        done
        executable="$(readlink -- "$entry/exe" 2>/dev/null)" || executable=''
        executable="${executable% (deleted)}"
        [[ "$executable" == /* ]] || executable="${arguments[0]}"
        if [[ "$executable" != /* ]]; then problems+=("PID ${pid}：找不到它的可执行文件"); continue; fi
        if ! trusted_executable "$executable"; then
            problems+=("PID ${pid}：程序 ${executable} 不是只有 root 或当前用户能改动的文件，不执行")
            continue
        fi
        if [ -n "$config" ] && [[ "$config" != /* ]]; then problems+=("PID ${pid}：配置文件是相对路径（${config}）"); continue; fi
        if ! dump="$(containerd_config_dump "$executable" "$config" 2>&1)"; then
            problems+=("PID ${pid}：无法读取配置 ${config:-（默认位置）}：$(tail -n 1 <<< "$dump")")
            continue
        fi
        mapfile -t values < <(containerd_dump_values "$driver" <<< "$dump")
        served="${address_override:-${values[1]-}}"
        [[ "$served" == /* ]] && [ "$(realpath -m -- "$served")" = "$address" ] || continue
        root="${root_override:-${values[0]-}}"
        root_path="${values[3]-}"
        if [ "${values[2]-}" != yes ]; then problems+=("PID ${pid}：配置中没有快照器 ${driver}"); continue; fi
        if [[ "$root" != /* || "$root" =~ [[:cntrl:]] ]] || [ ! -d "$root" ]; then problems+=("PID ${pid}：根目录无效（${root}）"); continue; fi
        if [ -n "$root_path" ] && { [[ "$root_path" != /* || "$root_path" =~ [[:cntrl:]] ]] || [ ! -d "$root_path" ]; }; then
            problems+=("PID ${pid}：快照目录无效（${root_path}）")
            continue
        fi
        STORAGE_FOUND=() LOCATION_PROBLEM=''
        if ! add_containerd_locations "$root" "$root_path" "$driver"; then problems+=("PID ${pid}：${LOCATION_PROBLEM}"); continue; fi
        if ! reason="$(containerd_holds_storage "$pid" "$root" "$root_path" "${STORAGE_FOUND[@]}")"; then
            problems+=("PID ${pid}：${reason}")
            continue
        fi
        if [ -n "$found" ] && [ "$found" != "$(printf '%s\n' "${STORAGE_FOUND[@]}")" ]; then
            echo "有多个 containerd 进程在地址 ${address} 上报告不同的存储位置，无法确定镜像存储的位置" >&2
            return 1
        fi
        found="$(printf '%s\n' "${STORAGE_FOUND[@]}")"
        locations=("${STORAGE_FOUND[@]}")
    done
    if [ -z "$found" ]; then
        echo "找不到为 Docker 服务的 containerd（地址 ${address}），无法确定镜像存储的位置" >&2
        [ "${#problems[@]}" -eq 0 ] || printf '  %s\n' "${problems[@]}" >&2
        return 1
    fi
    CONTAINERD_STORAGE_PATHS=("${locations[@]}")
}

# 本机 Docker 的存储位置（DOCKER_STORAGE_PATHS）：DockerRootDir、被符号链接指到它以外的子目录（例如移到另一块盘的
# overlay2、buildkit）和挂在这些目录内部的其他文件系统（volumes/、plugins/ 下是卷和插件，构建不写入，不计）；
# 使用 containerd 镜像存储时再加 containerd_storage_paths 找到的位置。rootful daemon 的数据目录只有 root 能进入，
# 其他用户（docker 组用户）看不到其中的符号链接，只接受 root；rootless daemon 由它所属的用户查看。远程 daemon
# 或确定不了位置时返回 1：不能拿本机路径的剩余空间冒充。
docker_storage_paths() {
    local endpoint info name root driver status options address base entry resolved
    local -a links=()
    DOCKER_STORAGE_PATHS=()
    endpoint="${DOCKER_HOST:-}"
    if [ -z "$endpoint" ]; then endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || endpoint=''; fi
    [[ "$endpoint" == unix://* ]] ||
        { echo "Docker 端点不是本机 socket（${endpoint:-未知}），无法检查它的存储空间；本项目的部署需要本机 Docker" >&2; return 1; }
    info="$(docker info --format '{{.Name}}|{{.DockerRootDir}}|{{.Driver}}|{{.DriverStatus}}|{{.SecurityOptions}}' 2>/dev/null)" ||
        { echo "无法连接 Docker" >&2; return 1; }
    IFS='|' read -r name root driver status options <<< "$info"
    [ "$name" = "$(uname -n)" ] ||
        { echo "Docker daemon 所在主机（${name}）不是本机（$(uname -n)），无法检查它的存储空间；本项目的部署需要本机 Docker" >&2; return 1; }
    if [[ "$options" != *name=rootless* ]] && [ "$EFFECTIVE_UID" != 0 ]; then
        echo "Docker 以 root 身份运行（rootful），它的数据目录只有 root 能完整查看，当前用户（UID ${EFFECTIVE_UID}）确认不了镜像存储在哪块磁盘上；请改用 root 运行" >&2
        return 1
    fi
    [[ "$root" == /* ]] && [ -d "$root" ] || { echo "找不到 Docker 数据目录：${root:-未知}" >&2; return 1; }
    # 找外移的子目录要列出目录内容：只能进入、不能列出（例如 0300）时，按已知名字仍能写入，链接却看不到。
    base="$(realpath -e -- "$root" 2>/dev/null)" && [ -r "$base" ] && [ -x "$base" ] ||
        { echo "当前用户无法列出并进入 Docker 数据目录 ${root}，确认不了镜像存储在哪块磁盘上" >&2; return 1; }
    STORAGE_FOUND=() LOCATION_PROBLEM=''
    add_storage_directory "$root" volumes plugins || { echo "$LOCATION_PROBLEM" >&2; return 1; }
    mapfile -d '' -t links < <(find "$base" -mindepth 1 -maxdepth 1 -type l -print0 2>/dev/null)
    wait "$!" || { echo "列不出 Docker 数据目录 ${root} 的内容，确认不了镜像存储在哪块磁盘上" >&2; return 1; }
    for entry in "${links[@]}"; do
        case "${entry##*/}" in volumes|plugins) continue ;; esac
        # 指向不存在位置的链接下什么也存不了。
        resolved="$(realpath -e -- "$entry" 2>/dev/null)" || continue
        [[ "$resolved/" == "$base/"* ]] || add_storage_directory "$resolved" || { echo "$LOCATION_PROBLEM" >&2; return 1; }
    done
    DOCKER_STORAGE_PATHS+=("${STORAGE_FOUND[@]}")
    [[ "$status" == *io.containerd.snapshotter.v1* ]] || return 0
    # 只在 containerd 镜像存储下查询：较早的 Docker 没有这个字段，模板会出错。
    address="$(docker info --format '{{.Containerd.Address}}' 2>/dev/null)" || address=''
    containerd_storage_paths "$address" "$driver" || return 1
    DOCKER_STORAGE_PATHS+=("${CONTAINERD_STORAGE_PATHS[@]}")
}

human_bytes() {
    awk -v bytes="$1" 'BEGIN { if (bytes >= 1073741824) printf "%.1f GiB", bytes / 1073741824; else printf "%.0f MiB", bytes / 1048576 }'
}

# Docker 显示的十进制大小（322MB、1.23GB）换算成字节。
human_to_bytes() {
    awk -v size="$1" 'BEGIN {
        unit["B"] = 1; unit["kB"] = 1e3; unit["KB"] = 1e3; unit["MB"] = 1e6; unit["GB"] = 1e9; unit["TB"] = 1e12; unit["PB"] = 1e15
        if (!match(size, /^[0-9]+(\.[0-9]+)?/)) exit 1
        suffix = substr(size, RLENGTH + 1)
        if (!(suffix in unit)) exit 1
        printf "%.0f\n", substr(size, 1, RLENGTH) * unit[suffix]
    }'
}

# 镜像解压后的大小（字节）。containerd 存储下 image inspect 的 .Size 只是压缩后的内容，所以读 docker image ls。
image_disk_size() {
    local id size
    id="$(candidate_reference_id "$1")" || return 1
    size="$(docker image ls --no-trunc --format '{{.ID}} {{.Size}}' 2>/dev/null | awk -v id="$id" '$1 == id { print $2; exit }')"
    [ -n "$size" ] || return 1
    human_to_bytes "$size"
}

# 参数为成对的“路径 字节数”：共享剩余空间的路径（同一文件系统、同一 btrfs 的各子卷、同一 ZFS 存储池）需求相加，
# 与其中最小的实际可用空间比较。不足时逐组列出挂载点、涉及的路径、可用和所需空间并返回 1。
check_free_space() {
    local -A need=() available=() mounts=() paths=()
    local path bytes pool free failed=0
    while [ "$#" -ge 2 ]; do
        path="$1"
        bytes="$2"
        shift 2
        mount_facts "$path" || { echo "无法确定 ${path} 所在的文件系统" >&2; return 1; }
        pool="$MOUNT_POOL"
        free="$(df -B1 --output=avail -- "$path" 2>/dev/null | sed -n '2p' | tr -d ' ')"
        [[ "$free" =~ ^[0-9]+$ ]] || { echo "无法读取 ${path} 所在文件系统的剩余空间" >&2; return 1; }
        if [ -z "${need[$pool]+set}" ]; then
            need[$pool]=0
            available[$pool]="$free"
            mounts[$pool]=''
            paths[$pool]=''
        fi
        [ "$free" -ge "${available[$pool]}" ] || available[$pool]="$free"
        [[ "、${mounts[$pool]}、" == *"、${MOUNT_TARGET}、"* ]] || mounts[$pool]+="${mounts[$pool]:+、}${MOUNT_TARGET}"
        need[$pool]=$(( ${need[$pool]} + bytes ))
        paths[$pool]+="${paths[$pool]:+、}${path}"
    done
    for pool in "${!need[@]}"; do
        if [ "${available[$pool]}" -lt "${need[$pool]}" ]; then
            echo "磁盘空间不足：${mounts[$pool]}（${paths[$pool]}）可用 $(human_bytes "${available[$pool]}")，需要 $(human_bytes "${need[$pool]}")" >&2
            failed=1
        fi
    done
    return "$failed"
}

# 构建前的磁盘预检。previous 为原镜像（没有时留空）；其余参数是数据路径（data/、群根、backup/、导出目录）。
# 每组共享剩余空间的 Docker 存储需要（原镜像解压后大小与下限取大）× 1.5 + 余量，同一组只算一次；组内其余路径
# 以 0 的需求参与检查，它们可能受更小的配额限制（ZFS 数据集），可用空间取组内最小值。数据路径所在的文件系统另外
# 保留 CANDIDATE_DATA_RESERVE_BYTES，与构建需求共享剩余空间时相加。
check_build_disk_space() {
    local previous="$1" size=0 estimate path
    local -A counted=()
    local args=()
    shift
    docker_storage_paths || return 1
    if [ -n "$previous" ]; then size="$(image_disk_size "$previous")" || size=0; fi
    [ "$size" -ge "$CANDIDATE_IMAGE_MIN_BYTES" ] || size="$CANDIDATE_IMAGE_MIN_BYTES"
    estimate=$(( size * 3 / 2 + CANDIDATE_BUILD_MARGIN_BYTES ))
    for path in "${DOCKER_STORAGE_PATHS[@]}"; do
        mount_facts "$path" || { echo "无法确定 ${path} 所在的文件系统" >&2; return 1; }
        if [ -n "${counted[$MOUNT_POOL]+set}" ]; then args+=("$path" 0); continue; fi
        counted[$MOUNT_POOL]=1
        args+=("$path" "$estimate")
    done
    for path in "$@"; do args+=("$path" "$CANDIDATE_DATA_RESERVE_BYTES"); done
    check_free_space "${args[@]}"
}
