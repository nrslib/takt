#!/usr/bin/env bash
MODEL="ollama-cloud/gemma4:31b" exec bash "$(dirname "$0")/opencode-run.sh" "$1"
