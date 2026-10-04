#!/usr/bin/env bash
# promptfoo exec provider: run the Claude headless coder in an isolated work copy.
# Usage: claude-coder.sh <model> <work-dir>
#
# Normal elapsed-time timeout is disabled. Set CLAUDE_CODER_TIMEOUT_SECONDS to a
# positive integer only when a bounded hang watchdog is explicitly required.
set -euo pipefail

model="$1"
work_dir="$2"
prompt="$3"
raw_timeout_seconds="${CLAUDE_CODER_TIMEOUT_SECONDS:-0}"
if [[ "$raw_timeout_seconds" =~ ^0+$ ]]; then
  timeout_seconds=0
elif [[ "$raw_timeout_seconds" =~ ^0*([1-9][0-9]{0,6})$ ]]; then
  timeout_seconds="${BASH_REMATCH[1]}"
else
  echo "CLAUDE_CODER_TIMEOUT_SECONDS must be 0 (disabled) or an integer from 1 through 2147483" >&2
  exit 2
fi
if [ "$timeout_seconds" -gt 2147483 ]; then
  echo "CLAUDE_CODER_TIMEOUT_SECONDS must be 0 (disabled) or an integer from 1 through 2147483" >&2
  exit 2
fi

claude_pid=''
watchdog_pid=''
tmp_dir=$(mktemp -d)
prompt_file="$tmp_dir/prompt"
timeout_marker="$tmp_dir/timed-out"
watchdog_firing_marker="$tmp_dir/watchdog-firing"

cleanup() {
  trap - INT TERM
  if [ -n "$watchdog_pid" ]; then
    kill -TERM "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
    watchdog_pid=''
  fi
  if [ -n "$claude_pid" ]; then
    kill -TERM -- "-$claude_pid" 2>/dev/null || true
    kill -KILL -- "-$claude_pid" 2>/dev/null || true
    wait "$claude_pid" 2>/dev/null || true
    claude_pid=''
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

cd "$(dirname "$0")/../${work_dir}"
printf '%s' "$prompt" > "$prompt_file"

set -m
claude -p \
  --model "$model" \
  --allowed-tools 'Read,Write,Edit,Glob,Grep,Bash' \
  --permission-mode acceptEdits \
  --setting-sources=project < "$prompt_file" 2>/dev/null &
claude_pid=$!
set +m

if [ "$timeout_seconds" -gt 0 ]; then
  (
    sleep "$timeout_seconds"
    : > "$watchdog_firing_marker"
    if kill -TERM -- "-$claude_pid" 2>/dev/null; then
      : > "$timeout_marker"
      sleep 15
      kill -KILL -- "-$claude_pid" 2>/dev/null || true
    fi
  ) >/dev/null 2>&1 &
  watchdog_pid=$!
fi

status=0
wait "$claude_pid" || status=$?
claude_pid=''
if [ -n "$watchdog_pid" ] && [ -f "$watchdog_firing_marker" ]; then
  wait "$watchdog_pid" 2>/dev/null || true
elif [ -n "$watchdog_pid" ]; then
  kill -TERM "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
fi
watchdog_pid=''

if [ -f "$timeout_marker" ]; then
  echo "claude headless coder timed out after ${timeout_seconds}s" >&2
  exit 124
fi
if [ "$status" -ne 0 ]; then
  echo "claude headless coder failed (exit ${status})" >&2
fi
exit "$status"
