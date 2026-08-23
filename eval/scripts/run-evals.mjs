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
 *         fix-plan-boundary-preflight, fix-plan-cause-check, fix-plan-bounded-proof,
 *         fix-verifier-family-boundary, fix-verifier-state-closure, fix-verifier-state-routing,
 *         fix-verifier-model-matrix, fix-verifier-routing-model-matrix,
 *         review-impact-path-coverage,
 *         initial-review-contract-discovery,
 *         initial-review-external-identity-wiring,
 *         testing-review-observable-evidence,
 *         follow-up-review-repair-regression,
 *         follow-up-testing-review-repair-regression,
 *         review-adjudication-binding,
 *         initial-plan-contract-closure, replan-contract-closure,
 *         issue-plan-samples, plan-report-source-authority,
 *         write-tests-contract-traceability,
 *         implement-contract-traceability,
 *         implementation-report-contract-traceability,
 *         review-adjudication, review-adjudication-report, final-readiness-supervision,
 *         final-readiness-preservation,
 *         final-readiness-precision,
 *         fix-verification-scope,
 *         fix-verification-current-diff-regression,
 *         fix-verification-preserved-condition,
 *         task-instruction-gherkin
 *         (default: all except suites that require optional CLI authentication)
 * Example: npm run eval:prompts -- arch --repeat 3
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
  'fix-plan-fresh-findings': 'promptfooconfig.fix-plan-fresh-findings.yaml',
  'fix-plan-boundary-preflight': 'promptfooconfig.fix-plan-boundary-preflight.yaml',
  'fix-plan-cause-check': 'promptfooconfig.fix-plan-cause-check.yaml',
  'fix-plan-bounded-proof': 'promptfooconfig.fix-plan-bounded-proof.yaml',
  'fix-verifier-family-boundary': 'promptfooconfig.fix-verifier-family-boundary.yaml',
  'fix-verifier-state-closure': 'promptfooconfig.fix-verifier-state-closure.yaml',
  'fix-verifier-state-routing': 'promptfooconfig.fix-verifier-state-routing.yaml',
  'fix-verifier-model-matrix': 'promptfooconfig.fix-verifier-model-matrix.yaml',
  'fix-verifier-routing-model-matrix': 'promptfooconfig.fix-verifier-routing-model-matrix.yaml',
  'review-impact-path-coverage': 'promptfooconfig.review-impact-path-coverage.yaml',
  'initial-review-contract-discovery': 'promptfooconfig.initial-review-contract-discovery.yaml',
  'initial-review-external-identity-wiring': 'promptfooconfig.initial-review-external-identity-wiring.yaml',
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
  'review-adjudication-binding': 'promptfooconfig.review-adjudication-binding.yaml',
  'security-review-method': 'promptfooconfig.security-review-method.yaml',
  'review-adjudication': 'promptfooconfig.review-adjudication.yaml',
  'review-adjudication-report': 'promptfooconfig.review-adjudication-report.yaml',
  'final-readiness-supervision': 'promptfooconfig.final-readiness-supervision.yaml',
  'final-readiness-preservation': 'promptfooconfig.final-readiness-preservation.yaml',
  'final-readiness-precision': 'promptfooconfig.final-readiness-precision.yaml',
  'fix-verification-scope': 'promptfooconfig.fix-verification-scope.yaml',
  'fix-verification-current-diff-regression': 'promptfooconfig.fix-verification-current-diff-regression.yaml',
  'fix-verification-preserved-condition': 'promptfooconfig.fix-verification-preserved-condition.yaml',
  'task-instruction-gherkin': 'promptfooconfig.task-instruction-gherkin.yaml',
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(scriptDir, '..');
const repoRoot = resolve(evalDir, '..');
const promptfooConfigDir = join(repoRoot, '.tmp', 'promptfoo');
mkdirSync(promptfooConfigDir, { recursive: true });

const args = process.argv.slice(2);
const firstFlagIndex = args.findIndex((a) => a.startsWith('-'));
const names = firstFlagIndex === -1 ? args : args.slice(0, firstFlagIndex);
const flags = firstFlagIndex === -1 ? [] : args.slice(firstFlagIndex);
for (const name of names) {
  if (!SUITES[name]) {
    throw new Error(`Unknown suite "${name}". Available: ${Object.keys(SUITES).join(', ')}`);
  }
}
// coding は Claude Opus / Codex Luna Max / Codex Sol High の3モデル測定で、
// Claude と Codex の両 CLI ログインが必要なため、明示的に呼び出す。
// rescan 系はローカルモデル（要 opencode 認証）を含む測定用スイートで、
// 弱いモデルの行は常に部分失敗するため、デフォルトのゲート実行からは除外する。
// fix-self-scan は claude ヘッドレス CLI（要 claude ログイン）で走るため、
// codex 前提のデフォルト実行からは除外し、明示的に呼び出す。
// initial-review-external-identity-wiring も同じ2つの外部 CLI で3モデルを使うため、
// デフォルト実行から除外して明示的に呼び出す。
// review-adjudication-binding も同じ2つの外部 CLI で3モデルを使うため、
// デフォルト実行から除外して明示的に呼び出す。
// security-review-method も同じ2つの外部 CLI で3モデルを使うため、
// デフォルト実行から除外して明示的に呼び出す。
// fix-plan-cause-check も claude（opus）と codex（gpt-5.6-luna）の
// 両ログインが必要な二重測定スイートのため、明示的に呼び出す。
// fix-plan-bounded-proof、fix-plan-fresh-findings、review-adjudication も claude（opus）と
// codex（Luna Max / Sol High）の両ログインが必要な3モデル測定スイートのため、明示的に呼び出す。
// review-impact-path-coverage と follow-up-review-repair-regression、follow-up-testing-review-repair-regression も claude（opus）と
// codex（Luna Max / Sol High）の両ログインが必要な3モデル測定スイートのため、明示的に呼び出す。
// fix-verification 系の対照スイートも同じ3モデルを使うため、明示的に呼び出す。
const DEFAULT_EXCLUDED = new Set([
  'coding',
  'rescan',
  'rescan-coding',
  'fix-self-scan',
  'fix-verifier-model-matrix',
  'fix-verifier-routing-model-matrix',
  'fix-plan-cause-check',
  'fix-plan-bounded-proof',
  'fix-plan-fresh-findings',
  'review-impact-path-coverage',
  'follow-up-review-repair-regression',
  'follow-up-testing-review-repair-regression',
  'review-adjudication',
  'review-adjudication-report',
  'initial-review-external-identity-wiring',
  'review-adjudication-binding',
  'security-review-method',
  'fix-verification-scope',
  'fix-verification-current-diff-regression',
  'fix-verification-preserved-condition',
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
    env: {
      ...process.env,
      PROMPTFOO_CONFIG_DIR: promptfooConfigDir,
    },
  });
  summary.push({ name, code: result.status ?? 1 });
}

console.log('\n=== eval summary ===');
for (const { name, code } of summary) {
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name}`);
}
process.exit(summary.some((s) => s.code !== 0) ? 1 : 0);
