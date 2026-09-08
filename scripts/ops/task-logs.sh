#!/usr/bin/env bash
# Standalone host-side extraction: Bash, awk and GNU coreutils; no running bot required.
set -euo pipefail
umask 077

usage() {
    cat <<'USAGE'
用法：bash scripts/ops/task-logs.sh <任务ID> [--context 3] [--log-dir <日志目录>]
任务 ID 为 8 位十六进制，例如 555d838a。扫描当前及轮转日志，结果写入项目 backup/tmp。
退出码：0=找到任务；2=没有匹配日志；1=参数或读取/写入失败。
USAGE
}
fail() { printf '%s\n' "$1" >&2; exit 1; }

if [ "$#" -eq 0 ]; then usage >&2; exit 1; fi
if [[ "$1" == --help || "$1" == -h ]]; then usage; exit 0; fi
task_id="$1"
shift
[[ "$task_id" =~ ^[0-9a-fA-F]{8}$ ]] || fail '请提供完整的 8 位任务 ID。'
task_id="$(printf '%s' "$task_id" | tr 'A-F' 'a-f')"
project="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
log_dir="$project/logs"
context=3
while [ "$#" -gt 0 ]; do
    case "$1" in
        --context)
            [ "$#" -ge 2 ] || fail '--context 缺少行数。'
            context="$2"; shift 2 ;;
        --log-dir)
            [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--log-dir 缺少目录。'
            log_dir="$2"; shift 2 ;;
        *) fail "未知参数：$1" ;;
    esac
done
[[ "$context" =~ ^[0-9]{1,3}$ ]] || fail '--context 必须是 0–100 的整数。'
context=$((10#$context))
[ "$context" -le 100 ] || fail '--context 必须是 0–100 的整数。'
[ -d "$log_dir" ] || fail "日志目录不存在：$log_dir"
log_dir="$(cd -- "$log_dir" && pwd)"

files=()
for file in "$log_dir"/mixin-chatbot.log*; do
    name="${file##*/}"
    if [[ -f "$file" && ! -L "$file" && "$name" =~ ^mixin-chatbot\.log(\.[1-9][0-9]*)?$ ]]; then
        files+=("$file")
    fi
done
if [ "${#files[@]}" -eq 0 ]; then
    printf '没有找到 mixin-chatbot.log 或数字后缀的轮转日志：%s\n' "$log_dir" >&2
    exit 2
fi
# Numeric/version sort handles .10 before .2; NUL separators preserve spaces in paths.
mapfile -d '' -t files < <(printf '%s\0' "${files[@]}" | LC_ALL=C sort -zrV)
(cd -- "$project" && mkdir -p -- backup/tmp)
output="$(mktemp -d "$project/backup/tmp/task-logs-$task_id-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
: > "$output/task.log"
: > "$output/context.log"

if ! LC_ALL=C awk -v task_id="$task_id" -v context="$context" -v output="$output" -v log_dir="$log_dir" '
function emit_context(number) {
    if (number <= last_written) return
    if (last_written && number > last_written + 1) print "--" > context_file
    print recent[number] > context_file
    last_written = number
}
function report(text) { print text > summary_file }
function record(text) { return text == "" ? "（保留日志中未找到）" : text }
BEGIN {
    task_file = output "/task.log"
    context_file = output "/context.log"
    summary_file = output "/summary.txt"
    pattern = "任务(:|：)[[:space:]]*" task_id "([^0-9A-Za-z_-]|$)"
    for (i = 1; i < ARGC; i++) {
        name = ARGV[i]
        sub(/^.*\//, "", name)
        scanned[++file_count] = name
    }
}
FNR == 1 {
    filename = FILENAME
    sub(/^.*\//, "", filename)
}
{
    sub(/\r$/, "")
    text = filename ":" FNR ": " $0
    recent[NR] = text
    delete recent[NR - context - 1]
    if (index($0, "Pi ModelRuntime 就绪")) latest_model = text
    if (tolower($0) ~ pattern) {
        if (!hits) { first_match = text; model_at_first = latest_model }
        hits++
        last_match = text
        if (index($0, "任务开始 -")) starts++
        if (index($0, "任务仍在运行 -")) last_heartbeat = text
        if (index($0, "任务总时限到达 -")) timeout_record = text
        print text > task_file
        first = NR - context
        if (first < 1) first = 1
        for (i = first; i <= NR; i++) emit_context(i)
        through = NR + context
    } else if (NR <= through) {
        emit_context(NR)
    }
}
END {
    report("任务日志提取")
    report("任务 ID: " task_id)
    report("日志目录: " log_dir)
    report("匹配行数: " (hits + 0))
    report("前后文: 各 " context " 行")
    report("扫描顺序（旧到新）:")
    for (i = 1; i <= file_count; i++) report("  " scanned[i])
    report("")
    report("模型信息（首次匹配前最近的就绪记录）:")
    report(record(model_at_first))
    report("")
    report("首条任务记录:")
    report(record(first_match))
    report("")
    report("最后一条运行心跳（含耗时、阶段、最近进展距今）:")
    report(record(last_heartbeat))
    report("")
    report("总时限到达记录（取消清理前）:")
    report(record(timeout_record))
    report("")
    report("最后一条任务记录:")
    report(record(last_match))
    report("")
    report("task.log: 仅任务匹配行；context.log: 匹配行及前后文，重叠行只保留一次。")
    report("每行带原日志文件名和行号；-- 表示省略了不相关的日志。")
    report("接收模型输出阶段要结合最近进展距今判断；本报告不直接断言超时原因。")
    report("这是已写入日志的一次读取，运行中的任务可能继续产生日志。")
    if (!hits) {
        report("未找到任务。请确认任务 ID、生产实例及日志目录；较早日志可能已轮转覆盖。")
    } else if (!starts) {
        report("未找到任务开始记录，当前提取的任务日志可能不完整。")
    } else if (starts > 1) {
        report("同一短任务 ID 有多条开始记录，请按时间、群和用户区分任务。")
    }
    report("日志保留原文，前后文可能包含其他任务；分享前请脱敏。")
}
' "${files[@]}"; then
    printf '提取失败，已写入的内容保留在：%s\n' "$output" >&2
    exit 1
fi
cat -- "$output/summary.txt"
printf '\n结果目录: %s\n' "$output"
if [ ! -s "$output/task.log" ]; then exit 2; fi
