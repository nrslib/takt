import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

const recordWorkflowSpanOutcome = vi.hoisted(() => vi.fn());
const mockApplyRuntimeEnvironment = vi.hoisted(() => vi.fn());

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../core/workflow/engine/WorkflowEngineSetup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/engine/WorkflowEngineSetup.js')>();
  return {
    ...actual,
    applyRuntimeEnvironment: mockApplyRuntimeEnvironment,
  };
});

vi.mock('../core/workflow/observability/workflowSpans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/observability/workflowSpans.js')>();
  return {
    ...actual,
    runWithWorkflowSpan: vi.fn(async (
      _params: unknown,
      execute: () => Promise<unknown>,
      getOutcome: (result: unknown) => Record<string, unknown>,
      getErrorOutcome?: (error: unknown) => Record<string, unknown>,
    ) => {
      try {
        const result = await execute();
        recordWorkflowSpanOutcome(getOutcome(result));
        return result;
      } catch (error) {
        if (getErrorOutcome) {
          recordWorkflowSpanOutcome(getErrorOutcome(error));
        }
        throw error;
      }
    }),
  };
});

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import {
  applyDefaultMocks,
  buildDefaultWorkflowConfig,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
  mockRunAgentSequence,
} from './engine-test-helpers.js';

describe('WorkflowEngine workflow span outcome', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyRuntimeEnvironment.mockImplementation(() => undefined);
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Given a step error, When runSingleIteration aborts, Then root workflow span outcome includes failure metadata', async () => {
    const config = buildDefaultWorkflowConfig({
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('continue', 'COMPLETE')],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
    mockRunAgentSequence([
      makeResponse({
        persona: 'plan',
        status: 'error',
        content: 'failed',
        error: 'request failed',
      }),
    ]);

    await engine.runSingleIteration();

    expect(recordWorkflowSpanOutcome).toHaveBeenCalledWith({
      status: 'aborted',
      abortKind: 'step_error',
      abortReason: 'Step "plan" failed: request failed',
      failure: {
        kind: 'step_error',
        step: 'plan',
        reason: 'Step "plan" failed: request failed',
      },
      nextStep: 'ABORT',
      iterations: 1,
    });
  });

  it('Given a single iteration runtime error, When runSingleIteration rejects, Then root workflow span outcome includes failure metadata', async () => {
    const config = buildDefaultWorkflowConfig({
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('continue', 'COMPLETE')],
        }),
      ],
    });
    mockApplyRuntimeEnvironment.mockImplementation((...args: unknown[]) => {
      const stage = args[2];
      if (stage === 'step') {
        throw new Error('prepare failed');
      }
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    await expect(engine.runSingleIteration()).rejects.toThrow('prepare failed');

    expect(recordWorkflowSpanOutcome).toHaveBeenCalledWith({
      status: 'error',
      abortKind: 'runtime_error',
      abortReason: 'Step execution failed: prepare failed',
      failure: {
        kind: 'runtime_error',
        step: 'plan',
        reason: 'Step execution failed: prepare failed',
      },
      iterations: 0,
    });
  });

  it('Given a step error, When run aborts, Then root workflow span outcome includes failure metadata', async () => {
    const config = buildDefaultWorkflowConfig({
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('continue', 'COMPLETE')],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
    mockRunAgentSequence([
      makeResponse({
        persona: 'plan',
        status: 'error',
        content: 'failed',
        error: 'request failed',
      }),
    ]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(recordWorkflowSpanOutcome).toHaveBeenCalledWith({
      status: 'aborted',
      abortKind: 'step_error',
      abortReason: 'Step "plan" failed: request failed',
      failure: {
        kind: 'step_error',
        step: 'plan',
        reason: 'Step "plan" failed: request failed',
      },
      iterations: 1,
    });
  });

  it('Given a full workflow runtime error, When run rejects, Then root workflow span outcome includes failure metadata', async () => {
    const config = buildDefaultWorkflowConfig({
      initialStep: 'plan',
      maxSteps: 0,
      steps: [
        makeStep('plan', {
          rules: [makeRule('continue', 'COMPLETE')],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit: async () => {
        throw new Error('limit handler failed');
      },
    });

    await expect(engine.run()).rejects.toThrow('limit handler failed');

    expect(recordWorkflowSpanOutcome).toHaveBeenCalledWith({
      status: 'error',
      abortKind: 'runtime_error',
      abortReason: 'Step execution failed: limit handler failed',
      failure: {
        kind: 'runtime_error',
        step: 'plan',
        reason: 'Step execution failed: limit handler failed',
      },
      iterations: 0,
    });
  });
});
