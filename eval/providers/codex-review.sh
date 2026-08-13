#!/usr/bin/env bash
# promptfoo exec provider: run a read-only Codex review in a fixture.
set -euo pipefail

model="$1"
work_dir="$2"
prompt="$3"
timeout_seconds="${CODEX_REVIEW_TIMEOUT_SECONDS:-900}"
codex_pid=''
watchdog_pid=''
tmp_dir=$(mktemp -d)
out="$tmp_dir/output"
prompt_file="$tmp_dir/prompt"

cleanup() {
  trap - INT TERM
  if [ -n "$watchdog_pid" ]; then
    kill -TERM "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
    watchdog_pid=''
  fi
  if [ -n "$codex_pid" ]; then
    kill -TERM -- "-$codex_pid" 2>/dev/null || true
    kill -KILL -- "-$codex_pid" 2>/dev/null || true
    wait "$codex_pid" 2>/dev/null || true
    codex_pid=''
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

cd "$(dirname "$0")/../${work_dir}"
printf '%s' "$prompt" > "$prompt_file"

set -m
codex exec -m "$model" -s read-only --skip-git-repo-check \
  -c model_reasoning_effort=max -o "$out" - < "$prompt_file" >/dev/null 2>&1 &
codex_pid=$!
set +m

node -e '
  const pid = Number(process.argv[1]);
  const timeoutMs = Number(process.argv[2]) * 1000;
  setTimeout(() => {
    try { process.kill(-pid, "SIGTERM"); } catch { process.exit(0); }
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }, 15_000);
  }, timeoutMs);
' "$codex_pid" "$timeout_seconds" >/dev/null 2>&1 &
watchdog_pid=$!

status=0
wait "$codex_pid" || status=$?
codex_pid=''
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=''
if [ "$status" -ne 0 ]; then
  echo "codex review failed or was killed after ${timeout_seconds}s (exit ${status})" >&2
  exit "$status"
fi
cat "$out"
