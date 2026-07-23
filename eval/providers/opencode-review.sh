#!/usr/bin/env bash
# promptfoo exec プロバイダ: 指定モデルの opencode をフィクスチャディレクトリで実行する。
# 使い方（promptfoo が末尾にプロンプトを追加で渡す）:
#   exec: bash providers/opencode-review.sh <provider/model> <fixture-dir>
#   exec: bash providers/opencode-review.sh <provider/model> <fixture-dir> --phase2=<phase2-prompt>
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec node "$script_dir/opencode-review.mjs" "$@"
