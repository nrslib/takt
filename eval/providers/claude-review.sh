#!/usr/bin/env bash
# promptfoo exec provider: run a read-only Claude headless review in a fixture.
set -euo pipefail

model="$1"
work_dir="$2"
prompt="$3"
timeout_seconds="${CLAUDE_REVIEW_TIMEOUT_SECONDS:-900}"
claude_pid=''
watchdog_pid=''

cleanup() {
  trap - INT TERM
  if [ -n "$watchdog_pid" ]; then
    kill -TERM "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
    watchdog_pid=''
  fi
  if [ -n "$claude_pid" ]; then
    kill -TERM "$claude_pid" 2>/dev/null || true
    kill -KILL "$claude_pid" 2>/dev/null || true
    wait "$claude_pid" 2>/dev/null || true
    claude_pid=''
  fi
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

cd "$(dirname "$0")/../${work_dir}"

printf '%s' "$prompt" | claude -p \
  --model "$model" \
  --allowed-tools 'Read,Glob,Grep' \
  --permission-mode dontAsk \
  --setting-sources=project \
  --no-session-persistence 2>/dev/null &
claude_pid=$!

node -e '
  const pid = Number(process.argv[1]);
  const timeoutMs = Number(process.argv[2]) * 1000;
  setTimeout(() => {
    try { process.kill(pid, "SIGTERM"); } catch { process.exit(0); }
    setTimeout(() => {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }, 15_000);
  }, timeoutMs);
' "$claude_pid" "$timeout_seconds" >/dev/null 2>&1 &
watchdog_pid=$!

status=0
wait "$claude_pid" || status=$?
claude_pid=''
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=''
if [ "$status" -ne 0 ]; then
  echo "claude headless review failed or was killed after ${timeout_seconds}s (exit ${status})" >&2
fi
exit "$status"
