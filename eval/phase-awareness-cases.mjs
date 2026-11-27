import { readFileSync } from 'node:fs';

export const PHASE_PROVIDERS = Object.freeze([
  { id: 'luna-max', cli: 'codex', model: 'gpt-6-luna', reasoning_effort: 'max' },
  { id: 'sol-low', cli: 'codex', model: 'gpt-6-sol', reasoning_effort: 'low' },
  { id: 'opus', cli: 'claude', model: 'claude-opus-5' },
]);

export const PHASE_CASES = Object.freeze([
  { id: '1', name: 'carryover-phase1', kind: 'carryover', step: 'review-adjudication' },
  { id: '2', name: 'carryover-phase1-other-domain', kind: 'carryover-code', step: 'coding-review' },
  { id: '3', name: 'phase2-same-session', kind: 'report-same', step: 'coding-review' },
  { id: '4', name: 'phase2-new-session', kind: 'report-new', step: 'coding-review' },
  { id: '5', name: 'phase2-stale-history', kind: 'report-stale', step: 'coding-review' },
  { id: '5b-same', case: '5b', name: 'phase2-missing-result-same', kind: 'missing-same', step: 'coding-review' },
  { id: '5b-new', case: '5b', name: 'phase2-missing-result-new', kind: 'missing-new', step: 'coding-review' },
  { id: '6-structured', case: '6', name: 'phase3-conductor-new-structured', kind: 'judge', stage: 'structured_output', step: 'review-adjudication' },
  { id: '6-tag', case: '6', name: 'phase3-conductor-new-tag', kind: 'judge', stage: 'phase3_tag', step: 'review-adjudication' },
  { id: '6b', name: 'phase3-ai-judge', kind: 'judge', stage: 'ai_judge', step: 'review-adjudication' },
  { id: '7', name: 'phase3-stale-history', kind: 'judge-stale', stage: 'structured_output', step: 'review-adjudication' },
  { id: '8', name: 'phase1-edit-forbidden-kept', kind: 'readonly', step: 'coding-review' },
  { id: '8b', name: 'phase2-then-edit-allowed', kind: 'edit', step: 'implement' },
  { id: '9', name: 'phase1-user-read-forbidden', kind: 'no-docs', step: 'coding-review' },
]);

export function phaseCase(id) {
  const entry = PHASE_CASES.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown phase case: ${id}`);
  return entry;
}

export function taskFor(entry) {
  return readFileSync(new URL(`./cases/phase-awareness-${entry.id}-task.md`, import.meta.url), 'utf8').trim();
}

export function trialCount(entry, provider, variant, smoke) {
  if (smoke) return provider.id === 'sol-low' ? 1 : 0;
  if (variant === 'red' && (entry.case ?? entry.id) === '5b') return 0;
  return ['1', '2'].includes(entry.id) && provider.id === 'luna-max' ? 10 : 3;
}

export const CURRENT_RESULT = 'CURRENT-202: src/count-active.mjs は全件数を返すため、無効な項目も有効件数に含まれる。active === true の項目だけを数える必要がある。';
export const JUDGE_CURRENT = '修正対象なし。今回の指摘はすべて解消済みであり、追加の修正は不要。';
export const JUDGE_OLD = '修正対象あり。OLD-101 は未修正で、修正が必要。';

export function makeStep(entry, instruction, edit = false) {
  const adjudication = entry.step === 'review-adjudication';
  return {
    name: entry.step,
    edit,
    allowGitCommit: false,
    instruction,
    outputContracts: [{
      name: 'review.md',
      order: '元の要求への回答と、今回確認した指摘および根拠を報告してください。',
      format: `# レビュー結果\n- ステップ: ${entry.step}\n## 元の要求への回答\n（今回の要求に対する結論）\n## 指摘\n${adjudication ? '| ID | 裁定（修正する / 外す） | 根拠 |\n|---|---|---|' : '（指摘 ID、対象、問題、根拠。指摘がなければその旨）'}`,
    }],
    rules: [
      { condition: { kind: 'semantic', label: '修正対象あり' }, next: 'fix' },
      { condition: { kind: 'semantic', label: '修正対象なし' }, next: 'COMPLETE' },
    ],
  };
}
