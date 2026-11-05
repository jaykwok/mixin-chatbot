#!/usr/bin/env bash
# The host Bun of a deploy-entry fixture (tests/ops/deploy-entry.test.ts): it only ever runs the core. The preflight answers
# FIXTURE_PREFLIGHT; the hand-over keeps a copy of the stage, its standard input, the lock and BOT_HOST it inherited, optionally
# publishes a transaction pointer (FIXTURE_POINTER) and exits with FIXTURE_CORE.
set -euo pipefail
printf 'bun %s\n' "$*" >> "$FIXTURE_EVENTS"
case " $* " in
    *" --preflight "*) exit "${FIXTURE_PREFLIGHT:-0}" ;;
esac
previous='' stage='' project=''
for arg in "$@"; do
    [ "$previous" != --stage ] || stage="$arg"
    [ "$previous" != --project ] || project="$arg"
    previous="$arg"
done
cp -R -- "$stage" "$FIXTURE_CAPTURE"
printf 'stdin=%s\nlock=%s\nhost=%s\n' "$(readlink /proc/self/fd/0)" "${BOT_DEPLOY_LOCK_HELD:-}" "${BOT_HOST-unset}" > "$FIXTURE_CAPTURE.env"
echo CORE-HANDOVER
[ -z "${FIXTURE_POINTER:-}" ] || printf '%s\n' "$FIXTURE_POINTER" > "$project/data/state/deploy-transaction"
exit "${FIXTURE_CORE:-0}"
