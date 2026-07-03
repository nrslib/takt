#!/usr/bin/env bash
# promptfoo exec プロバイダ: codex exec ヘッドレスで1発実行する（強モデル対照用）
set -euo pipefail
prompt="$1"
out=$(mktemp)
trap 'rm -f "$out"' EXIT
printf '%s' "$prompt" | codex exec - --model gpt-5.5 --sandbox read-only --skip-git-repo-check --ephemeral -o "$out" >/dev/null 2>&1
cat "$out"
