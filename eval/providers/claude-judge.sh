#!/usr/bin/env bash
# promptfoo exec プロバイダ: claude ヘッドレス CLI での判定専用実行（ツールなし・読み取りのみ）。
# 使い方: exec: bash providers/claude-judge.sh <model>
# fix-loop-convergence スイートで使用。編集を伴わない机上判定のため
# ツールを許可せず、個人設定の混入を避けるため --setting-sources=project で固定する。
set -euo pipefail
model="$1"
prompt="$2"
timeout_seconds="${CLAUDE_JUDGE_TIMEOUT_SECONDS:-600}"
cd "$(dirname "$0")/.."
tmp_dir=$(mktemp -d)
prompt_file="$tmp_dir/prompt"
timeout_marker="$tmp_dir/timed-out"
trap 'rm -rf "$tmp_dir"' EXIT
printf '%s' "$prompt" > "$prompt_file"

set -m
claude -p \
  --model "$model" \
  --disallowedTools "*" \
  --setting-sources=project < "$prompt_file" 2>/dev/null &
claude_pid=$!
set +m
(
  sleep "$timeout_seconds"
  : > "$timeout_marker"
  kill -TERM -- "-$claude_pid" 2>/dev/null || exit 0
  sleep 15
  kill -KILL -- "-$claude_pid" 2>/dev/null || true
) >/dev/null 2>&1 &
watchdog_pid=$!
status=0
wait "$claude_pid" || status=$?
if [ -f "$timeout_marker" ]; then
  wait "$watchdog_pid" 2>/dev/null || true
else
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
fi
if [ "$status" -ne 0 ]; then
  echo "claude judge run failed or was killed after ${timeout_seconds}s (exit ${status})" >&2
fi
exit "$status"
