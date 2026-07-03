#!/usr/bin/env bash
MODEL="ollama-cloud/qwen3-coder-next" exec bash "$(dirname "$0")/opencode-run.sh" "$1"
