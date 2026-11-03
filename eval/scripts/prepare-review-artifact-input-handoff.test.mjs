import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const promptDir = join(repo, 'eval/prompts/review-artifact-input-handoff');

test('all four cases use the exact declared producer receipt in the current Phase 1 prompt', () => {
  const prepared = spawnSync(process.execPath, ['eval/scripts/prepare-review-artifact-input-handoff.mjs'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: '/dev/null' },
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const receipts = JSON.parse(readFileSync(join(promptDir, 'receipts.json'), 'utf8'));
  assert.deepEqual(receipts.map((entry) => entry.case), ['follow-up', 'replan', 'synthesis', 'merge']);
  assert.deepEqual(receipts.map((entry) => entry.reachability), [
    'anomalous_report_combination', 'normal', 'normal', 'normal',
  ]);
  assert.deepEqual(receipts.map((entry) => entry.report_files), [
    ['fix-plan.md', 'fix-report.md', 'fix-verification.md'],
    ['review-resolution.md'],
    ['backend-review.md', 'testing-review.md'],
    ['review-target.md', 'backend-review.md', 'review-summary.md'],
  ]);
  const replanProducerRoot = join(
    repo,
    'eval/.work/review-artifact-input-handoff/.takt/runs/eval/replan/reports/subworkflows',
  );
  const resolutionPaths = readdirSync(replanProducerRoot, { recursive: true })
    .filter((path) => basename(path) === 'review-resolution.md');
  assert.equal(resolutionPaths.length, 1);
  const producerDir = dirname(join(replanProducerRoot, resolutionPaths[0]));
  for (const name of ['review-resolution.md', 'summary.md']) {
    assert.ok(readFileSync(join(producerDir, name), 'utf8').trim().length > 0,
      `final-gate must produce a nonempty ${name}`);
  }
  const replanReceipt = receipts.find((receipt) => receipt.case === 'replan');
  assert.ok(replanReceipt.injected_report_scopes.every((report) => report.reference !== 'summary.md'),
    'replan must receive only its selected report, even when the producer writes multiple reports');
  for (const receipt of receipts) {
    assert.equal(receipt.baseline_sha, '946a0283df86e00dce84b7d381a6bb188b29594b');
    const oldPrompt = readFileSync(join(promptDir, `${receipt.case}-baseline.md`), 'utf8');
    const newPrompt = readFileSync(join(promptDir, `${receipt.case}-current.md`), 'utf8');
    assert.ok(!oldPrompt.includes('## 宣言された成果物入力'));
    assert.ok(!oldPrompt.includes(receipt.expected_marker));
    assert.equal(newPrompt.includes('## 宣言された成果物入力'),
      receipt.case === 'follow-up' || receipt.case === 'synthesis' || receipt.case === 'merge');
    assert.ok(newPrompt.includes(receipt.expected_marker));
    assert.ok(!newPrompt.includes(`UNRELATED-SHADOW-${receipt.case}-`));
    assert.ok(receipt.report_files.every((name) =>
      receipt.injected_report_scopes.some((report) => report.reference === name && report.scope === 'declared-producer')));
  }
  assert.match(readFileSync(join(promptDir, 'follow-up-current.md'), 'utf8'), /### remediation: fix-plan\.md\n# Fix plan[\s\S]*### remediation: fix-report\.md\n# Fix report[\s\S]*### remediation: fix-verification\.md\n# Completion verification/);
  assert.match(readFileSync(join(promptDir, 'replan-current.md'), 'utf8'), /最終判定:\n# Review resolution/);
  assert.match(readFileSync(join(promptDir, 'synthesis-current.md'), 'utf8'), /レビュー対象: # Review target/);
  assert.match(readFileSync(join(promptDir, 'merge-current.md'), 'utf8'), /レビューサマリー: # Review summary/);
  assert.ok(receipts.find((receipt) => receipt.case === 'synthesis')?.injected_report_scopes.some((report) =>
    report.reference === 'review-target.md' && report.scope === 'step'));
  assert.match(readFileSync(join(promptDir, 'follow-up-baseline.md'), 'utf8'), /iteration-<n>--step-remediation/);
  assert.doesNotMatch(readFileSync(join(promptDir, 'follow-up-current.md'), 'utf8'), /iteration-<n>--step-remediation/);
  assert.match(readFileSync(join(promptDir, 'merge-baseline.md'), 'utf8'), /subworkflows\//);
  assert.doesNotMatch(readFileSync(join(promptDir, 'merge-current.md'), 'utf8'), /subworkflows\//);
  const synthesisTarget = join(
    repo,
    'eval/.work/review-artifact-input-handoff/.takt/runs/eval/synthesis/reports/review-target.md',
  );
  assert.match(readFileSync(synthesisTarget, 'utf8'), /Review src\/routes\.mjs authorization/);
});
