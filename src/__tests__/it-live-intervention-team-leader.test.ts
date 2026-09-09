import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

const mockExecuteAgent = vi.hoisted(() => vi.fn());

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: (...args: unknown[]) => mockExecuteAgent(...args),
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: 'done', method: 'auto_select' }),
}));

import { runAgent } from '../agents/runner.js';
import { requestMoreParts, type DecomposeTaskOptions, type MorePartsOptions } from '../agents/decompose-task-usecase.js';
import type { StructuredCaller } from '../agents/structured-caller.js';
import { WorkflowEngine, type WorkflowEngineOptions } from '../core/workflow/index.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import {
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
} from './engine-test-helpers.js';

const REPORT_DIR = 'test-report-dir';

interface LiveWorkflowEngineOptions extends WorkflowEngineOptions {
  readonly liveIntervention: LiveInterventionFileStore;
}

interface SessionAwareStructuredResponse {
  readonly sessionId?: string;
}

function createEngineOptions(
  projectCwd: string,
  store: LiveInterventionFileStore,
  structuredCaller: StructuredCaller,
): LiveWorkflowEngineOptions {
  return {
    projectCwd,
    reportDirName: REPORT_DIR,
    provider: 'mock',
    structuredCaller,
    liveIntervention: store,
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function dispatchStructuredPrompt(
  options: DecomposeTaskOptions,
  instruction: string,
): void {
  options.onPromptResolved?.({
    systemPrompt: 'team leader',
    userInstruction: instruction,
  });
  options.onDispatch?.(undefined);
}

describe('TeamLeaderRunner live intervention integration', () => {
  let projectCwd: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    projectCwd = createTestTmpDir();
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
    mockExecuteAgent.mockImplementation((
      persona: Parameters<typeof runAgent>[0],
      instruction: Parameters<typeof runAgent>[1],
      options: Parameters<typeof runAgent>[2],
    ) => runAgent(persona, instruction, options));
  });

  afterEach(() => {
    if (engine !== undefined) {
      cleanupWorkflowEngine(engine);
      engine = undefined;
    }
    if (existsSync(projectCwd)) {
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  it.each([true, false])('keeps leader feedback bounded with dispatch notification=%s', async (notifyDispatch) => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const decompositionGate = createDeferred<SessionAwareStructuredResponse & { parts: unknown[] }>();
    let decompositionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      decompositionStarted = resolve;
    });
    let feedbackOptions: MorePartsOptions | undefined;
    let feedbackInstruction = '';
    let feedbackCalls = 0;
    const workerInstructions: string[] = [];

    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (_instruction, _maxInitialParts, options) => {
        dispatchStructuredPrompt(options, 'decompose the task');
        decompositionStarted();
        await decompositionGate.promise;
        return {
          parts: [{ id: 'part-1', title: 'one part', instruction: 'run one part' }],
          sessionId: 'leader-session',
        };
      },
      requestMoreParts: async (originalInstruction, _results, _existingIds, options) => {
        feedbackCalls += 1;
        if (feedbackCalls > 10) throw new Error('feedback did not make progress');
        feedbackInstruction = originalInstruction;
        feedbackOptions = options;
        if (notifyDispatch) feedbackOptions.onDispatch?.(undefined);
        return {
          done: true,
          reasoning: 'no more parts',
          cancelPartIds: [],
          parts: [],
        };
      },
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (typeof persona === 'string' && persona.includes('coder')) {
        workerInstructions.push(instruction);
      }
      options.onPromptResolved?.({
        systemPrompt: persona ?? '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return makeResponse({ persona: 'coder', content: 'part complete', sessionId: 'worker-session' });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader',
      maxSteps: 10,
      initialStep: 'implement',
      steps: [makeStep('implement', {
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 1,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store, structuredCaller));
    const runPromise = engine.run();
    await started;
    await store.issue('leader feedback instruction', '2026-09-03T00:00:00.000Z');
    decompositionGate.resolve({
      parts: [{ id: 'part-1', title: 'one part', instruction: 'run one part' }],
      sessionId: 'leader-session',
    });

    const state = await runPromise;

    expect(state.status).toBe('completed');
    expect(feedbackCalls).toBeLessThanOrEqual(10);
    expect(feedbackInstruction).toContain('leader feedback instruction');
    expect(feedbackOptions?.sessionId).toBe('leader-session');
    expect(feedbackInstruction.indexOf('leader feedback instruction')).toBeGreaterThanOrEqual(0);
    expect(workerInstructions).toHaveLength(1);
    expect(workerInstructions[0]).not.toContain('leader feedback instruction');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: notifyDispatch ? 1 : 0,
      unconsumedWarned: notifyDispatch ? 0 : 1,
      deliveredNextStep: 0,
      instructions: [expect.objectContaining({ state: notifyDispatch ? 'deliveredSameSession' : 'unconsumedWarned' })],
    });
  });

  it('injects instructions already pending at the start of the leader step', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    await store.issue('apply before decomposition', '2026-09-03T00:00:00.000Z');
    let decompositionInstruction = '';

    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (instruction, _maxInitialParts, options) => {
        decompositionInstruction = instruction;
        dispatchStructuredPrompt(options, instruction);
        return {
          parts: [{ id: 'part-1', title: 'one part', instruction: 'run one part' }],
          sessionId: 'leader-session',
        };
      },
      requestMoreParts: async (_originalInstruction, _results, _existingIds, options) => {
        options.onDispatch?.(undefined);
        return {
          done: true,
          reasoning: 'no more parts',
          cancelPartIds: [],
          parts: [],
        };
      },
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options.onPromptResolved?.({
        systemPrompt: persona ?? '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return makeResponse({ persona: 'coder', content: 'part complete', sessionId: 'worker-session' });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader-initial',
      maxSteps: 10,
      initialStep: 'implement',
      steps: [makeStep('implement', {
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 1,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store, structuredCaller));
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(decompositionInstruction).toContain('apply before decomposition');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({ state: 'deliveredNextStep' })],
    });
  });

  it('retains parts returned by initial feedback when a live follow-up is complete', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const feedbackInstructions: string[] = [];
    const feedbackOptions: MorePartsOptions[] = [];
    const workerInstructions: string[] = [];
    let feedbackCallCount = 0;

    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (_instruction, _maxInitialParts, options) => {
        dispatchStructuredPrompt(options, 'decompose');
        await store.issue('instruction before initial feedback', '2026-09-03T00:00:00.000Z');
        return {
          parts: [{ id: 'part-1', title: 'one part', instruction: 'run one part' }],
          sessionId: 'leader-session',
        };
      },
      requestMoreParts: async (originalInstruction, _results, _existingIds, options) => {
        feedbackCallCount += 1;
        feedbackInstructions.push(originalInstruction);
        feedbackOptions.push(options);
        options.onDispatch?.(undefined);
        if (feedbackCallCount === 1) {
          await store.issue('instruction during initial feedback', '2026-09-03T00:00:01.000Z');
          return {
            done: false,
            reasoning: 'schedule the additional part',
            cancelPartIds: [],
            parts: [{ id: 'part-2', title: 'additional part', instruction: 'run the additional part' }],
            sessionId: 'leader-session',
          };
        }
        return {
          done: true,
          reasoning: 'no more parts',
          cancelPartIds: [],
          parts: [],
          sessionId: 'leader-session',
        };
      },
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      workerInstructions.push(instruction);
      options.onPromptResolved?.({
        systemPrompt: persona ?? '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return makeResponse({ persona: 'coder', content: 'part complete', sessionId: 'worker-session' });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader-initial-feedback-merge',
      maxSteps: 10,
      initialStep: 'implement',
      steps: [makeStep('implement', {
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 1,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(
      config,
      projectCwd,
      'test task',
      createEngineOptions(projectCwd, store, structuredCaller),
    );
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(feedbackCallCount).toBe(3);
    expect(feedbackInstructions[0]).toContain('instruction before initial feedback');
    expect(feedbackInstructions[1]).toContain('instruction during initial feedback');
    expect(feedbackOptions.map((options) => options.sessionId)).toEqual([
      'leader-session',
      'leader-session',
      'leader-session',
    ]);
    expect(workerInstructions).toHaveLength(2);
    expect(workerInstructions[1]).toContain('run the additional part');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 2,
      deliveredNextStep: 0,
      instructions: [
        expect.objectContaining({ state: 'deliveredSameSession' }),
        expect.objectContaining({ state: 'deliveredSameSession' }),
      ],
    });
  });

  it('drains an instruction issued during leader feedback before scheduling the next outcome', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const feedbackInstructions: string[] = [];
    const feedbackOptions: MorePartsOptions[] = [];
    const workerInstructions: string[] = [];

    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (_instruction, _maxInitialParts, options) => {
        dispatchStructuredPrompt(options, 'decompose');
        return {
          parts: [{ id: 'part-1', title: 'one part', instruction: 'run one part' }],
          sessionId: 'leader-session',
        };
      },
      requestMoreParts: async (originalInstruction, _results, _existingIds, options) => {
        feedbackInstructions.push(originalInstruction);
        feedbackOptions.push(options);
        if (feedbackInstructions.length === 1) {
          await store.issue('issued during leader feedback', '2026-09-03T00:00:01.000Z');
        }
        options.onDispatch?.(undefined);
        if (feedbackInstructions.length === 1) {
          return {
            done: false,
            reasoning: 'schedule the additional part',
            cancelPartIds: [],
            parts: [{ id: 'part-2', title: 'additional part', instruction: 'run the additional part' }],
            sessionId: 'leader-session',
          };
        }
        return {
          done: true,
          reasoning: 'no more parts',
          cancelPartIds: [],
          parts: [],
          sessionId: 'leader-session',
        };
      },
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      workerInstructions.push(instruction);
      options.onPromptResolved?.({
        systemPrompt: persona ?? '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return makeResponse({ persona: 'coder', content: 'part complete', sessionId: 'worker-session' });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader-feedback-drain',
      maxSteps: 10,
      initialStep: 'implement',
      steps: [makeStep('implement', {
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 1,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store, structuredCaller));
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(feedbackInstructions).toHaveLength(3);
    expect(feedbackInstructions[1]).toContain('issued during leader feedback');
    expect(feedbackOptions[1]?.sessionId).toBe('leader-session');
    expect(workerInstructions).toHaveLength(2);
    expect(workerInstructions[1]).toContain('run the additional part');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      deliveredNextStep: 0,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('drains an instruction issued after initial feedback marked planning done', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const decompositionGate = createDeferred<void>();
    const decompositionStarted = createDeferred<void>();
    const workerGate = createDeferred<ReturnType<typeof makeResponse>>();
    const workerStarted = createDeferred<void>();
    const feedbackInstructions: string[] = [];
    const feedbackOptions: MorePartsOptions[] = [];
    const workerInstructions: string[] = [];

    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (_instruction, _maxInitialParts, options) => {
        dispatchStructuredPrompt(options, 'decompose');
        decompositionStarted.resolve();
        await decompositionGate.promise;
        return {
          parts: [{ id: 'part-1', title: 'one part', instruction: 'run one part' }],
          sessionId: 'leader-session',
        };
      },
      requestMoreParts: async (originalInstruction, _results, _existingIds, options) => {
        feedbackInstructions.push(originalInstruction);
        const sessionAwareOptions = options;
        feedbackOptions.push(sessionAwareOptions);
        sessionAwareOptions.onDispatch?.(undefined);
        return {
          done: true,
          reasoning: 'no more parts',
          cancelPartIds: [],
          parts: [],
        };
      },
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      workerInstructions.push(instruction);
      workerStarted.resolve();
      options.onPromptResolved?.({
        systemPrompt: persona ?? '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return workerGate.promise;
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader-after-initial-feedback',
      maxSteps: 10,
      initialStep: 'implement',
      steps: [makeStep('implement', {
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 1,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(
      config,
      projectCwd,
      'test task',
      createEngineOptions(projectCwd, store, structuredCaller),
    );
    const runPromise = engine.run();
    await decompositionStarted.promise;
    await store.issue('instruction before worker execution', '2026-09-03T00:00:00.000Z');
    decompositionGate.resolve();
    await workerStarted.promise;
    await store.issue('instruction after initial feedback', '2026-09-03T00:00:01.000Z');
    workerGate.resolve(makeResponse({ persona: 'coder', content: 'part complete', sessionId: 'worker-session' }));

    const state = await runPromise;

    expect(state.status).toBe('completed');
    expect(feedbackInstructions).toHaveLength(2);
    expect(feedbackInstructions[0]).toContain('instruction before worker execution');
    expect(feedbackInstructions[1]).toContain('instruction after initial feedback');
    expect(feedbackOptions.map((options) => options.sessionId)).toEqual([
      'leader-session',
      'leader-session',
    ]);
    expect(workerInstructions).toHaveLength(1);
    expect(workerInstructions[0]).not.toContain('instruction after initial feedback');
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 2,
      deliveredNextStep: 0,
      instructions: [
        expect.objectContaining({ state: 'deliveredSameSession' }),
        expect.objectContaining({ state: 'deliveredSameSession' }),
      ],
    });
  });

  it('drains an instruction issued after normal feedback marked planning done', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const partAGate = createDeferred<ReturnType<typeof makeResponse>>();
    const partBGate = createDeferred<ReturnType<typeof makeResponse>>();
    const partAStarted = createDeferred<void>();
    const partBStarted = createDeferred<void>();
    const firstFeedbackStarted = createDeferred<void>();
    const releaseFirstFeedback = createDeferred<void>();
    const feedbackInstructions: string[] = [];
    const feedbackOptions: MorePartsOptions[] = [];
    let workerCallCount = 0;
    let feedbackCallCount = 0;

    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (_instruction, _maxInitialParts, options) => {
        dispatchStructuredPrompt(options, 'decompose');
        return {
          parts: [
            { id: 'part-a', title: 'part A', instruction: 'run part A' },
            { id: 'part-b', title: 'part B', instruction: 'run part B' },
          ],
          sessionId: 'leader-session',
        };
      },
      requestMoreParts: async (originalInstruction, _results, _existingIds, options) => {
        feedbackCallCount += 1;
        feedbackInstructions.push(originalInstruction);
        const sessionAwareOptions = options;
        feedbackOptions.push(sessionAwareOptions);
        sessionAwareOptions.onDispatch?.(undefined);
        if (feedbackCallCount === 1) {
          firstFeedbackStarted.resolve();
          await releaseFirstFeedback.promise;
        }
        return {
          done: true,
          reasoning: 'no more parts',
          cancelPartIds: [],
          parts: [],
        };
      },
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const workerIndex = workerCallCount;
      workerCallCount += 1;
      if (workerIndex === 0) {
        partAStarted.resolve();
      } else {
        partBStarted.resolve();
      }
      options.onPromptResolved?.({
        systemPrompt: persona ?? '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return (workerIndex === 0 ? partAGate : partBGate).promise;
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader-after-normal-feedback',
      maxSteps: 10,
      initialStep: 'implement',
      steps: [makeStep('implement', {
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 2,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(
      config,
      projectCwd,
      'test task',
      createEngineOptions(projectCwd, store, structuredCaller),
    );
    const runPromise = engine.run();
    await Promise.all([partAStarted.promise, partBStarted.promise]);
    partAGate.resolve(makeResponse({ persona: 'coder', content: 'part A complete', sessionId: 'worker-a' }));
    await firstFeedbackStarted.promise;
    releaseFirstFeedback.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await store.issue('instruction after normal feedback', '2026-09-03T00:00:01.000Z');
    partBGate.resolve(makeResponse({ persona: 'coder', content: 'part B complete', sessionId: 'worker-b' }));

    const state = await runPromise;

    expect(state.status).toBe('completed');
    expect(feedbackCallCount).toBe(2);
    expect(feedbackInstructions[1]).toContain('instruction after normal feedback');
    expect(feedbackOptions.map((options) => options.sessionId)).toEqual([
      'leader-session',
      'leader-session',
    ]);
    expect(workerCallCount).toBe(2);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      deliveredNextStep: 0,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('retains a Companion correction part when its live follow-up marks planning done', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline-sha'),
      readDiff: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        snapshot: {
          digest: 'current-digest',
          changedLines: 10,
          content: '+changed content\n',
          changedFiles: ['src/changed.ts'],
          fileFingerprints: { 'src/changed.ts': 'current-digest' },
          hunkFingerprints: { 'src/changed.ts:1-10': 'current-digest' },
          omittedBytes: 0,
          truncated: false,
        },
      }),
    };
    const feedbackInstructions: string[] = [];
    const feedbackOptions: MorePartsOptions[] = [];
    const workerInstructions: string[] = [];
    let feedbackCallCount = 0;

    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (_instruction, _maxInitialParts, options) => {
        dispatchStructuredPrompt(options, 'decompose');
        return {
          parts: [{ id: 'part-1', title: 'one part', instruction: 'run one part' }],
          sessionId: 'leader-session',
        };
      },
      requestMoreParts: async (originalInstruction, _results, _existingIds, options) => {
        feedbackCallCount += 1;
        feedbackInstructions.push(originalInstruction);
        feedbackOptions.push(options);
        options.onDispatch?.(undefined);
        if (feedbackCallCount === 1) {
          return {
            done: true,
            reasoning: 'planning complete before Companion review',
            cancelPartIds: [],
            parts: [],
            sessionId: 'leader-session',
          };
        }
        if (feedbackCallCount === 2) {
          await store.issue('instruction during Companion correction planning', '2026-09-03T00:00:01.000Z');
          return {
            done: false,
            reasoning: 'schedule the Companion correction',
            cancelPartIds: [],
            parts: [{ id: 'part-2', title: 'correction part', instruction: 'run the correction part' }],
            sessionId: 'leader-session',
          };
        }
        return {
          done: true,
          reasoning: 'no more parts',
          cancelPartIds: [],
          parts: [],
          sessionId: 'leader-session',
        };
      },
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options.internalAgentName === 'reviewer') {
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: {
            findings: [{
              severity: 'must_fix',
              file: 'src/changed.ts',
              line: 1,
              finding: 'Fix the changed implementation.',
            }],
            notes: null,
          },
        });
      }
      workerInstructions.push(instruction);
      options.onPromptResolved?.({
        systemPrompt: persona ?? '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return makeResponse({
        persona: 'coder',
        content: instruction.includes('run the correction part')
          ? 'correction complete'
          : 'part complete',
        sessionId: 'worker-session',
      });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader-companion-feedback-merge',
      maxSteps: 10,
      initialStep: 'implement',
      companions: {
        reviewer: {
          name: 'reviewer',
          description: 'Review the implementation.',
          instruction: 'Review the implementation.',
          instructionRef: 'reviewer',
          intervalMs: 60_000,
        },
      },
      steps: [makeStep('implement', {
        companion: { fixed: ['reviewer'], pool: [] },
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 1,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(
      config,
      projectCwd,
      'test task',
      {
        ...createEngineOptions(projectCwd, store, structuredCaller),
        companionEnabled: true,
        companionFixPolicy: 'single',
        companionProviders: { reviewer: { provider: 'mock' } },
        companionDiffReader,
      },
    );
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(feedbackCallCount).toBe(3);
    expect(feedbackInstructions[2]).toContain('instruction during Companion correction planning');
    expect(feedbackOptions.map((options) => options.sessionId)).toEqual([
      'leader-session',
      'leader-session',
      'leader-session',
    ]);
    expect(workerInstructions.some((instruction) => instruction.includes('run one part'))).toBe(true);
    expect(workerInstructions.filter((instruction) => instruction.includes('run the correction part'))).toHaveLength(1);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      deliveredNextStep: 0,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('aborts instead of creating a fresh leader session for a post-done instruction without a session ID', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const partAGate = createDeferred<ReturnType<typeof makeResponse>>();
    const partBGate = createDeferred<ReturnType<typeof makeResponse>>();
    const partAStarted = createDeferred<void>();
    const partBStarted = createDeferred<void>();
    const firstFeedbackStarted = createDeferred<void>();
    const releaseFirstFeedback = createDeferred<void>();
    let workerCallCount = 0;
    let feedbackCallCount = 0;

    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (_instruction, _maxInitialParts, options) => {
        dispatchStructuredPrompt(options, 'decompose');
        return {
          parts: [
            { id: 'part-a', title: 'part A', instruction: 'run part A' },
            { id: 'part-b', title: 'part B', instruction: 'run part B' },
          ],
        };
      },
      requestMoreParts: async (_originalInstruction, _results, _existingIds, options) => {
        feedbackCallCount += 1;
        options.onDispatch?.(undefined);
        if (feedbackCallCount === 1) {
          firstFeedbackStarted.resolve();
          await releaseFirstFeedback.promise;
          return {
            done: true,
            reasoning: 'no more parts',
            cancelPartIds: [],
            parts: [],
          };
        }
        throw new Error('unexpected structured feedback call');
      },
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const workerIndex = workerCallCount;
      workerCallCount += 1;
      if (workerIndex === 0) {
        partAStarted.resolve();
      } else {
        partBStarted.resolve();
      }
      options.onPromptResolved?.({
        systemPrompt: persona ?? '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return (workerIndex === 0 ? partAGate : partBGate).promise;
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader-post-done-missing-session',
      maxSteps: 10,
      initialStep: 'implement',
      steps: [makeStep('implement', {
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 2,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(
      config,
      projectCwd,
      'test task',
      createEngineOptions(projectCwd, store, structuredCaller),
    );
    const runPromise = engine.run();
    await Promise.all([partAStarted.promise, partBStarted.promise]);
    partAGate.resolve(makeResponse({ persona: 'coder', content: 'part A complete', sessionId: 'worker-a' }));
    await firstFeedbackStarted.promise;
    releaseFirstFeedback.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await store.issue('instruction after planning done without session', '2026-09-03T00:00:01.000Z');
    partBGate.resolve(makeResponse({ persona: 'coder', content: 'part B complete', sessionId: 'worker-b' }));

    const state = await runPromise;

    expect(state.status).toBe('aborted');
    expect(feedbackCallCount).toBe(1);
    expect(workerCallCount).toBe(2);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 0,
      deliveredNextStep: 0,
      unconsumedWarned: 1,
      terminalStatus: 'failed',
      instructions: [expect.objectContaining({ state: 'unconsumedWarned' })],
    });
  });

  it('passes an explicit MoreParts session ID through structured transport to executeAgent', async () => {
    mockExecuteAgent.mockResolvedValue(makeResponse({
      persona: 'team-leader-more-parts',
      sessionId: 'leader-session-2',
      structuredOutput: {
        done: true,
        reasoning: 'no more parts',
        cancelPartIds: [],
        parts: [],
      },
    }));
    const response = await requestMoreParts(
      'original task',
      [],
      [],
      {
        cwd: projectCwd,
        provider: 'mock',
        resolvedProvider: 'mock',
        sessionId: 'leader-session-1',
        cancellablePartIds: [],
      },
    );

    expect(response.sessionId).toBe('leader-session-2');
    expect(mockExecuteAgent).toHaveBeenCalledOnce();
    expect(mockExecuteAgent.mock.calls[0]?.[2]).toMatchObject({
      sessionId: 'leader-session-1',
      resolvedExecution: { provider: 'mock' },
    });
  });

  it('passes a rotated MoreParts session ID to the next leader feedback call', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const feedbackSessions: Array<string | undefined> = [];
    let morePartsCallCount = 0;

    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (instruction, _maxInitialParts, options) => {
        dispatchStructuredPrompt(options, instruction);
        return {
          parts: [{ id: 'part-1', title: 'one part', instruction: 'run one part' }],
          sessionId: 'leader-session-1',
        };
      },
      requestMoreParts,
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options.onPromptResolved?.({
        systemPrompt: persona ?? '',
        userInstruction: instruction,
      });
      options.onDispatch?.(options.permissionMode);
      return makeResponse({ persona: 'coder', content: 'part complete', sessionId: 'worker-session' });
    });
    mockExecuteAgent.mockImplementation(async (
      persona: Parameters<typeof runAgent>[0],
      instruction: Parameters<typeof runAgent>[1],
      options: Parameters<typeof runAgent>[2],
    ) => {
      if (typeof persona !== 'string' || !persona.includes('team-leader')) {
        return runAgent(persona, instruction, options);
      }

      feedbackSessions.push(options.sessionId);
      morePartsCallCount += 1;
      if (morePartsCallCount === 1) {
        await store.issue('issued during the first MoreParts call', '2026-09-03T00:00:00.000Z');
      }
      options.onDispatch?.(options.permissionMode);
      return makeResponse({
        persona: 'team-leader-more-parts',
        sessionId: morePartsCallCount === 1 ? 'leader-session-2' : undefined,
        structuredOutput: {
          done: true,
          reasoning: 'no more parts',
          cancelPartIds: [],
          parts: [],
        },
      });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader-session-rotation',
      maxSteps: 10,
      initialStep: 'implement',
      steps: [makeStep('implement', {
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 1,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(
      config,
      projectCwd,
      'test task',
      createEngineOptions(projectCwd, store, structuredCaller),
    );
    const state = await engine.run();
    const feedbackCalls = mockExecuteAgent.mock.calls.filter(([persona]) => (
      typeof persona === 'string' && persona.includes('team-leader')
    ));

    expect(state.status).toBe('completed');
    expect(feedbackSessions).toEqual(['leader-session-1', 'leader-session-2']);
    expect(feedbackCalls[1]?.[2].sessionId).toBe('leader-session-2');
    expect(morePartsCallCount).toBe(2);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredSameSession: 1,
      instructions: [expect.objectContaining({ state: 'deliveredSameSession' })],
    });
  });

  it('fails the leader step instead of creating a fresh session when decomposition omits its session ID', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const requestFeedback = vi.fn();
    const structuredCaller: StructuredCaller = {
      judgeStatus: async () => ({ label: 'done', method: 'auto_select' }),
      evaluateCondition: async () => 0,
      decomposeTask: async (_instruction, _maxInitialParts, options) => {
        dispatchStructuredPrompt(options, 'decompose');
        await store.issue('leader session is required');
        return {
          parts: [{ id: 'part-1', title: 'one part', instruction: 'run one part' }],
        };
      },
      requestMoreParts: async (...args) => {
        requestFeedback();
        throw new Error(`unexpected feedback call: ${args[0]}`);
      },
    };

    const config: WorkflowConfig = {
      name: 'live-intervention-team-leader-missing-session',
      maxSteps: 10,
      initialStep: 'implement',
      steps: [makeStep('implement', {
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 1,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(
      config,
      projectCwd,
      'test task',
      createEngineOptions(projectCwd, store, structuredCaller),
    );
    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(requestFeedback).not.toHaveBeenCalled();
    expect(store.read()).toMatchObject({
      pending: 0,
      unconsumedWarned: 1,
      terminalStatus: 'failed',
    });
  });
});
