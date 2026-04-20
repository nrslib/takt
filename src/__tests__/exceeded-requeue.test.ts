/**
 * Integration tests for exceeded status and requeue flow
 *
 * Covers:
 * - WorkflowEngine: onIterationLimit returning null causes engine to stop (exceeded behavior)
 * - WorkflowEngine: onIterationLimit returning a number allows continuation
 * - WorkflowEngine: onIterationLimit receives correct request (currentStep, maxSteps, currentIteration)
 * - StateManager: initialIteration option sets the starting iteration counter
 * - WorkflowEngineOptions: initialIteration passed down to StateManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { WorkflowConfig } from '../core/models/index.js';

// --- Mock setup (must be before imports that use these modules) ---

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

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
  cleanupWorkflowEngine,
} from './engine-test-helpers.js';

// --- Tests ---

describe('WorkflowEngine: onIterationLimit - exceeded behavior', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = null;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should abort engine when onIterationLimit returns null (non-interactive mode)', async () => {
    // Given: a workflow with maxSteps=1 and onIterationLimit returning null.
    // plan → implement (not COMPLETE) so the limit check fires between plan and implement.
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 1,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeStep('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const onIterationLimit = vi.fn().mockResolvedValue(null);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });

    // When: engine runs and hits the iteration limit after plan
    const state = await engine.run();

    // Then: engine is aborted (plan ran → iteration=1 >= maxSteps=1, null returned)
    expect(state.status).toBe('aborted');
    expect(onIterationLimit).toHaveBeenCalledOnce();
  });

  it('should continue when onIterationLimit returns a positive number', async () => {
    // Given: a workflow with maxSteps=1 and onIterationLimit granting more iterations.
    // plan → implement so the limit fires between plan and implement.
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 1,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeStep('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    // onIterationLimit called once (at iteration=1), grants 5 more iterations → maxSteps=6
    const onIterationLimit = vi.fn().mockResolvedValueOnce(5);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
      { index: 0, method: 'phase1_tag' }, // implement → COMPLETE
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });

    // When: engine runs
    const state = await engine.run();

    // Then: engine completed because limit was extended (plan+limit check+implement → COMPLETE)
    expect(state.status).toBe('completed');
    expect(onIterationLimit).toHaveBeenCalledOnce();
  });

  it('should continue without calling onIterationLimit when iteration limit is ignored', async () => {
    // Given: a workflow that would normally exceed maxSteps between plan and implement.
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 1,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeStep('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const onIterationLimit = vi.fn().mockResolvedValue(null);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
      { index: 0, method: 'phase1_tag' }, // implement → COMPLETE
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
      ignoreIterationLimit: true,
    } as never);

    // When: engine runs with iteration-limit ignoring enabled
    const state = await engine.run();

    // Then: workflow completes and the limit callback is not used
    expect(state.status).toBe('completed');
    expect(onIterationLimit).not.toHaveBeenCalled();
  });

  it('should not emit iteration limit for infinite maxSteps even after exceeding a finite threshold', async () => {
    const config: WorkflowConfig = {
      name: 'infinite-complete',
      maxSteps: 'infinite',
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'review')],
        }),
        makeStep('review', {
          rules: [makeRule('done', 'fix')],
        }),
        makeStep('fix', {
          rules: [makeRule('done', 'verify')],
        }),
        makeStep('verify', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const onIterationLimit = vi.fn().mockResolvedValue(null);
    const limitEvents: Array<{ iteration: number; maxSteps: number }> = [];

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
      makeResponse({ persona: 'review', content: 'Review complete' }),
      makeResponse({ persona: 'fix', content: 'Fix complete' }),
      makeResponse({ persona: 'verify', content: 'Verify complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });
    engine.on('iteration:limit', (iteration, maxSteps) => {
      limitEvents.push({ iteration, maxSteps });
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(4);
    expect(onIterationLimit).not.toHaveBeenCalled();
    expect(limitEvents).toEqual([]);
  });

  it('should abort infinite maxSteps workflows only via workflow transition, not iteration limit', async () => {
    const config: WorkflowConfig = {
      name: 'infinite-abort',
      maxSteps: 'infinite',
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'review')],
        }),
        makeStep('review', {
          rules: [makeRule('done', 'stop')],
        }),
        makeStep('stop', {
          rules: [makeRule('done', 'ABORT')],
        }),
      ],
    };

    const onIterationLimit = vi.fn().mockResolvedValue(null);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
      makeResponse({ persona: 'review', content: 'Review complete' }),
      makeResponse({ persona: 'stop', content: 'Abort now' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(3);
    expect(onIterationLimit).not.toHaveBeenCalled();
  });

  it('should preserve non-iteration aborts when iteration limit is ignored', async () => {
    const loopConfig: WorkflowConfig = {
      name: 'loop-test',
      maxSteps: 1,
      loopDetection: { maxConsecutiveSameStep: 3, action: 'abort' },
      initialStep: 'loop-step',
      steps: [
        makeStep('loop-step', {
          rules: [makeRule('continue', 'loop-step')],
        }),
      ],
    };

    for (let i = 0; i < 5; i++) {
      vi.mocked(runAgent).mockImplementationOnce(async (persona, prompt, options) => {
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: prompt,
        });
        return makeResponse({ content: `iteration ${i}` });
      });
      mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);
    }

    const loopEngine = new WorkflowEngine(loopConfig, tmpDir, 'loop task', {
      projectCwd: tmpDir,
      ignoreIterationLimit: true,
    });
    const loopAbort = vi.fn();
    loopEngine.on('workflow:abort', loopAbort);

    const loopState = await loopEngine.run();

    expect(loopState.status).toBe('aborted');
    expect(loopAbort).toHaveBeenCalledOnce();
    expect(loopAbort.mock.calls[0]?.[1]).toContain('Loop detected');
    cleanupWorkflowEngine(loopEngine);

    const blockedConfig: WorkflowConfig = {
      name: 'blocked-test',
      maxSteps: 1,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    vi.mocked(runAgent).mockReset();
    mockRunAgentSequence([
      makeResponse({ persona: 'plan', status: 'blocked', content: 'Need clarification' }),
    ]);

    const blockedEngine = new WorkflowEngine(blockedConfig, tmpDir, 'blocked task', {
      projectCwd: tmpDir,
      ignoreIterationLimit: true,
    });
    const blockedAbort = vi.fn();
    blockedEngine.on('workflow:abort', blockedAbort);

    const blockedState = await blockedEngine.run();

    expect(blockedState.status).toBe('aborted');
    expect(blockedAbort).toHaveBeenCalledOnce();
    expect(blockedAbort.mock.calls[0]?.[1]).toContain('Workflow blocked');
    cleanupWorkflowEngine(blockedEngine);

    vi.mocked(runAgent).mockReset();
    mockRunAgentSequence([
      makeResponse({ persona: 'plan', status: 'error', content: 'Partial output', error: 'request failed' }),
    ]);

    const errorEngine = new WorkflowEngine(blockedConfig, tmpDir, 'error task', {
      projectCwd: tmpDir,
      ignoreIterationLimit: true,
    });
    const errorAbort = vi.fn();
    errorEngine.on('workflow:abort', errorAbort);

    const errorState = await errorEngine.run();

    expect(errorState.status).toBe('aborted');
    expect(errorAbort).toHaveBeenCalledOnce();
    expect(errorAbort.mock.calls[0]?.[1]).toContain('Step "plan" failed: request failed');
    cleanupWorkflowEngine(errorEngine);

    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('runtime exploded'));
    const runtimeEngine = new WorkflowEngine(blockedConfig, tmpDir, 'runtime task', {
      projectCwd: tmpDir,
      ignoreIterationLimit: true,
    });
    const runtimeAbort = vi.fn();
    runtimeEngine.on('workflow:abort', runtimeAbort);

    const runtimeState = await runtimeEngine.run();

    expect(runtimeState.status).toBe('aborted');
    expect(runtimeAbort).toHaveBeenCalledOnce();
    expect(runtimeAbort.mock.calls[0]?.[1]).toContain('Step execution failed: runtime exploded');
    cleanupWorkflowEngine(runtimeEngine);

    const interruptEngine = new WorkflowEngine(blockedConfig, tmpDir, 'interrupt task', {
      projectCwd: tmpDir,
      ignoreIterationLimit: true,
    });
    const interruptAbort = vi.fn();
    interruptEngine.on('workflow:abort', interruptAbort);
    interruptEngine.abort();

    const interruptState = await interruptEngine.run();

    expect(interruptState.status).toBe('aborted');
    expect(interruptAbort).toHaveBeenCalledOnce();
    expect(interruptAbort.mock.calls[0]?.[1]).toContain('SIGINT');
  });

  it('should pass correct request data to onIterationLimit', async () => {
    // Given: a workflow with maxSteps=1
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 1,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeStep('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const capturedRequest = { currentIteration: 0, maxSteps: 0, currentStep: '' };
    const onIterationLimit = vi.fn().mockImplementation(async (request: typeof capturedRequest) => {
      Object.assign(capturedRequest, request);
      return null;
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });

    // When: engine runs and hits the iteration limit
    await engine.run();

    // Then: onIterationLimit received correct request data
    expect(capturedRequest.currentIteration).toBe(1);
    expect(capturedRequest.maxSteps).toBe(1);
    // currentStep is the next step to run (implement) since plan already ran
    expect(capturedRequest.currentStep).toBe('implement');
  });

  it('should update maxSteps in engine config when onIterationLimit returns additionalIterations', async () => {
    // Given: a workflow with maxSteps=2
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 2,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeStep('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    // Grant 1 more iteration when limit is reached at iteration=2
    const onIterationLimit = vi.fn().mockResolvedValueOnce(1);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan' }),
      makeResponse({ persona: 'implement', content: 'Impl' }),
      // Third step needed after extension
      makeResponse({ persona: 'implement', content: 'Impl done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
      { index: 0, method: 'phase1_tag' }, // implement → COMPLETE
      // This never runs because we complete on the second implement
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });

    // When: engine runs
    const state = await engine.run();

    // Then: completed since limit was extended by 1 (2 → 3)
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(2);
  });

  it('should emit iteration:limit event before calling onIterationLimit', async () => {
    // Given: a workflow with maxSteps=1 and plan → implement so the limit fires.
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 1,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeStep('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const onIterationLimit = vi.fn().mockResolvedValue(null);
    const eventOrder: string[] = [];

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit: async (request) => {
        eventOrder.push('onIterationLimit');
        return onIterationLimit(request);
      },
    });

    engine.on('iteration:limit', () => {
      eventOrder.push('iteration:limit');
    });

    // When: engine runs
    await engine.run();

    // Then: iteration:limit event emitted before onIterationLimit callback
    expect(eventOrder).toEqual(['iteration:limit', 'onIterationLimit']);
  });
});

describe('WorkflowEngine: initialIteration option', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = null;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should start iteration counter from initialIteration value', async () => {
    // Given: a workflow with maxSteps=60 and initialIteration=30
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 60,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      initialIteration: 30,
    });

    // When: engine runs one step
    const state = await engine.run();

    // Then: iteration is 31 (30 + 1 step)
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(31);
  });

  it('should start from 0 when initialIteration is not provided', async () => {
    // Given: a workflow without initialIteration
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 60,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
    });

    // When: engine runs one step
    const state = await engine.run();

    // Then: iteration is 1 (0 + 1 step)
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
  });

  it('should trigger iteration limit immediately when initialIteration >= maxSteps', async () => {
    // Given: initialIteration=30, maxSteps=30 (already at limit on first check)
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 30,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const onIterationLimit = vi.fn().mockResolvedValue(null);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      initialIteration: 30,
      onIterationLimit,
    });

    // When: engine runs
    const state = await engine.run();

    // Then: iteration limit handler is called immediately (no steps executed)
    expect(onIterationLimit).toHaveBeenCalledOnce();
    expect(onIterationLimit).toHaveBeenCalledWith(expect.objectContaining({
      currentIteration: 30,
      maxSteps: 30,
      currentStep: 'plan',
    }));
    expect(state.status).toBe('aborted');
  });

  it('should emit iteration:limit with correct count when initialIteration is set', async () => {
    // Given: initialIteration=30, maxSteps=31 (one step before limit)
    const config: WorkflowConfig = {
      name: 'test',
      maxSteps: 31,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeStep('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const limitEvents: { iteration: number; maxSteps: number }[] = [];

    const onIterationLimit = vi.fn().mockResolvedValue(null);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      initialIteration: 30,
      onIterationLimit,
    });

    engine.on('iteration:limit', (iteration, maxSteps) => {
      limitEvents.push({ iteration, maxSteps });
    });

    // When: engine runs
    await engine.run();

    // Then: limit event emitted with correct counts
    // After plan runs, iteration = 31 >= maxSteps=31, so limit is reached
    expect(limitEvents).toHaveLength(1);
    expect(limitEvents[0]!.iteration).toBe(31);
    expect(limitEvents[0]!.maxSteps).toBe(31);
  });
});
