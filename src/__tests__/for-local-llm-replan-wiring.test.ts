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

const DEV_WORKFLOWS = [
  'takt-default-for-local-llm',
  'backend-for-local-llm',
  'backend-cqrs-for-local-llm',
  'frontend-for-local-llm',
  'dual-for-local-llm',
] as const;

describe.each(['ja', 'en'] as const)('for-local-llm replan wiring (%s)', (lang) => {
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
    const replanMonitor = monitors.find((monitor) => monitor.cycle.includes('plan'));
    expect(replanMonitor).toBeDefined();
    expect(replanMonitor!.cycle).toEqual(['plan', 'write_tests', 'implement', 'reviewers', 'fix']);
    const replanNexts = replanMonitor!.judge!.rules.map((rule) => rule.next);
    // fix 完了の横取り防止（先頭で reviewers へ返す）、ABORT は最後の手段
    expect(replanNexts[0]).toBe('reviewers');
    expect(replanNexts).toContain('plan');
    expect(replanNexts[replanNexts.length - 1]).toBe('ABORT');

    for (const monitor of monitors.filter((m) => !m.cycle.includes('plan'))) {
      const nexts = monitor.judge!.rules.map((rule) => rule.next);
      expect(nexts).toContain('plan');
      expect(nexts[nexts.length - 1]).toBe('ABORT');
    }
  });
});
