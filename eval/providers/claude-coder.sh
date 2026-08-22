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
  --allowed-tools 'Read,Write,Edit,Glob,Grep,Bash' \
  --permission-mode acceptEdits \
  --setting-sources=project 2>/dev/null &
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
  echo "claude headless run failed or was killed after ${timeout_seconds}s (exit ${status})" >&2
fi
exit "$status"
