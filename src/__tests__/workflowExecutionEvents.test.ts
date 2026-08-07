import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FindingLedger, WorkflowResumePoint, WorkflowStep } from '../core/models/index.js';
import { initAnalyticsWriter } from '../features/analytics/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { AnalyticsEmitter } from '../features/tasks/execute/analyticsEmitter.js';
import { bindWorkflowExecutionEvents } from '../features/tasks/execute/workflowExecutionEvents.js';
import { createWorkflowTerminalPayloadFactory } from '../features/tasks/execute/workflowTerminalPayload.js';
import { resetDebugLogger, setVerboseConsole } from '../shared/utils/debug.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import type { ProviderType } from '../shared/types/provider.js';

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
  currentProvider?: ProviderType;
  configuredModel?: string;
  resumePoint?: WorkflowResumePoint;
  findingIds?: string[];
  traceDiscovery?: { queries: string[] };
  eventSink?: ReturnType<typeof vi.fn>;
  shouldNotifyRateLimit?: boolean;
  display?: { flush: ReturnType<typeof vi.fn> };
}) {
  const resumePoint = options?.resumePoint ?? {
    version: 2,
    stack: [{
      workflow: 'parent',
      workflow_ref: 'project:sha256:parent',
      step: 'review',
      kind: 'agent',
      occurrence: 1,
    }],
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
  const displayRef = {
    current: options?.display ?? null,
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
    setFindingContractFindingIds: vi.fn(),
    onRoutingDecision: vi.fn(),
  };
  const usageEventLogger = {
    logUsageFor: vi.fn(),
  };
  const sessionLogger = {
    onPhaseStart: vi.fn(),
    onPhaseComplete: vi.fn(),
    onJudgeStage: vi.fn(),
    onWorkflowCallStart: vi.fn(),
    onWorkflowCallComplete: vi.fn(),
    onStepStart: vi.fn(),
    onStepComplete: vi.fn(),
    onWorkflowComplete: vi.fn(),
    onWorkflowAbort: vi.fn(),
  };
  const sessionLog = {
    task: 'task',
    projectDir: '/tmp/project',
    workflowName: 'parent',
    iterations: 0,
    startTime: new Date().toISOString(),
    status: 'running' as const,
    history: [],
  };
  const terminalPayloads = createWorkflowTerminalPayloadFactory({
    runSlug: 'run-1',
    projectCwd: '/tmp/project',
    task: 'task',
    workflowName: 'parent',
    sessionLog,
    sessionId: 'session',
    ndjsonLogPath: '/tmp/project/run/logs/session.jsonl',
    traceReportMode: 'redacted',
    ...(options?.traceDiscovery === undefined
      ? {}
      : {
          traceDiscovery: {
            serviceName: 'takt',
            runId: 'run-1',
            workflowName: 'parent',
            queries: options.traceDiscovery.queries,
          },
        }),
  });
  const bridge = bindWorkflowExecutionEvents({
    engine: engine as never,
    workflowConfig: {
      name: 'parent',
      maxSteps: 5,
      steps: [{ name: 'review' }],
    },
    currentProvider: options?.currentProvider ?? 'mock',
    configuredModel: options?.configuredModel ?? 'gpt-test',
    out: out as never,
    prefixWriter: prefixWriter as never,
    displayRef: displayRef as never,
    handlerRef: { current: null },
    usageEventLogger: usageEventLogger as never,
    analyticsEmitter: analyticsEmitter as never,
    sessionLogger: sessionLogger as never,
    runMetaManager: runMetaManager as never,
    shouldNotifyRateLimit: options?.shouldNotifyRateLimit ?? false,
    initialResumePoint: resumePoint,
    sessionLog,
    eventSink: options?.eventSink,
    terminalPayloads,
  });

  return {
    bridge,
    engine,
    out,
    runMetaManager,
    prefixWriter,
    displayRef,
    resumePoint,
    analyticsEmitter,
    usageEventLogger,
    sessionLogger,
    terminalPayloads,
  };
}

describe('bindWorkflowExecutionEvents', () => {
  it('workflow_call lifecycle を SessionLogger へ橋渡しする', () => {
    const { engine, sessionLogger } = createBridgeHarness();
    const lifecycle = {
      parentWorkflow: 'project:sha256:parent',
      step: 'delegate',
      childWorkflow: 'project:sha256:child',
      callInstance: 1,
      stack: [{
        workflow: 'parent',
        workflow_ref: 'project:sha256:parent',
        step: 'delegate',
        kind: 'workflow_call' as const,
        occurrence: 1,
      }],
    };
    const complete = {
      ...lifecycle,
      result: { status: 'failed' as const, reason: 'child failed' },
    };

    engine.emit('workflow_call:start', lifecycle);
    engine.emit('workflow_call:complete', complete);

    expect(sessionLogger.onWorkflowCallStart).toHaveBeenCalledWith(lifecycle);
    expect(sessionLogger.onWorkflowCallComplete).toHaveBeenCalledWith(complete);
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

    engine.emit(
      'step:start',
      step,
      2,
      'instruction',
      { provider: 'mock', model: 'gpt-test' },
      'parent',
      step.name,
      7,
    );
    engine.emit('phase:start', step, 1, 'main', 'instruction', [], 'phase-1', 2);
    engine.emit('phase:complete', step, 1, 'main', 'approved', 'done', undefined, 'phase-1', 2);
    engine.emit('step:complete', step, response, 'instruction', step.name);
    engine.emit('workflow:complete', { iteration: 2 });

    expect(runMetaManager.finalize).not.toHaveBeenCalled();
    const payload = bridge.prepareTerminalPublicationPayload();

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
    expect(runMetaManager.finalize).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      status: 'completed',
      iterations: 2,
    });
    expect(bridge.state.lastStepName).toBe('review');
    expect(bridge.state.lastStepContent).toBe('approved');
    expect(bridge.state.sessionLog.iterations).toBe(1);
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

    engine.emit(
      'step:start',
      judgeStep,
      8,
      'judge',
      { provider: 'mock', model: 'gpt-test' },
      'parent',
      'review',
    );
    engine.emit('phase:start', judgeStep, 3, 'judge', 'judge', [], 'judge-phase', 8);
    engine.emit(
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
    engine.emit('step:complete', judgeStep, response, 'judge', 'review');

    expect(runMetaManager.updateStep).toHaveBeenCalledWith('review', 8, resumePoint);
    expect(runMetaManager.updatePhase).toHaveBeenCalledTimes(2);
    expect(runMetaManager.updatePhase.mock.calls.map((call) => call[0])).toEqual(['review', 'review']);
    expect(bridge.state.currentStepName).toBe('review');
    expect(bridge.state.lastStepName).toBe('review');
  });

  it('step の開始・完了を event payload の発生元 stack で相関する', () => {
    const { engine, sessionLogger } = createBridgeHarness();
    const step = {
      name: 'child-review',
      personaDisplayName: 'Reviewer',
      instruction: '',
      rules: [],
    } as WorkflowStep;
    const workflowStack = [
      {
        workflow: 'parent',
        workflow_ref: 'project:sha256:parent',
        step: 'delegate',
        kind: 'workflow_call' as const,
        occurrence: 1,
      },
      {
        workflow: 'child',
        workflow_ref: 'project:sha256:child',
        step: step.name,
        kind: 'agent' as const,
        occurrence: 1,
      },
    ];

    engine.emit(
      'step:start',
      step,
      2,
      'instruction',
      { provider: 'mock', model: 'gpt-test' },
      'child',
      'delegate',
      1,
      workflowStack,
    );
    const response = {
      persona: 'reviewer',
      status: 'done',
      content: 'approved',
      timestamp: new Date(),
    };
    engine.emit(
      'step:complete',
      step,
      response,
      'instruction',
      'delegate',
      workflowStack,
    );

    expect(sessionLogger.onStepStart).toHaveBeenCalledWith(
      step,
      2,
      'instruction',
      workflowStack,
      { provider: 'mock', model: 'gpt-test' },
    );
    expect(sessionLogger.onStepComplete).toHaveBeenCalledWith(
      step,
      response,
      'instruction',
      workflowStack,
    );
  });

  it('workflow abort kind を実行状態に保持する', () => {
    const { bridge, engine } = createBridgeHarness();

    engine.emit(
      'workflow:abort',
      { iteration: 3 },
      'Workflow aborted by step transition',
      'step_transition',
      {
        kind: 'step_transition',
        step: 'review',
        reason: 'Workflow aborted by step transition',
        error: 'Workflow aborted by step transition',
      },
    );

    expect(bridge.state.abortKind).toBe('step_transition');
  });

  it('terminal投影失敗をadditionalに保持しcleanupを完了して最初のabort intentを維持する', () => {
    const projectionFailure = new Error('resume-point projection failed');
    const display = { flush: vi.fn() };
    const {
      bridge,
      engine,
      runMetaManager,
      prefixWriter,
      displayRef,
    } = createBridgeHarness({ display });
    runMetaManager.updateResumePoint.mockImplementation(() => {
      throw projectionFailure;
    });

    expect(() => {
      engine.emit(
        'workflow:abort',
        { iteration: 3 },
        'first abort',
        'step_error',
        { kind: 'step_error', step: 'reviewers', reason: 'first abort', error: 'first abort' },
      );
    }).not.toThrow();
    expect(() => {
      engine.emit(
        'workflow:abort',
        { iteration: 4 },
        'second abort',
        'runtime_error',
        { kind: 'runtime_error', step: 'reviewers', reason: 'second abort', error: 'second abort' },
      );
    }).not.toThrow();

    expect(bridge.getStagedAbort()).toEqual({
      iteration: 3,
      reason: 'first abort',
      kind: 'step_error',
      status: 'failed',
    });
    expect(bridge.getFinalizationIssues()).toEqual([
      expect.objectContaining({
        name: 'RunProjectionError',
        stage: 'meta',
        cause: projectionFailure,
      }),
      expect.objectContaining({
        name: 'RunProjectionError',
        stage: 'meta',
        cause: projectionFailure,
      }),
    ]);
    expect(display.flush).toHaveBeenCalledOnce();
    expect(displayRef.current).toBeNull();
    expect(prefixWriter.flush).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      kind: 'interrupt',
      expectedStatus: 'aborted',
      failureError: 'terminal reason',
    },
    {
      kind: 'step_error',
      expectedStatus: 'failed',
      failureError: 'NEEDS_ADJUDICATION: finding invariant failed',
    },
  ] as const)('publishes $kind as $expectedStatus', ({
    kind,
    expectedStatus,
    failureError,
  }) => {
    const { bridge, engine, runMetaManager } = createBridgeHarness();

    engine.emit(
      'workflow:abort',
      { iteration: 3 },
      'terminal reason',
      kind,
      { kind, step: 'reviewers', reason: 'terminal reason', error: failureError },
    );
    const payload = bridge.prepareTerminalPublicationPayload();

    expect(runMetaManager.finalize).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      status: expectedStatus,
      iterations: 3,
      reason: 'terminal reason',
      failure: {
        step: 'reviewers',
        error: failureError,
      },
    });
    expect(bridge.state.failure).toEqual({
      step: 'reviewers',
      error: failureError,
    });
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
    };

    const context = {
      iteration: 4,
      workflowName: 'peer-review',
      scopeIdentity: 'peer-review-scope',
    };
    engine.emit('findings:ledger', ledger, context);

    expect(analyticsEmitter.onFindingLedgerUpdated).toHaveBeenCalledWith(
      ledger,
      context,
    );
  });

  it('workflow complete event が TraceQL discovery を完了出力へ渡す', () => {
    const { bridge, engine } = createBridgeHarness({
      traceDiscovery: {
        queries: ['{ resource.service.name = "takt" && span."takt.run.id" = "run-843" }'],
      },
    });

    engine.emit('workflow:complete', { iteration: 2 });
    const payload = bridge.prepareTerminalPublicationPayload();

    expect(payload.traceDiscovery?.queries).toEqual([
      '{ resource.service.name = "takt" && span."takt.run.id" = "run-843" }',
    ]);
  });

  it('workflow abort event が TraceQL discovery を abort 出力へ渡す', () => {
    const { bridge, engine } = createBridgeHarness({
      traceDiscovery: {
        queries: ['{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }'],
      },
    });

    engine.emit(
      'workflow:abort',
      { iteration: 2 },
      'Step "write_tests" failed',
      'step_error',
      {
        kind: 'step_error',
        step: 'write_tests',
        reason: 'Step "write_tests" failed',
        error: 'write tests failed',
      },
    );
    const payload = bridge.prepareTerminalPublicationPayload();

    expect(payload.traceDiscovery?.queries).toEqual([
      '{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }',
    ]);
  });

  it('finding ledger analytics の書き込み失敗後も workflow complete を処理する', () => {
    const analyticsRoot = mkdtempSync(join(tmpdir(), 'takt-test-ledger-analytics-failure-'));
    const analyticsPath = join(analyticsRoot, 'not-a-directory');
    writeFileSync(analyticsPath, 'not a directory', 'utf-8');
    initAnalyticsWriter(true, analyticsPath);
    try {
      const actualAnalyticsEmitter = new AnalyticsEmitter('run-ledger', false);
      const {
        bridge,
        engine,
        runMetaManager,
        analyticsEmitter,
      } = createBridgeHarness();
      analyticsEmitter.onFindingLedgerUpdated.mockImplementation((
        ledger: FindingLedger,
        context: {
          readonly iteration: number;
          readonly workflowName: string;
          readonly scopeIdentity: string;
        },
      ) => {
        actualAnalyticsEmitter.onFindingLedgerUpdated(ledger, context);
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
            rawFindingIds: ['run:reviewers:1:architecture-review:architecture-review.md:raw-1'],
            firstSeen: { runId: 'run', stepName: 'reviewers', timestamp: '2026-06-13T02:00:00.000Z' },
            lastSeen: { runId: 'run', stepName: 'reviewers', timestamp: '2026-06-13T02:00:00.000Z' },
          },
        ],
        rawFindings: [],
        conflicts: [],
      };

      expect(() => engine.emit('findings:ledger', ledger, {
        iteration: 2,
        workflowName: 'peer-review',
        scopeIdentity: 'peer-review-scope',
      })).not.toThrow();
      expect(() => engine.emit('workflow:complete', { iteration: 3 })).not.toThrow();
      const payload = bridge.prepareTerminalPublicationPayload();

      expect(runMetaManager.finalize).not.toHaveBeenCalled();
      expect(payload).toMatchObject({
        status: 'completed',
        iterations: 3,
      });
    } finally {
      resetAnalyticsWriter();
      rmSync(analyticsRoot, { recursive: true, force: true });
    }
  });

  it('direct child resumeの初回stepでchild ledgerの現行Finding IDsを渡す', () => {
    const { analyticsEmitter, engine } = createBridgeHarness();
    const step = {
      name: 'fix',
      personaDisplayName: 'Coder',
      instruction: '',
    } as WorkflowStep;
    engine.emit(
      'step:start',
      step,
      1,
      'fix',
      { provider: 'mock', model: 'test' },
      'peer-review',
      step.name,
      1,
      [],
      'peer-review-scope',
      ['F-1001', 'F-1002'],
    );

    expect(analyticsEmitter.setFindingContractFindingIds).toHaveBeenCalledWith(
      'peer-review-scope',
      ['F-1001', 'F-1002'],
    );
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

    engine.emit('routing:decision', step, response, 'Implement API', providerInfo, 'agent', 1234, 2);

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
    const { engine, out } = createBridgeHarness({
      currentProvider: 'cursor',
      configuredModel: 'global-model',
    });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emit('step:start', step, 1, 'instruction', {
      provider: 'cursor',
      model: undefined,
      modelSource: 'step',
    }, 'parent', step.name);

    expect(out.info).toHaveBeenCalledWith('Model: (default)');
  });

  it('workflow_call 親子の完了順が入れ子でも開始時の usage context を保持する', () => {
    const { engine, usageEventLogger, analyticsEmitter } = createBridgeHarness();
    const parentStep = {
      name: 'call-child',
      kind: 'workflow_call',
      call: 'child',
      personaDisplayName: 'Child workflow',
      instruction: '',
      rules: [],
    } as WorkflowStep;
    const childStep = {
      name: 'child-implement',
      personaDisplayName: 'Child coder',
      instruction: '',
      rules: [],
    } as WorkflowStep;
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, usageMissing: false };

    engine.emit('step:start', parentStep, 1, 'call child', {
      provider: 'codex',
      model: 'parent-model',
    }, 'parent', parentStep.name);
    engine.emit('step:start', childStep, 1, 'implement', {
      provider: 'claude',
      model: 'child-model',
    }, 'parent', childStep.name);
    engine.emit('step:complete', childStep, {
      persona: 'child-implement',
      status: 'done',
      content: 'child done',
      timestamp: new Date(),
      providerUsage: usage,
    }, 'implement', childStep.name);
    engine.emit('step:complete', parentStep, {
      persona: 'call-child',
      status: 'done',
      content: 'parent done',
      timestamp: new Date(),
      providerUsage: usage,
    }, 'call child', parentStep.name);

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
      [
        expect.objectContaining({
          provider: 'codex',
          providerModel: 'parent-model',
          step: 'call-child',
          stepType: 'workflow_call',
        }),
        expect.objectContaining({ success: true, usage }),
      ],
    ]);
    expect(analyticsEmitter.onStepComplete.mock.calls).toEqual([
      [
        childStep,
        expect.objectContaining({ content: 'child done' }),
        {
          iteration: 1,
          workflowName: 'parent',
          scopeIdentity: '{"workflow":"parent","stack":[]}',
          provider: 'claude',
          model: 'child-model',
        },
      ],
      [
        parentStep,
        expect.objectContaining({ content: 'parent done' }),
        {
          iteration: 1,
          workflowName: 'parent',
          scopeIdentity: '{"workflow":"parent","stack":[]}',
          provider: 'codex',
          model: 'parent-model',
        },
      ],
    ]);
  });

  it('parallel substep reportは対応するstep:startなしで実行境界のcontextを使う', () => {
    const { engine, analyticsEmitter } = createBridgeHarness();
    const reportRoot = mkdtempSync(join(tmpdir(), 'takt-parallel-report-context-'));
    const reportPath = join(reportRoot, 'architecture-review.md');
    writeFileSync(reportPath, '# Architecture review\n');
    const subStep = {
      name: 'architecture-review',
      personaDisplayName: 'Architecture Reviewer',
      instruction: '',
      rules: [],
    } as WorkflowStep;
    const workflowStack = [{
      workflow: 'parent',
      workflow_ref: 'project:sha256:parent',
      step: 'reviewers',
      kind: 'parallel' as const,
      occurrence: 2,
    }];
    const reportContext = {
      iteration: 7,
      workflowName: 'parent',
      resumeStepName: 'reviewers',
      stepIteration: 3,
      providerInfo: {
        provider: 'codex' as const,
        model: 'gpt-5',
      },
      provider: 'codex' as const,
      model: 'gpt-5',
      workflowStack,
      findingScopeIdentity: 'review-scope',
      findingIds: ['F-0007'],
    };

    try {
      expect(() => {
        engine.emit(
          'step:report',
          subStep,
          reportPath,
          'architecture-review.md',
          reportContext,
        );
      }).not.toThrow();
      expect(analyticsEmitter.onStepReport).toHaveBeenCalledWith(
        subStep,
        reportPath,
        {
          iteration: 7,
          workflowName: 'parent',
          scopeIdentity: 'review-scope',
          provider: 'codex',
          model: 'gpt-5',
        },
      );
    } finally {
      rmSync(reportRoot, { recursive: true, force: true });
    }
  });

  it('同名 parallel child の逆順完了でも開始 scope ごとの analytics context を保持する', () => {
    const { engine, analyticsEmitter } = createBridgeHarness();
    const slowStep = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
      rules: [],
    } as WorkflowStep;
    const fastStep = {
      ...slowStep,
    };
    const slowStack = [
      {
        workflow: 'parent',
        workflow_ref: 'project:sha256:parent',
        step: 'slow-delegate',
        kind: 'workflow_call',
        occurrence: 1,
      },
      {
        workflow: 'shared-child',
        workflow_ref: 'project:sha256:shared-child',
        step: 'review',
        kind: 'agent',
        occurrence: 1,
      },
    ];
    const fastStack = [
      {
        workflow: 'parent',
        workflow_ref: 'project:sha256:parent',
        step: 'fast-delegate',
        kind: 'workflow_call',
        occurrence: 1,
      },
      {
        workflow: 'shared-child',
        workflow_ref: 'project:sha256:shared-child',
        step: 'review',
        kind: 'agent',
        occurrence: 1,
      },
    ];

    engine.emit(
      'step:start',
      slowStep,
      3,
      'slow',
      { provider: 'codex', model: 'slow-model' },
      'shared-child',
      slowStep.name,
      1,
      slowStack,
      'slow-finding-scope',
      ['F-0001'],
    );
    engine.emit(
      'step:start',
      fastStep,
      4,
      'fast',
      { provider: 'claude', model: 'fast-model' },
      'shared-child',
      fastStep.name,
      1,
      fastStack,
      'fast-finding-scope',
      ['F-0002'],
    );
    engine.emit('step:complete', fastStep, {
      persona: 'reviewer',
      status: 'done',
      content: 'fast done',
      timestamp: new Date(),
    }, 'fast', fastStep.name, fastStack);
    engine.emit('step:complete', slowStep, {
      persona: 'reviewer',
      status: 'done',
      content: 'slow done',
      timestamp: new Date(),
    }, 'slow', slowStep.name, slowStack);

    expect(analyticsEmitter.onStepComplete.mock.calls.map(
      ([, response, context]) => ({
        content: response.content,
        context,
      }),
    )).toEqual([
      {
        content: 'fast done',
        context: {
          iteration: 4,
          workflowName: 'shared-child',
          scopeIdentity: 'fast-finding-scope',
          provider: 'claude',
          model: 'fast-model',
        },
      },
      {
        content: 'slow done',
        context: {
          iteration: 3,
          workflowName: 'shared-child',
          scopeIdentity: 'slow-finding-scope',
          provider: 'codex',
          model: 'slow-model',
        },
      },
    ]);
    expect(analyticsEmitter.setFindingContractFindingIds.mock.calls).toEqual([
      ['slow-finding-scope', ['F-0001']],
      ['fast-finding-scope', ['F-0002']],
    ]);
  });

  it.each([
    ['parallel', { parallel: { steps: [] } }],
    ['team_leader', { teamLeader: { maxConcurrency: 1, refillThreshold: 0, timeoutMs: 1000 } }],
  ])('%s parent の集約レスポンスを usage として記録しない', (_stepType, delegatedConfig) => {
    const { engine, usageEventLogger } = createBridgeHarness();
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
      ...delegatedConfig,
    } as WorkflowStep;
    const response = {
      persona: 'review',
      status: 'done',
      content: 'aggregated',
      timestamp: new Date(),
    } as const;

    engine.emit(
      'step:start',
      step,
      1,
      'instruction',
      { provider: 'mock', model: 'test-model' },
      'parent',
      step.name,
    );
    engine.emit('step:complete', step, response, 'instruction', step.name);

    expect(usageEventLogger.logUsageFor).not.toHaveBeenCalled();
  });

  it('loop monitor judge model が明示省略された場合は usage に default として記録する', () => {
    const { engine, out } = createBridgeHarness({
      currentProvider: 'codex',
      configuredModel: 'configured-model',
    });
    const step = {
      name: '_loop_judge_ai_review_ai_fix',
      personaDisplayName: 'loop-judge',
      instruction: '',
    } as WorkflowStep;

    engine.emit('step:start', step, 1, 'instruction', {
      provider: 'codex',
      model: undefined,
      modelSource: 'step',
    }, 'parent', step.name);

    expect(out.info).toHaveBeenCalledWith('Model: (default)');
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

    engine.emit('step:start', step, 1, 'instruction', {
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

    engine.emit('step:start', step, 1, 'instruction', {
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

    engine.emit('step:start', step, 1, 'instruction', {
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

      engine.emit('step:start', step, 1, 'instruction', {
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

    engine.emit('step:start', step, 1, 'instruction', {
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

    engine.emit('step:start', step, 1, 'instruction', {
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

      engine.emit('step:start', step, 1, 'instruction', {
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

      engine.emit('step:start', step, 1, 'instruction', {
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    bridge.emitProviderOutput({ type: 'text', data: { text: 'streamed answer' } });
    engine.emit('step:blocked', step, {
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

  it('event sink へ step completed の専用イベントを渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    engine.emit('step:complete', step, {
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

    engine.emit('step:rate_limited', step, {
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

    engine.emit('step:blocked', step, {
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    engine.emit('step:blocked', step, {
      content: '質問: First question?',
      status: 'blocked',
    });
    engine.emit('step:blocked', step, {
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'opencode', model: 'gpt-test' }, 'parent', step.name);
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

  it('workflow completed 成功/失敗をbackend-neutral payloadへstageする', () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const successHarness = createBridgeHarness({ eventSink });

    successHarness.engine.emit('workflow:complete', { iteration: 2 });
    const successPayload =
      successHarness.bridge.prepareTerminalPublicationPayload();

    expect(successPayload).toMatchObject({
      status: 'completed',
      iterations: 2,
    });
    expect(eventSink).not.toHaveBeenCalled();

    eventSink.mockClear();
    const failureHarness = createBridgeHarness({ eventSink });
    failureHarness.engine.emit(
      'workflow:abort',
      { iteration: 3 },
      'Step "review" failed',
      'step_error',
      {
        kind: 'step_error',
        step: 'review',
        reason: 'Step "review" failed',
        error: 'review failed',
      },
    );
    const failurePayload =
      failureHarness.bridge.prepareTerminalPublicationPayload();

    expect(failurePayload).toMatchObject({
      status: 'failed',
      iterations: 3,
      reason: 'Step "review" failed',
    });
    expect(eventSink).not.toHaveBeenCalled();
  });

  it('terminal payloadをimmutableな同一instanceとして一度だけ確定する', () => {
    const { bridge, engine } = createBridgeHarness();
    engine.emit('workflow:complete', { iteration: 2 });

    const first = bridge.prepareTerminalPublicationPayload();
    const second = bridge.prepareTerminalPublicationPayload();

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('event sink 失敗はworkflowをabortせずlive delivery issueにする', async () => {
    const eventSinkError = new Error('session/update failed');
    const { bridge, engine } = createBridgeHarness({
      eventSink: vi.fn().mockRejectedValue(eventSinkError),
    });

    engine.emit('step:start', {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', 'review');

    await expect(bridge.flushEventSink()).resolves.toBeUndefined();
    expect(engine.abort).not.toHaveBeenCalled();
    expect(bridge.state.abortReason).toBeUndefined();
    expect(bridge.getFinalizationIssues()).toHaveLength(2);
    expect(bridge.getFinalizationIssues()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'RunLiveDeliveryError',
          cause: eventSinkError,
        }),
      ]),
    );
  });

  it('event sink の同期throwもworkflow outcomeを変更しない', async () => {
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

    await expect(bridge.flushEventSink()).resolves.toBeUndefined();
    expect(engine.abort).not.toHaveBeenCalled();
    expect(bridge.state.abortReason).toBeUndefined();
    expect(bridge.getFinalizationIssues()).toEqual([
      expect.objectContaining({
        name: 'RunLiveDeliveryError',
        cause: eventSinkError,
      }),
    ]);
  });
});
