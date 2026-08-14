#!/usr/bin/env bash
# promptfoo exec プロバイダ: codex CLI での判定専用実行（read-only）。
# 使い方: exec: bash providers/codex-judge.sh <model> [reasoning-effort]
# fix-loop-convergence スイートで使用。モデルを明示指定するため
# openai:codex-sdk ではなく CLI を直接使う。
set -euo pipefail
model="$1"
if [ "$#" -ge 3 ]; then
  reasoning_effort="$2"
  prompt="$3"
else
  reasoning_effort="max"
  prompt="$2"
fi
raw_timeout_seconds="${CODEX_JUDGE_TIMEOUT_SECONDS:-600}"
if [[ ! "$raw_timeout_seconds" =~ ^0*([1-9][0-9]{0,6})$ ]]; then
  echo "CODEX_JUDGE_TIMEOUT_SECONDS must be an integer from 1 through 2147483" >&2
  exit 2
fi
timeout_seconds="${BASH_REMATCH[1]}"
if [ "$timeout_seconds" -gt 2147483 ]; then
  echo "CODEX_JUDGE_TIMEOUT_SECONDS must be an integer from 1 through 2147483" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
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
  let timedOut = false;
  let failed = false;
  process.on("SIGTERM", () => {
    if (!timedOut) process.exit(0);
  });
  setTimeout(() => {
    timedOut = true;
    try {
      writeFileSync(timeoutMarker, "");
    } catch (error) {
      console.error(`failed to record timeout: ${error.message}`);
      failed = true;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      console.error(`failed to terminate Codex process group: ${error.message}`);
      process.kill(process.ppid, "SIGTERM");
      process.exit(1);
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          console.error(`failed to kill Codex process group: ${error.message}`);
          failed = true;
        }
      }
      process.exit(failed ? 1 : 0);
    }, 15_000);
  }, timeoutMs);
' "$codex_pid" "$timeout_seconds" "$timeout_marker" >/dev/null &
watchdog_pid=$!

status=0
wait "$codex_pid" || status=$?
kill -TERM "$watchdog_pid" 2>/dev/null || true
watchdog_status=0
wait "$watchdog_pid" 2>/dev/null || watchdog_status=$?
watchdog_pid=''
if [ "$watchdog_status" -ne 0 ] && { [ -f "$timeout_marker" ] || [ "$watchdog_status" -ne 143 ]; }; then
  echo "codex judge watchdog failed (exit ${watchdog_status})" >&2
  exit 125
fi
if [ -f "$timeout_marker" ]; then
  echo "codex judge timed out after ${timeout_seconds}s" >&2
  exit 124
fi
if [ "$status" -ne 0 ]; then
  echo "codex judge run failed (exit ${status})" >&2
  exit "$status"
fi
codex_pid=''
cat "$out"
