import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import type { StatusJudgmentPhaseContext } from '../core/workflow/phase-runner.js';
import { makeRule, makeStep } from './test-helpers.js';

const mockRunStatusJudgmentPhase = vi.hoisted(() => vi.fn());

vi.mock('../core/workflow/phase-runner.js', () => ({
  runStatusJudgmentPhase: mockRunStatusJudgmentPhase,
}));

import { SystemStepExecutor } from '../core/workflow/engine/SystemStepExecutor.js';

function createState(): WorkflowState {
  return {
    workflowName: 'system-step-rule-resolution',
    currentStep: 'route',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

describe('SystemStepExecutor rule resolution', () => {
  const getStatusJudgmentContext = vi.fn((): StatusJudgmentPhaseContext => {
    throw new Error('provider resolution must not run');
  });
  const executor = new SystemStepExecutor({
    task: 'route system workflow',
    projectCwd: '/project',
    getCwd: () => '/project',
    getRuleContext: () => ({ interactive: false }),
    getStatusJudgmentContext,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunStatusJudgmentPhase.mockResolvedValue({ label: 'approved', method: 'auto_select' });
  });

  it.each([
    ['machine-only rules', [makeRule('when(true)', 'COMPLETE')]],
    ['a preceding matching machine rule', [
      makeRule('when(true)', 'COMPLETE'),
      makeRule('approved', 'COMPLETE'),
    ]],
  ])('should not resolve a provider context for %s', async (_case, rules) => {
    const response = await executor.run(makeStep({ name: 'route', rules }), createState());

    expect(response).toMatchObject({ matchedRuleIndex: 0, matchedRuleMethod: 'auto_select' });
    expect(getStatusJudgmentContext).not.toHaveBeenCalled();
    expect(mockRunStatusJudgmentPhase).not.toHaveBeenCalled();
  });

  it('should auto-select a single semantic candidate when provider resolution would fail', async () => {
    const step = makeStep({ name: 'route', rules: [makeRule('approved', 'COMPLETE')] });

    const response = await executor.run(step, createState());

    expect(response).toMatchObject({ matchedRuleIndex: 0, matchedRuleMethod: 'auto_select' });
    expect(getStatusJudgmentContext).not.toHaveBeenCalled();
    expect(mockRunStatusJudgmentPhase).not.toHaveBeenCalled();
  });

  it('should use getCwd for system input services', async () => {
    const getCwd = vi.fn(() => '/execution');
    const resolveSystemInput = vi.fn(() => ({ exists: true }));
    const systemStepServicesFactory = vi.fn(() => ({
      resolveSystemInput,
      executeEffect: vi.fn(),
    }));
    const inputExecutor = new SystemStepExecutor({
      task: 'resolve system input',
      projectCwd: '/project',
      getCwd,
      getRuleContext: () => ({ interactive: false }),
      getStatusJudgmentContext,
      systemStepServicesFactory,
    });
    const step = makeStep({
      name: 'route',
      kind: 'system',
      systemInputs: [{ type: 'task_context', source: 'current_task', as: 'task' }],
      rules: [makeRule('when(true)', 'COMPLETE')],
    });
    const state = createState();

    await inputExecutor.run(step, state);

    expect(getCwd).toHaveBeenCalledOnce();
    expect(systemStepServicesFactory).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/execution',
      projectCwd: '/project',
    }));
    expect(resolveSystemInput).toHaveBeenCalledOnce();
    expect(state.systemContexts.get('route')).toEqual({ task: { exists: true } });
  });

  it('should store __proto__ system input aliases as own bindings without changing the context prototype', async () => {
    const resolvedInput = { exists: true };
    const aliasExecutor = new SystemStepExecutor({
      task: 'resolve system input alias',
      projectCwd: '/project',
      getCwd: () => '/project',
      getRuleContext: () => ({ interactive: false }),
      getStatusJudgmentContext,
      systemStepServicesFactory: () => ({
        resolveSystemInput: () => resolvedInput,
        executeEffect: vi.fn(),
      }),
    });
    const step = makeStep({
      name: 'route',
      kind: 'system',
      systemInputs: [{ type: 'task_context', source: 'current_task', as: '__proto__' }],
      rules: [makeRule('when(true)', 'COMPLETE')],
    });
    const state = createState();

    await aliasExecutor.run(step, state);

    const context = state.systemContexts.get('route');
    expect(context).toBeDefined();
    expect(Object.getPrototypeOf(context)).toBeNull();
    expect(Object.hasOwn(context!, '__proto__')).toBe(true);
    expect(context!['__proto__']).toBe(resolvedInput);
  });

  it('should use getCwd for effect services', async () => {
    const getCwd = vi.fn(() => '/execution');
    const systemStepServicesFactory = vi.fn(() => ({
      resolveSystemInput: vi.fn(),
      executeEffect: vi.fn().mockResolvedValue({ merged: true }),
    }));
    const effectExecutor = new SystemStepExecutor({
      task: 'run system effect',
      projectCwd: '/project',
      getCwd,
      getRuleContext: () => ({ interactive: false }),
      getStatusJudgmentContext,
      systemStepServicesFactory,
    });
    const step = makeStep({
      name: 'route',
      kind: 'system',
      effects: [{ type: 'merge_pr', pr: 42 }],
      rules: [makeRule('when(true)', 'COMPLETE')],
    });

    await effectExecutor.run(step, createState());

    expect(getCwd).toHaveBeenCalledOnce();
    expect(systemStepServicesFactory).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/execution',
      projectCwd: '/project',
    }));
  });
});
