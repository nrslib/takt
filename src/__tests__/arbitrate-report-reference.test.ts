/**
 * 裁定ステップ（ai-antipattern-no-fix / instruction: arbitrate 系）と
 * antipattern ループ監視 judge の {report:X} 参照が、その時点で実在する
 * 1次レビュー（ai-antipattern-review-1st）の output contract 名と一致する
 * ことの回帰テスト。
 *
 * v3-r4 の死因: for-local-llm 系の 1次レビューは ai-antipattern-review-1st.md
 * を書くのに、共有 facet の arbitrate.md が後段 reviewers の成果物である
 * ai-antipattern-review.md を参照していた。{report:} は存在チェックなしの
 * 単純パス置換のため、裁定エージェントが実在しないレポートを探して詰み、
 * ルール不一致で fail-fast abort した（71分・iteration 6）。
 */
import { describe, expect, it, vi } from 'vitest';

const languageState = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    if (key === 'enableBuiltinWorkflows') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinWorkflows') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
}));

import { loadWorkflow } from '../infra/config/loaders/workflowLoader.js';

const REPORT_REFERENCE_PATTERN = /\{report:([^}]+)\}/g;

function extractReportReferences(instruction: string | undefined): string[] {
  if (!instruction) return [];
  return [...instruction.matchAll(REPORT_REFERENCE_PATTERN)]
    .map((match) => (match[1] ?? '').trim())
    .filter((name) => name.length > 0);
}

/** 1次レビューが ai-antipattern-review-1st.md を書く系譜（-1st 参照が正）。 */
const FIRST_SUFFIX_WORKFLOWS = [
  'takt-default-for-local-llm',
  'backend-for-local-llm',
  'backend-cqrs-for-local-llm',
  'frontend-for-local-llm',
  'dual-for-local-llm',
] as const;

/** 1次レビューが ai-antipattern-review.md を書く系譜（従来参照のまま）。 */
const PLAIN_NAME_WORKFLOWS = [
  'takt-default-refresh-all',
  'takt-default-refresh-fast',
  'backend',
  'backend-cqrs',
  'backend-maintenance',
  'dual',
  'dual-cqrs',
  'frontend',
  'frontend-maintenance',
  'draft',
] as const;

const ALL_ARBITRATE_WORKFLOWS = [...FIRST_SUFFIX_WORKFLOWS, ...PLAIN_NAME_WORKFLOWS];

describe.each(['ja', 'en'] as const)('arbitrate report references (%s)', (lang) => {
  it.each(ALL_ARBITRATE_WORKFLOWS)(
    '%s: 裁定ステップと antipattern ループ監視 judge の {report:X} は 1次レビューの output contract 名を指す',
    (name) => {
      languageState.value = lang;
      const workflow = loadWorkflow(name, process.cwd());
      expect(workflow).toBeDefined();

      const firstReview = workflow!.steps.find((step) => step.name === 'ai-antipattern-review-1st');
      expect(firstReview).toBeDefined();
      const contractNames = new Set((firstReview!.outputContracts ?? []).map((contract) => contract.name));
      expect(contractNames.size).toBeGreaterThan(0);

      const arbitrateStep = workflow!.steps.find((step) => step.name === 'ai-antipattern-no-fix');
      expect(arbitrateStep).toBeDefined();
      const references = extractReportReferences(arbitrateStep!.instruction);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(contractNames.has(reference)).toBe(true);
      }

      // antipattern サイクルを見ている judge も、その時点で存在するレポート
      // （= 1次レビューの成果物）だけを参照する。
      const antipatternMonitors = (workflow!.loopMonitors ?? []).filter((monitor) => (
        monitor.cycle.some((step) => step.startsWith('ai-antipattern'))
      ));
      expect(antipatternMonitors.length).toBeGreaterThan(0);
      for (const monitor of antipatternMonitors) {
        const judgeReferences = extractReportReferences(monitor.judge.instruction);
        expect(judgeReferences.length).toBeGreaterThan(0);
        for (const reference of judgeReferences) {
          expect(contractNames.has(reference)).toBe(true);
        }
      }
    },
  );

  it.each(FIRST_SUFFIX_WORKFLOWS)(
    '%s: 1次レビューは ai-antipattern-review-1st.md を書き、裁定はそれを参照する（v3-r4 回帰）',
    (name) => {
      languageState.value = lang;
      const workflow = loadWorkflow(name, process.cwd());
      const firstReview = workflow!.steps.find((step) => step.name === 'ai-antipattern-review-1st');
      const contractNames = (firstReview!.outputContracts ?? []).map((contract) => contract.name);
      expect(contractNames).toContain('ai-antipattern-review-1st.md');

      const arbitrateStep = workflow!.steps.find((step) => step.name === 'ai-antipattern-no-fix');
      expect(extractReportReferences(arbitrateStep!.instruction)).toContain('ai-antipattern-review-1st.md');
      // 後段 reviewers の成果物（裁定時点では存在しない）を参照しない。
      expect(extractReportReferences(arbitrateStep!.instruction)).not.toContain('ai-antipattern-review.md');
    },
  );
});
