import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowResumePoint, WorkflowStep } from '../core/models/index.js';
import { bindWorkflowExecutionEvents } from '../features/tasks/execute/workflowExecutionEvents.js';
import { resetDebugLogger, setVerboseConsole } from '../shared/utils/debug.js';

class TestEngine extends EventEmitter {
  constructor(private readonly resumePoint: WorkflowResumePoint) {
    super();
  }

  getResumePoint(): WorkflowResumePoint {
    return this.resumePoint;
  }
}

function createBridgeHarness(options?: {
  currentProvider?: string;
  configuredModel?: string;
  resumePoint?: WorkflowResumePoint;
}) {
  const resumePoint = options?.resumePoint ?? {
    version: 1,
    stack: [{ workflow: 'parent', step: 'review', kind: 'agent' }],
    iteration: 2,
    elapsed_ms: 100,
  } satisfies WorkflowResumePoint;
  const engine = new TestEngine(resumePoint);
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
    analyticsEmitter: {
      updateProviderInfo: vi.fn(),
      onStepComplete: vi.fn(),
      onStepReport: vi.fn(),
    } as never,
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

  return { bridge, engine, out, runMetaManager, resumePoint };
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
