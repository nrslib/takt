#!/usr/bin/env bash
MODEL="ollama-cloud/qwen3.5:397b" exec bash "$(dirname "$0")/opencode-run.sh" "$1"
