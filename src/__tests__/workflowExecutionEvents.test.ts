import { EventEmitter } from 'node:events';
import { writeFileSync, rmSync } from 'node:fs';
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
    providerEventLogger: {
      setStep: vi.fn(),
      setProvider: vi.fn(),
    } as never,
    usageEventLogger: {
      setStep: vi.fn(),
      setProvider: vi.fn(),
      logUsage: vi.fn(),
    } as never,
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
    shouldNotifyWorkflowComplete: false,
    shouldNotifyWorkflowAbort: false,
    writeTraceReportOnce: vi.fn(),
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
  });

  return { bridge, engine, out, runMetaManager, resumePoint, analyticsEmitter };
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

  it('finding ledger analytics の書き込み失敗後も workflow complete を処理する', () => {
    const analyticsPath = join(tmpdir(), `takt-test-ledger-analytics-failure-${Date.now()}`);
    writeFileSync(analyticsPath, 'not a directory', 'utf-8');
    initAnalyticsWriter(true, analyticsPath);
    try {
      const actualAnalyticsEmitter = new AnalyticsEmitter('run-ledger', 'mock', 'test-model');
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
      rmSync(analyticsPath, { force: true });
    }
  });

  it('event bridge 初期化時に既存 open finding id を analytics emitter に渡す', () => {
    const { analyticsEmitter } = createBridgeHarness({ findingIds: ['F-0001', 'F-0002'] });

    expect(analyticsEmitter.seedFindingContractFindingIds).toHaveBeenCalledWith(['F-0001', 'F-0002']);
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
});
