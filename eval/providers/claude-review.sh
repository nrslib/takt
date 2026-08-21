#!/usr/bin/env bash
# promptfoo exec provider: run a read-only Claude headless review in a fixture.
set -euo pipefail

model="$1"
work_dir="$2"
prompt="$3"
raw_timeout_seconds="${CLAUDE_REVIEW_TIMEOUT_SECONDS:-0}"
if [[ "$raw_timeout_seconds" =~ ^0+$ ]]; then
  timeout_seconds=0
elif [[ "$raw_timeout_seconds" =~ ^0*([1-9][0-9]{0,6})$ ]]; then
  timeout_seconds="${BASH_REMATCH[1]}"
else
  echo "CLAUDE_REVIEW_TIMEOUT_SECONDS must be 0 (disabled) or an integer from 1 through 2147483" >&2
  exit 2
fi
if [ "$timeout_seconds" -gt 2147483 ]; then
  echo "CLAUDE_REVIEW_TIMEOUT_SECONDS must be 0 (disabled) or an integer from 1 through 2147483" >&2
  exit 2
fi

claude_pid=''
watchdog_pid=''
tmp_dir=$(mktemp -d)
prompt_file="$tmp_dir/prompt"
timeout_marker="$tmp_dir/timed-out"

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
  --allowed-tools 'Read,Glob,Grep' \
  --permission-mode dontAsk \
  --setting-sources=project \
  --no-session-persistence < "$prompt_file" 2>/dev/null &
claude_pid=$!
set +m

if [ "$timeout_seconds" -gt 0 ]; then
  (
    sleep "$timeout_seconds"
    : > "$timeout_marker"
    kill -TERM -- "-$claude_pid" 2>/dev/null || exit 0
    sleep 15
    kill -KILL -- "-$claude_pid" 2>/dev/null || true
  ) >/dev/null 2>&1 &
  watchdog_pid=$!
fi

status=0
wait "$claude_pid" || status=$?
claude_pid=''
if [ -n "$watchdog_pid" ] && [ -f "$timeout_marker" ]; then
  wait "$watchdog_pid" 2>/dev/null || true
elif [ -n "$watchdog_pid" ]; then
  kill -TERM "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
fi
watchdog_pid=''

if [ -f "$timeout_marker" ]; then
  echo "claude headless review timed out after ${timeout_seconds}s" >&2
  exit 124
fi
if [ "$status" -ne 0 ]; then
  echo "claude headless review failed (exit ${status})" >&2
fi
exit "$status"
