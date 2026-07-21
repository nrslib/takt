/**
 * for-local-llm 系譜の「再計画優先」配線の回帰テスト。
 *
 * 実 builtin をロードし、状態機械の遷移先を検証する:
 * - fix の行き詰まりは ABORT ではなく plan に戻る
 * - 再計画サイクル監視の judge は「fix 完了 → reviewers」を最優先に持つ
 * - 旧 reviewers/fix 監視の judge も ABORT の前に plan の選択肢を持つ
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
import { createPartStep } from '../core/workflow/engine/team-leader-common.js';

const DEV_WORKFLOWS = [
  'takt-default-for-local-llm',
  'backend-for-local-llm',
  'backend-cqrs-for-local-llm',
  'frontend-for-local-llm',
  'dual-for-local-llm',
] as const;

describe.each(['ja', 'en'] as const)('for-local-llm replan wiring (%s)', (lang) => {
  it('should route implementation work through a sequential Team Leader with isolated member sessions', () => {
    languageState.value = lang;
    const workflow = loadWorkflow('takt-default-for-local-llm', process.cwd());

    for (const name of ['implement', 'ai-antipattern-fix', 'fix']) {
      const step = workflow!.steps.find((candidate) => candidate.name === name);
      expect(step?.tags).toEqual(['leader']);
      expect(step?.teamLeader).toEqual(expect.objectContaining({
        initialMaxParts: 1,
        maxConcurrency: 1,
        maxTotalParts: 6,
        partTags: ['coding'],
        failOnPartError: false,
      }));
      const member = createPartStep(step!, {
        id: 'member-1',
        title: 'member',
        instruction: 'implement assigned work',
      });
      expect(member.tags).toEqual(['coding']);
      expect(member.session).toBe('refresh');
    }
    expect(workflow!.steps.find((step) => step.name === 'implement')?.passPreviousResponse).toBe(true);
    expect(workflow!.steps.find((step) => step.name === 'ai-antipattern-fix')?.passPreviousResponse).toBe(true);
  });

  it.each(DEV_WORKFLOWS)('should route fix dead ends to plan and keep abort as the last resort when %s is loaded', (name) => {
    languageState.value = lang;
    const workflow = loadWorkflow(name, process.cwd());
    expect(workflow).toBeDefined();

    const fix = workflow!.steps.find((step) => step.name === 'fix');
    expect(fix).toBeDefined();
    // 言語切替が実際に効いている証明: 条件文言が言語ごとに異なる
    const planRule = (fix!.rules ?? []).find((rule) => rule.next === 'plan');
    expect(planRule).toBeDefined();
    expect(planRule!.condition).toBe(lang === 'ja'
      ? '修正を進められない、または人間の判断が必要'
      : 'Cannot proceed with fixes, or human judgment is required');
    const fixNexts = (fix!.rules ?? []).map((rule) => rule.next);
    expect(fixNexts).not.toContain('ABORT');

    const monitors = workflow!.loopMonitors ?? [];
    expect(monitors.map((monitor) => monitor.cycle)).toContainEqual([
      'reviewers',
      'final-gate',
      'fix',
    ]);
    const replanMonitor = monitors.find((monitor) => monitor.cycle.includes('plan'));
    expect(replanMonitor).toBeDefined();
    expect(replanMonitor!.cycle).toEqual(['plan', 'write_tests', 'implement', 'reviewers', 'fix']);
    const replanNexts = replanMonitor!.judge!.rules.map((rule) => rule.next);
    // fix 完了の横取り防止（先頭で reviewers へ返す）、ABORT は最後の手段
    expect(replanNexts[0]).toBe('reviewers');
    expect(replanNexts).toContain('plan');
    expect(replanNexts[replanNexts.length - 1]).toBe('ABORT');

    // ai-antipattern-review-1st ⇄ ai-antipattern-fix は行き詰まっても reviewers へ委ねる設計。
    // ここは実装直後の自己レビューに過ぎず、plan への再計画や ABORT は
    // 下流の reviewers/fix・reviewers/final-gate/fix 監視が最終的に担うため持たない。
    const antipatternMonitor = monitors.find((monitor) => monitor.cycle.includes('ai-antipattern-review-1st'));
    expect(antipatternMonitor).toBeDefined();
    const antipatternNexts = antipatternMonitor!.judge!.rules.map((rule) => rule.next);
    expect(antipatternNexts).toEqual(['ai-antipattern-review-1st', 'reviewers']);

    // ai-antipattern-fix ⇄ ai-antipattern-no-fix の相互遷移（fix の rules に
    // next: ai-antipattern-no-fix が2本、no-fix の rules に next: ai-antipattern-fix
    // が1本）は実在する。この判定すれ違いが無監視だと max_steps まで回るため、
    // review-1st⇄fix と同じ threshold・judge 構成で監視する（PR #1017 CodeRabbit 指摘）。
    const arbitrationMonitor = monitors.find((monitor) => monitor.cycle.includes('ai-antipattern-no-fix'));
    expect(arbitrationMonitor).toBeDefined();
    expect(arbitrationMonitor!.cycle).toEqual(['ai-antipattern-fix', 'ai-antipattern-no-fix']);
    expect(arbitrationMonitor!.threshold).toBe(antipatternMonitor!.threshold);
    expect(arbitrationMonitor!.judge!.persona).toBe('supervisor');
    expect(arbitrationMonitor!.judge!.rules.map((rule) => rule.next)).toEqual(['ai-antipattern-review-1st', 'reviewers']);

    for (const monitor of monitors.filter((m) => !m.cycle.includes('plan') && !m.cycle.includes('ai-antipattern-review-1st') && !m.cycle.includes('ai-antipattern-no-fix'))) {
      const nexts = monitor.judge!.rules.map((rule) => rule.next);
      expect(nexts).toContain('plan');
      expect(nexts[nexts.length - 1]).toBe('ABORT');
    }
  });

  // 対策バッチ B1: provisional fixpoint（前ラウンドから意味的な変化が無い）に
  // 達したら plan への差し戻しではなく NEEDS_ADJUDICATION（要人手裁定の終端状態）
  // へルーティングする。fixpoint ルールは「変化のあるラウンドでは従来どおり
  // plan へ」の要請を満たすため、汎用の provisional.count ルールより前に
  // 置かれていなければならない（first-match-wins のルール評価順）。
  it.each(DEV_WORKFLOWS)('should route provisional fixpoint to NEEDS_ADJUDICATION before falling back to plan when %s is loaded', (name) => {
    languageState.value = lang;
    const workflow = loadWorkflow(name, process.cwd());
    expect(workflow).toBeDefined();
    const finalGate = loadWorkflow('merge-readiness-finding-contract-final-gate-for-local-llm', process.cwd());
    expect(finalGate).toBeDefined();

    for (const stepName of ['reviewers', 'merge-readiness-review', 'supervise']) {
      const source = stepName === 'reviewers' ? workflow! : finalGate!;
      const step = source.steps.find((candidate) => candidate.name === stepName);
      expect(step, `step "${stepName}" should exist`).toBeDefined();
      const rules = step!.rules ?? [];

      // 各ステップは review-integrity の anomaly ルールも持つ。supervise 自身の
      // Finding Contract 取込でも新しい anomaly が生じ得るため、MRR 後でも必要。
      // fixpoint ルールは condition で特定する。
      const fixpointRuleIndex = rules.findIndex((rule) => rule.next === 'NEEDS_ADJUDICATION' && rule.condition.includes('findings.provisional.fixpoint'));
      expect(fixpointRuleIndex, `step "${stepName}" should route fixpoint to NEEDS_ADJUDICATION`).toBeGreaterThanOrEqual(0);
      expect(rules[fixpointRuleIndex]!.condition).toContain('findings.provisional.fixpoint');

      const replanRuleIndex = rules.findIndex((rule) => (
        rule.next === 'plan' || rule.returnValue === 'need_replan'
      ) && rule.condition.includes('findings.provisional.count'));
      expect(replanRuleIndex, `step "${stepName}" should still route provisional.count to plan`).toBeGreaterThanOrEqual(0);

      // first-match-wins: fixpoint must be checked before the generic
      // provisional.count replan rule, or a fixpoint round would never reach
      // NEEDS_ADJUDICATION (it would keep matching the earlier plan rule).
      expect(fixpointRuleIndex).toBeLessThan(replanRuleIndex);
    }
  });

  // 有限停止予算（codex 裁定・対策バッチ B1 の拡張）: レビュアーが毎ラウンド
  // 別の架空 provisional を生成し続けると provisional 集合が churn し続け、
  // fixpoint が永久に成立しない。累積ラウンド数（または経過時間）が上限を
  // 超えたら、fixpoint 未成立でも同じ NEEDS_ADJUDICATION へルーティングする。
  // 優先順位は COMPLETE > fixpoint > budget > plan — budget ルールは fixpoint
  // ルールの直後、汎用の provisional.count ルールより前に置かれていなければ
  // ならない（first-match-wins のルール評価順）。
  it.each(DEV_WORKFLOWS)('should route the exhausted stop budget to NEEDS_ADJUDICATION after fixpoint but before falling back to plan when %s is loaded', (name) => {
    languageState.value = lang;
    const workflow = loadWorkflow(name, process.cwd());
    expect(workflow).toBeDefined();
    const finalGate = loadWorkflow('merge-readiness-finding-contract-final-gate-for-local-llm', process.cwd());
    expect(finalGate).toBeDefined();

    for (const stepName of ['reviewers', 'merge-readiness-review', 'supervise']) {
      const source = stepName === 'reviewers' ? workflow! : finalGate!;
      const step = source.steps.find((candidate) => candidate.name === stepName);
      expect(step, `step "${stepName}" should exist`).toBeDefined();
      const rules = step!.rules ?? [];

      const fixpointRuleIndex = rules.findIndex((rule) => rule.condition.includes('findings.provisional.fixpoint') && rule.next === 'NEEDS_ADJUDICATION');
      const budgetRuleIndex = rules.findIndex((rule) => rule.condition.includes('findings.rounds.budgetExhausted') && rule.next === 'NEEDS_ADJUDICATION');
      const replanRuleIndex = rules.findIndex((rule) => (
        rule.next === 'plan' || rule.returnValue === 'need_replan'
      ) && rule.condition.includes('findings.provisional.count'));

      expect(fixpointRuleIndex, `step "${stepName}" should route fixpoint to NEEDS_ADJUDICATION`).toBeGreaterThanOrEqual(0);
      expect(budgetRuleIndex, `step "${stepName}" should route the exhausted stop budget to NEEDS_ADJUDICATION`).toBeGreaterThanOrEqual(0);
      expect(replanRuleIndex, `step "${stepName}" should still route provisional.count to plan`).toBeGreaterThanOrEqual(0);

      // COMPLETE > fixpoint > budget > plan: budget is checked after fixpoint
      // (a round that reached fixpoint should report that reason, not budget)
      // and before the generic provisional.count replan rule (or a budget
      // round would never reach NEEDS_ADJUDICATION — it would keep matching
      // the earlier plan rule).
      expect(fixpointRuleIndex).toBeLessThan(budgetRuleIndex);
      expect(budgetRuleIndex).toBeLessThan(replanRuleIndex);
    }
  });

  // 既定のセッションキーは persona 由来（session-key.ts）のため、同じ persona
  // "ai-antipattern-reviewer" を使う ai-antipattern-review-1st と、並列
  // reviewers 配下の Finding Contract 版 ai-antipattern-review が同一セッションを
  // 共有してしまっていた（native StructuredOutput の成功履歴混線の原因）。
  // 明示的な session_key で切り離したことを固定する。
  it.each(DEV_WORKFLOWS)('should isolate ai-antipattern-review sessions from the -1st step when %s is loaded', (name) => {
    languageState.value = lang;
    const workflow = loadWorkflow(name, process.cwd());
    expect(workflow).toBeDefined();

    const firstPass = workflow!.steps.find((step) => step.name === 'ai-antipattern-review-1st');
    expect(firstPass).toBeDefined();
    expect(firstPass!.sessionKey).toBe('ai-antipattern-review-1st');

    const reviewers = workflow!.steps.find((step) => step.name === 'reviewers');
    expect(reviewers).toBeDefined();
    const findingContractReview = reviewers!.parallel?.find((step) => step.name === 'ai-antipattern-review');
    expect(findingContractReview).toBeDefined();
    expect(findingContractReview!.sessionKey).toBe('ai-antipattern-review-finding-contract');

    // 別々のキーである（同一セッションに退化していない）ことも明示する
    expect(findingContractReview!.sessionKey).not.toBe(firstPass!.sessionKey);
  });
});
