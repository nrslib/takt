import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

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
import { WorkflowEngine, type WorkflowEngineOptions } from '../core/workflow/index.js';
import type { ArpeggioStepConfig, WorkflowConfig } from '../core/models/index.js';
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

describe('ArpeggioRunner live intervention integration', () => {
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

  it('keeps completed and running batches unchanged and injects history only into later batches', async () => {
    const csvPath = join(projectCwd, 'data.csv');
    const templatePath = join(projectCwd, 'batch-template.md');
    mkdirSync(projectCwd, { recursive: true });
    writeFileSync(
      csvPath,
      'name,task\nAlice,one\nBob,two\nCarol,three\nDave,four\nEve,five\nFrank,six',
      'utf8',
    );
    writeFileSync(templatePath, 'Process {line:1}', 'utf8');

    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    const runningBatchGate = createDeferred<void>();
    let runningBatchCount = 0;
    let runningBatchesStarted!: () => void;
    const runningStarted = new Promise<void>((resolve) => {
      runningBatchesStarted = resolve;
    });
    const abortSignals: (AbortSignal | undefined)[] = [];

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const callNumber = vi.mocked(runAgent).mock.calls.length;
      abortSignals.push(options.abortSignal);
      markProviderDispatch(persona, instruction, options);
      if (callNumber === 3 || callNumber === 4) {
        runningBatchCount += 1;
        if (runningBatchCount === 2) {
          runningBatchesStarted();
        }
        await runningBatchGate.promise;
      }
      return makeResponse({
        persona: 'batch-worker',
        content: `batch-${callNumber}`,
        sessionId: `batch-session-${callNumber}`,
      });
    });

    const arpeggio: ArpeggioStepConfig = {
      source: 'csv',
      sourcePath: csvPath,
      batchSize: 1,
      concurrency: 2,
      templatePath,
      merge: { strategy: 'concat' },
      maxRetries: 0,
      retryDelayMs: 0,
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-arpeggio',
      maxSteps: 10,
      initialStep: 'process',
      steps: [makeStep('process', {
        arpeggio,
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    engine = new WorkflowEngine(config, projectCwd, 'test task', {
      projectCwd,
      reportDirName: REPORT_DIR,
      provider: 'mock',
      liveIntervention: store,
    } as LiveWorkflowEngineOptions);
    const runPromise = engine.run();
    await runningStarted;
    await store.issue('apply to future batches', '2026-09-03T00:00:00.000Z');
    runningBatchGate.resolve(undefined);

    const state = await runPromise;
    const calls = vi.mocked(runAgent).mock.calls;
    const rawEvents = readFileSync(store.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const deliveryEvents = rawEvents.filter((event) => event.type === 'delivered');

    expect(state.status).toBe('completed');
    expect(calls).toHaveLength(6);
    expect(calls.slice(0, 4).every((call) => !call[1].includes('apply to future batches'))).toBe(true);
    expect(calls.slice(4).every((call) => call[1].includes('apply to future batches'))).toBe(true);
    expect(abortSignals[2]?.aborted).toBe(false);
    expect(abortSignals[3]?.aborted).toBe(false);
    expect(deliveryEvents.length).toBeGreaterThan(0);
    expect(deliveryEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'delivered',
        mode: 'batch_boundary',
        step: 'process',
        processedBatchCount: 2,
        runningBatchIndexes: [2, 3],
        appliesToBatchIndexes: [4, 5],
        instructionIds: [1],
      }),
    ]));
    expect(store.read()).toMatchObject({
      pending: 0,
      deliveredNextStep: 1,
      instructions: [expect.objectContaining({
        content: 'apply to future batches',
        state: 'deliveredNextStep',
      })],
    });
  });

  it('settles the current delivery before preparing the next batch boundary under lock contention', async () => {
    const csvPath = join(projectCwd, 'settlement-data.csv');
    const templatePath = join(projectCwd, 'settlement-template.md');
    mkdirSync(projectCwd, { recursive: true });
    writeFileSync(csvPath, 'name,task\nAlice,one\nBob,two', 'utf8');
    writeFileSync(templatePath, 'Process {line:1}', 'utf8');

    const store = new LiveInterventionFileStore(projectCwd, REPORT_DIR);
    await store.issue('initial arpeggio instruction', '2026-09-03T00:00:00.000Z');
    const firstBatch = createDeferred<AgentResponse>();
    let firstBatchStarted!: () => void;
    const firstBatchStartedPromise = new Promise<void>((resolve) => {
      firstBatchStarted = resolve;
    });
    let commitReleased = false;
    let boundaryPreparedBeforeCommitRelease = false;
    let preparationCount = 0;
    const originalPrepareDelivery = store.prepareDelivery.bind(store);
    vi.spyOn(store, 'prepareDelivery').mockImplementation((context) => {
      preparationCount += 1;
      if (preparationCount > 1 && !commitReleased) {
        boundaryPreparedBeforeCommitRelease = true;
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
        await store.issue('next batch instruction', '2026-09-03T00:00:01.000Z');
        lockFd = openSync(lockPath, 'wx');
        markProviderDispatch(persona, instruction, options);
        firstBatchStarted();
        return firstBatch.promise;
      }
      markProviderDispatch(persona, instruction, options);
      return makeResponse({
        persona: 'batch-worker',
        content: 'batch-2',
        sessionId: 'batch-session-2',
      });
    });

    const arpeggio: ArpeggioStepConfig = {
      source: 'csv',
      sourcePath: csvPath,
      batchSize: 1,
      concurrency: 1,
      templatePath,
      merge: { strategy: 'concat' },
      maxRetries: 0,
      retryDelayMs: 0,
    };
    const config: WorkflowConfig = {
      name: 'live-intervention-arpeggio-settlement',
      maxSteps: 10,
      initialStep: 'process',
      steps: [makeStep('process', {
        arpeggio,
        rules: [makeRule('done', 'COMPLETE')],
      })],
    };

    try {
      engine = new WorkflowEngine(config, projectCwd, 'test task', {
        projectCwd,
        reportDirName: REPORT_DIR,
        provider: 'mock',
        liveIntervention: store,
      } as LiveWorkflowEngineOptions);
      const runPromise = engine.run();
      await firstBatchStartedPromise;
      firstBatch.resolve(makeResponse({
        persona: 'batch-worker',
        content: 'batch-1',
        sessionId: 'batch-session-1',
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
      expect(boundaryPreparedBeforeCommitRelease).toBe(false);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.[1]).toContain('initial arpeggio instruction');
      expect(calls[1]?.[1]).toContain('next batch instruction');
      expect(deliveryEvents).toEqual([
        expect.objectContaining({
          type: 'delivered',
          mode: 'batch_boundary',
          instructionIds: [1],
        }),
        expect.objectContaining({
          type: 'delivered',
          mode: 'batch_boundary',
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
});
