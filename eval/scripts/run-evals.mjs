#!/usr/bin/env node
/**
 * Run promptfoo eval suites sequentially without stopping on failures
 * (promptfoo exits non-zero when a test fails, which would break `&&` chains).
 *
 * Usage: node eval/scripts/run-evals.mjs [suite...] [--promptfoo-flags...]
 * Suites: coding, arch, antipattern, frontend, cqrs, rescan, rescan-coding,
 *         frontend-coder, cqrs-coder (default: all except rescan / rescan-coding,
 *         which need opencode auth)
 * Example: npm run eval:prompts -- arch --repeat 3
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITES = {
  coding: 'promptfooconfig.coding.yaml',
  arch: 'promptfooconfig.arch.yaml',
  antipattern: 'promptfooconfig.antipattern.yaml',
  frontend: 'promptfooconfig.frontend.yaml',
  cqrs: 'promptfooconfig.cqrs.yaml',
  rescan: 'promptfooconfig.rescan.yaml',
  'rescan-coding': 'promptfooconfig.rescan-coding.yaml',
  'rescan-semantics': 'promptfooconfig.rescan-semantics.yaml',
  'frontend-coder': 'promptfooconfig.frontend-coder.yaml',
  'cqrs-coder': 'promptfooconfig.cqrs-coder.yaml',
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(scriptDir, '..');
const repoRoot = resolve(evalDir, '..');

const args = process.argv.slice(2);
const firstFlagIndex = args.findIndex((a) => a.startsWith('-'));
const names = firstFlagIndex === -1 ? args : args.slice(0, firstFlagIndex);
const flags = firstFlagIndex === -1 ? [] : args.slice(firstFlagIndex);
for (const name of names) {
  if (!SUITES[name]) {
    throw new Error(`Unknown suite "${name}". Available: ${Object.keys(SUITES).join(', ')}`);
  }
}
// rescan / rescan-coding はローカルモデル（要 opencode 認証）を含む測定用スイートで、
// 弱いモデルの行は常に部分失敗するため、デフォルトのゲート実行からは除外する。
const DEFAULT_EXCLUDED = new Set(['rescan', 'rescan-coding', 'rescan-semantics']);
const selected = names.length > 0 ? names : Object.keys(SUITES).filter((s) => !DEFAULT_EXCLUDED.has(s));

const summary = [];
for (const name of selected) {
  const config = join(evalDir, SUITES[name]);
  console.log(`\n=== suite: ${name} (${SUITES[name]}) ===`);
  const result = spawnSync('npx', ['promptfoo', 'eval', '-c', config, '--no-progress-bar', ...flags], {
    stdio: 'inherit',
    cwd: repoRoot,
  });
  summary.push({ name, code: result.status ?? 1 });
}

console.log('\n=== eval summary ===');
for (const { name, code } of summary) {
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name}`);
}
process.exit(summary.some((s) => s.code !== 0) ? 1 : 0);
