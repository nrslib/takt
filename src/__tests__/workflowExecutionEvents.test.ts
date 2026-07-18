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
import { resetDebugLogger, setVerboseConsole } from '../shared/utils/debug.js';

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
  currentProvider?: string;
  configuredModel?: string;
  resumePoint?: WorkflowResumePoint;
  findingIds?: string[];
  traceDiscovery?: { queries: string[] };
  eventSink?: ReturnType<typeof vi.fn>;
  shouldNotifyRateLimit?: boolean;
}) {
  const resumePoint = options?.resumePoint ?? {
    version: 1,
    stack: [{ workflow: 'parent', step: 'review', kind: 'agent' }],
    iteration: 2,
    elapsed_ms: 100,
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
    updateProviderInfo: vi.fn(),
    onStepComplete: vi.fn(),
    onStepReport: vi.fn(),
    onFindingLedgerUpdated: vi.fn(),
    seedFindingContractFindingIds: vi.fn(),
    onRoutingDecision: vi.fn(),
  };
  const usageEventLogger = {
    logUsageFor: vi.fn(),
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
    currentProvider: options?.currentProvider ?? 'mock',
    configuredModel: options?.configuredModel ?? 'gpt-test',
    out: out as never,
    prefixWriter: prefixWriter as never,
    displayRef: { current: null },
    handlerRef: { current: null },
    usageEventLogger: usageEventLogger as never,
    analyticsEmitter: analyticsEmitter as never,
    sessionLogger: {
      onPhaseStart: vi.fn(),
      setIteration: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
      onStepStart: vi.fn(),
      onStepComplete: vi.fn(),
      onWorkflowComplete: vi.fn(),
      onWorkflowAbort: vi.fn(),
    } as never,
    runMetaManager: runMetaManager as never,
    ndjsonLogPath: '/tmp/project/run/logs/session.jsonl',
    shouldNotifyRateLimit: options?.shouldNotifyRateLimit ?? false,
    shouldNotifyWorkflowComplete: false,
    shouldNotifyWorkflowAbort: false,
    writeTraceReportOnce: vi.fn(),
    traceDiscovery: options?.traceDiscovery,
    getCurrentWorkflowStack: () => resumePoint.stack,
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
    resumePoint,
    analyticsEmitter,
    usageEventLogger,
  };
}

describe('bindWorkflowExecutionEvents', () => {
  it('event bridge が run meta と実行結果を同期する', () => {
    const { bridge, engine, runMetaManager, resumePoint } = createBridgeHarness();

    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
      rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
    } as WorkflowStep;
    const response = {
      persona: 'reviewer',
      status: 'done',
      content: 'approved',
      timestamp: new Date(),
      matchedRuleIndex: 0,
    };

    engine.emit('step:start', step, 2, 'instruction', { provider: 'mock', model: 'gpt-test' });
    engine.emit('phase:start', step, 1, 'main', 'instruction', [], 'phase-1', 2);
    engine.emit('phase:complete', step, 1, 'main', 'approved', 'done', undefined, 'phase-1', 2);
    engine.emit('step:complete', step, response, 'instruction');
    engine.emit('workflow:complete', { iteration: 2 });

    expect(runMetaManager.updateStep).toHaveBeenCalledWith('review', 2, resumePoint);
    expect(runMetaManager.updatePhase).toHaveBeenCalledTimes(2);
    expect(runMetaManager.updatePhase.mock.calls[0]?.slice(0, 3)).toEqual(['review', 2, 1]);
    expect(runMetaManager.updatePhase.mock.calls[1]?.slice(0, 3)).toEqual(['review', 2, 1]);
    expect(runMetaManager.updateResumePoint).toHaveBeenCalledWith(resumePoint);
    expect(runMetaManager.finalize).toHaveBeenCalledWith('completed', 2);
    expect(bridge.state.lastStepName).toBe('review');
    expect(bridge.state.lastStepContent).toBe('approved');
    expect(bridge.state.sessionLog.iterations).toBe(1);
  });

  it('findings ledger event を analytics emitter に渡す', () => {
    const { engine, analyticsEmitter } = createBridgeHarness();
    const ledger: FindingLedger = {
      version: 1,
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-06-13T01:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
    };

    engine.emit('findings:ledger', ledger);

    expect(analyticsEmitter.onFindingLedgerUpdated).toHaveBeenCalledWith(ledger);
  });

  it('workflow complete event が TraceQL discovery を完了出力へ渡す', () => {
    const { engine, out } = createBridgeHarness({
      traceDiscovery: {
        queries: ['{ resource.service.name = "takt" && span."takt.run.id" = "run-843" }'],
      },
    });

    engine.emit('workflow:complete', { iteration: 2 });

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

    engine.emit('workflow:abort', { iteration: 2 }, 'Step "write_tests" failed');

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
      const actualAnalyticsEmitter = new AnalyticsEmitter('run-ledger', 'mock', 'test-model', 'parent');
      const { engine, runMetaManager, analyticsEmitter } = createBridgeHarness();
      analyticsEmitter.onFindingLedgerUpdated.mockImplementation((ledger: FindingLedger) => {
        actualAnalyticsEmitter.onFindingLedgerUpdated(ledger);
      });
      const ledger: FindingLedger = {
        version: 1,
        workflowName: 'peer-review',
        nextId: 2,
        updatedAt: '2026-06-13T02:30:00.000Z',
        findings: [
          {
            id: 'F-0001',
            status: 'open',
            lifecycle: 'new',
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
      };

      expect(() => engine.emit('findings:ledger', ledger)).not.toThrow();
      expect(() => engine.emit('workflow:complete', { iteration: 3 })).not.toThrow();

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
      providerSource: 'auto.ai',
      autoRoutingDecision: {
        candidateName: 'coding',
        costTier: 'medium',
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
    const { engine, out, usageEventLogger, analyticsEmitter } = createBridgeHarness({
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
    });

    expect(out.info).toHaveBeenCalledWith('Model: (default)');
    expect(analyticsEmitter.updateProviderInfo).toHaveBeenCalledWith(1, 'cursor', '(default)', 'parent');
  });

  it('workflow_call 親子の完了順が入れ子でも開始時の usage context を保持する', () => {
    const { engine, usageEventLogger } = createBridgeHarness();
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
    });
    engine.emit('step:start', childStep, 1, 'implement', {
      provider: 'claude',
      model: 'child-model',
    });
    engine.emit('step:complete', childStep, {
      persona: 'child-implement',
      status: 'done',
      content: 'child done',
      timestamp: new Date(),
      providerUsage: usage,
    }, 'implement');
    engine.emit('step:complete', parentStep, {
      persona: 'call-child',
      status: 'done',
      content: 'parent done',
      timestamp: new Date(),
      providerUsage: usage,
    }, 'call child');

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
  });

  it.each([
    ['parallel', { parallel: { steps: [] } }],
    ['team_leader', { teamLeader: { maxConcurrency: 1, maxTotalParts: 1, refillThreshold: 0, timeoutMs: 1000 } }],
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

    engine.emit('step:complete', step, response, 'instruction');

    expect(usageEventLogger.logUsageFor).not.toHaveBeenCalled();
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

    engine.emit('step:start', step, 1, 'instruction', {
      provider: 'codex',
      model: undefined,
      modelSource: 'step',
    });

    expect(out.info).toHaveBeenCalledWith('Model: (default)');
    expect(analyticsEmitter.updateProviderInfo).toHaveBeenCalledWith(1, 'codex', '(default)', 'parent');
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
    });

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
    });

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
    });

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
      });

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
    });

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
    });

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
      });

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
      });

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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' });
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' });
    engine.emit('step:complete', step, {
      persona: 'reviewer',
      status: 'done',
      content: 'approved',
      timestamp: new Date(),
    }, 'instruction');
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' });
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' });
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' });
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' });
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' });
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

    engine.emit('step:start', step, 1, 'instruction', { provider: 'opencode', model: 'gpt-test' });
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

    successHarness.engine.emit('workflow:complete', { iteration: 2 });
    await successHarness.bridge.flushEventSink();

    expect(eventSink).toHaveBeenCalledWith({
      type: 'completed',
      success: true,
      reportDirectory: '/tmp/project/run/reports',
    });

    eventSink.mockClear();
    const failureHarness = createBridgeHarness({ eventSink });
    failureHarness.engine.emit('workflow:abort', { iteration: 3 }, 'Step "review" failed');
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

    engine.emit('step:start', {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep, 1, 'instruction', { provider: 'mock', model: 'gpt-test' });

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
