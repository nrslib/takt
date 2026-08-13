#!/usr/bin/env node
/**
 * Run promptfoo eval suites sequentially without stopping on failures
 * (promptfoo exits non-zero when a test fails, which would break `&&` chains).
 *
 * Usage: node eval/scripts/run-evals.mjs [suite...] [--promptfoo-flags...]
 * Suites: coding, arch, arch-failure-aggregation, antipattern, frontend, cqrs,
 *         rescan, rescan-coding,
 *         frontend-coder,
 *         cqrs-coder, fix-closure, fix-plan-fresh-findings,
 *         fix-plan-boundary-preflight, review-family-closure,
 *         initial-review-contract-discovery, testing-review-observable-evidence,
 *         follow-up-review-repair-regression,
 *         follow-up-testing-review-repair-regression,
 *         initial-plan-contract-closure, replan-contract-closure,
 *         issue-plan-samples, plan-report-source-authority,
 *         write-tests-contract-traceability,
 *         implement-contract-traceability,
 *         implementation-report-contract-traceability,
 *         review-adjudication, final-readiness-supervision,
 *         final-readiness-preservation,
 *         task-instruction-gherkin
 *         (default: all except rescan suites,
 *         which need opencode auth)
 * Example: npm run eval:prompts -- arch --repeat 3
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITES = {
  coding: 'promptfooconfig.coding.yaml',
  arch: 'promptfooconfig.arch.yaml',
  'arch-failure-aggregation': 'promptfooconfig.arch-failure-aggregation.yaml',
  antipattern: 'promptfooconfig.antipattern.yaml',
  frontend: 'promptfooconfig.frontend.yaml',
  cqrs: 'promptfooconfig.cqrs.yaml',
  rescan: 'promptfooconfig.rescan.yaml',
  'rescan-coding': 'promptfooconfig.rescan-coding.yaml',
  'frontend-coder': 'promptfooconfig.frontend-coder.yaml',
  'cqrs-coder': 'promptfooconfig.cqrs-coder.yaml',
  'fix-closure': 'promptfooconfig.fix-closure.yaml',
  'fix-self-scan': 'promptfooconfig.fix-self-scan.yaml',
  'fix-loop-convergence': 'promptfooconfig.fix-loop-convergence.yaml',
  'fix-plan-fresh-findings': 'promptfooconfig.fix-plan-fresh-findings.yaml',
  'fix-plan-boundary-preflight': 'promptfooconfig.fix-plan-boundary-preflight.yaml',
  'review-family-closure': 'promptfooconfig.review-family-closure.yaml',
  'initial-review-contract-discovery': 'promptfooconfig.initial-review-contract-discovery.yaml',
  'testing-review-observable-evidence': 'promptfooconfig.testing-review-observable-evidence.yaml',
  'initial-plan-contract-closure': 'promptfooconfig.initial-plan-contract-closure.yaml',
  'replan-contract-closure': 'promptfooconfig.replan-contract-closure.yaml',
  'issue-plan-samples': 'promptfooconfig.issue-plan-samples.yaml',
  'plan-report-source-authority': 'promptfooconfig.plan-report-source-authority.yaml',
  'write-tests-contract-traceability': 'promptfooconfig.write-tests-contract-traceability.yaml',
  'write-tests-default-priority': 'promptfooconfig.write-tests-default-priority.yaml',
  'write-tests-default-priority-codex': 'promptfooconfig.write-tests-default-priority-codex.yaml',
  'scope-default-write-tests': 'promptfooconfig.scope-default-write-tests.yaml',
  'scope-maintenance-write-tests': 'promptfooconfig.scope-maintenance-write-tests.yaml',
  'scope-architecture-search': 'promptfooconfig.scope-architecture-search.yaml',
  'scope-architecture-search-none': 'promptfooconfig.scope-architecture-search-none.yaml',
  'scope-architecture-search-unrelated': 'promptfooconfig.scope-architecture-search-unrelated.yaml',
  'scope-architecture-boundary': 'promptfooconfig.scope-architecture-boundary.yaml',
  'implement-contract-traceability': 'promptfooconfig.implement-contract-traceability.yaml',
  'implementation-report-contract-traceability': 'promptfooconfig.implementation-report-contract-traceability.yaml',
  'follow-up-review-repair-regression': 'promptfooconfig.follow-up-review-repair-regression.yaml',
  'follow-up-testing-review-repair-regression': 'promptfooconfig.follow-up-testing-review-repair-regression.yaml',
  'review-mode-authority': 'promptfooconfig.review-mode-authority.yaml',
  'fix-verifier-family-boundary': 'promptfooconfig.fix-verifier-family-boundary.yaml',
  'companion-early-scan': 'promptfooconfig.companion-early-scan.yaml',
  'companion-evidence-boundary': 'promptfooconfig.companion-evidence-boundary.yaml',
  'review-adjudication': 'promptfooconfig.review-adjudication.yaml',
  'final-readiness-supervision': 'promptfooconfig.final-readiness-supervision.yaml',
  'final-readiness-preservation': 'promptfooconfig.final-readiness-preservation.yaml',
  'task-instruction-gherkin': 'promptfooconfig.task-instruction-gherkin.yaml',
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
// rescan 系はローカルモデル（要 opencode 認証）を含む測定用スイートで、
// 弱いモデルの行は常に部分失敗するため、デフォルトのゲート実行からは除外する。
// fix-self-scan は claude ヘッドレス CLI（要 claude ログイン）で走るため、
// codex 前提のデフォルト実行からは除外し、明示的に呼び出す。
// fix-loop-convergence も claude（opus）と codex（gpt-5.6-luna）の両ログインが
// 必要な二重測定スイートのため、明示的に呼び出す。
const DEFAULT_EXCLUDED = new Set([
  'rescan',
  'rescan-coding',
  'fix-self-scan',
  'fix-loop-convergence',
  'write-tests-default-priority',
  'write-tests-default-priority-codex',
]);
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
