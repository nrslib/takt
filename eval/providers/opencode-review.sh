#!/usr/bin/env bash
# promptfoo exec プロバイダ: 指定モデルの opencode を隔離したフィクスチャコピーで実行する。
# 使い方（promptfoo が末尾にプロンプトを追加で渡す）:
#   exec: bash providers/opencode-review.sh <provider/model> <fixture-dir>
set -euo pipefail

model="$1"
fixture_dir="$2"
prompt="$3"
raw_idle_timeout_seconds="${OPENCODE_REVIEW_IDLE_TIMEOUT_SECONDS:-900}"
if [[ ! "$raw_idle_timeout_seconds" =~ ^0*([1-9][0-9]{0,6})$ ]]; then
  echo "OPENCODE_REVIEW_IDLE_TIMEOUT_SECONDS must be an integer from 1 through 2147483" >&2
  exit 2
fi
idle_timeout_seconds="${BASH_REMATCH[1]}"
if [ "$idle_timeout_seconds" -gt 2147483 ]; then
  echo "OPENCODE_REVIEW_IDLE_TIMEOUT_SECONDS must be an integer from 1 through 2147483" >&2
  exit 2
fi

source_dir="$(cd "$(dirname "$0")/../${fixture_dir}" && pwd)"
tmp_dir=$(mktemp -d)
work_dir="$tmp_dir/work"
event_log="$tmp_dir/events.jsonl"
diagnostic_log="$tmp_dir/opencode.log"
idle_marker="$tmp_dir/idle-timed-out"
opencode_pid=''
watchdog_pid=''

cleanup() {
  trap - INT TERM
  if [ -n "$watchdog_pid" ]; then
    kill -TERM "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
    watchdog_pid=''
  fi
  if [ -n "$opencode_pid" ]; then
    kill -TERM -- "-$opencode_pid" 2>/dev/null || true
    kill -KILL -- "-$opencode_pid" 2>/dev/null || true
    wait "$opencode_pid" 2>/dev/null || true
    opencode_pid=''
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

mkdir -p "$work_dir"
cp -R "$source_dir/." "$work_dir/"
work_dir="$(cd "$work_dir" && pwd -P)"
prompt="${prompt//$source_dir/$work_dir}"
cd "$work_dir"

set -m
opencode run -m "$model" --pure --format json --print-logs --log-level INFO \
  "$prompt" >"$event_log" 2>"$diagnostic_log" &
opencode_pid=$!
set +m

node -e '
  const { statSync, writeFileSync } = require("node:fs");
  const pid = Number(process.argv[1]);
  const idleMs = Number(process.argv[2]) * 1000;
  const idleMarker = process.argv[3];
  const activityFiles = process.argv.slice(4);
  let lastActivity = Date.now();
  let lastObservedMtime = 0;

  const poll = setInterval(() => {
    let newestMtime = 0;
    for (const file of activityFiles) {
      try {
        newestMtime = Math.max(newestMtime, statSync(file).mtimeMs);
      } catch {}
    }
    if (newestMtime > lastObservedMtime) {
      lastObservedMtime = newestMtime;
      lastActivity = Date.now();
      return;
    }
    if (Date.now() - lastActivity < idleMs) return;

    clearInterval(poll);
    writeFileSync(idleMarker, "");
    try { process.kill(-pid, "SIGTERM"); } catch { process.exit(0); }
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      process.exit(0);
    }, 15_000);
  }, 1_000);
' "$opencode_pid" "$idle_timeout_seconds" "$idle_marker" \
  "$event_log" "$diagnostic_log" >/dev/null 2>&1 &
watchdog_pid=$!

status=0
wait "$opencode_pid" || status=$?
opencode_pid=''
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=''
if [ "${OPENCODE_REVIEW_DEBUG:-0}" = "1" ]; then
  cat "$diagnostic_log" >&2
fi
if [ -f "$idle_marker" ]; then
  echo "opencode review made no observable progress for ${idle_timeout_seconds}s" >&2
  exit 124
fi
if [ "$status" -ne 0 ]; then
  echo "opencode review failed (exit ${status})" >&2
  if [ "${OPENCODE_REVIEW_DEBUG:-0}" != "1" ]; then
    tail -n 40 "$diagnostic_log" >&2
  fi
  exit "$status"
fi

node -e '
  const { readFileSync } = require("node:fs");
  const lines = readFileSync(process.argv[1], "utf8").split(/\r?\n/);
  const output = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      output.push(event.part.text);
    }
  }
  if (output.length === 0) {
    console.error("opencode review completed without a text response");
    process.exit(65);
  }
  process.stdout.write(`${output.join("\n")}\n`);
' "$event_log"
