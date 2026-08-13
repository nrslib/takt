#!/usr/bin/env bash
# promptfoo exec provider: run a read-only Claude headless review in a fixture.
set -euo pipefail

model="$1"
work_dir="$2"
prompt="$3"
timeout_seconds="${CLAUDE_REVIEW_TIMEOUT_SECONDS:-900}"

cd "$(dirname "$0")/../${work_dir}"

printf '%s' "$prompt" | claude -p \
  --model "$model" \
  --allowed-tools 'Read,Glob,Grep' \
  --permission-mode dontAsk \
  --setting-sources=project \
  --no-session-persistence 2>/dev/null &
claude_pid=$!

(
  sleep "$timeout_seconds"
  kill -TERM "$claude_pid" 2>/dev/null || exit 0
  sleep 15
  kill -KILL "$claude_pid" 2>/dev/null || true
) >/dev/null 2>&1 &
watchdog_pid=$!

status=0
wait "$claude_pid" || status=$?
kill "$watchdog_pid" 2>/dev/null || true
if [ "$status" -ne 0 ]; then
  echo "claude headless review failed or was killed after ${timeout_seconds}s (exit ${status})" >&2
fi
exit "$status"
