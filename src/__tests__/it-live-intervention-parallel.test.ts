import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSync, existsSync, openSync, readFileSync, rmSync, unlinkSync } from 'node:fs';

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
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: 'approved', method: 'auto_select' }),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine, type WorkflowEngineOptions } from '../core/workflow/index.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import type { AgentResponse, WorkflowConfig } from '../core/models/index.js';
import type { LiveInterventionChannel } from '../core/workflow/live-intervention/types.js';
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
  readonly liveIntervention: LiveInterventionChannel;
}

function createEngineOptions(
  projectCwd: string,
  liveIntervention: LiveInterventionChannel,
): LiveWorkflowEngineOptions {
  return {
    projectCwd,
    reportDirName: REPORT_DIR,
    provider: 'mock',
    liveIntervention,
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

function markProviderDispatch(
  persona: string | undefined,
  instruction: string,
  options: Parameters<typeof runAgent>[2],
): void {
  options.onPromptResolved?.({
    systemPrompt: persona ?? '',
    userInstruction: instruction,
  });
  options.onDispatch?.(options.permissionMode);
}

describe('ParallelRunner live intervention integration', () => {
  let projectCwd: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    projectCwd = createTestTmpDir();
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });
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

  it('waits for the active substep, discards the interrupted trial, and reruns the whole parallel step', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    let resolveFirstTurn!: (response: AgentResponse) => void;
    const firstTurn = new Promise<AgentResponse>((resolve) => {
      resolveFirstTurn = resolve;
    });
    let firstTurnStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstTurnStarted = resolve;
    });
    const abortSignals: (AbortSignal | undefined)[] = [];

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      abortSignals.push(options.abortSignal);
      const callNumber = vi.mocked(runAgent).mock.calls.length;
      if (callNumber === 1) {
        markProviderDispatch(persona, instruction, options);
        firstTurnStarted();
        return firstTurn.promise;
      }
      markProviderDispatch(persona, instruction, options);
      if (callNumber === 2) {
        return makeResponse({ content: 'a from rerun', sessionId: 'rerun-session' });
      }
      return makeResponse({ content: 'b from rerun', sessionId: 'b-session' });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-parallel',
      maxSteps: 10,
      initialStep: 'reviewers',
      steps: [{
        ...makeStep('reviewers', {
          concurrency: 1,
          parallel: [
            makeStep('a', { rules: [makeRule('approved', 'COMPLETE')] }),
            makeStep('b', { rules: [makeRule('approved', 'COMPLETE')] }),
          ],
          rules: [makeRule('all("approved")', 'COMPLETE')],
        }),
      }],
    };

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    const runPromise = engine.run();
    await started;
    await store.issue('parallel rerun instruction', '2026-09-03T00:00:00.000Z');
    resolveFirstTurn(makeResponse({
      content: 'a from interrupted trial',
      sessionId: 'trial-session',
    }));

    const state = await runPromise;
    const calls = vi.mocked(runAgent).mock.calls;
    const rawEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const delivery = rawEvents.find((event) => event.type === 'delivered');

    expect(state.status).toBe('completed');
    expect(calls.map((call) => call[0])).toEqual([
      '../personas/a.md',
      '../personas/a.md',
      '../personas/b.md',
    ]);
    expect(calls[0]?.[2].abortSignal?.aborted).toBe(false);
    expect(calls[1]?.[2].sessionId).not.toBe('trial-session');
    expect(calls[1]?.[1]).toContain('parallel rerun instruction');
    expect(calls[2]?.[1]).toContain('parallel rerun instruction');
    expect(state.stepOutputs.get('a')?.content).toBe('a from rerun');
    expect(state.stepOutputs.get('b')?.content).toBe('b from rerun');
    expect(delivery).toMatchObject({
      type: 'delivered',
      mode: 'next_step',
      target: 'parallel_restart',
      instructionIds: [1],
    });
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({ state: 'deliveredNextStep' })],
    });
  });

  it('reruns the whole parallel step when the parent status judgment receives an instruction', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    let issued = false;
    vi.mocked(runStatusJudgmentPhase).mockImplementation(async (step) => {
      if (step.name === 'reviewers' && !issued) {
        issued = true;
        await store.issue('parent judgment rerun instruction');
      }
      return { label: 'approved', method: 'auto_select' };
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      markProviderDispatch(persona, instruction, options);
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'reviewer',
        content: `${typeof persona === 'string' ? persona : 'reviewer'} result`,
        sessionId: `${typeof persona === 'string' ? persona : 'reviewer'}-session`,
      });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-parent-judgment-restart',
      maxSteps: 10,
      initialStep: 'reviewers',
      steps: [makeStep('reviewers', {
        concurrency: 2,
        parallel: [
          makeStep('a', { rules: [makeRule('approved', 'COMPLETE')] }),
          makeStep('b', { rules: [makeRule('approved', 'COMPLETE')] }),
        ],
        rules: [
          makeRule('approved', 'COMPLETE'),
          makeRule('needs-fix', 'ABORT'),
        ],
      })],
    };

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    const state = await engine.run();
    const calls = vi.mocked(runAgent).mock.calls;
    const deliveryEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === 'delivered');
    const aCalls = calls.filter(([persona]) => persona === '../personas/a.md');
    const bCalls = calls.filter(([persona]) => persona === '../personas/b.md');

    expect(state.status).toBe('completed');
    expect(vi.mocked(runStatusJudgmentPhase)).toHaveBeenCalledTimes(2);
    expect(aCalls).toHaveLength(2);
    expect(bCalls).toHaveLength(2);
    expect(aCalls[0]?.[1]).not.toContain('parent judgment rerun instruction');
    expect(bCalls[0]?.[1]).not.toContain('parent judgment rerun instruction');
    expect(aCalls[1]?.[1]).toContain('parent judgment rerun instruction');
    expect(bCalls[1]?.[1]).toContain('parent judgment rerun instruction');
    expect(deliveryEvents).toEqual([
      expect.objectContaining({
        mode: 'next_step',
        target: 'parallel_restart',
        instructionIds: [1],
      }),
    ]);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({ state: 'deliveredNextStep' })],
    });
  });

  it('aborts with an ordinary parent judgment error without creating a restart delivery', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const abort = vi.fn();
    let parentJudgmentCalls = 0;
    vi.mocked(runStatusJudgmentPhase).mockImplementation(async (step) => {
      if (step.name === 'reviewers') {
        parentJudgmentCalls += 1;
        await store.issue('instruction before ordinary parent failure');
        throw new Error('ordinary parent status judgment failure');
      }
      return { label: 'approved', method: 'auto_select' };
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      markProviderDispatch(persona, instruction, options);
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'reviewer',
        content: `${typeof persona === 'string' ? persona : 'reviewer'} result`,
        sessionId: `${typeof persona === 'string' ? persona : 'reviewer'}-session`,
      });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-parent-judgment-error',
      maxSteps: 10,
      initialStep: 'reviewers',
      steps: [makeStep('reviewers', {
        concurrency: 2,
        parallel: [
          makeStep('a', { rules: [makeRule('approved', 'COMPLETE')] }),
          makeStep('b', { rules: [makeRule('approved', 'COMPLETE')] }),
        ],
        rules: [
          makeRule('approved', 'COMPLETE'),
          makeRule('needs-fix', 'ABORT'),
        ],
      })],
    };

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    engine.on('workflow:abort', abort);
    const state = await engine.run();
    const calls = vi.mocked(runAgent).mock.calls;
    const deliveryEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === 'delivered');
    const aCalls = calls.filter(([persona]) => persona === '../personas/a.md');
    const bCalls = calls.filter(([persona]) => persona === '../personas/b.md');

    expect(state.status).toBe('aborted');
    expect(parentJudgmentCalls).toBe(1);
    expect(aCalls).toHaveLength(1);
    expect(bCalls).toHaveLength(1);
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[1]).toBe(
      'Step execution failed: ordinary parent status judgment failure',
    );
    expect(abort.mock.calls[0]?.[2]).toBe('runtime_error');
    expect(abort.mock.calls[0]?.[3]).toMatchObject({
      kind: 'runtime_error',
      step: 'reviewers',
      reason: 'Step execution failed: ordinary parent status judgment failure',
      error: 'ordinary parent status judgment failure',
    });
    expect(deliveryEvents).toHaveLength(0);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredNextStep: 0,
      terminalStatus: 'failed',
      unconsumedWarned: 1,
      instructions: [expect.objectContaining({ state: 'unconsumedWarned' })],
    });
  });

  it('does not continue a sub-step after its report phase observes a new instruction', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const reportStarted = createDeferred<void>();
    const reportRelease = createDeferred<void>();
    let reportCalls = 0;
    vi.mocked(runReportPhase).mockImplementation(async () => {
      reportCalls += 1;
      reportStarted.resolve(undefined);
      await reportRelease.promise;
    });

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      markProviderDispatch(persona, instruction, options);
      return makeResponse({
        content: `parallel result ${vi.mocked(runAgent).mock.calls.length}`,
        sessionId: `parallel-session-${vi.mocked(runAgent).mock.calls.length}`,
      });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-parallel-report-boundary',
      maxSteps: 10,
      initialStep: 'reviewers',
      steps: [makeStep('reviewers', {
        concurrency: 1,
        parallel: [makeStep('reviewer', {
          outputContracts: [{ name: 'review.md', format: 'markdown' }],
          rules: [makeRule('approved', 'COMPLETE')],
        })],
        rules: [makeRule('all("approved")', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, store));
    const runPromise = engine.run();
    await reportStarted.promise;
    await store.issue('instruction during report phase', '2026-09-03T00:00:00.000Z');
    reportRelease.resolve(undefined);

    const state = await runPromise;

    expect(state.status).toBe('completed');
    expect(reportCalls).toBe(2);
    expect(vi.mocked(mockRuleEvaluation)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).not.toContain('instruction during report phase');
    expect(vi.mocked(runAgent).mock.calls[1]?.[1]).toContain('instruction during report phase');
    expect(state.stepOutputs.get('reviewer')?.content).toBe('parallel result 2');
  });

  it('settles the current delivery before preparing a restart snapshot under lock contention', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    await store.issue('initial parallel instruction', '2026-09-03T00:00:00.000Z');
    const firstTurn = createDeferred<AgentResponse>();
    let firstTurnStarted!: () => void;
    const firstTurnStartedPromise = new Promise<void>((resolve) => {
      firstTurnStarted = resolve;
    });
    let commitReleased = false;
    let restartPreparedBeforeCommitRelease = false;
    const originalPrepareDelivery = store.prepareDelivery.bind(store);
    vi.spyOn(store, 'prepareDelivery').mockImplementation((context) => {
      if (context.target === 'parallel_restart' && !commitReleased) {
        restartPreparedBeforeCommitRelease = true;
      }
      return originalPrepareDelivery(context);
    });

    const lockPath = `${store.getFilePath()}.lock`;
    let lockFd: number | undefined;
    const releaseLock = (): void => {
      if (lockFd === undefined) {
        return;
      }
      closeSync(lockFd);
      lockFd = undefined;
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const callNumber = vi.mocked(runAgent).mock.calls.length;
      if (callNumber === 1) {
        await store.issue('parallel follow-up instruction', '2026-09-03T00:00:01.000Z');
        lockFd = openSync(lockPath, 'wx');
        markProviderDispatch(persona, instruction, options);
        firstTurnStarted();
        return firstTurn.promise;
      }
      markProviderDispatch(persona, instruction, options);
      return makeResponse({
        content: callNumber === 2 ? 'a from rerun' : 'b from rerun',
        sessionId: `rerun-session-${callNumber}`,
      });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-parallel-settlement',
      maxSteps: 10,
      initialStep: 'reviewers',
      steps: [{
        ...makeStep('reviewers', {
          concurrency: 1,
          parallel: [
            makeStep('a', { rules: [makeRule('approved', 'COMPLETE')] }),
            makeStep('b', { rules: [makeRule('approved', 'COMPLETE')] }),
          ],
          rules: [makeRule('all("approved")', 'COMPLETE')],
        }),
      }],
    };

    try {
      engine = new WorkflowEngine(
        config,
        projectCwd,
        'test task',
        createEngineOptions(projectCwd, store),
      );
      const runPromise = engine.run();
      await firstTurnStartedPromise;
      firstTurn.resolve(makeResponse({
        content: 'a from interrupted trial',
        sessionId: 'trial-session',
      }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      commitReleased = true;
      releaseLock();

      const state = await runPromise;
      const calls = vi.mocked(runAgent).mock.calls;
      const rawEvents = readFileSync(store.getFilePath(), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const deliveryEvents = rawEvents.filter((event) => event.type === 'delivered');

      expect(state.status).toBe('completed');
      expect(restartPreparedBeforeCommitRelease).toBe(false);
      expect(calls).toHaveLength(3);
      expect(calls[1]?.[1]).toContain('initial parallel instruction');
      expect(calls[1]?.[1]).toContain('parallel follow-up instruction');
      expect(calls[2]?.[1]).toContain('parallel follow-up instruction');
      expect(deliveryEvents).toEqual([
        expect.objectContaining({
          mode: 'next_step',
          target: 'parallel_step',
          instructionIds: [1],
        }),
        expect.objectContaining({
          mode: 'next_step',
          target: 'parallel_restart',
          instructionIds: [2],
        }),
      ]);
      expect(store.read()).toMatchObject({
        pending: 0,
        deliveredNextStep: 2,
        instructions: [
          expect.objectContaining({ state: 'deliveredNextStep' }),
          expect.objectContaining({ state: 'deliveredNextStep' }),
        ],
      });
    } finally {
      commitReleased = true;
      releaseLock();
    }
  });

  it('waits for late substep dispatches before preparing a restart snapshot', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    await store.issue('initial parallel instruction', '2026-09-03T00:00:00.000Z');
    const firstCallGate = createDeferred<void>();
    let firstCallStarted!: () => void;
    const firstCallStartedPromise = new Promise<void>((resolve) => {
      firstCallStarted = resolve;
    });
    let liveInterventionReadCount = 0;
    const liveIntervention: LiveInterventionChannel = {
      read: () => {
        const state = store.read();
        liveInterventionReadCount += 1;
        if (liveInterventionReadCount === 2) {
          void store.issue('parallel delayed dispatch instruction', '2026-09-03T00:00:01.000Z');
        }
        return state;
      },
      prepareDelivery: (context) => store.prepareDelivery(context),
      commitDelivery: (delivery) => store.commitDelivery(delivery),
      recordTerminal: (status, terminalAt) => store.recordTerminal(status, terminalAt),
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const callNumber = vi.mocked(runAgent).mock.calls.length;
      if (callNumber === 1) {
        firstCallStarted();
        await firstCallGate.promise;
        markProviderDispatch(persona, instruction, options);
        return makeResponse({
          content: 'a from delayed trial',
          sessionId: 'delayed-trial-session',
        });
      }
      markProviderDispatch(persona, instruction, options);
      return makeResponse({
        content: callNumber === 2 ? 'a from rerun' : 'b from rerun',
        sessionId: `rerun-session-${callNumber}`,
      });
    });

    const config: WorkflowConfig = {
      name: 'live-intervention-parallel-delayed-dispatch',
      maxSteps: 10,
      initialStep: 'reviewers',
      steps: [{
        ...makeStep('reviewers', {
          concurrency: 2,
          parallel: [
            makeStep('a', { rules: [makeRule('approved', 'COMPLETE')] }),
            makeStep('b', { rules: [makeRule('approved', 'COMPLETE')] }),
          ],
          rules: [makeRule('all("approved")', 'COMPLETE')],
        }),
      }],
    };

    engine = new WorkflowEngine(config, projectCwd, 'test task', createEngineOptions(projectCwd, liveIntervention));
    const runPromise = engine.run();
    await firstCallStartedPromise;
    firstCallGate.resolve(undefined);

    const state = await runPromise;
    const calls = vi.mocked(runAgent).mock.calls;
    const rawEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const deliveryEvents = rawEvents.filter((event) => event.type === 'delivered');

    expect(state.status).toBe('completed');
    expect(calls).toHaveLength(3);
    expect(calls[1]?.[1]).toContain('initial parallel instruction');
    expect(calls[1]?.[1]).toContain('parallel delayed dispatch instruction');
    expect(calls[2]?.[1]).toContain('parallel delayed dispatch instruction');
    expect(deliveryEvents).toEqual([
      expect.objectContaining({
        mode: 'next_step',
        target: 'parallel_step',
        instructionIds: [1],
      }),
      expect.objectContaining({
        mode: 'next_step',
        target: 'parallel_restart',
        instructionIds: [2],
      }),
    ]);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredNextStep: 2,
      instructions: [
        expect.objectContaining({ state: 'deliveredNextStep' }),
        expect.objectContaining({ state: 'deliveredNextStep' }),
      ],
    });
  });

  it('commits a parallel workflow_call delivery once through the parent channel', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    await store.issue('parallel workflow_call instruction', '2026-09-03T00:00:00.000Z');

    const childConfig: WorkflowConfig = {
      name: 'live-intervention-child',
      subworkflow: { callable: true },
      maxSteps: 10,
      initialStep: 'child-review',
      steps: [makeStep('child-review', {
        rules: [makeRule('approved', 'COMPLETE')],
      })],
    };
    const delegatedStep = {
      name: 'delegated',
      personaDisplayName: 'delegated',
      instruction: '',
      kind: 'workflow_call' as const,
      call: childConfig.name,
      rules: [makeRule('COMPLETE', 'COMPLETE')],
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-parallel-workflow-call',
      maxSteps: 10,
      initialStep: 'reviewers',
      steps: [makeStep('reviewers', {
        concurrency: 2,
        parallel: [
          makeStep('agent-review', { rules: [makeRule('approved', 'COMPLETE')] }),
          delegatedStep,
        ],
        rules: [makeRule('all("approved")', 'COMPLETE')],
      })],
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      markProviderDispatch(persona, instruction, options);
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'reviewer',
        content: 'approved',
        sessionId: `${typeof persona === 'string' ? persona : 'reviewer'}-session`,
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      workflowCallResolver: () => childConfig,
    });
    const workflowCallCompletions: unknown[] = [];
    engine.on('workflow_call:complete', (event) => workflowCallCompletions.push(event));
    const state = await engine.run();
    const rawEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const deliveredEvents = rawEvents.filter((event) => event.type === 'delivered');

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(workflowCallCompletions).toEqual([
      expect.objectContaining({
        step: 'delegated',
        result: { status: 'completed' },
      }),
    ]);
    expect(vi.mocked(runAgent).mock.calls.every(([, instruction]) => (
      instruction.includes('parallel workflow_call instruction')
    ))).toBe(true);
    expect(deliveredEvents).toHaveLength(1);
    expect(deliveredEvents[0]).toMatchObject({
      mode: 'next_step',
      target: 'parallel_step',
      instructionIds: [1],
    });
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({ state: 'deliveredNextStep' })],
    });
  });

  it('reruns the whole parallel step when a workflow_call receives an instruction while active', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const childTurn = createDeferred<AgentResponse>();
    let childStarted!: () => void;
    const childStartedPromise = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    let childInvocationCount = 0;
    let siblingInvocationCount = 0;
    const abortSignals: (AbortSignal | undefined)[] = [];

    const childConfig: WorkflowConfig = {
      name: 'live-intervention-deferred-child',
      subworkflow: { callable: true },
      maxSteps: 10,
      initialStep: 'child-review',
      steps: [makeStep('child-review', {
        rules: [makeRule('approved', 'COMPLETE')],
      })],
    };
    const delegatedStep = {
      name: 'delegated',
      personaDisplayName: 'delegated',
      instruction: '',
      kind: 'workflow_call' as const,
      call: childConfig.name,
      rules: [makeRule('COMPLETE', 'COMPLETE')],
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-deferred-parallel-workflow-call',
      maxSteps: 10,
      initialStep: 'reviewers',
      steps: [makeStep('reviewers', {
        concurrency: 2,
        parallel: [
          makeStep('agent-review', { rules: [makeRule('approved', 'COMPLETE')] }),
          delegatedStep,
        ],
        rules: [makeRule('all("approved")', 'COMPLETE')],
      })],
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      abortSignals.push(options.abortSignal);
      markProviderDispatch(persona, instruction, options);
      if (typeof persona === 'string' && persona.includes('child-review')) {
        childInvocationCount += 1;
        if (childInvocationCount === 1) {
          childStarted();
          return childTurn.promise;
        }
        return makeResponse({
          persona: 'child-review',
          content: 'child final result',
          sessionId: 'child-rerun-session',
        });
      }
      siblingInvocationCount += 1;
      return makeResponse({
        persona: 'agent-review',
        content: `sibling result ${siblingInvocationCount}`,
        sessionId: `sibling-session-${siblingInvocationCount}`,
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      workflowCallResolver: () => childConfig,
    });
    const runPromise = engine.run();
    await childStartedPromise;
    await store.issue('instruction during child workflow_call', '2026-09-03T00:00:00.000Z');
    childTurn.resolve(makeResponse({
      persona: 'child-review',
      content: 'child interrupted trial result',
      sessionId: 'child-trial-session',
    }));

    const state = await runPromise;
    const calls = vi.mocked(runAgent).mock.calls;
    const rawEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const deliveryEvents = rawEvents.filter((event) => event.type === 'delivered');
    const childCalls = calls.filter(([persona]) => (
      typeof persona === 'string' && persona.includes('child-review')
    ));
    const siblingCalls = calls.filter(([persona]) => (
      typeof persona === 'string' && persona.includes('agent-review')
    ));

    expect(state.status).toBe('completed');
    expect(childInvocationCount).toBe(2);
    expect(siblingInvocationCount).toBe(2);
    expect(childCalls).toHaveLength(2);
    expect(siblingCalls).toHaveLength(2);
    expect(childCalls[1]?.[1]).toContain('instruction during child workflow_call');
    expect(siblingCalls[1]?.[1]).toContain('instruction during child workflow_call');
    expect(abortSignals).toHaveLength(4);
    expect(abortSignals.every((signal) => signal === undefined || signal.aborted === false)).toBe(true);
    expect(state.stepOutputs.get('delegated')?.content).toBe('child final result');
    expect(state.stepOutputs.get('delegated')?.content).not.toBe('child interrupted trial result');
    expect(state.stepOutputs.get('agent-review')?.content).toBe('sibling result 2');
    expect(engine?.getResumePoint()?.stack).toEqual([
      expect.objectContaining({
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      }),
    ]);
    expect(deliveryEvents).toHaveLength(1);
    expect(deliveryEvents[0]).toMatchObject({
      type: 'delivered',
      mode: 'next_step',
      target: 'parallel_restart',
      instructionIds: [1],
    });
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({ state: 'deliveredNextStep' })],
    });
  });

  it('keeps the parent parallel resume frame without a live intervention', async () => {
    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    let childInvocationCount = 0;
    let siblingInvocationCount = 0;

    const childConfig: WorkflowConfig = {
      name: 'live-intervention-no-issue-child',
      subworkflow: { callable: true },
      maxSteps: 10,
      initialStep: 'child-review',
      steps: [makeStep('child-review', {
        rules: [makeRule('approved', 'COMPLETE')],
      })],
    };
    const delegatedStep = {
      name: 'delegated',
      personaDisplayName: 'delegated',
      instruction: '',
      kind: 'workflow_call' as const,
      call: childConfig.name,
      rules: [makeRule('COMPLETE', 'COMPLETE')],
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-no-issue-parallel-workflow-call',
      maxSteps: 10,
      initialStep: 'reviewers',
      steps: [makeStep('reviewers', {
        concurrency: 2,
        parallel: [
          makeStep('agent-review', { rules: [makeRule('approved', 'COMPLETE')] }),
          delegatedStep,
        ],
        rules: [makeRule('all("approved")', 'COMPLETE')],
      })],
    };

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      markProviderDispatch(persona, instruction, options);
      if (typeof persona === 'string' && persona.includes('child-review')) {
        childInvocationCount += 1;
        return makeResponse({
          persona: 'child-review',
          content: 'child result',
          sessionId: 'child-session',
        });
      }
      siblingInvocationCount += 1;
      return makeResponse({
        persona: 'agent-review',
        content: 'sibling result',
        sessionId: 'sibling-session',
      });
    });

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      ...createEngineOptions(projectCwd, store),
      workflowCallResolver: () => childConfig,
    });
    const state = await engine.run();
    const rawEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const deliveryEvents = rawEvents.filter((event) => event.type === 'delivered');

    expect(state.status).toBe('completed');
    expect(childInvocationCount).toBe(1);
    expect(siblingInvocationCount).toBe(1);
    expect(deliveryEvents).toHaveLength(0);
    expect(engine?.getResumePoint()?.stack).toEqual([
      expect.objectContaining({
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      }),
    ]);
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredNextStep: 0,
      instructions: [],
    });
  });
});
