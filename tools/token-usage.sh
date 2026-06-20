#!/usr/bin/env bash
# Token usage summary across TAKT runs
# Usage: ./tools/token-usage.sh [dir...] [--top N] [--csv] [--all]
#   dir: directories to scan (default: ../takt-worktrees + .takt/runs/)
#   --top N: show top N runs (default: 10)
#   --csv: output as CSV
#   --all: include mock/zero-token runs
set -euo pipefail

SCAN_DIRS=()
TOP=10
CSV=false
SHOW_ALL=false

for arg in "$@"; do
  case "$arg" in
    --top) TOP="next" ;;
    --csv) CSV=true ;;
    --all) SHOW_ALL=true ;;
    *)
      if [[ "$TOP" == "next" ]]; then
        TOP="$arg"
      else
        SCAN_DIRS+=("$arg")
      fi
      ;;
  esac
done

if [[ ${#SCAN_DIRS[@]} -eq 0 ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
  WORKTREES_DIR="$(dirname "$PROJECT_DIR")/takt-worktrees"
  LOCAL_RUNS_DIR="$PROJECT_DIR/.takt/runs"
  [[ -d "$WORKTREES_DIR" ]] && SCAN_DIRS+=("$WORKTREES_DIR")
  [[ -d "$LOCAL_RUNS_DIR" ]] && SCAN_DIRS+=("$LOCAL_RUNS_DIR")
fi

if [[ ${#SCAN_DIRS[@]} -eq 0 ]]; then
  echo "Error: no scan directories found" >&2
  exit 1
fi

FILES="$(find "${SCAN_DIRS[@]}" -name '*usage-events.phase.jsonl' 2>/dev/null || true)"

if [[ -z "$FILES" ]]; then
  echo "No usage records found." >&2
  exit 1
fi

echo "$FILES" | node --input-type=module -e '
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

const top = parseInt(process.argv[1] || "10");
const csv = process.argv[2] === "true";
const showAll = process.argv[3] === "true";

const rl = createInterface({ input: process.stdin });
const records = [];

for await (const filePath of rl) {
  const p = filePath.trim();
  if (!p) continue;
  try {
    const lines = readFileSync(p, "utf-8").trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        r._source_path = p;
        records.push(r);
      } catch {}
    }
  } catch {}
}

if (records.length === 0) {
  console.error("No usage records found.");
  process.exit(1);
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function pct(part, whole) {
  return whole > 0 ? ((part / whole) * 100).toFixed(0) + "%" : "-";
}

function extractTaskName(sourcePath) {
  if (!sourcePath) return null;
  const m = sourcePath.match(/takt-worktrees\/[^/]*?-([a-z].*?)(?=\/\.takt)/);
  if (m) return m[1];
  const m2 = sourcePath.match(/takt-worktrees\/\d{8}T\d{4}-(.+?)\//);
  if (m2) return m2[1];
  return null;
}

const byRun = new Map();
for (const r of records) {
  const key = r.run_id;
  if (!byRun.has(key)) {
    byRun.set(key, {
      run_id: key,
      provider: r.provider,
      model: r.provider_model,
      timestamp: r.timestamp,
      task: extractTaskName(r._source_path),
      steps: new Map(),
      total: { input: 0, output: 0, total: 0, cached: 0 },
      records: 0,
    });
  }
  const run = byRun.get(key);
  run.records++;
  if (!run.task && r._source_path) {
    run.task = extractTaskName(r._source_path);
  }

  const u = r.usage || {};
  run.total.input += u.input_tokens || 0;
  run.total.output += u.output_tokens || 0;
  run.total.total += u.total_tokens || 0;
  run.total.cached += u.cached_input_tokens || 0;

  const stepKey = r.step || "unknown";
  if (!run.steps.has(stepKey)) {
    run.steps.set(stepKey, { input: 0, output: 0, total: 0, cached: 0, count: 0 });
  }
  const s = run.steps.get(stepKey);
  s.input += u.input_tokens || 0;
  s.output += u.output_tokens || 0;
  s.total += u.total_tokens || 0;
  s.cached += u.cached_input_tokens || 0;
  s.count++;
}

let runs = [...byRun.values()].sort((a, b) => {
  const ta = a.timestamp || "";
  const tb = b.timestamp || "";
  return tb.localeCompare(ta);
});

if (!showAll) {
  runs = runs.filter(r => r.total.total > 0);
}

const grandTotal = runs.reduce((s, r) => s + r.total.total, 0);
const grandCached = runs.reduce((s, r) => s + r.total.cached, 0);
const grandInput = runs.reduce((s, r) => s + r.total.input, 0);
const grandOutput = runs.reduce((s, r) => s + r.total.output, 0);

if (csv) {
  console.log("task,run_id,provider,model,step,input_tokens,output_tokens,total_tokens,cached_tokens,calls");
  for (const run of runs.slice(0, top)) {
    for (const [step, s] of [...run.steps.entries()].sort((a, b) => b[1].total - a[1].total)) {
      console.log([run.task || "-", run.run_id, run.provider, run.model, step, s.input, s.output, s.total, s.cached, s.count].join(","));
    }
  }
  process.exit(0);
}

const W = 76;
const bar = "=".repeat(W);

console.log();
console.log(bar);
console.log("  TAKT Token Usage Summary");
console.log(bar);
console.log(`  Total: ${fmt(grandTotal)} tokens (cached: ${fmt(grandCached)}, ${pct(grandCached, grandInput)} of input)`);
console.log(`  Input: ${fmt(grandInput)}  Output: ${fmt(grandOutput)}  Runs: ${runs.length}`);
console.log(bar);
console.log();

const shown = runs.slice(0, top);
for (const run of shown) {
  const date = run.timestamp ? run.timestamp.slice(0, 10) : "unknown";
  const task = run.task || run.run_id.replace(/^\d{8}-\d{6}-/, "").replace(/-[a-z0-9]{6}$/, "");
  const right = fmt(run.total.total);
  const header = `${date}  ${task}`;
  const pad = Math.max(2, W - 4 - header.length - right.length);
  console.log(`  ${header}  ${"·".repeat(pad)}  ${right}`);
  console.log(`  ${run.provider}/${run.model}  ${run.records} calls  cached: ${pct(run.total.cached, run.total.input)}`);

  const steps = [...run.steps.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [name, s] of steps) {
    const label = `    ${name} (×${s.count})`;
    const val = fmt(s.total);
    const dots = Math.max(2, W - 4 - label.length - val.length);
    console.log(`  ${label}  ${"·".repeat(dots)}  ${val}`);
  }
  console.log();
}

if (runs.length > top) {
  console.log(`  ... and ${runs.length - top} more runs (use --top ${runs.length} to show all)`);
  console.log();
}
' -- "$TOP" "$CSV" "$SHOW_ALL"
