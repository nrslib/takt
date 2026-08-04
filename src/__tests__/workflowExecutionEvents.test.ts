import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionLog } from '../shared/utils/index.js';
import {
  finalizeWorkflowAbort,
  finalizeWorkflowSuccess,
  reportWorkflowCompletion,
} from '../features/tasks/execute/workflowExecutionReporting.js';
import type {
  AgentResponse,
  FindingLedger,
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowStep,
} from '../core/models/index.js';
import { initAnalyticsWriter } from '../features/analytics/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { AnalyticsEmitter } from '../features/tasks/execute/analyticsEmitter.js';
import { SessionLogger } from '../features/tasks/execute/sessionLogger.js';
import { bindWorkflowExecutionEvents } from '../features/tasks/execute/workflowExecutionEvents.js';
import { resetDebugLogger, setVerboseConsole } from '../shared/utils/debug.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import {
  type WorkflowExecutionScope,
  snapshotWorkflowExecutionScope,
} from '../core/workflow/workflow-execution-scope.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { runAgent } from '../agents/runner.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));

const { mockSaveSessionState } = vi.hoisted(() => ({
  mockSaveSessionState: vi.fn(),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveSessionState: (...args: unknown[]) => mockSaveSessionState(...args),
}));

const SCOPED_EVENT_ARGUMENT_COUNTS: Readonly<Record<string, number>> = {
  'step:start': 8,
  'step:complete': 4,
  'routing:decision': 8,
  'phase:start': 7,
  'phase:complete': 8,
  'phase:judge_stage': 6,
  'step:report': 4,
  'findings:ledger': 2,
};

class TestEngine extends EventEmitter {
  public abort = vi.fn();

  constructor(
    private readonly resumePoint: WorkflowResumePoint,
    private readonly findingIds: string[] = [],
  ) {
    super();
  }

  getResumePoint(): WorkflowResumePoint {
    return this.resumePoint;
  }

  getExecutionScope(): WorkflowExecutionScope {
    return snapshotWorkflowExecutionScope(this.resumePoint.stack);
  }

  emitScoped(
    executionScope: WorkflowExecutionScope,
    eventName: string,
    ...args: unknown[]
  ): boolean {
    const expectedArgumentCount = SCOPED_EVENT_ARGUMENT_COUNTS[eventName];
    if (expectedArgumentCount === undefined) {
      return super.emit(eventName, ...args);
    }
    const contractArgs = [...args];
    if (eventName === 'routing:decision' && contractArgs.length === 7) {
      contractArgs.push(this.resumePoint.stack[0]?.workflow);
    }
    if (eventName === 'step:start' && contractArgs.length < 8) {
      while (contractArgs.length < 7) {
        contractArgs.push(undefined);
      }
      contractArgs.push(this.resumePoint.max_steps ?? 5);
    }
    while (contractArgs.length < expectedArgumentCount) {
      contractArgs.push(undefined);
    }
    return super.emit(eventName, ...contractArgs, executionScope);
  }

  getState() {
    return {
      findings: {
        open: {
          items: this.findingIds.map((id) => ({ id })),
        },
      },
    };
  }
}

function createBridgeHarness(options?: {
  currentProvider?: string;
  configuredModel?: string;
  resumePoint?: WorkflowResumePoint;
  findingIds?: string[];
  traceDiscovery?: { queries: string[] };
  eventSink?: ReturnType<typeof vi.fn>;
  shouldNotifyRateLimit?: boolean;
}) {
  const resumePoint = options?.resumePoint ?? {
    version: 2,
    stack: [{ workflow: 'parent', step: 'review', kind: 'agent' }],
    iteration: 2,
    elapsed_ms: 100,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  } satisfies WorkflowResumePoint;
  const engine = new TestEngine(resumePoint, options?.findingIds);
  const out = {
    info: vi.fn(),
    blankLine: vi.fn(),
    status: vi.fn(),
    error: vi.fn(),
    logLine: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };
  const prefixWriter = {
    setStepContext: vi.fn(),
    flush: vi.fn(),
  };
  const runMetaManager = {
    updateStep: vi.fn(),
    updatePhase: vi.fn(),
    updateResumePoint: vi.fn(),
    finalize: vi.fn(),
  };
  const analyticsEmitter = {
    onStepComplete: vi.fn(),
    onStepReport: vi.fn(),
    onFindingLedgerUpdated: vi.fn(),
    seedFindingContractFindingIds: vi.fn(),
    onRoutingDecision: vi.fn(),
  };
  const usageEventLogger = {
    logUsageFor: vi.fn(),
  };
  const sessionLogger = {
    onPhaseStart: vi.fn(),
    setIteration: vi.fn(),
    onPhaseComplete: vi.fn(),
    onJudgeStage: vi.fn(),
    onStepStart: vi.fn(),
    onStepComplete: vi.fn(),
    onWorkflowCallStart: vi.fn(),
    onWorkflowCallComplete: vi.fn(),
    onWorkflowComplete: vi.fn(),
    onWorkflowAbort: vi.fn(),
  };
  const bridge = bindWorkflowExecutionEvents({
    engine: engine as never,
    workflowConfig: {
      name: 'parent',
      maxSteps: 5,
      steps: [{ name: 'review' }],
    },
    task: 'task',
    projectCwd: '/tmp/project',
    currentProvider: (options?.currentProvider ?? 'mock') as never,
    configuredModel: options?.configuredModel,
    out: out as never,
    prefixWriter: prefixWriter as never,
    displayRef: { current: null },
    handlerRef: { current: null },
    usageEventLogger: usageEventLogger as never,
    analyticsEmitter: analyticsEmitter as never,
    sessionLogger: sessionLogger as never,
    runMetaManager: runMetaManager as never,
    ndjsonLogPath: '/tmp/project/run/logs/session.jsonl',
    shouldNotifyRateLimit: options?.shouldNotifyRateLimit ?? false,
    shouldNotifyWorkflowComplete: false,
    shouldNotifyWorkflowAbort: false,
    writeTraceReportOnce: vi.fn(),
    traceDiscovery: options?.traceDiscovery,
    initialResumePoint: resumePoint,
    sessionLog: {
      task: 'task',
      projectDir: '/tmp/project',
      workflowName: 'parent',
      iterations: 0,
      startTime: new Date().toISOString(),
      status: 'running',
      history: [],
    },
    eventSink: options?.eventSink,
    reportDirectory: '/tmp/project/run/reports',
  });

  return {
    bridge,
    engine,
    out,
    runMetaManager,
    prefixWriter,
    resumePoint,
    analyticsEmitter,
    usageEventLogger,
    sessionLogger,
  };
}

function bindActualWorkflowConsumers(
  engine: WorkflowEngine,
  workflowConfig: WorkflowConfig & { maxSteps: number | 'infinite' },
  root: string,
  runSlug: string,
) {
  const ndjsonLogPath = join(root, 'logs', `${runSlug}.jsonl`);
  const analyticsDir = join(root, 'analytics');
  mkdirSync(join(root, 'logs'), { recursive: true });
  initAnalyticsWriter(true, analyticsDir);
  const usageEventLogger = { logUsageFor: vi.fn() };
  const sessionLogger = new SessionLogger(ndjsonLogPath, true);
  const analyticsEmitter = new AnalyticsEmitter(runSlug, false);
  bindWorkflowExecutionEvents({
    engine,
    workflowConfig,
    task: 'scope task',
    projectCwd: root,
    currentProvider: 'mock',
    configuredModel: undefined,
    out: {
      info: vi.fn(), blankLine: vi.fn(), status: vi.fn(), error: vi.fn(),
      logLine: vi.fn(), success: vi.fn(), warn: vi.fn(),
    } as never,
    prefixWriter: undefined,
    displayRef: { current: null },
    handlerRef: { current: null },
    usageEventLogger: usageEventLogger as never,
    analyticsEmitter,
    sessionLogger,
    runMetaManager: {
      updateStep: vi.fn(), updatePhase: vi.fn(), updateResumePoint: vi.fn(), finalize: vi.fn(),
    } as never,
    ndjsonLogPath,
    shouldNotifyRateLimit: false,
    shouldNotifyWorkflowComplete: false,
    shouldNotifyWorkflowAbort: false,
    writeTraceReportOnce: vi.fn(),
    initialResumePoint: undefined,
    sessionLog: {
      task: 'scope task', projectDir: root, workflowName: workflowConfig.name,
      iterations: 0, startTime: new Date().toISOString(), status: 'running', history: [],
    },
    eventSink: undefined,
    reportDirectory: join(root, '.takt', 'runs', runSlug, 'reports'),
  });
  return { analyticsDir, ndjsonLogPath, usageEventLogger };
}

function readNdjsonRecords(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createDeferredAgentResponse() {
  let resolve!: (response: AgentResponse) => void;
  const promise = new Promise<AgentResponse>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('bindWorkflowExecutionEvents', () => {
  it('実 WorkflowEngine の scope を SessionLogger と AnalyticsEmitter まで保持する', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-event-integration-'));
    const ndjsonLogPath = join(root, 'logs', 'session.jsonl');
    const analyticsDir = join(root, 'analytics');
    mkdirSync(join(root, 'logs'), { recursive: true });
    initAnalyticsWriter(true, analyticsDir);
    try {
      const workflowConfig = {
        name: 'actual-engine-scope',
        initialStep: 'review',
        maxSteps: 2,
        steps: [{
          name: 'review',
          persona: 'reviewer',
          personaDisplayName: 'Reviewer',
          instruction: 'Review actual scope',
          provider: 'mock' as const,
          rules: [normalizeRule({ condition: 'when(true)', next: 'COMPLETE' })],
        }],
      };
      const engine = new WorkflowEngine(workflowConfig, root, 'scope task', {
        projectCwd: root,
        reportDirName: 'actual-engine-run',
        provider: 'mock',
      });
      vi.mocked(runAgent).mockImplementationOnce(async (persona, prompt, options) => {
        options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
        return {
          persona: String(persona),
          status: 'done',
          content: 'approved',
          timestamp: new Date('2026-08-01T00:00:00.000Z'),
          providerUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, usageMissing: false },
        };
      });
      const usageEventLogger = { logUsageFor: vi.fn() };
      const sessionLogger = new SessionLogger(ndjsonLogPath, true);
      const analyticsEmitter = new AnalyticsEmitter('actual-engine-run', false);
      const out = {
        info: vi.fn(), blankLine: vi.fn(), status: vi.fn(), error: vi.fn(),
        logLine: vi.fn(), success: vi.fn(), warn: vi.fn(),
      };
      bindWorkflowExecutionEvents({
        engine,
        workflowConfig,
        task: 'scope task',
        projectCwd: root,
        currentProvider: 'mock',
        configuredModel: undefined,
        out: out as never,
        prefixWriter: undefined,
        displayRef: { current: null },
        handlerRef: { current: null },
        usageEventLogger: usageEventLogger as never,
        analyticsEmitter,
        sessionLogger,
        runMetaManager: {
          updateStep: vi.fn(), updatePhase: vi.fn(), updateResumePoint: vi.fn(), finalize: vi.fn(),
        } as never,
        ndjsonLogPath,
        shouldNotifyRateLimit: false,
        shouldNotifyWorkflowComplete: false,
        shouldNotifyWorkflowAbort: false,
        writeTraceReportOnce: vi.fn(),
        initialResumePoint: undefined,
        sessionLog: {
          task: 'scope task', projectDir: root, workflowName: workflowConfig.name,
          iterations: 0, startTime: new Date().toISOString(), status: 'running', history: [],
        },
        eventSink: undefined,
        reportDirectory: join(root, '.takt', 'runs', 'actual-engine-run', 'reports'),
      });

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const records = readFileSync(ndjsonLogPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; stack?: unknown; iteration?: number });
      const stepStart = records.find((record) => record.type === 'step_start');
      const stepComplete = records.find((record) => record.type === 'step_complete');
      expect(stepStart?.stack).toEqual([{ workflow: 'actual-engine-scope', step: 'review', kind: 'agent' }]);
      expect(stepComplete?.stack).toEqual(stepStart?.stack);
      expect(stepComplete?.iteration).toBe(1);
      expect(usageEventLogger.logUsageFor).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'mock', step: 'review' }),
        expect.objectContaining({ success: true }),
      );
      const analyticsFiles = readdirSync(analyticsDir);
      const analyticsRecords = analyticsFiles.flatMap((file) => readFileSync(join(analyticsDir, file), 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>));
      expect(analyticsRecords).toContainEqual(expect.objectContaining({
        type: 'step_result', step: 'review', provider: 'mock', iteration: 1,
      }));
    } finally {
      resetAnalyticsWriter();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('実 Engine と公開 consumer は mixed parallel の child 解決失敗でも親 scope と元エラーを保持する', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-event-parallel-failure-'));
    const workflowConfig: WorkflowConfig & { maxSteps: number } = {
      name: 'parallel-parent',
      initialStep: 'reviewers',
      maxSteps: 3,
      steps: [{
        name: 'reviewers',
        personaDisplayName: 'Reviewers',
        instruction: 'Run reviewers',
        parallel: [
          {
            name: 'delegate-review',
            kind: 'workflow_call',
            call: 'missing/review',
            personaDisplayName: 'Delegated review',
            instruction: '',
            rules: [normalizeRule({ condition: 'COMPLETE', next: 'COMPLETE' })],
          },
          {
            name: 'local-review',
            persona: 'local-reviewer',
            personaDisplayName: 'Local reviewer',
            instruction: 'Review locally',
            provider: 'mock',
            rules: [normalizeRule({ condition: 'when(true)', next: 'COMPLETE' })],
          },
        ],
        rules: [normalizeRule({ condition: 'when(true)', next: 'COMPLETE' })],
      }],
    };
    const engine = new WorkflowEngine(workflowConfig, root, 'scope task', {
      projectCwd: root,
      reportDirName: 'parallel-failure',
      provider: 'mock',
      workflowCallResolver: () => null,
    });
    vi.mocked(runAgent).mockImplementationOnce(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      return {
        persona: String(persona),
        status: 'done',
        content: 'local review complete',
        timestamp: new Date('2026-08-01T00:00:00.000Z'),
      };
    });
    const { ndjsonLogPath } = bindActualWorkflowConsumers(
      engine,
      workflowConfig,
      root,
      'parallel-failure',
    );
    try {
      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(state.stepOutputs.get('delegate-review')?.error).toContain(
        'references unknown workflow "missing/review"',
      );
      const records = readNdjsonRecords(ndjsonLogPath);
      const parentRecords = records.filter((record) => (
        record.step === 'reviewers'
        && (record.type === 'step_start' || record.type === 'step_complete')
      ));
      expect(parentRecords).toHaveLength(2);
      expect(parentRecords[1]?.stack).toEqual(parentRecords[0]?.stack);
      expect(parentRecords[0]?.stack).toEqual([
        expect.objectContaining({ workflow: 'parallel-parent', step: 'reviewers', kind: 'agent' }),
      ]);
      const localPhaseRecords = records.filter((record) => (
        record.step === 'local-review'
        && (record.type === 'phase_start' || record.type === 'phase_complete')
      ));
      expect(localPhaseRecords).toHaveLength(2);
      expect(localPhaseRecords[1]?.stack).toEqual(localPhaseRecords[0]?.stack);
      expect(localPhaseRecords[0]?.stack).toEqual(parentRecords[0]?.stack);
    } finally {
      resetAnalyticsWriter();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('実 Engine と公開 consumer は parallel child の逆順完了を provider 別 scope へ帰属する', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-event-parallel-provider-'));
    const childA: WorkflowConfig = {
      name: 'child-a',
      subworkflow: { callable: true, visibility: 'internal' },
      initialStep: 'review-a',
      steps: [{
        name: 'review-a',
        persona: 'reviewer-a',
        personaDisplayName: 'Reviewer A',
        instruction: 'Review A',
        provider: 'claude-sdk',
        model: 'claude-sonnet-4-5',
        rules: [normalizeRule({ condition: 'when(true)', next: 'COMPLETE' })],
      }],
    };
    const childB: WorkflowConfig = {
      name: 'child-b',
      subworkflow: { callable: true, visibility: 'internal' },
      initialStep: 'review-b',
      steps: [{
        name: 'review-b',
        persona: 'reviewer-b',
        personaDisplayName: 'Reviewer B',
        instruction: 'Review B',
        provider: 'codex',
        model: 'gpt-5',
        rules: [normalizeRule({ condition: 'when(true)', next: 'COMPLETE' })],
      }],
    };
    const workflowConfig: WorkflowConfig & { maxSteps: number } = {
      name: 'parallel-provider-parent',
      initialStep: 'reviewers',
      maxSteps: 4,
      steps: [{
        name: 'reviewers',
        personaDisplayName: 'Reviewers',
        instruction: 'Run delegated reviewers',
        parallel: [
          {
            name: 'delegate-a',
            kind: 'workflow_call',
            call: 'child-a',
            personaDisplayName: 'Delegate A',
            instruction: '',
            rules: [normalizeRule({ condition: 'COMPLETE', next: 'COMPLETE' })],
          },
          {
            name: 'delegate-b',
            kind: 'workflow_call',
            call: 'child-b',
            personaDisplayName: 'Delegate B',
            instruction: '',
            rules: [normalizeRule({ condition: 'COMPLETE', next: 'COMPLETE' })],
          },
        ],
        rules: [normalizeRule({ condition: 'all("COMPLETE")', next: 'COMPLETE' })],
      }],
    };
    const workflows = new Map([
      [childA.name, childA],
      [childB.name, childB],
    ]);
    const engine = new WorkflowEngine(workflowConfig, root, 'scope task', {
      projectCwd: root,
      reportDirName: 'parallel-provider',
      provider: 'mock',
      workflowCallResolver: ({ step }) => workflows.get(step.call) ?? null,
    });
    const deferredA = createDeferredAgentResponse();
    const deferredB = createDeferredAgentResponse();
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      if (persona === 'reviewer-a') {
        return deferredA.promise;
      }
      if (persona === 'reviewer-b') {
        return deferredB.promise;
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    const { analyticsDir, ndjsonLogPath } = bindActualWorkflowConsumers(
      engine,
      workflowConfig,
      root,
      'parallel-provider',
    );
    try {
      const statePromise = engine.run();
      await vi.waitFor(() => expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2));
      deferredB.resolve({
        persona: 'reviewer-b', status: 'done', content: 'B complete',
        timestamp: new Date('2026-08-01T00:00:01.000Z'),
      });
      await vi.waitFor(() => {
        const records = readNdjsonRecords(ndjsonLogPath);
        expect(records.some((record) => record.type === 'step_complete' && record.step === 'review-b')).toBe(true);
      });
      deferredA.resolve({
        persona: 'reviewer-a', status: 'done', content: 'A complete',
        timestamp: new Date('2026-08-01T00:00:02.000Z'),
      });
      const state = await statePromise;

      expect(state.status).toBe('completed');
      const sessionRecords = readNdjsonRecords(ndjsonLogPath);
      for (const stepName of ['review-a', 'review-b']) {
        const start = sessionRecords.find((record) => record.type === 'step_start' && record.step === stepName);
        const complete = sessionRecords.find((record) => record.type === 'step_complete' && record.step === stepName);
        expect(start?.stack).toEqual(expect.arrayContaining([
          expect.objectContaining({ step: 'reviewers' }),
          expect.objectContaining({ step: stepName === 'review-a' ? 'delegate-a' : 'delegate-b', kind: 'workflow_call' }),
          expect.objectContaining({ step: stepName }),
        ]));
        expect(complete?.stack).toEqual(start?.stack);
      }
      const analyticsRecords = readdirSync(analyticsDir).flatMap((file) => (
        readNdjsonRecords(join(analyticsDir, file))
      ));
      const resultEvents = analyticsRecords.filter((record) => record.type === 'step_result');
      expect(resultEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ step: 'review-a', provider: 'claude-sdk', model: 'claude-sonnet-4-5' }),
        expect.objectContaining({ step: 'review-b', provider: 'codex', model: 'gpt-5' }),
        expect.objectContaining({ step: 'reviewers', provider: 'mock', model: '(default)' }),
      ]));
      expect(resultEvents.map((record) => record.step)).toEqual(['review-b', 'review-a', 'reviewers']);
    } finally {
      resetAnalyticsWriter();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('event bridge が run meta と実行結果を同期する', () => {
    const { bridge, engine, runMetaManager, prefixWriter, resumePoint } = createBridgeHarness();

    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
      rules: [normalizeRule({ condition: 'COMPLETE', next: 'COMPLETE' })],
    } as WorkflowStep;
    const response = {
      persona: 'reviewer',
      status: 'done',
      content: 'approved',
      timestamp: new Date(),
      matchedRuleIndex: 0,
    };

    engine.emitScoped(engine.getExecutionScope(),
      'step:start',
      step,
      2,
      'instruction',
      { provider: 'mock', model: 'gpt-test' },
      'parent',
      step.name,
      7,
    );
    engine.emitScoped(engine.getExecutionScope(), 'phase:start', step, 1, 'main', 'instruction', [], 'phase-1', 2);
    engine.emitScoped(engine.getExecutionScope(), 'phase:complete', step, 1, 'main', 'approved', 'done', undefined, 'phase-1', 2);
    engine.emitScoped(engine.getExecutionScope(), 'step:complete', step, response, 'instruction', step.name);
    engine.emitScoped(engine.getExecutionScope(), 'workflow:complete', { iteration: 2 });

    expect(runMetaManager.updateStep).toHaveBeenCalledWith('review', 2, resumePoint);
    expect(prefixWriter.setStepContext).toHaveBeenCalledWith({
      stepName: 'review',
      iteration: 2,
      maxSteps: 5,
      stepIteration: 7,
    });
    expect(runMetaManager.updatePhase).toHaveBeenCalledTimes(2);
    expect(runMetaManager.updatePhase.mock.calls[0]?.slice(0, 3)).toEqual(['review', 2, 1]);
    expect(runMetaManager.updatePhase.mock.calls[1]?.slice(0, 3)).toEqual(['review', 2, 1]);
    expect(runMetaManager.updateResumePoint).toHaveBeenCalledWith(resumePoint);
    expect(runMetaManager.finalize).toHaveBeenCalledWith('completed', 2);
    expect(bridge.state.lastStepName).toBe('review');
    expect(bridge.state.lastStepContent).toBe('approved');
    expect(bridge.state.sessionLog.iterations).toBe(2);
  });

  it('内部 step は観測名を維持しつつ再開可能な実 step を run meta に保存する', () => {
    const { bridge, engine, runMetaManager, resumePoint } = createBridgeHarness();
    const judgeStep = {
      name: '_loop_judge_review_fix',
      personaDisplayName: 'loop-judge',
      instruction: '',
      rules: [normalizeRule({ condition: 'done', next: 'review' })],
    } as WorkflowStep;
    const response = {
      persona: 'loop-judge',
      status: 'done',
      content: 'continue',
      timestamp: new Date(),
      matchedRuleIndex: 0,
    };

    engine.emitScoped(engine.getExecutionScope(),
      'step:start',
      judgeStep,
      8,
      'judge',
      { provider: 'mock', model: 'gpt-test' },
      'parent',
      'review',
    );
    engine.emitScoped(engine.getExecutionScope(), 'phase:start', judgeStep, 3, 'judge', 'judge', [], 'judge-phase', 8);
    engine.emitScoped(engine.getExecutionScope(),
      'phase:complete',
      judgeStep,
      3,
      'judge',
      'continue',
      'done',
      undefined,
      'judge-phase',
      8,
    );
    engine.emitScoped(engine.getExecutionScope(), 'step:complete', judgeStep, response, 'judge', 'review');

    expect(runMetaManager.updateStep).toHaveBeenCalledWith('review', 8, resumePoint);
    expect(runMetaManager.updatePhase).toHaveBeenCalledTimes(2);
    expect(runMetaManager.updatePhase.mock.calls.map((call) => call[0])).toEqual(['review', 'review']);
    expect(bridge.state.currentStepName).toBe('review');
    expect(bridge.state.lastStepName).toBe('review');
  });

  it('workflow abort kind を実行状態に保持する', () => {
    const { bridge, engine } = createBridgeHarness();

    engine.emitScoped(engine.getExecutionScope(),
      'workflow:abort',
      { iteration: 3 },
      'Workflow aborted by step transition',
      'step_transition',
    );

    expect(bridge.state.abortKind).toBe('step_transition');
  });

  it('findings ledger event を analytics emitter に渡す', () => {
    const { engine, analyticsEmitter } = createBridgeHarness();
    const ledger: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-06-13T01:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };

    engine.emitScoped(engine.getExecutionScope(), 'findings:ledger', ledger, 2);

    expect(analyticsEmitter.onFindingLedgerUpdated).toHaveBeenCalledWith(ledger, 2);
  });

  it('workflow complete event が TraceQL discovery を完了出力へ渡す', () => {
    const { engine, out } = createBridgeHarness({
      traceDiscovery: {
        queries: ['{ resource.service.name = "takt" && span."takt.run.id" = "run-843" }'],
      },
    });

    engine.emitScoped(engine.getExecutionScope(), 'workflow:complete', { iteration: 2 });

    expect(out.info).toHaveBeenCalledWith('TraceQL discovery:');
    expect(out.info).toHaveBeenCalledWith(
      '  { resource.service.name = "takt" && span."takt.run.id" = "run-843" }',
    );
  });

  it('workflow abort event が TraceQL discovery を abort 出力へ渡す', () => {
    const { engine, out } = createBridgeHarness({
      traceDiscovery: {
        queries: ['{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }'],
      },
    });

    engine.emitScoped(engine.getExecutionScope(), 'workflow:abort', { iteration: 2 }, 'Step "write_tests" failed');

    expect(out.info).toHaveBeenCalledWith('TraceQL discovery:');
    expect(out.info).toHaveBeenCalledWith(
      '  { resource.service.name = "takt" && span."takt.task.issue_number" = 792 }',
    );
  });

  it('finding ledger analytics の書き込み失敗後も workflow complete を処理する', () => {
    const analyticsRoot = mkdtempSync(join(tmpdir(), 'takt-test-ledger-analytics-failure-'));
    const analyticsPath = join(analyticsRoot, 'not-a-directory');
    writeFileSync(analyticsPath, 'not a directory', 'utf-8');
    initAnalyticsWriter(true, analyticsPath);
    try {
      const actualAnalyticsEmitter = new AnalyticsEmitter('run-ledger', false);
      const { engine, runMetaManager, analyticsEmitter } = createBridgeHarness();
      analyticsEmitter.onFindingLedgerUpdated.mockImplementation((ledger: FindingLedger, iteration: number) => {
        actualAnalyticsEmitter.onFindingLedgerUpdated(ledger, iteration);
      });
      const ledger: FindingLedger = {
        workflowName: 'peer-review',
        nextId: 2,
        updatedAt: '2026-06-13T02:30:00.000Z',
        findings: [
          {
            id: 'F-0001',
            status: 'open',
            lifecycle: 'new',
            revision: 1,
            severity: 'high',
            title: 'Analytics write should not abort workflow',
            reviewers: ['architecture-reviewer'],
            rawFindingIds: ['run:reviewers:1:architecture-review:raw-1'],
            firstSeen: { runId: 'run', stepName: 'reviewers', timestamp: '2026-06-13T02:00:00.000Z' },
            lastSeen: { runId: 'run', stepName: 'reviewers', timestamp: '2026-06-13T02:00:00.000Z' },
          },
        ],
        rawFindings: [],
        conflicts: [],
        interpretations: [],
      };

      expect(() => engine.emitScoped(engine.getExecutionScope(), 'findings:ledger', ledger, 2)).not.toThrow();
      expect(() => engine.emitScoped(engine.getExecutionScope(), 'workflow:complete', { iteration: 3 })).not.toThrow();

      expect(runMetaManager.finalize).toHaveBeenCalledWith('completed', 3);
    } finally {
      resetAnalyticsWriter();
      rmSync(analyticsRoot, { recursive: true, force: true });
    }
  });

  it('event bridge 初期化時に既存 open finding id を analytics emitter に渡す', () => {
    const { analyticsEmitter } = createBridgeHarness({ findingIds: ['F-0001', 'F-0002'] });

    expect(analyticsEmitter.seedFindingContractFindingIds).toHaveBeenCalledWith(['F-0001', 'F-0002']);
  });

  it('routing decision event を analytics emitter に渡す', () => {
    const { engine, analyticsEmitter } = createBridgeHarness();
    const step = {
      name: 'implement.part-1',
      personaDisplayName: 'Coder',
      instruction: 'Implement API',
    } as WorkflowStep;
    const response = {
      persona: 'implement.part-1',
      status: 'done',
      content: 'done',
      timestamp: new Date('2026-02-18T10:00:00.000Z'),
    };
    const providerInfo = {
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.dynamic',
      autoRoutingDecision: {
        candidateName: 'coding',
        routingTier: 'medium',
        strategy: 'balanced',
        candidateCount: 2,
      },
    };

    engine.emitScoped(engine.getExecutionScope(), 'routing:decision', step, response, 'Implement API', providerInfo, 'agent', 1234, 2);

    expect(analyticsEmitter.onRoutingDecision).toHaveBeenCalledWith(
      step,
      response,
      'Implement API',
      providerInfo,
      'agent',
      1234,
      2,
      'parent',
    );
  });

  it('step model が明示省略された場合は configured model へ戻さず default として記録する', () => {
    const { engine, out, usageEventLogger, analyticsEmitter } = createBridgeHarness({
      currentProvider: 'cursor',
      configuredModel: 'global-model',
    });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
      provider: 'cursor',
      model: undefined,
      modelSource: 'step',
    }, 'parent', step.name);

    expect(out.info).toHaveBeenCalledWith('Model: (default)');
    expect(usageEventLogger.logUsageFor).not.toHaveBeenCalled();
  });

  it('workflow_call wrapper を usage として記録せず child 実 step の usage context だけを保持する', () => {
    const { engine, usageEventLogger } = createBridgeHarness();
    const childStep = {
      name: 'child-implement',
      personaDisplayName: 'Child coder',
      instruction: '',
      rules: [],
    } as WorkflowStep;
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, usageMissing: false };

    engine.emitScoped(engine.getExecutionScope(), 'step:start', childStep, 1, 'implement', {
      provider: 'claude',
      model: 'child-model',
    }, 'parent', childStep.name);
    engine.emitScoped(engine.getExecutionScope(), 'step:complete', childStep, {
      persona: 'child-implement',
      status: 'done',
      content: 'child done',
      timestamp: new Date(),
      providerUsage: usage,
    }, 'implement', childStep.name);
    expect(usageEventLogger.logUsageFor.mock.calls).toEqual([
      [
        expect.objectContaining({
          provider: 'claude',
          providerModel: 'child-model',
          step: 'child-implement',
          stepType: 'normal',
        }),
        expect.objectContaining({ success: true, usage }),
      ],
    ]);
  });

  it('arpeggio parent の集約 usage と analytics を実 provider identity へ記録する', () => {
    const { engine, usageEventLogger, analyticsEmitter } = createBridgeHarness();
    const step = {
      name: 'batch-review',
      personaDisplayName: 'Batch reviewer',
      instruction: '',
      arpeggio: {
        source: 'csv', sourcePath: 'input.csv', batchSize: 1, concurrency: 1,
        templatePath: 'template.md', merge: { strategy: 'concat' }, maxRetries: 0, retryDelayMs: 0,
      },
      rules: [],
    } as WorkflowStep;
    const response = {
      persona: 'batch-review',
      status: 'done',
      content: 'merged',
      timestamp: new Date('2026-08-01T00:00:00.000Z'),
      providerUsage: { inputTokens: 9, outputTokens: 4, totalTokens: 13, usageMissing: false },
    } as const;
    const scope = engine.getExecutionScope();

    engine.emitScoped(scope, 'step:start', step, 2, '', {
      provider: 'codex', model: 'gpt-5',
    }, 'parent', step.name, 1, 5);
    engine.emitScoped(scope, 'step:complete', step, response, '', step.name);

    expect(usageEventLogger.logUsageFor).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex', providerModel: 'gpt-5', step: 'batch-review', stepType: 'arpeggio',
      }),
      expect.objectContaining({ success: true, usage: response.providerUsage }),
    );
    expect(analyticsEmitter.onStepComplete).toHaveBeenCalledWith(
      step,
      response,
      { iteration: 2, provider: 'codex', model: 'gpt-5' },
    );
  });

  it('parallel child の完了順に依存せず provider・model・iteration を scope ごとに保持する', () => {
    const { engine, analyticsEmitter } = createBridgeHarness();
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
      rules: [],
    } as WorkflowStep;
    const scopeA = snapshotWorkflowExecutionScope([
      { workflow: 'parent', step: 'reviewers', kind: 'agent' },
      { workflow: 'child-a', step: 'review', kind: 'agent' },
    ]);
    const scopeB = snapshotWorkflowExecutionScope([
      { workflow: 'parent', step: 'reviewers', kind: 'agent' },
      { workflow: 'child-b', step: 'review', kind: 'agent' },
    ]);
    const responseA = {
      persona: 'reviewer-a',
      status: 'done',
      content: 'A done',
      timestamp: new Date('2026-08-01T00:00:00.000Z'),
    } as const;
    const responseB = {
      persona: 'reviewer-b',
      status: 'done',
      content: 'B done',
      timestamp: new Date('2026-08-01T00:00:01.000Z'),
    } as const;

    engine.emitScoped(scopeA, 'step:start', step, 1, 'A', { provider: 'claude', model: 'sonnet' }, 'child-a', step.name, 1, 5);
    engine.emitScoped(scopeB, 'step:start', step, 2, 'B', { provider: 'codex', model: 'gpt-5' }, 'child-b', step.name, 1, 5);
    engine.emitScoped(scopeB, 'step:complete', step, responseB, 'B', step.name);
    engine.emitScoped(scopeA, 'step:complete', step, responseA, 'A', step.name);

    expect(analyticsEmitter.onStepComplete.mock.calls).toEqual([
      [step, responseB, { iteration: 2, provider: 'codex', model: 'gpt-5' }],
      [step, responseA, { iteration: 1, provider: 'claude', model: 'sonnet' }],
    ]);
  });

  it('workflow_call lifecycle を agent step の副作用なしで session logger へ渡す', () => {
    const {
      engine,
      sessionLogger,
      usageEventLogger,
      analyticsEmitter,
      runMetaManager,
    } = createBridgeHarness();
    const lifecycle = {
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      callInstance: 2,
      stack: [
        {
          workflow: 'parent',
          step: 'delegate',
          kind: 'workflow_call' as const,
          call_instance: 2,
        },
      ],
    };
    const completion = {
      ...lifecycle,
      result: {
        status: 'completed' as const,
        returnValue: 'approved',
      },
    };

    engine.emitScoped(engine.getExecutionScope(), 'workflow_call:start', lifecycle);
    engine.emitScoped(engine.getExecutionScope(), 'workflow_call:complete', completion);

    expect(sessionLogger.onWorkflowCallStart).toHaveBeenCalledWith(lifecycle);
    expect(sessionLogger.onWorkflowCallComplete).toHaveBeenCalledWith(completion);
    expect(usageEventLogger.logUsageFor).not.toHaveBeenCalled();
    expect(analyticsEmitter.onStepComplete).not.toHaveBeenCalled();
    expect(runMetaManager.updateStep).not.toHaveBeenCalled();
  });

  it.each([
    ['parallel', {
      parallel: [{ name: 'child', persona: 'reviewer', instruction: 'review', rules: [] }],
    }],
    ['team_leader', {
      name: 'fix',
      edit: true,
      teamLeader: { maxConcurrency: 1, refillThreshold: 0, timeoutMs: 1000 },
    }],
    ['system', { kind: 'system' }],
  ])('%s step は analytics を維持し agent usage だけを記録しない', (_stepType, delegatedConfig) => {
    const { engine, usageEventLogger, analyticsEmitter } = createBridgeHarness({
      currentProvider: 'codex',
      configuredModel: 'gpt-5',
    });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
      ...delegatedConfig,
    } as WorkflowStep;
    const response = {
      persona: 'review',
      status: 'done',
      content: 'Fixed AI-001',
      timestamp: new Date('2026-08-01T00:00:00.000Z'),
    } as const;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', undefined, 'parent', step.name);
    engine.emitScoped(engine.getExecutionScope(), 'step:complete', step, response, 'instruction', step.name);

    expect(usageEventLogger.logUsageFor).not.toHaveBeenCalled();
    expect(analyticsEmitter.onStepComplete).toHaveBeenCalledWith(
      step,
      response,
      { iteration: 1, provider: 'codex', model: 'gpt-5' },
    );
  });

  it('実 AnalyticsEmitter は delegated・system の step_result と team-leader fix の fix_action を発行する', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-event-delegated-analytics-'));
    const analyticsDir = join(root, 'analytics');
    initAnalyticsWriter(true, analyticsDir);
    try {
      const resumePoint = {
        version: 2 as const,
        stack: [{ workflow: 'parent', step: 'review', kind: 'agent' as const }],
        iteration: 3,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      };
      const engine = new TestEngine(resumePoint);
      const usageEventLogger = { logUsageFor: vi.fn() };
      const analyticsEmitter = new AnalyticsEmitter('delegated-run', false);
      bindWorkflowExecutionEvents({
        engine: engine as never,
        workflowConfig: {
          name: 'parent',
          maxSteps: 5,
          steps: [{ name: 'reviewers' }, { name: 'fix' }, { name: 'sync' }],
        },
        task: 'task',
        projectCwd: root,
        currentProvider: 'mock',
        configuredModel: 'root-model',
        out: {
          info: vi.fn(), blankLine: vi.fn(), status: vi.fn(), error: vi.fn(),
          logLine: vi.fn(), success: vi.fn(), warn: vi.fn(),
        } as never,
        prefixWriter: undefined,
        displayRef: { current: null },
        handlerRef: { current: null },
        usageEventLogger: usageEventLogger as never,
        analyticsEmitter,
        sessionLogger: {
          onPhaseStart: vi.fn(), setIteration: vi.fn(), onPhaseComplete: vi.fn(),
          onJudgeStage: vi.fn(), onStepStart: vi.fn(), onStepComplete: vi.fn(),
          onWorkflowCallStart: vi.fn(), onWorkflowCallComplete: vi.fn(),
          onWorkflowComplete: vi.fn(), onWorkflowAbort: vi.fn(),
        } as never,
        runMetaManager: {
          updateStep: vi.fn(), updatePhase: vi.fn(), updateResumePoint: vi.fn(), finalize: vi.fn(),
        } as never,
        ndjsonLogPath: join(root, 'session.jsonl'),
        shouldNotifyRateLimit: false,
        shouldNotifyWorkflowComplete: false,
        shouldNotifyWorkflowAbort: false,
        writeTraceReportOnce: vi.fn(),
        initialResumePoint: resumePoint,
        sessionLog: {
          task: 'task', projectDir: root, workflowName: 'parent', iterations: 0,
          startTime: new Date().toISOString(), status: 'running', history: [],
        },
        eventSink: undefined,
        reportDirectory: join(root, 'reports'),
      });
      const steps = [
        {
          name: 'reviewers',
          personaDisplayName: 'Reviewers',
          instruction: '',
          parallel: [{ name: 'child', persona: 'reviewer', instruction: 'review', rules: [] }],
        },
        {
          name: 'fix',
          personaDisplayName: 'Fix lead',
          instruction: '',
          edit: true,
          teamLeader: { maxConcurrency: 1, refillThreshold: 0, timeoutMs: 1000 },
        },
        {
          name: 'sync',
          personaDisplayName: 'System',
          instruction: '',
          kind: 'system',
        },
      ] as WorkflowStep[];
      steps.forEach((step, index) => {
        const iteration = index + 1;
        const response = {
          persona: step.name,
          status: 'done',
          content: step.name === 'fix' ? 'Fixed AI-001' : 'done',
          timestamp: new Date('2026-08-01T00:00:00.000Z'),
        } as const;
        engine.emitScoped(engine.getExecutionScope(), 'step:start', step, iteration, '', undefined, 'parent', step.name, 1, 5);
        engine.emitScoped(engine.getExecutionScope(), 'step:complete', step, response, '', step.name);
      });
      engine.emitScoped(engine.getExecutionScope(), 'workflow_call:start', {
        parentWorkflow: 'parent',
        step: 'delegate',
        childWorkflow: 'child',
        callInstance: 1,
        stack: [{ workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 }],
      });

      const analyticsRecords = readNdjsonRecords(join(analyticsDir, '2026-08-01.jsonl'));
      expect(analyticsRecords.filter((record) => record.type === 'step_result').map((record) => record.step))
        .toEqual(['reviewers', 'fix', 'sync']);
      expect(analyticsRecords).toContainEqual(expect.objectContaining({
        type: 'fix_action',
        findingId: 'AI-001',
        iteration: 2,
      }));
      expect(analyticsRecords.some((record) => record.step === 'delegate')).toBe(false);
      expect(usageEventLogger.logUsageFor).not.toHaveBeenCalled();
    } finally {
      resetAnalyticsWriter();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loop monitor judge model が明示省略された場合は usage に default として記録する', () => {
    const { engine, out, usageEventLogger, analyticsEmitter } = createBridgeHarness({
      currentProvider: 'codex',
      configuredModel: 'configured-model',
    });
    const step = {
      name: '_loop_judge_ai_review_ai_fix',
      personaDisplayName: 'loop-judge',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
      provider: 'codex',
      model: undefined,
      modelSource: 'step',
    }, 'parent', step.name);

    expect(out.info).toHaveBeenCalledWith('Model: (default)');
    expect(usageEventLogger.logUsageFor).not.toHaveBeenCalled();
  });

  it('OpenCode variant を step start の provider option 表示に含める', () => {
    const { engine, out } = createBridgeHarness({
      currentProvider: 'opencode',
      configuredModel: 'gpt-5',
    });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
      provider: 'opencode',
      model: 'gpt-5',
      providerOptions: { opencode: { variant: 'high' } },
    }, 'parent', step.name);

    expect(out.info).toHaveBeenCalledWith('Variant: high');
  });

  it('Codex reasoning effort を step start の provider option 表示に含める', () => {
    const { engine, out } = createBridgeHarness({
      currentProvider: 'codex',
      configuredModel: 'gpt-5.2',
    });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
      provider: 'codex',
      model: 'gpt-5.2',
      providerOptions: { codex: { reasoningEffort: 'high' } },
    }, 'parent', step.name);

    expect(out.info).toHaveBeenCalledWith('Reasoning effort: high');
  });

  it('Codex base URL を step start の provider option 表示では伏せる', () => {
    const { engine, out } = createBridgeHarness({
      currentProvider: 'codex',
      configuredModel: 'gpt-5.2',
    });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
      provider: 'codex',
      model: 'gpt-5.2',
      providerOptions: { codex: { baseUrl: 'http://127.0.0.1:8787/v1' } },
    }, 'parent', step.name);

    expect(out.info).toHaveBeenCalledWith('Base URL: [configured]');
  });

  it('verbose 時に Claude SDK base URL を伏せて解決ソースを表示する', () => {
    resetDebugLogger();
    setVerboseConsole(true);
    try {
      const { engine, out } = createBridgeHarness({
        currentProvider: 'claude-sdk',
        configuredModel: 'claude-sonnet-4-5',
      });
      const step = {
        name: 'review',
        personaDisplayName: 'Reviewer',
        instruction: '',
      } as WorkflowStep;

      engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
        provider: 'claude-sdk',
        model: 'claude-sonnet-4-5',
        providerOptions: { claude: { baseUrl: 'http://127.0.0.1:8787' } },
        providerOptionsSources: { 'claude.baseUrl': 'project' },
      }, 'parent', step.name);

      expect(out.info).toHaveBeenCalledWith('Base URL: [configured] (source: project)');
    } finally {
      resetDebugLogger();
    }
  });

  it('Kiro agent を step start の provider option 表示に含める', () => {
    const { engine, out } = createBridgeHarness({
      currentProvider: 'kiro',
      configuredModel: 'kiro-default',
    });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
      provider: 'kiro',
      model: 'kiro-default',
      providerOptions: { kiro: { agent: 'reviewer-agent' } },
    }, 'parent', step.name);

    expect(out.info).toHaveBeenCalledWith('Agent: reviewer-agent');
  });

  it('Kiro agent 未指定なら Agent 行を表示しない', () => {
    const { engine, out } = createBridgeHarness({
      currentProvider: 'kiro',
      configuredModel: 'kiro-default',
    });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
      provider: 'kiro',
      model: 'kiro-default',
      providerOptions: { opencode: { variant: 'high' } },
    }, 'parent', step.name);

    const agentLines = out.info.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('Agent:'),
    );
    expect(agentLines).toEqual([]);
  });

  it('verbose 時に Kiro agent の解決ソースを表示する', () => {
    resetDebugLogger();
    setVerboseConsole(true);
    try {
      const { engine, out } = createBridgeHarness({
        currentProvider: 'kiro',
        configuredModel: 'kiro-default',
      });
      const step = {
        name: 'review',
        personaDisplayName: 'Reviewer',
        instruction: '',
      } as WorkflowStep;

      engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
        provider: 'kiro',
        model: 'kiro-default',
        providerOptions: { kiro: { agent: 'reviewer-agent' } },
        providerOptionsSources: { 'kiro.agent': 'step' },
      }, 'parent', step.name);

      expect(out.info).toHaveBeenCalledWith('Agent: reviewer-agent (source: step)');
    } finally {
      resetDebugLogger();
    }
  });

  it('verbose 時に OpenCode variant の解決ソースを表示する', () => {
    resetDebugLogger();
    setVerboseConsole(true);
    try {
      const { engine, out } = createBridgeHarness({
        currentProvider: 'opencode',
        configuredModel: 'gpt-5',
      });
      const step = {
        name: 'review',
        personaDisplayName: 'Reviewer',
        instruction: '',
      } as WorkflowStep;

      engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', {
        provider: 'opencode',
        model: 'gpt-5',
        providerOptions: { opencode: { variant: 'high' } },
        providerOptionsSources: { 'opencode.variant': 'persona' },
      }, 'parent', step.name);

      expect(out.info).toHaveBeenCalledWith('Variant: high (source: persona)');
    } finally {
      resetDebugLogger();
    }
  });

  it('event sink へ progress、confirmation request、provider output を渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    bridge.emitProviderOutput({ type: 'text', data: { text: 'streamed answer' } });
    engine.emitScoped(engine.getExecutionScope(), 'step:blocked', step, {
      content: '質問: Which file should be updated?',
      status: 'blocked',
    });
    await bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'step_started',
      step: 'review',
      iteration: 1,
      maxSteps: 5,
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'progress',
      message: 'Starting step "review" (1/5)',
      step: 'review',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'output',
      outputType: 'text',
      message: 'streamed answer',
      step: 'review',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'blocked',
      confirmationId: 'confirmation-1',
      message: 'Which file should be updated?',
      step: 'review',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'confirmation_requested',
      confirmationId: 'confirmation-1',
      message: 'Which file should be updated?',
      step: 'review',
    });
  });

  it('step_started と表示へ step 開始時の有効上限 snapshot を渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine, out } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(),
      'step:start',
      step,
      2,
      'instruction',
      { provider: 'mock', model: 'gpt-test' },
      'parent',
      step.name,
      1,
      3,
    );
    await bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'step_started',
      step: 'review',
      iteration: 2,
      maxSteps: 3,
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'progress',
      message: 'Starting step "review" (2/3)',
      step: 'review',
    });
    expect(out.info).toHaveBeenCalledWith('[2/3] review (Reviewer)');
  });

  it('event sink へ step completed の専用イベントを渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    engine.emitScoped(engine.getExecutionScope(), 'step:complete', step, {
      persona: 'reviewer',
      status: 'done',
      content: 'approved',
      timestamp: new Date(),
    }, 'instruction', step.name);
    await bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'step_completed',
      step: 'review',
      status: 'done',
    });
  });

  it('event sink へ rate limited の専用イベントを渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:rate_limited', step, {
      status: 'rate_limited',
      content: '',
      error: 'retry later',
    });
    await bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'rate_limited',
      step: 'review',
      message: 'retry later',
    });
  });

  it('event sink へ blocked の専用イベントを渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:blocked', step, {
      content: '質問: Proceed?',
      status: 'blocked',
    });
    await bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'blocked',
      step: 'review',
      confirmationId: 'confirmation-1',
      message: 'Proceed?',
    });
  });

  it('event sink へ run started を共通 bridge 経由で渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge } = createBridgeHarness({ eventSink });

    bridge.emitRunStarted({
      type: 'run_started',
      runDirectory: '/tmp/project/run',
      reportDirectory: '/tmp/project/run/reports',
      ndjsonLogPath: '/tmp/project/run/logs/session.jsonl',
    });
    await bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'run_started',
      runDirectory: '/tmp/project/run',
      reportDirectory: '/tmp/project/run/reports',
      ndjsonLogPath: '/tmp/project/run/logs/session.jsonl',
    });
  });

  it('event sink へ provider output の公開種別を渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { content: 'tool failed', isError: true },
    });
    bridge.emitProviderOutput({
      type: 'result',
      data: {
        result: 'provider done',
        sessionId: 'session-1',
        success: true,
      },
    });
    bridge.emitProviderOutput({
      type: 'assistant_error',
      data: { error: 'assistant crashed', sessionId: 'session-1' },
    });
    bridge.emitProviderOutput({
      type: 'error',
      data: { message: 'transport failed' },
    });
    await bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'output',
      outputType: 'tool_result',
      message: 'tool failed',
      step: 'review',
      isError: true,
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'output',
      outputType: 'result',
      message: 'provider done',
      step: 'review',
      isError: false,
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'output',
      outputType: 'error',
      message: 'assistant crashed',
      step: 'review',
      isError: true,
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'output',
      outputType: 'error',
      message: 'transport failed',
      step: 'review',
      isError: true,
    });
  });

  it('event sink dispatch を発行順に直列化する', async () => {
    const delivered: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstDispatched = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const eventSink = vi.fn(async (event: { type: string; message?: string }) => {
      if (event.message === 'first') {
        await firstDispatched;
      }
      delivered.push(event.message ?? event.type);
    });
    const { bridge } = createBridgeHarness({ eventSink });

    bridge.emitProviderOutput({ type: 'text', data: { text: 'first' } });
    bridge.emitProviderOutput({ type: 'text', data: { text: 'second' } });
    await Promise.resolve();
    expect(delivered).toEqual([]);

    releaseFirst?.();
    await bridge.flushEventSink();

    expect(delivered).toEqual(['first', 'second']);
  });

  it('同一 step の confirmation request に一意な ID を付ける', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    engine.emitScoped(engine.getExecutionScope(), 'step:blocked', step, {
      content: '質問: First question?',
      status: 'blocked',
    });
    engine.emitScoped(engine.getExecutionScope(), 'step:blocked', step, {
      content: '質問: Second question?',
      status: 'blocked',
    });
    await bridge.flushEventSink();

    const confirmationEvents = eventSink.mock.calls
      .map((call) => call[0])
      .filter((event) => event.type === 'confirmation_requested');
    expect(confirmationEvents.map((event) => event.confirmationId)).toEqual([
      'confirmation-1',
      'confirmation-2',
    ]);
  });

  it('event sink へ tool use と tool result を構造化して渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    bridge.emitProviderOutput({
      type: 'tool_use',
      data: { id: 'tool-1', tool: 'Read', input: { file_path: 'src/index.ts' } },
    });
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { content: 'file content', isError: false },
    });
    await bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'tool_started',
      toolCallId: 'tool-1',
      tool: 'Read',
      input: { file_path: 'src/index.ts' },
      step: 'review',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'tool_completed',
      toolCallId: 'tool-1',
      message: 'file content',
      step: 'review',
      isError: false,
    });
  });

  it('event sink へ複数 tool use の tool result を FIFO で対応づける', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    bridge.emitProviderOutput({
      type: 'tool_use',
      data: { id: 'tool-a', tool: 'Read', input: { file_path: 'src/a.ts' } },
    });
    bridge.emitProviderOutput({
      type: 'tool_use',
      data: { id: 'tool-b', tool: 'Read', input: { file_path: 'src/b.ts' } },
    });
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { content: 'content a', isError: false },
    });
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { content: 'content b', isError: false },
    });
    await bridge.flushEventSink();

    const toolEvents = eventSink.mock.calls
      .map((call) => call[0])
      .filter((event) => event.type === 'tool_started' || event.type === 'tool_completed');

    expect(toolEvents).toEqual([
      {
        type: 'tool_started',
        toolCallId: 'tool-a',
        tool: 'Read',
        input: { file_path: 'src/a.ts' },
        step: 'review',
      },
      {
        type: 'tool_started',
        toolCallId: 'tool-b',
        tool: 'Read',
        input: { file_path: 'src/b.ts' },
        step: 'review',
      },
      {
        type: 'tool_completed',
        toolCallId: 'tool-a',
        message: 'content a',
        step: 'review',
        isError: false,
      },
      {
        type: 'tool_completed',
        toolCallId: 'tool-b',
        message: 'content b',
        step: 'review',
        isError: false,
      },
    ]);
  });

  it('event sink へ空の tool result でも pending tool call の完了を渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    bridge.emitProviderOutput({
      type: 'tool_use',
      data: { id: 'tool-a', tool: 'Read', input: { file_path: 'src/a.ts' } },
    });
    bridge.emitProviderOutput({
      type: 'tool_use',
      data: { id: 'tool-b', tool: 'Read', input: { file_path: 'src/b.ts' } },
    });
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { content: '', isError: false },
    });
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { content: 'content b', isError: false },
    });
    await bridge.flushEventSink();

    const toolCompletedEvents = eventSink.mock.calls
      .map((call) => call[0])
      .filter((event) => event.type === 'tool_completed');

    expect(toolCompletedEvents).toEqual([
      {
        type: 'tool_completed',
        toolCallId: 'tool-a',
        message: '',
        step: 'review',
        isError: false,
      },
      {
        type: 'tool_completed',
        toolCallId: 'tool-b',
        message: 'content b',
        step: 'review',
        isError: false,
      },
    ]);
  });

  it('event sink へ permission と rate limit stream event を渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emitScoped(engine.getExecutionScope(), 'step:start', step, 1, 'instruction', { provider: 'opencode', model: 'gpt-test' }, 'parent', step.name);
    bridge.emitProviderOutput({
      type: 'permission_asked',
      data: {
        requestId: 'perm-1',
        sessionId: 'session-1',
        permission: 'edit',
        patterns: ['src/index.ts'],
        always: [],
        reply: 'reject',
      },
    });
    bridge.emitProviderOutput({
      type: 'permission_summary',
      data: {
        sessionId: 'session-1',
        resolvedPermissions: [{ permission: 'edit', pattern: 'src/index.ts', action: 'reject' }],
      },
    });
    bridge.emitProviderOutput({
      type: 'rate_limit',
      data: {
        sessionId: 'session-1',
        status: 'rejected',
        rateLimitType: 'requests',
      },
    });
    await bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'confirmation_requested',
      confirmationId: 'perm-1',
      message: 'Permission requested: edit',
      step: 'review',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'tool_completed',
      toolCallId: 'perm-1',
      message: 'Permission summary: 1 resolved permissions',
      step: 'review',
      isError: false,
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'rate_limited',
      message: 'Rate limit rejected (requests)',
      step: 'review',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'error',
      message: 'Rate limit rejected (requests)',
      step: 'review',
    });
  });

  it('event sink へ workflow completed 成功/失敗を渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const successHarness = createBridgeHarness({ eventSink });

    successHarness.engine.emitScoped(successHarness.engine.getExecutionScope(), 'workflow:complete', { iteration: 2 });
    await successHarness.bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'completed',
      success: true,
      reportDirectory: '/tmp/project/run/reports',
    });

    eventSink.mockClear();
    const failureHarness = createBridgeHarness({ eventSink });
    failureHarness.engine.emitScoped(failureHarness.engine.getExecutionScope(), 'workflow:abort', { iteration: 3 }, 'Step "review" failed');
    await failureHarness.bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'completed',
      success: false,
      reportDirectory: '/tmp/project/run/reports',
      reason: 'Step "review" failed',
    });

  });

  it('event sink 失敗時は workflow を abort し、flush で伝播する', async () => {
    const eventSinkError = new Error('session/update failed');
    const { bridge, engine } = createBridgeHarness({
      eventSink: vi.fn().mockRejectedValue(eventSinkError),
    });

    engine.emitScoped(engine.getExecutionScope(), 'step:start', {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', 'review');

    await expect(bridge.flushEventSink()).rejects.toThrow('session/update failed');
    expect(engine.abort).toHaveBeenCalled();
    expect(bridge.state.abortReason).toBe('Workflow event sink failed: session/update failed');
  });

  it('event sink の同期 throw も workflow を abort し、flush で伝播する', async () => {
    const eventSinkError = new Error('session/update threw');
    const { bridge, engine } = createBridgeHarness({
      eventSink: vi.fn(() => {
        throw eventSinkError;
      }),
    });

    bridge.emitRunStarted({
      type: 'run_started',
      runDirectory: '/tmp/project/run',
      reportDirectory: '/tmp/project/run/reports',
      ndjsonLogPath: '/tmp/project/run/logs/session.jsonl',
    });

    await expect(bridge.flushEventSink()).rejects.toThrow('session/update threw');
    expect(engine.abort).toHaveBeenCalled();
    expect(bridge.state.abortReason).toBe('Workflow event sink failed: session/update threw');
  });
});

describe('workflowExecutionReporting', () => {
  function createSessionLog(): SessionLog {
    return {
      task: 'Implement subworkflow call',
      projectDir: '/project',
      workflowName: 'takt-default',
      iterations: 3,
      startTime: '2026-04-14T00:00:00.000Z',
      status: 'running',
      history: [],
    };
  }

  beforeEach(() => {
    mockSaveSessionState.mockReset();
  });

  it('should warn with workflow, task, and project path when saving success session state fails', () => {
    const warnings: string[] = [];
    mockSaveSessionState.mockImplementation(() => {
      throw new Error('disk full');
    });

    const finalized = finalizeWorkflowSuccess(
      createSessionLog(),
      'Implement subworkflow call',
      'takt-default',
      'done',
      'fix',
      '/project',
      (warning) => {
        warnings.push(warning);
      },
    );

    expect(finalized.status).toBe('completed');
    expect(finalized.endTime).toBeDefined();
    expect(warnings).toEqual([
      expect.stringContaining('Failed to save session state for workflow "takt-default"'),
    ]);
    expect(warnings[0]).toContain('task "Implement subworkflow call"');
    expect(warnings[0]).toContain('in /project: disk full');
  });

  it('should warn with workflow, task, and project path when saving abort session state fails', () => {
    const warnings: string[] = [];
    mockSaveSessionState.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const finalized = finalizeWorkflowAbort(
      createSessionLog(),
      'user_interrupted',
      'Implement subworkflow call',
      'takt-default',
      'fix',
      '/project',
      (warning) => {
        warnings.push(warning);
      },
    );

    expect(finalized.status).toBe('aborted');
    expect(finalized.endTime).toBeDefined();
    expect(warnings).toEqual([
      expect.stringContaining('Failed to save session state for workflow "takt-default"'),
    ]);
    expect(warnings[0]).toContain('task "Implement subworkflow call"');
    expect(warnings[0]).toContain('in /project: permission denied');
  });

  it('Given unsafe trace discovery metadata, When reporting workflow completion, Then it sanitizes TraceQL query hints', () => {
    const out = {
      success: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    reportWorkflowCompletion(
      out as never,
      {
        ...createSessionLog(),
        endTime: '2026-04-14T00:00:01.000Z',
      },
      3,
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      false,
      {
        queries: [
          '{ span."takt.run.id" = "run-843" }\x1b[31m\n\tbad\x1f',
        ],
      },
    );

    expect(out.info).toHaveBeenCalledWith('TraceQL discovery:');
    expect(out.info).toHaveBeenCalledWith('  { span."takt.run.id" = "run-843" }\\n\\tbad\\x1f');
  });
});
