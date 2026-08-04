#!/usr/bin/env bash
# promptfoo exec プロバイダ: claude ヘッドレス CLI を work copy で実行する。
# 使い方（promptfoo が末尾にプロンプトを追加で渡す）:
#   exec: bash providers/claude-coder.sh <model> <work-dir>
#
# --setting-sources=project は測定条件の固定のための意図的な選択。
# 本番の claude provider（src/infra/claude-headless/client.ts）は通常経路で
# --setting-sources を渡さずユーザー設定を読み込むが、この eval では
# 個人の ~/.claude/CLAUDE.md が測定条件に混入しないよう固定する。
set -euo pipefail
model="$1"
work_dir="$2"
prompt="$3"
cd "$(dirname "$0")/../${work_dir}"
printf '%s' "$prompt" | claude -p \
  --model "$model" \
  --allowed-tools 'Read,Write,Edit,Glob,Grep,Bash' \
  --permission-mode acceptEdits \
  --setting-sources=project 2>/dev/null
