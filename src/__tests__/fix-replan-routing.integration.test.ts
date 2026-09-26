import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', { spy: true });
vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/workflow/phase-runner.js')>(),
  runStatusJudgmentPhase: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import type { WorkflowEvents } from '../core/workflow/types.js';
import { saveGlobalConfig } from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import { getScenarioQueue, resetScenario, setMockScenario } from '../infra/mock/index.js';
import { cleanupWorkflowEngine, createTestTmpDir } from './engine-test-helpers.js';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const languages = ['ja', 'en'] as const;
const originalPlan = 'Accepted contract: preserve the public API. Initial plan: inspect the failed boundary.';
const revisedPlan = 'Accepted contract: preserve the public API. Revised plan: reproduce the boundary failure and verify the repair.';
const blockedFix = 'The planned repair cannot proceed: the boundary assumption is invalid.';
const invalidVerification = 'plan_invalid: the plan omits the state transition at the boundary.';
let directory: string;
let engine: WorkflowEngine | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runStatusJudgmentPhase).mockReset();
  directory = createTestTmpDir();
});

afterEach(() => {
  if (engine) cleanupWorkflowEngine(engine);
  engine = undefined;
  resetScenario();
  rmSync(directory, { recursive: true, force: true });
});

function load(language: 'ja' | 'en'): WorkflowConfig {
  saveGlobalConfig({ language, provider: 'mock', autoFetch: false });
  const resourceRoot = resolve(repoRoot, 'builtins', language);
  return loadWorkflowFromFile(
    resolve(resourceRoot, 'workflows', 'development-remediation.yaml'),
    directory,
    { resourceRoot },
  );
}

function start(config: WorkflowConfig, language: 'ja' | 'en', initialStep: string) {
  engine = new WorkflowEngine({ ...config, initialStep }, directory, 'Complete required work without losing the accepted contract', {
    projectCwd: directory,
    provider: 'mock',
    language,
    reportDirName: 'reports',
  });
  const abort = vi.fn<WorkflowEvents['workflow:abort']>();
  const started = vi.fn<WorkflowEvents['step:start']>();
  engine.on('workflow:abort', abort);
  engine.on('step:start', started);
  return { engine, abort, started };
}

function queueScenario(config: WorkflowConfig, steps: readonly { name: string; ruleIndex: number; report: string }[]) {
  setMockScenario(steps.flatMap(({ name, ruleIndex, report }) => {
    const rule = config.steps.find(step => step.name === name)?.rules?.[ruleIndex];
    if (rule?.condition.kind !== 'semantic') throw new Error(`Missing semantic rule for ${name}`);
    vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label: rule.condition.label, method: 'phase3_tag' });
    return [
      { status: 'done' as const, content: `Executed ${name}: ${report}` },
      { status: 'done' as const, content: report },
    ];
  }));
}

function phase1Prompt(callIndex: number): string {
  const call = vi.mocked(runAgent).mock.calls[callIndex * 2];
  if (!call) throw new Error(`Missing real runner call for step ${callIndex}`);
  expect(call[2]?.resolvedProvider).toBe('mock');
  return call[1];
}

describe('fix-replan routes through the shipped WorkflowEngine graph with the mock provider', () => {
  it.each(languages)('%s: fix returns through fix-replan to fix with the previous reports retained', async (language) => {
    const config = load(language);
    const { engine, abort, started } = start(config, language, 'fix-plan');
    queueScenario(config, [
      { name: 'fix-plan', ruleIndex: 0, report: originalPlan },
      { name: 'fix', ruleIndex: 1, report: blockedFix },
      { name: 'fix-replan', ruleIndex: 0, report: revisedPlan },
      { name: 'fix', ruleIndex: 0, report: 'Boundary repair completed.' },
      { name: 'fix-verifier', ruleIndex: 0, report: 'verified' },
    ]);

    const state = await engine.run();

    expect(abort.mock.calls.map(call => call.slice(1))).toEqual([]);
    expect(state.status).toBe('completed');
    expect(started.mock.calls.map(([step]) => step.name)).toEqual(['fix-plan', 'fix', 'fix-replan', 'fix', 'fix-verifier']);
    expect(phase1Prompt(1)).toContain(originalPlan);
    expect(phase1Prompt(2)).toContain(originalPlan);
    expect(phase1Prompt(2)).toContain(blockedFix);
    expect(phase1Prompt(3)).toContain(revisedPlan);
    expect(readFileSync(resolve(directory, '.takt/runs/reports/reports/fix-plan.md'), 'utf8')).toContain(revisedPlan);
    expect(runAgent).toHaveBeenCalledTimes(10);
    expect(getScenarioQueue()?.remaining).toBe(0);
  });

  it.each(languages)('%s: verifier plan_invalid returns through fix-replan to fix with verification evidence', async (language) => {
    const config = load(language);
    const { engine, abort, started } = start(config, language, 'fix-plan');
    queueScenario(config, [
      { name: 'fix-plan', ruleIndex: 0, report: originalPlan },
      { name: 'fix', ruleIndex: 0, report: 'Initial repair completed but the boundary remains unverified.' },
      { name: 'fix-verifier', ruleIndex: 1, report: invalidVerification },
      { name: 'fix-replan', ruleIndex: 0, report: revisedPlan },
      { name: 'fix', ruleIndex: 0, report: 'Revised repair completed with boundary evidence.' },
      { name: 'fix-verifier', ruleIndex: 0, report: 'verified' },
    ]);

    const state = await engine.run();

    expect(abort.mock.calls.map(call => call.slice(1))).toEqual([]);
    expect(state.status).toBe('completed');
    expect(started.mock.calls.map(([step]) => step.name)).toEqual(['fix-plan', 'fix', 'fix-verifier', 'fix-replan', 'fix', 'fix-verifier']);
    expect(phase1Prompt(3)).toContain(originalPlan);
    expect(phase1Prompt(3)).toContain('Initial repair completed but the boundary remains unverified.');
    expect(phase1Prompt(3)).toContain(invalidVerification);
    expect(phase1Prompt(4)).toContain(revisedPlan);
    expect(runAgent).toHaveBeenCalledTimes(12);
    expect(getScenarioQueue()?.remaining).toBe(0);
  });

  describe.each(languages)('%s: fix-replan terminal routes', (language) => {
    it('returns need_replan when the accepted contract must change', async () => {
      const config = load(language);
      const { engine, abort } = start(config, language, 'fix-replan');
      queueScenario(config, [{ name: 'fix-replan', ruleIndex: 1, report: 'The accepted contract requires a project-wide change.' }]);

      const state = await engine.run();

      expect(abort.mock.calls.map(call => call.slice(1))).toEqual([]);
      expect(state).toMatchObject({ status: 'completed', returnValue: 'need_replan' });
      expect(getScenarioQueue()?.remaining).toBe(0);
    });

    it('aborts by the selected terminal rule rather than a provider failure', async () => {
      const config = load(language);
      const { engine, abort } = start(config, language, 'fix-replan');
      queueScenario(config, [{ name: 'fix-replan', ruleIndex: 2, report: 'No feasible project-local work remains.' }]);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abort).toHaveBeenCalledOnce();
      expect(abort.mock.calls[0]?.[3]).toMatchObject({ kind: 'step_transition', step: 'fix-replan' });
      expect(getScenarioQueue()?.remaining).toBe(0);
    });
  });
});
