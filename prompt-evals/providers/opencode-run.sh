#!/usr/bin/env bash
# promptfoo exec プロバイダ: MODEL 環境変数のモデルで opencode run を1発実行する
set -euo pipefail
prompt="$1"
opencode run -m "$MODEL" --pure "$prompt" 2>/dev/null
