#!/usr/bin/env bash
# promptfoo exec provider: run a read-only Codex review in a fixture.
# Usage: codex-review.sh <model> [reasoning-effort] <work-dir>
set -euo pipefail

model="$1"
if [ "$#" -ge 4 ]; then
  reasoning_effort="$2"
  work_dir="$3"
  prompt="$4"
else
  reasoning_effort="max"
  work_dir="$2"
  prompt="$3"
fi
raw_timeout_seconds="${CODEX_REVIEW_TIMEOUT_SECONDS:-900}"
if [[ ! "$raw_timeout_seconds" =~ ^0*([1-9][0-9]{0,6})$ ]]; then
  echo "CODEX_REVIEW_TIMEOUT_SECONDS must be an integer from 1 through 2147483" >&2
  exit 2
fi
timeout_seconds="${BASH_REMATCH[1]}"
if [ "$timeout_seconds" -gt 2147483 ]; then
  echo "CODEX_REVIEW_TIMEOUT_SECONDS must be an integer from 1 through 2147483" >&2
  exit 2
fi
codex_pid=''
watchdog_pid=''
tmp_dir=$(mktemp -d)
out="$tmp_dir/output"
prompt_file="$tmp_dir/prompt"
timeout_marker="$tmp_dir/timed-out"

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
  -c "model_reasoning_effort=$reasoning_effort" -o "$out" - < "$prompt_file" >/dev/null 2>&1 &
codex_pid=$!
set +m

node -e '
  const { writeFileSync } = require("node:fs");
  const pid = Number(process.argv[1]);
  const timeoutMs = Number(process.argv[2]) * 1000;
  const timeoutMarker = process.argv[3];
  setTimeout(() => {
    writeFileSync(timeoutMarker, "");
    try { process.kill(-pid, "SIGTERM"); } catch { process.exit(0); }
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }, 15_000);
  }, timeoutMs);
' "$codex_pid" "$timeout_seconds" "$timeout_marker" >/dev/null 2>&1 &
watchdog_pid=$!

status=0
wait "$codex_pid" || status=$?
codex_pid=''
if [ ! -f "$timeout_marker" ]; then
  kill "$watchdog_pid" 2>/dev/null || true
fi
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=''
if [ "$status" -ne 0 ]; then
  echo "codex review failed or was killed after ${timeout_seconds}s (exit ${status})" >&2
  exit "$status"
fi
cat "$out"
