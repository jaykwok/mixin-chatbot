#!/usr/bin/env bash
# Host runtime bootstrap only. All service/maintenance policy belongs to scripts/ops/core.
# Downloads are pinned to an explicit release and the SHA-256 published on that GitHub release.
ops_bun_usable() {
    local version
    [ -f "$1" ] && [ -x "$1" ] || return 1
    version="$("$1" --version 2>/dev/null)" || return 1
    [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
    (( BASH_REMATCH[1] > 1 || (BASH_REMATCH[1] == 1 && (BASH_REMATCH[2] > 4 || (BASH_REMATCH[2] == 4 && BASH_REMATCH[3] >= 4))) ))
}

ops_bun_asset() {
    local arch libc
    [ "$(uname -s)" = Linux ] || { echo '当前平台需要先安装 Bun 1.4.4 或更高版本' >&2; return 1; }
    arch="$(uname -m)"; libc="$(ldd --version 2>&1 || true)"
    # The host core loads glibc (libc.so.6) for process supervision and its locks.
    case "$libc" in
        *musl*) echo '不支持 Alpine/musl 主机（宿主侧核心需要 glibc），未下载运行时' >&2; return 1 ;;
        *GLIBC*|*'GNU libc'*|*'GNU C Library'*) ;;
        *) echo '无法确定宿主 libc，未下载运行时' >&2; return 1 ;;
    esac
    case "$arch" in
        x86_64) printf '%s\n' 'bun-linux-x64-baseline e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76' ;;
        aarch64) printf '%s\n' 'bun-linux-aarch64 baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e' ;;
        *) echo "不支持的 Linux 架构：$arch" >&2; return 1 ;;
    esac
}

ops_bun_private_dir() {
    local path="$1" actual
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then mkdir -m 700 -- "$path" || return 1; fi
    [ -d "$path" ] && [ ! -L "$path" ] || { echo '运行时目录不能是链接或其他文件' >&2; return 1; }
    actual="$(stat -c '%u:%a' -- "$path")" || return 1
    [ "$actual" = "$(id -u):700" ] || { echo "运行时目录需由当前身份持有且权限为 700：$path" >&2; return 1; }
}

ops_bun_cache_valid() {
    local directory="$1" source="$2" line sum file
    ops_bun_private_dir "$directory" || return 1
    for file in bun bun.sha256 source; do
        [ -f "$directory/$file" ] && [ ! -L "$directory/$file" ] && [ "$(stat -c %u -- "$directory/$file")" = "$(id -u)" ] || return 1
    done
    [ "$(cat "$directory/source")" = "$source" ] || return 1
    line="$(cat "$directory/bun.sha256")"
    [[ "$line" =~ ^[a-f0-9]{64}$ ]] || return 1
    sum="$(sha256sum -- "$directory/bun")" || return 1
    [ "${sum%% *}" = "$line" ] && ops_bun_usable "$directory/bun"
}

ops_bun() (
    set -euo pipefail
    local candidate asset sha choice parent final temporary='' sum
    if [ -n "${MIXIN_OPS_BUN:-}" ]; then
        ops_bun_usable "$MIXIN_OPS_BUN" || { echo '任务指定的 Bun 不可用；未换用另一运行时' >&2; exit 1; }
        printf '%s\n' "$MIXIN_OPS_BUN"; exit 0
    fi
    candidate="$(command -v bun || true)"
    if [ -n "$candidate" ] && ops_bun_usable "$candidate"; then printf '%s\n' "$candidate"; exit 0; fi
    choice="$(ops_bun_asset)" || exit 1
    read -r asset sha <<< "$choice" || exit 1
    for candidate in curl unzip sha256sum flock; do command -v "$candidate" >/dev/null || { echo "主机缺少 $candidate，无法准备固定 Bun 运行时" >&2; exit 1; }; done
    ops_bun_private_dir "$PROJECT_DIR/.console" || exit 1
    parent="$PROJECT_DIR/.console/bun"; ops_bun_private_dir "$parent" || exit 1
    [ ! -L "$parent/install.lock" ] || { echo '运行时安装锁不能是链接' >&2; exit 1; }
    umask 077
    exec 8> "$parent/install.lock" || exit 1
    flock -w 30 8 || { echo '另一个进程正在准备 Bun，请稍后重试' >&2; exit 1; }
    final="$parent/1.4.4-$asset"
    if [ -e "$final" ] || [ -L "$final" ]; then
        ops_bun_cache_valid "$final" "$asset $sha" || { echo '已保存 Bun 运行时的身份或摘要不符，现场已保留' >&2; exit 1; }
        printf '%s\n' "$final/bun"; exit 0
    fi
    temporary="$(mktemp -d "$parent/.bun-stage.XXXXXXXX")" || exit 1
    # Only this invocation's exact files; older stages remain for explicit inspection.
    trap 'if [ -n "$temporary" ]; then rm -f -- "$temporary/archive.zip" "$temporary/bun" "$temporary/bun.sha256" "$temporary/source"; rmdir -- "$temporary" || true; fi' EXIT
    echo '宿主机没有可用 Bun；首次下载固定版本 1.4.4，并验证发布摘要。' >&2
    curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 --retry 2 \
        --output "$temporary/archive.zip" "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/$asset.zip" >&2 || exit 1
    sum="$(sha256sum -- "$temporary/archive.zip")" || exit 1
    [ "${sum%% *}" = "$sha" ] || { echo 'Bun 发布文件摘要不符，未解包或执行' >&2; exit 1; }
    unzip -p "$temporary/archive.zip" "$asset/bun" > "$temporary/bun" || exit 1
    chmod 700 "$temporary/bun" || exit 1
    [ "$("$temporary/bun" --version)" = 1.4.4 ] || { echo 'Bun 版本不符，未安装' >&2; exit 1; }
    sum="$(sha256sum -- "$temporary/bun")" || exit 1
    printf '%s\n' "${sum%% *}" > "$temporary/bun.sha256" || exit 1
    printf '%s\n' "$asset $sha" > "$temporary/source" || exit 1
    rm -- "$temporary/archive.zip" || exit 1
    mv -T -- "$temporary" "$final" || exit 1
    temporary=''
    printf '%s\n' "$final/bun"
)

ops_core() {
    local runtime
    runtime="$(ops_bun)" || return 1
    "$runtime" --no-env-file "$OPS_SOURCE_DIR/scripts/ops/core/cli.ts" --project "$PROJECT_DIR" "$@"
}

# 运维核心开始的事务在快照中记下固定运行包的摘要（host-runtime），续做和回滚只用它：.console/runtime/source-<摘要>
# 中的核心入口。不是这种事务、摘要无效或运行包不在时返回 1；运行包的内容由核心按摘要核对。
ops_pinned_core() {
    local record="$1/host-runtime" digest core
    [ -f "$record" ] && [ ! -L "$record" ] || return 1
    digest="$(tr -d '\n' < "$record")"
    [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || return 1
    core="$PROJECT_DIR/.console/runtime/source-$digest/scripts/ops/core/cli.ts"
    [ -f "$core" ] && [ ! -L "$core" ] || return 1
    printf '%s\n' "$core"
}
