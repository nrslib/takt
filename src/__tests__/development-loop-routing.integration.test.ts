import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
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

describe('shipped development continuation routes', () => {
  it.each(variants(implementations))('$language/$name composes the instruction for its continuation route', ({ language, name }) => {
    const implementation = load(language, name).steps.find(step => step.name === 'implement');
    expect(implementation?.instructionRef).toContain('development-implementation-continuation');
  });

  it.each(variants(['simple', 'simple-core', 'simple-mini', 'mini-core']))('$language/$name does not inherit a continuation instruction without its route', ({ language, name }) => {
    const implementation = load(language, name).steps.find(step => step.name === 'implement');
    expect(implementation).toBeDefined();
    expect(implementation?.instructionRef).not.toContain('development-implementation-continuation');
  });

  it.each(variants(implementations))('$language/$name continues unfinished valid work before completing', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    const pending = await execute(config, 'implement', 2);
    expect(pending.nextStep).toBe('implement');
    expect(pending.isComplete).toBe(false);
    expect(pending.returnValue).toBeUndefined();
    const done = await execute(config, 'implement', 0);
    expect(done.nextStep).toBe('COMPLETE');
    expect(done.isComplete).toBe(true);
  });

  it.each(variants(implementations))('$language/$name returns only an invalid plan to its caller', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    expect((await execute(config, 'implement', 3)).returnValue).toBe('need_replan');
  });

  it.each(variants(implementations))('$language/$name stops work requiring unavailable external action', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    const result = await execute(config, 'implement', 4);
    expect(result.nextStep).toBe('ABORT');
    expect(result.isComplete).toBe(true);
    expect(result.returnValue).toBeUndefined();
  });

  it.each(variants(implementations))('$language/$name collects an available user answer and resumes implementation', async ({ language, name }) => {
    const config = load(language, name);
    const implementation = config.steps.find(step => step.name === 'implement');
    if (!implementation) throw new Error('Missing implementation step');
    expect(determineRuleTransition(implementation, 5)).toMatchObject({ nextStep: 'implement', requiresUserInput: true });
    const onUserInput = vi.fn().mockResolvedValueOnce('Use the requested export target.');
    start(config, 'implement', { interactive: true, onUserInput });
    const waiting = await execute(config, 'implement', 5);
    expect(waiting).toMatchObject({ nextStep: 'implement', isComplete: false });
    expect(waiting.returnValue).toBeUndefined();
    expect(onUserInput).toHaveBeenCalledOnce();
    expect((await execute(config, 'implement', 0)).nextStep).toBe('COMPLETE');
  });

  it.each(variants(implementations))('$language/$name stops without requesting input when interactive mode is unavailable', async ({ language, name }) => {
    const config = load(language, name);
    const onUserInput = vi.fn();
    start(config, 'implement', { interactive: false, onUserInput });
    const result = await execute(config, 'implement', 4);
    expect(result).toMatchObject({ nextStep: 'ABORT', isComplete: true });
    expect(result.returnValue).toBeUndefined();
    expect(onUserInput).not.toHaveBeenCalled();
  });

  it.each(variants(remediations))('$language/$name investigates locally and resumes the same repair plan', async ({ language, name }) => {
    const config = load(language, name);
    const investigation = config.steps.find(step => step.name === 'investigate');
    expect(investigation).toMatchObject({ edit: true });
    start(config, 'fix-plan');
    const pending = await execute(config, 'fix-plan', 1);
    expect(pending.nextStep).toBe('investigate');
    expect(pending.returnValue).toBeUndefined();
    expect((await execute(config, 'investigate', 0)).nextStep).toBe('fix-plan');
    expect((await execute(config, 'fix-plan', 0)).nextStep).toBe('fix');
  });

  it.each(variants(remediations))('$language/$name returns a task-wide plan defect to its caller', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    expect(await execute(config, 'fix-plan', 2)).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
  });

  it.each(variants(remediations).flatMap(variant => ['fix-plan', 'investigate'].map(stepName => ({ ...variant, stepName }))))('$language/$name/$stepName stops at a confirmed external blocker', async ({ language, name, stepName }) => {
    const config = load(language, name);
    start(config, stepName);
    const result = await execute(config, stepName, stepName === 'fix-plan' ? 3 : 1);
    expect(result).toMatchObject({ nextStep: 'ABORT', isComplete: true });
    expect(result.returnValue).toBeUndefined();
  });

  it.each(variants(remediations))('$language/$name monitors repeated local investigations without overriding an exit', ({ language, name }) => {
    const config = load(language, name);
    const detector = new CycleDetector(config.loopMonitors);
    for (let cycle = 1; cycle <= 4; cycle++) {
      expect(detector.recordAndCheck('fix-plan', 'investigate').triggered).toBe(false);
      const result = detector.recordAndCheck('investigate', 'fix-plan');
      expect(result.triggered).toBe(cycle === 4);
      if (result.triggered) {
        expect(result.monitor?.judge.rules.map(rule => rule.next)).toEqual(['fix-plan', 'ABORT']);
      }
    }
    expect(detector.recordAndCheck('fix-plan', 'fix').triggered).toBe(false);
  });

});
