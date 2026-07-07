#!/usr/bin/env bash
# promptfoo exec プロバイダ: 指定モデルの opencode をフィクスチャディレクトリで実行する。
# 使い方（promptfoo が末尾にプロンプトを追加で渡す）:
#   exec: bash providers/opencode-review.sh <provider/model> <fixture-dir>
set -euo pipefail
model="$1"
fixture_dir="$2"
prompt="$3"
cd "$(dirname "$0")/../${fixture_dir}"
opencode run -m "$model" --pure "$prompt" 2>/dev/null
