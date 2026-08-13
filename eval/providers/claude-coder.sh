#!/usr/bin/env bash
# promptfoo exec プロバイダ: claude ヘッドレス CLI を work copy で実行する。
# 使い方（promptfoo が末尾にプロンプトを追加で渡す）:
#   exec: bash providers/claude-coder.sh <model> <work-dir>
#
# --setting-sources=project は測定条件の固定のための意図的な選択。
# 本番の claude provider（src/infra/claude-headless/client.ts）は通常経路で
# --setting-sources を渡さずユーザー設定を読み込むが、この eval では
# 個人のグローバル設定が測定条件に混入しないよう固定する。
#
# 外部 CLI が停止しても評価ジョブが完了するよう、watchdog で hard timeout を
# かける（TERM → 猶予後 KILL）。実測の coder 実行は 6〜12 分。
set -euo pipefail
model="$1"
work_dir="$2"
prompt="$3"
timeout_seconds="${CLAUDE_CODER_TIMEOUT_SECONDS:-1800}"
cd "$(dirname "$0")/../${work_dir}"

printf '%s' "$prompt" | claude -p \
  --model "$model" \
  --allowed-tools 'Read,Write,Edit,Glob,Grep,Bash' \
  --permission-mode acceptEdits \
  --setting-sources=project 2>/dev/null &
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
  echo "claude headless run failed or was killed after ${timeout_seconds}s (exit ${status})" >&2
fi
exit "$status"
