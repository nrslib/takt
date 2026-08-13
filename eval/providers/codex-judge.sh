#!/usr/bin/env bash
# promptfoo exec プロバイダ: codex CLI での判定専用実行（read-only）。
# 使い方: exec: bash providers/codex-judge.sh <model>
# fix-loop-convergence スイートで使用。モデルを明示指定するため
# openai:codex-sdk ではなく CLI を直接使う。
set -euo pipefail
model="$1"
prompt="$2"
timeout_seconds="${CODEX_JUDGE_TIMEOUT_SECONDS:-600}"
cd "$(dirname "$0")/.."
out=$(mktemp)
trap 'rm -f "$out"' EXIT

printf '%s' "$prompt" | codex exec -m "$model" -s read-only --skip-git-repo-check \
  -c model_reasoning_effort=medium -o "$out" - >/dev/null 2>&1 &
codex_pid=$!
(
  sleep "$timeout_seconds"
  kill -TERM "$codex_pid" 2>/dev/null || exit 0
  sleep 15
  kill -KILL "$codex_pid" 2>/dev/null || true
) >/dev/null 2>&1 &
watchdog_pid=$!
status=0
wait "$codex_pid" || status=$?
kill "$watchdog_pid" 2>/dev/null || true
if [ "$status" -ne 0 ]; then
  echo "codex judge run failed or was killed after ${timeout_seconds}s (exit ${status})" >&2
  exit "$status"
fi
cat "$out"
