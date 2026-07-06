/**
 * for-local-llm 系譜の「再計画優先」配線の回帰テスト。
 *
 * 実 builtin をロードし、状態機械の遷移先を検証する:
 * - fix の行き詰まりは ABORT ではなく plan に戻る
 * - 再計画サイクル監視の judge は「fix 完了 → reviewers」を最優先に持つ
 * - 旧 reviewers/fix 監視の judge も ABORT の前に plan の選択肢を持つ
 */
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../infra/config/loaders/workflowLoader.js';

const DEV_WORKFLOWS = [
  'takt-default-for-local-llm',
  'backend-for-local-llm',
  'backend-cqrs-for-local-llm',
  'frontend-for-local-llm',
  'dual-for-local-llm',
] as const;

describe.each(['ja', 'en'] as const)('for-local-llm replan wiring (%s)', (lang) => {
  it.each(DEV_WORKFLOWS)('%s: fix dead ends route to plan, judges prefer replan over abort', (name) => {
    const workflow = loadWorkflow(name, process.cwd(), { language: lang });
    expect(workflow).toBeDefined();

    const fix = workflow!.steps.find((step) => step.name === 'fix');
    expect(fix).toBeDefined();
    const fixNexts = (fix!.rules ?? []).map((rule) => rule.next);
    expect(fixNexts).toContain('plan');
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
