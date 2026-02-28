#!/usr/bin/env bash
set -euo pipefail

runtime_root="${TAKT_RUNTIME_ROOT:?TAKT_RUNTIME_ROOT is required}"
runtime_tmp="${TAKT_RUNTIME_TMP:-$runtime_root/tmp}"
gradle_home="$runtime_root/gradle"

mkdir -p "$runtime_tmp" "$gradle_home"

echo "GRADLE_USER_HOME=$gradle_home"
echo "TMPDIR=$runtime_tmp"
# Codex コンテナは UDP ソケット（Gradle デーモン通信）をブロックするためデーモンを無効化
echo "GRADLE_OPTS=-Dorg.gradle.daemon=false"
