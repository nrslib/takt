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
raw_idle_timeout_seconds="${CODEX_REVIEW_IDLE_TIMEOUT_SECONDS:-${CODEX_REVIEW_TIMEOUT_SECONDS:-900}}"
if [[ ! "$raw_idle_timeout_seconds" =~ ^0*([1-9][0-9]{0,6})$ ]]; then
  echo "CODEX_REVIEW_IDLE_TIMEOUT_SECONDS must be an integer from 1 through 2147483" >&2
  exit 2
fi
idle_timeout_seconds="${BASH_REMATCH[1]}"
if [ "$idle_timeout_seconds" -gt 2147483 ]; then
  echo "CODEX_REVIEW_IDLE_TIMEOUT_SECONDS must be an integer from 1 through 2147483" >&2
  exit 2
fi
codex_pid=''
watchdog_pid=''
tmp_dir=$(mktemp -d)
out="$tmp_dir/output"
prompt_file="$tmp_dir/prompt"
event_log="$tmp_dir/events.jsonl"
idle_marker="$tmp_dir/idle-timed-out"

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
  -c "model_reasoning_effort=$reasoning_effort" --json -o "$out" - \
  < "$prompt_file" >"$event_log" 2>&1 &
codex_pid=$!
set +m

node -e '
  const { statSync, writeFileSync } = require("node:fs");
  const pid = Number(process.argv[1]);
  const idleMs = Number(process.argv[2]) * 1000;
  const idleMarker = process.argv[3];
  const activityFile = process.argv[4];
  let lastActivity = Date.now();
  let lastObservedMtime = 0;

  const poll = setInterval(() => {
    let observedMtime = 0;
    try {
      observedMtime = statSync(activityFile).mtimeMs;
    } catch {}
    if (observedMtime > lastObservedMtime) {
      lastObservedMtime = observedMtime;
      lastActivity = Date.now();
      return;
    }
    if (Date.now() - lastActivity < idleMs) return;

    clearInterval(poll);
    try { process.kill(-pid, "SIGTERM"); } catch { process.exit(0); }
    writeFileSync(idleMarker, "");
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      process.exit(0);
    }, 15_000);
  }, 1_000);
' "$codex_pid" "$idle_timeout_seconds" "$idle_marker" "$event_log" >/dev/null 2>&1 &
watchdog_pid=$!

status=0
wait "$codex_pid" || status=$?
codex_pid=''
watchdog_status=0
if [ -n "$watchdog_pid" ]; then
  kill -TERM "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || watchdog_status=$?
  watchdog_pid=''
  if [ "$watchdog_status" -ne 0 ] && [ "$watchdog_status" -ne 143 ]; then
    echo "codex review watchdog failed (exit ${watchdog_status})" >&2
    exit 125
  fi
fi
if [ -f "$idle_marker" ]; then
  echo "codex review made no observable progress for ${idle_timeout_seconds}s" >&2
  exit 124
fi
if [ "$status" -ne 0 ]; then
  echo "codex review failed (exit ${status})" >&2
  tail -n 40 "$event_log" >&2
  exit "$status"
fi
cat "$out"
