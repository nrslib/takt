import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { CycleDetector } from '../core/workflow/engine/cycle-detector.js';
import { determineRuleTransition } from '../core/workflow/engine/transitions.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import {
  cleanupWorkflowEngine, createTestTmpDir, makeResponse, makeStep, mockRunAgentSequence,
} from './engine-test-helpers.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const implementations = ['development-implement', 'development-implement-dynamic', 'development-implement-team'];
const remediations = ['development-remediation', 'development-remediation-dynamic', 'development-remediation-team', 'review-remediation'];
const variants = (names: string[]) => (['ja', 'en'] as const).flatMap(language => names.map(name => ({ language, name })));
let directory: string;
let engine: WorkflowEngine | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runReportPhase).mockResolvedValue(undefined);
  directory = createTestTmpDir();
});
afterEach(() => {
  if (engine) cleanupWorkflowEngine(engine);
  engine = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function load(language: string, name: string): WorkflowConfig {
  const resourceRoot = resolve(repoRoot, 'builtins', language);
  return loadWorkflowFromFile(resolve(resourceRoot, 'workflows', `${name}.yaml`), directory, { resourceRoot });
}

function start(config: WorkflowConfig, initialStep: string, options: Pick<WorkflowEngineOptions, 'interactive' | 'onUserInput'> = {}): void {
  // Keep the shipped graph and return contract; replace agent execution details only.
  engine = new WorkflowEngine({
    ...config,
    initialStep,
    steps: config.steps.map(step => makeStep(step.name, { rules: step.rules })),
  }, directory, 'Complete required work without losing the accepted contract', {
    projectCwd: directory,
    reportDirName: 'reports',
    ...options,
  });
}

async function execute(config: WorkflowConfig, stepName: string, ruleIndex: number) {
  const rule = config.steps.find(step => step.name === stepName)?.rules?.[ruleIndex];
  if (rule?.condition.kind !== 'semantic' || !engine) throw new Error('Missing semantic rule or engine');
  mockRunAgentSequence([makeResponse({ content: 'Recorded current work and remaining evidence.' })]);
  vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label: rule.condition.label, method: 'phase3_tag' });
  return engine.runSingleIteration();
}

describe('shipped development completion and remediation routes', () => {
  it.each(variants(implementations))('$language/$name sends executable incompleteness to reimplement once, then hands remaining gaps to planning', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    const pending = await execute(config, 'implement', 2);
    expect(pending.nextStep).toBe('reimplement');
    expect(pending.isComplete).toBe(false);
    expect(pending.returnValue).toBeUndefined();
    const remaining = await execute(config, 'reimplement', 2);
    expect(remaining).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
    expect(remaining.nextStep).toBe('COMPLETE');
    start(config, 'reimplement');
    expect((await execute(config, 'reimplement', 0)).nextStep).toBe('COMPLETE');
  });

  it.each(variants(implementations))('$language/$name returns only an invalid plan to its caller', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    expect((await execute(config, 'implement', 3)).returnValue).toBe('need_replan');
    start(config, 'reimplement');
    expect((await execute(config, 'reimplement', 3)).returnValue).toBe('need_replan');
  });

  it.each(variants(implementations))('$language/$name passes an external blocker to planning at either implementation step', async ({ language, name }) => {
    const config = load(language, name);
    for (const stepName of ['implement', 'reimplement']) {
      start(config, stepName);
      const result = await execute(config, stepName, 4);
      expect(result).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
      expect(result.nextStep).toBe('COMPLETE');
    }
  });

  it.each(variants(implementations))('$language/$name collects an available user answer and resumes the same implementation step', async ({ language, name }) => {
    const config = load(language, name);
    for (const stepName of ['implement', 'reimplement']) {
      const implementation = config.steps.find(step => step.name === stepName);
      if (!implementation) throw new Error(`Missing ${stepName} step`);
      expect(determineRuleTransition(implementation, 5)).toMatchObject({ nextStep: stepName, requiresUserInput: true });
      const onUserInput = vi.fn().mockResolvedValueOnce('Use the requested export target.');
      start(config, stepName, { interactive: true, onUserInput });
      const waiting = await execute(config, stepName, 5);
      expect(waiting).toMatchObject({ nextStep: stepName, isComplete: false });
      expect(waiting.returnValue).toBeUndefined();
      expect(onUserInput).toHaveBeenCalledOnce();
      expect((await execute(config, stepName, 0)).nextStep).toBe('COMPLETE');
    }
  });

  it.each(variants(implementations))('$language/$name passes a headless external blocker to planning without requesting input', async ({ language, name }) => {
    const config = load(language, name);
    for (const stepName of ['implement', 'reimplement']) {
      const onUserInput = vi.fn();
      start(config, stepName, { interactive: false, onUserInput });
      const result = await execute(config, stepName, 4);
      expect(result).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
      expect(result.nextStep).toBe('COMPLETE');
      expect(onUserInput).not.toHaveBeenCalled();
    }
  });

  it.each(variants(['development-core']))('$language routes implementation workflow results through the planning handoffs', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    expect((await execute(config, 'implement', 0)).nextStep).toBe('peer-review');
    start(config, 'implement');
    expect((await execute(config, 'implement', 1)).nextStep).toBe('replan');
    start(config, 'implement');
    expect((await execute(config, 'implement', 2)).nextStep).toBe('replan');
    start(config, 'replan');
    expect((await execute(config, 'replan', 0)).nextStep).toBe('implement');
    start(config, 'replan');
    expect((await execute(config, 'replan', 1)).nextStep).toBe('peer-review');
    start(config, 'replan');
    expect((await execute(config, 'replan', 2)).nextStep).toBe('ABORT');
  });

  it.each(['ja', 'en'] as const)('%s: loads scenario-based fix-replan through the dynamic remediation fragment', (language) => {
    const resourceRoot = resolve(repoRoot, 'builtins', language);
    const config = loadWorkflowFromFile(
      resolve(resourceRoot, 'workflows', 'development-remediation-dynamic.yaml'),
      directory,
      { resourceRoot, callableArgs: { fix_replan_instruction: 'scenario-based-fix-replan' } },
    );
    const step = config.steps.find(candidate => candidate.name === 'fix-replan');
    const scenario = readFileSync(resolve(resourceRoot, 'facets/partials/instructions/requirement-scenario-maintenance.md'), 'utf8').trim();
    expect(step).toBeDefined();
    expect(step?.instructionRef).toContain('scenario-based-fix-replan');
    expect(step?.instruction).toContain('{report:fix-verification.md}');
    expect(step?.instruction).toContain(scenario);
    expect(step?.instruction).not.toContain('{{include:');
  });

  it.each(variants(remediations))('$language/$name executes plan-scoped investigation in fix and preserves the repair path', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    const pending = await execute(config, 'fix-plan', 0);
    expect(pending.nextStep).toBe('fix');
    expect(pending.returnValue).toBeUndefined();
    expect((await execute(config, 'fix', 0)).nextStep).toBe('fix-verifier');
    expect((await execute(config, 'fix-verifier', 0)).nextStep).toBe('COMPLETE');
  });

  it.each(variants(remediations))('$language/$name returns a task-wide plan defect to its caller', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    expect(await execute(config, 'fix-plan', 1)).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
  });

  it.each(variants(remediations))('$language/$name stops at a confirmed external blocker', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    const result = await execute(config, 'fix-plan', 2);
    expect(result).toMatchObject({ nextStep: 'ABORT', isComplete: true });
    expect(result.returnValue).toBeUndefined();
  });

  it.each(variants(remediations))('$language/$name triggers its repair loop monitor on the fourth cycle', ({ language, name }) => {
    const config = load(language, name);
    const detector = new CycleDetector(config.loopMonitors);
    const planningStep = 'fix-replan';
    for (let cycle = 1; cycle <= 4; cycle++) {
      expect(detector.recordAndCheck(planningStep, 'fix').triggered).toBe(false);
      const result = detector.recordAndCheck('fix', planningStep);
      expect(result.triggered).toBe(cycle === 4);
    }
  });

});
