import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowResumePoint, WorkflowStep } from '../core/models/index.js';
import type { StepProviderInfo } from '../core/workflow/types.js';
import { initAnalyticsWriter } from '../features/analytics/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { AnalyticsEmitter } from '../features/tasks/execute/analyticsEmitter.js';
import { bindWorkflowExecutionEvents } from '../features/tasks/execute/workflowExecutionEvents.js';
import { createOutputFns } from '../features/tasks/execute/outputFns.js';
import { SessionLogger } from '../features/tasks/execute/sessionLogger.js';
import { createWorkflowTerminalPayloadFactory } from '../features/tasks/execute/workflowTerminalPayload.js';
import { initNdjsonLog, parseNdjsonRecord } from '../infra/fs/session.js';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import { isVerboseConsole, resetDebugLogger, setVerboseConsole } from '../shared/utils/debug.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import type { ProviderType } from '../shared/types/provider.js';
import { MAX_TERMINAL_OUTPUT_BYTES, sanitizeTerminalText } from '../shared/utils/text.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import type { StreamDisplay } from '../shared/ui/index.js';
import type { ReportReferenceDiagnostic } from '../core/workflow/instruction/report-reference-validation.js';
import type { ReportReferenceConsumer } from '../core/workflow/instruction/prepared-instruction.js';
import { TaskPrefixWriter } from '../shared/ui/TaskPrefixWriter.js';
import { isQueryActive, registerQuery, unregisterQuery } from '../infra/claude/query-manager.js';

class TestEngine extends EventEmitter {
  public abort = vi.fn();

  constructor(private readonly resumePoint: WorkflowResumePoint) {
    super();
  }

  getResumePoint(): WorkflowResumePoint {
    return this.resumePoint;
  }

}

function createBridgeHarness(options?: {
  runtimeReportDiagnostics?: readonly ReportReferenceDiagnostic[];
  currentProvider?: ProviderType;
  configuredModel?: string;
  resumePoint?: WorkflowResumePoint;
  traceDiscovery?: { queries: string[] };
  eventSink?: ReturnType<typeof vi.fn>;
  shouldNotifyRateLimit?: boolean;
  display?: { flush: ReturnType<typeof vi.fn> };
  engine?: TestEngine;
  sessionLogger?: SessionLogger;
  prefixWriter?: TaskPrefixWriter | null;
  out?: ReturnType<typeof createOutputFns>;
  workflowConfig?: { name: string; maxSteps: number; steps: Array<{ name: string }> };
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
  const engine = options?.engine ?? new TestEngine(resumePoint);
  const out = {
    header: vi.fn(),
    info: vi.fn(),
    blankLine: vi.fn(),
    status: vi.fn(),
    error: vi.fn(),
    logLine: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };
  // Kept non-null so existing tests can assert against it without a null
  // check; when the caller opts out (prefixWriter: null), the harness passes
  // `null` to the bridge itself via prefixWriterArg below instead.
  const prefixWriter = {
    setStepContext: vi.fn(),
    flush: vi.fn(),
  };
  const prefixWriterArg = options?.prefixWriter === null ? null : options?.prefixWriter ?? prefixWriter;
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
    onRoutingDecision: vi.fn(),
    onCompanionEvent: vi.fn(),
  };
  const usageEventLogger = {
    logUsageFor: vi.fn(),
  };
  const sessionLogger = options?.sessionLogger ?? {
    onPhaseStart: vi.fn(),
    onPhaseComplete: vi.fn(),
    onJudgeStage: vi.fn(),
    onWorkflowCallStart: vi.fn(),
    onWorkflowCallComplete: vi.fn(),
    onStepStart: vi.fn(),
    onStepComplete: vi.fn(),
    onWorkflowComplete: vi.fn(),
    onWorkflowAbort: vi.fn(),
    onCompanionReviewRound: vi.fn(),
    onCompanionQueueCoalesced: vi.fn(),
    onCompanionCall: vi.fn(),
    onCompanionReviewSkipped: vi.fn(),
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
    runtimeReportDiagnostics: options?.runtimeReportDiagnostics,
    engine: engine as never,
    workflowConfig: options?.workflowConfig ?? {
      name: 'parent',
      maxSteps: 5,
      steps: [{ name: 'review' }],
    },
    currentProvider: options?.currentProvider ?? 'mock',
    configuredModel: options?.configuredModel ?? 'gpt-test',
    out: options?.out ?? out,
    prefixWriter: prefixWriterArg as never,
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
  it('matches runtime report warnings to the workflow, call path, parallel position and resolved reference', () => {
    const consumer: ReportReferenceConsumer = {
      workflowRef: 'project:sha256:child',
      callPath: [
        { workflowRef: 'project:sha256:parent', step: 'parallel' },
        { workflowRef: 'project:sha256:parent', step: 'left' },
      ],
      stepPath: ['parallel', 'work'],
    };
    const { engine, out } = createBridgeHarness({ runtimeReportDiagnostics: [{
      level: 'warning', message: 'Static guarantee warning',
      runtimeCheck: { consumer, reference: 'plan.md', message: 'warning-token' },
    }] });
    const missing = [{ reference: 'plan.md', scope: 'missing' }];
    engine.emit('report:resolved', { consumer: { ...consumer, workflowRef: 'project:sha256:other' }, reports: missing });
    engine.emit('report:resolved', { consumer: { ...consumer, callPath: [
      consumer.callPath[0], { workflowRef: 'project:sha256:parent', step: 'right' },
    ] }, reports: missing });
    engine.emit('report:resolved', { consumer: { ...consumer, stepPath: ['other', 'work'] }, reports: missing });
    engine.emit('report:resolved', { consumer, reports: [{ reference: 'other.md', scope: 'missing' }] });
    engine.emit('report:resolved', { consumer, reports: [{ reference: 'plan.md', scope: 'parent-run-readonly' }] });
    expect(out.warn).not.toHaveBeenCalled();

    engine.emit('report:resolved', { consumer, reports: missing });
    expect(out.warn).toHaveBeenCalledExactlyOnceWith('warning-token');
    // A later invocation is judged from its own resolution, rather than a cached decision.
    engine.emit('report:resolved', { consumer, reports: [{ reference: 'plan.md', scope: 'parent-run-readonly' }] });
    expect(out.warn).toHaveBeenCalledTimes(1);
    engine.emit('report:resolved', { consumer, reports: missing });
    expect(out.warn).toHaveBeenCalledTimes(2);
  });

  describe('provider option terminal output', () => {
    describe.each([
      { provider: 'claude', label: 'Effort', path: 'claude.effort' },
      { provider: 'claude-sdk', label: 'Effort', path: 'claude.effort' },
      { provider: 'claude-headless', label: 'Effort', path: 'claude.effort' },
      { provider: 'codex', label: 'Reasoning effort', path: 'codex.reasoningEffort' },
      { provider: 'opencode', label: 'Variant', path: 'opencode.variant' },
      { provider: 'copilot', label: 'Effort', path: 'copilot.effort' },
      { provider: 'kiro', label: 'Agent', path: 'kiro.agent' },
    ] as const)('$provider $path', ({ provider, label, path }) => {
      it.each([
        { value: 'demo', expected: 'demo', verbose: false },
        { value: 'demo\x1b]52;c;c2FmZQ==\x07', expected: 'demo', verbose: false },
        { value: 'demo\x07', expected: 'demo\\x07', verbose: false },
        { value: 'demo\x07', expected: 'demo\\x07', verbose: true },
      ])('safely displays $expected with verbose=$verbose and preserves the original options', ({ value, expected, verbose }) => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const previousVerbose = isVerboseConsole();
        try {
          setVerboseConsole(verbose);
          const { engine, sessionLogger } = createBridgeHarness({ prefixWriter: null, out: createOutputFns(undefined) });
          const step = { name: 'review', personaDisplayName: 'Reviewer', instruction: '' } as WorkflowStep;
          const providerInfo: StepProviderInfo = {
            provider,
            model: undefined,
            providerOptions: {
              claude: { effort: value },
              codex: { reasoningEffort: value },
              opencode: { variant: value },
              copilot: { effort: value },
              kiro: { agent: value },
            },
            providerOptionsSources: { [path]: 'project' },
          };
          const originalInfo = structuredClone(providerInfo);

          engine.emit('step:start', step, 1, 'instruction', providerInfo, 'parent', step.name);

          const optionLines = consoleSpy.mock.calls.map((args) => args.join(' '))
            .filter((line) => line.includes(`${label}: `));
          expect(optionLines).toHaveLength(1);
          const rawLine = optionLines[0]!;
          expect(rawLine).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
          expect(rawLine.replace(/\x1b\[[0-9;]*m/g, '')).toBe(
            `[INFO] ${label}: ${expected}${verbose ? ' (source: project)' : ''}`,
          );
          expect(providerInfo).toEqual(originalInfo);
          expect(sessionLogger.onStepStart).toHaveBeenCalledWith(step, 1, 'instruction', undefined, originalInfo);
        } finally {
          setVerboseConsole(previousVerbose);
          consoleSpy.mockRestore();
        }
      });

      it('omits the option line when the value is unset', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          const { engine } = createBridgeHarness({ prefixWriter: null, out: createOutputFns(undefined) });
          const step = { name: 'review', personaDisplayName: 'Reviewer', instruction: '' } as WorkflowStep;

          engine.emit('step:start', step, 1, 'instruction', { provider, providerOptions: {} }, 'parent', step.name);

          expect(consoleSpy.mock.calls.map((args) => args.join(' '))
            .filter((line) => line.includes(`${label}: `))).toEqual([]);
        } finally {
          consoleSpy.mockRestore();
        }
      });
    });

    it.each([
      { value: 'モデル/demo-1', expected: 'モデル/demo-1' },
      { value: 'demo]52;c;c2FmZQ==', expected: 'demo]52;c;c2FmZQ==' },
      { value: 'demo\x1b[2JX', expected: 'demoX' },
      { value: 'demo\x1b]', expected: 'demo\\x1b]' },
      { value: 'demo\x7f', expected: 'demo\\x7f' },
      { value: 'demo\x9b', expected: 'demo\\x9b' },
      { value: 'demo\r\n\tX', expected: 'demo\\r\\n\\tX' },
    ])('safely displays the Kiro agent boundary value $expected', ({ value, expected }) => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { engine } = createBridgeHarness({ prefixWriter: null, out: createOutputFns(undefined) });
        const step = { name: 'review', personaDisplayName: 'Reviewer', instruction: '' } as WorkflowStep;

        engine.emit('step:start', step, 1, 'instruction', {
          provider: 'kiro', providerOptions: { kiro: { agent: value } },
        }, 'parent', step.name);

        const optionLines = consoleSpy.mock.calls.map((args) => args.join(' '))
          .filter((line) => line.includes('Agent: '));
        expect(optionLines).toHaveLength(1);
        const rawLine = optionLines[0]!;
        expect(rawLine).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
        expect(rawLine.replace(/\x1b\[[0-9;]*m/g, '')).toBe(`[INFO] Agent: ${expected}`);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it.each([
      { value: 'demo\r\n\tX', expectedLines: ['[INFO] Agent: demo', '\tX'] },
      { value: 'demo\x1b]52;c;c2FmZQ==\x07', expectedLines: ['[INFO] Agent: demo'] },
    ])('preserves prefixed option lines for $expectedLines', ({ value, expectedLines }) => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const writeFn = vi.fn();
      const prefixWriter = new TaskPrefixWriter({ taskName: 'task', colorIndex: 0, writeFn });
      try {
        const { engine } = createBridgeHarness({ prefixWriter, out: createOutputFns(prefixWriter) });
        const step = { name: 'review', personaDisplayName: 'Reviewer', instruction: '' } as WorkflowStep;

        engine.emit('step:start', step, 1, 'instruction', {
          provider: 'kiro', providerOptions: { kiro: { agent: value } },
        }, 'parent', step.name, 1);

        const raw = writeFn.mock.calls.map(([line]) => String(line)).join('');
        expect(raw).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/u);
        const lines = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split('\n');
        expect(lines.slice(-expectedLines.length)).toEqual(
          expectedLines.map((line) => `[task][review](1/5)(1) ${line}`),
        );
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it.each([false, true])('keeps provider options silent with prefix=%s', (prefixed) => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const prefixWriter = prefixed ? new TaskPrefixWriter({ taskName: 'task', colorIndex: 0 }) : undefined;
        const { engine } = createBridgeHarness({ prefixWriter: prefixWriter ?? null, out: createOutputFns(prefixWriter, 'silent') });
        const step = { name: 'review', personaDisplayName: 'Reviewer', instruction: '' } as WorkflowStep;

        engine.emit('step:start', step, 1, 'instruction', {
          provider: 'kiro', providerOptions: { kiro: { agent: 'demo\x07' } },
        }, 'parent', step.name);

        expect(consoleSpy).not.toHaveBeenCalled();
        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
        consoleSpy.mockRestore();
      }
    });
  });

  describe('model terminal output', () => {
    describe.each(['configuredModel', 'providerInfo.model'] as const)('%s', (source) => {
      it.each([
        { model: 'demo', expected: 'demo' },
        { model: 'モデル/demo-1', expected: 'モデル/demo-1' },
        { model: 'demo52;c;c2FmZQ==', expected: 'demo52;c;c2FmZQ==' },
        { model: 'demo\x1b]52;c;c2FmZQ==\x07', expected: 'demo' },
        { model: 'demo\x1b[2JX', expected: 'demoX' },
        { model: 'demo\x1b]', expected: 'demo\\x1b]' },
        { model: 'demo\x07', expected: 'demo\\x07' },
        { model: 'demo\x7f', expected: 'demo\\x7f' },
        { model: 'demo\x9b', expected: 'demo\\x9b' },
        { model: 'demo\r\n\tX', expected: 'demo\\r\\n\\tX' },
      ])('safely displays $expected without changing the model input', ({ model, expected }) => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          const options = {
            configuredModel: source === 'configuredModel' ? model : 'fallback',
            prefixWriter: null,
            out: createOutputFns(undefined),
          };
          const { engine, sessionLogger } = createBridgeHarness(options);
          const step = { name: 'review', personaDisplayName: 'Reviewer', instruction: '' } as WorkflowStep;
          const providerInfo = source === 'configuredModel'
            ? { provider: 'mock' as const }
            : { provider: 'mock' as const, model };

          engine.emit('step:start', step, 1, 'instruction', providerInfo, 'parent', step.name);

          const modelLines = consoleSpy.mock.calls.map((args) => args.join(' '))
            .filter((line) => line.includes('Model: '));
          expect(modelLines).toHaveLength(1);
          const rawLine = modelLines[0]!;
          expect(rawLine).not.toMatch(/\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/u);
          expect(rawLine.replace(/\x1b\[[0-9;]*m/g, '')).toBe(`[INFO] Model: ${expected}`);
          expect(options.configuredModel).toBe(source === 'configuredModel' ? model : 'fallback');
          if (source === 'providerInfo.model') expect(providerInfo).toHaveProperty('model', model);
          expect(sessionLogger.onStepStart).toHaveBeenCalledWith(step, 1, 'instruction', undefined, providerInfo);
        } finally {
          consoleSpy.mockRestore();
        }
      });
    });

    it('preserves prefixed model line splitting and tabs while removing CR', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const writeFn = vi.fn();
      const prefixWriter = new TaskPrefixWriter({ taskName: 'task', colorIndex: 0, writeFn });
      try {
        const { engine } = createBridgeHarness({ prefixWriter, out: createOutputFns(prefixWriter) });
        const step = { name: 'review', personaDisplayName: 'Reviewer', instruction: '' } as WorkflowStep;

        engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'demo\r\n\tX' }, 'parent', step.name, 1);

        const raw = writeFn.mock.calls.map(([line]) => String(line)).join('');
        expect(raw).not.toContain('\r');
        const lines = raw.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
        expect(lines).toContain('[task][review](1/5)(1) [INFO] Model: demo');
        expect(lines).toContain('[task][review](1/5)(1) \tX');
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('keeps model output silent', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const { engine } = createBridgeHarness({ prefixWriter: null, out: createOutputFns(undefined, 'silent') });
        const step = { name: 'review', personaDisplayName: 'Reviewer', instruction: '' } as WorkflowStep;

        engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'demo\x07' }, 'parent', step.name);

        expect(consoleSpy).not.toHaveBeenCalled();
        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
        consoleSpy.mockRestore();
      }
    });
  });

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

  it('Companion監査のSessionLogger失敗をワークフローへ伝播させない', () => {
    const sessionLogger = {
      onCompanionCall: vi.fn(() => { throw new Error('call audit append failed'); }),
      onCompanionReviewRound: vi.fn(() => { throw new Error('review audit append failed'); }),
      onCompanionReviewSkipped: vi.fn(() => { throw new Error('skip audit append failed'); }),
    } as unknown as SessionLogger;
    const { engine } = createBridgeHarness({ sessionLogger });

    expect(() => {
      engine.emit('companion:call', {
        step: 'review',
        agent: 'security-reviewer',
        purpose: 'reviewer',
        attempt: 1,
        status: 'completed',
        provider: 'mock',
        promptResolved: false,
      });
      engine.emit('companion:review_round', {
        step: 'review',
        reviewMode: 'live',
        companion: 'security-reviewer',
        trigger: 'quiet',
        digest: 'digest',
        changedLines: 1,
        findingCount: 0,
        reviewerFindings: [],
        acceptedFindings: [],
      });
      engine.emit('companion:review_skipped', {
        step: 'review',
        companion: 'security-reviewer',
        phase: 'live',
        reason: 'unchanged_digest',
      });
    }).not.toThrow();

    expect(sessionLogger.onCompanionCall).toHaveBeenCalledOnce();
    expect(sessionLogger.onCompanionReviewRound).toHaveBeenCalledOnce();
    expect(sessionLogger.onCompanionReviewSkipped).toHaveBeenCalledOnce();
  });

  it('SessionLoggerの監査NDJSON失敗時に未永続レコードをメモリへ残さない', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-companion-audit-failure-'));
    try {
      const sessionLogger = new SessionLogger(logsDir, false);
      const { engine } = createBridgeHarness({ sessionLogger });

      expect(() => engine.emit('companion:review_skipped', {
        step: 'review',
        companion: 'security-reviewer',
        phase: 'live',
        reason: 'unchanged_digest',
        observedGeneration: 2,
      })).not.toThrow();
      expect(() => engine.emit('companion:queue_coalesced', {
        step: 'review',
        companion: 'security-reviewer',
        replaced: {
          trigger: 'quiet',
          digest: 'digest-1',
          changedLines: 1,
          observedGeneration: 1,
        },
        replacement: {
          trigger: 'quiet',
          digest: 'digest-2',
          changedLines: 2,
          observedGeneration: 2,
        },
      })).not.toThrow();

      expect(sessionLogger.getNdjsonRecords()).toEqual([]);
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('child workflow の companion review event を relay と親 bridge 経由で run NDJSON に記録する', async () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-companion-relay-'));
    try {
      const ndjsonPath = initNdjsonLog('session-relay', 'task', 'parent', { logsDir });
      const sessionLogger = new SessionLogger(ndjsonPath, false);
      const bridgeHarness = createBridgeHarness({ sessionLogger });
      const parentConfig = {
        name: 'parent',
        initialStep: 'delegate',
        maxSteps: 10,
        steps: [],
      };
      const childConfig = {
        name: 'child',
        initialStep: 'review',
        maxSteps: 10,
        steps: [{ name: 'review' }],
      };
      const step = {
        name: 'delegate',
        call: 'child',
        personaDisplayName: 'delegate',
        instruction: '',
      };
      const state = {
        workflowName: 'parent',
        currentStep: 'delegate',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map([['delegate', 1]]),
        dynamicParallelSelections: new Map(),
        status: 'running',
      };
      const childState = {
        ...state,
        workflowName: 'child',
        currentStep: 'review',
        status: 'completed',
      };
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const childScope = ['subworkflows', 'iteration-1--step-delegate--workflow-child'];
      const reviewRoundPayload = {
        step: 'review',
        reviewMode: 'live',
        companion: 'security-reviewer',
        trigger: 'quiet',
        digest: 'child-digest',
        changedLines: 12,
        findingCount: 0,
        reviewerFindings: [],
        acceptedFindings: [],
        runPathNamespace: childScope,
      };
      const queueCoalescedPayload = {
        step: 'review',
        companion: 'security-reviewer',
        runPathNamespace: childScope,
        replaced: {
          trigger: 'quiet',
          digest: 'child-digest',
          changedLines: 12,
          observedGeneration: 1,
        },
        replacement: {
          trigger: 'forced',
          digest: 'child-digest-2',
          changedLines: 18,
          observedGeneration: 2,
        },
      };
      const callPayload = {
        step: 'review',
        agent: 'security-reviewer',
        purpose: 'reviewer' as const,
        attempt: 1,
        status: 'completed' as const,
        provider: 'mock' as const,
        promptResolved: false,
        runPathNamespace: childScope,
      };
      const skippedPayload = {
        step: 'review',
        companion: 'security-reviewer',
        phase: 'fix' as const,
        reason: 'unchanged_digest' as const,
        runPathNamespace: childScope,
      };
      const childEngine = {
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, listener);
        }),
        runWithResult: vi.fn().mockImplementation(async () => {
          listeners.get('companion:review_round')?.(reviewRoundPayload);
          listeners.get('companion:queue_coalesced')?.(queueCoalescedPayload);
          listeners.get('companion:call')?.(callPayload);
          listeners.get('companion:review_skipped')?.(skippedPayload);
          return { state: childState };
        }),
      };
      const sharedRuntime = { startedAtMs: Date.now(), maxSteps: 10 };
      const executor = new WorkflowCallExecutor({
        getConfig: () => parentConfig as never,
        getOptions: () => ({ projectCwd: '/tmp/project', reportDirName: 'run' }),
        getMaxSteps: () => 10,
        updateMaxSteps: vi.fn(),
        getCwd: () => '/tmp/project',
        projectCwd: '/tmp/project',
        task: 'task',
        sharedRuntime: sharedRuntime as never,
        resumeStackPrefix: [],
        consumeWorkflowCallContinuation: vi.fn(),
        runPaths: { slug: 'run' } as never,
        resolveWorkflowCall: vi.fn(),
        createEngine: vi.fn().mockReturnValue(childEngine),
        emit: (event: string, ...args: unknown[]) => bridgeHarness.engine.emit(event, ...args),
        state: state as never,
        setActiveResumePoint: vi.fn(),
      });

      const prepared = executor.prepare(step as never, childConfig as never, 1, []);
      await executor.execute({
        step: step as never,
        preparedExecution: prepared,
        childProviderInfo: { provider: 'mock', model: 'test-model' },
        parentProviderOptions: undefined,
        personaProviders: undefined,
        providerRouting: undefined,
        providerLadders: undefined,
      } as never, { syncParentState: true });

      const records = readFileSync(ndjsonPath, 'utf8')
        .trim()
        .split('\n')
        .map(parseNdjsonRecord);
      expect(records).toContainEqual(expect.objectContaining({
        type: 'companion_review_round',
        step: 'review',
        reviewMode: 'live',
        companion: 'security-reviewer',
        trigger: 'quiet',
        digest: 'child-digest',
        changedLines: 12,
        findingCount: 0,
        runPathNamespace: childScope,
      }));
      expect(records).toContainEqual(expect.objectContaining({
        type: 'companion_call',
        promptResolved: false,
        runPathNamespace: childScope,
      }));
      expect(records).toContainEqual(expect.objectContaining({
        type: 'companion_review_skipped',
        phase: 'fix',
        runPathNamespace: childScope,
      }));
      expect(records).toContainEqual(expect.objectContaining({
        type: 'companion_queue_coalesced',
        step: 'review',
        companion: 'security-reviewer',
        replaced: expect.objectContaining({ digest: 'child-digest' }),
        replacement: expect.objectContaining({ digest: 'child-digest-2' }),
        runPathNamespace: childScope,
      }));
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
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

  it('タスク中断の終端イベントで別タスクのClaude queryを停止しない', () => {
    const { engine, bridge } = createBridgeHarness({ currentProvider: 'claude' });
    const sibling = { interrupt: vi.fn(async () => {}) };
    const siblingId = 'goal-abort-sibling-query';
    registerQuery(siblingId, sibling as never);
    try {
      engine.emit('workflow:abort', { iteration: 3 }, 'Goal was aborted', 'interrupt', {
        kind: 'interrupt', step: 'review', reason: 'Goal was aborted', error: 'Goal was aborted',
      });
      expect(bridge.state.abortKind).toBe('interrupt');
      expect(sibling.interrupt).not.toHaveBeenCalled();
      expect(isQueryActive(siblingId)).toBe(true);
    } finally { unregisterQuery(siblingId); }
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
      failureCategory: AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT,
    },
    {
      kind: 'step_error',
      expectedStatus: 'failed',
      failureError: 'REVIEW_FAILED: report validation failed',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    },
  ] as const)('publishes $kind as $expectedStatus', ({
    kind,
    expectedStatus,
    failureError,
    failureCategory,
  }) => {
    const { bridge, engine, runMetaManager } = createBridgeHarness();

    engine.emit(
      'workflow:abort',
      { iteration: 3 },
      'terminal reason',
      kind,
      {
        kind,
        step: 'reviewers',
        reason: 'terminal reason',
        error: failureError,
        failureCategory,
      },
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
        failureCategory,
      },
    });
    expect(bridge.state.failure).toEqual({
      step: 'reviewers',
      error: failureError,
      failureCategory,
    });
    expect(payload.sessionRecord).toMatchObject({
      type: 'workflow_abort',
      failureCategory,
    });
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

  it('workflow_call中は子workflowのstep数で進捗表示し、親へ戻ったら親のstep数へ戻す', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const harness = createBridgeHarness({
        prefixWriter: null,
        workflowConfig: {
          name: 'parent',
          maxSteps: 10,
          steps: [{ name: 'plan' }, { name: 'call-child' }, { name: 'supervise' }],
        },
      });
      const { engine } = harness;
      // The bridge replaces displayRef.current with a real StreamDisplay once
      // prefixWriter is absent; the harness's own type only covers the
      // {flush} mock shape it defaults to, so read it back through that type.
      const displayRef = harness.displayRef as unknown as { current: StreamDisplay | null };
      const planStep = {
        name: 'plan',
        personaDisplayName: 'Planner',
        instruction: '',
        rules: [],
      } as WorkflowStep;
      const implementStep = {
        name: 'implement',
        personaDisplayName: 'Child coder',
        instruction: '',
        rules: [],
      } as WorkflowStep;
      const reviewStep = {
        name: 'review',
        personaDisplayName: 'Child reviewer',
        instruction: '',
        rules: [],
      } as WorkflowStep;
      const superviseStep = {
        name: 'supervise',
        personaDisplayName: 'Supervisor',
        instruction: '',
        rules: [],
      } as WorkflowStep;
      const providerInfo = { provider: 'mock' as const, model: 'gpt-test' };

      // parent step 1/3 ("plan")
      engine.emit('step:start', planStep, 1, 'plan', providerInfo, 'parent', planStep.name, 1, [], 0, 3);
      consoleLogSpy.mockClear();
      displayRef.current!.showInit('gpt-test');
      expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('step 1/3');

      // workflow_call の子 step は親の steps に存在しない名前 — 子workflowの steps (2件) で数える
      engine.emit('step:start', implementStep, 2, 'implement', providerInfo, 'child', implementStep.name, 1, [], 0, 2);
      consoleLogSpy.mockClear();
      displayRef.current!.showInit('gpt-test');
      expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('step 1/2');

      engine.emit('step:start', reviewStep, 3, 'review', providerInfo, 'child', reviewStep.name, 1, [], 1, 2);
      consoleLogSpy.mockClear();
      displayRef.current!.showInit('gpt-test');
      expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('step 2/2');

      // 親へ戻った後は親の steps (3件) で数える — step 2/3 が飛ばされず表示される
      engine.emit('step:start', superviseStep, 4, 'supervise', providerInfo, 'parent', superviseStep.name, 1, [], 2, 3);
      consoleLogSpy.mockClear();
      displayRef.current!.showInit('gpt-test');
      expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('step 3/3');
    } finally {
      consoleLogSpy.mockRestore();
    }
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
          scopeIdentity: '{"workflow":"parent","stack":[{"workflow":"parent","workflow_ref":"project:sha256:parent","step":"reviewers","kind":"parallel","occurrence":2}]}',
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
          scopeIdentity: expect.any(String),
          provider: 'claude',
          model: 'fast-model',
        },
      },
      {
        content: 'slow done',
        context: {
          iteration: 3,
          workflowName: 'shared-child',
          scopeIdentity: expect.any(String),
          provider: 'codex',
          model: 'slow-model',
        },
      },
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

    const infoText = out.info.mock.calls.flat().map((value) => String(value)).join('\n');
    expect(infoText).not.toContain('127.0.0.1:8787');
  });

  it.each([
    { fastMode: true, label: 'enabled' },
    { fastMode: false, label: 'disabled' },
  ])('verbose 時に Codex fast mode=%s と解決ソースを表示する', ({ fastMode, label }) => {
    resetDebugLogger();
    setVerboseConsole(true);
    try {
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
        providerOptions: { codex: { fastMode } },
        providerOptionsSources: { 'codex.fastMode': 'project' },
      }, 'parent', step.name);

      const infoLines = out.info.mock.calls.map(([value]) => String(value));
      expect(infoLines).toContain(`Fast mode: ${label} (source: project)`);
    } finally {
      resetDebugLogger();
    }
  });

  it('Codex fast mode が未指定ならサマリー行を表示しない', () => {
    resetDebugLogger();
    setVerboseConsole(true);
    try {
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

      const fastModeLines = out.info.mock.calls
        .map(([value]) => String(value))
        .filter((line) => line.startsWith('Fast mode:'));
      expect(fastModeLines).toEqual([]);
    } finally {
      resetDebugLogger();
    }
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

      const infoText = out.info.mock.calls.flat().map((value) => String(value)).join('\n');
      expect(infoText).not.toContain('127.0.0.1:8787');
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

  it('step error は端末表示だけをサニタイズし、event sink には元値を渡す', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine, out } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;
    const unsafeError = 'provider failed\x1b]52;c;secret\x07\r\x00';

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    engine.emit('step:complete', step, {
      persona: 'reviewer',
      status: 'error',
      content: '',
      error: unsafeError,
      timestamp: new Date(),
    }, 'instruction', step.name);
    await bridge.flushEventSink();

    const terminalMessage = out.error.mock.calls[0]?.[0] as string;
    expect(terminalMessage).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(terminalMessage).toContain('provider failed');
    expect(terminalMessage).toContain('\\r\\x00');
    expect(eventSink).toHaveBeenCalledWith({
      type: 'error',
      message: unsafeError,
      step: 'review',
    });
  });

  it(`step error の最終端末表示を${MAX_TERMINAL_OUTPUT_BYTES}バイト以内に収め、truncation markerを保持する`, async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine, out } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;
    const marker = '[TRUNCATED: 12000 bytes, full text: /tmp/failure.txt]';
    const error = `${'x'.repeat(
      MAX_TERMINAL_OUTPUT_BYTES - Buffer.byteLength(marker, 'utf8'),
    )}${marker}`;

    engine.emit('step:start', step, 1, 'instruction', { provider: 'mock', model: 'gpt-test' }, 'parent', step.name);
    engine.emit('step:complete', step, {
      persona: 'reviewer',
      status: 'error',
      content: '',
      error,
      timestamp: new Date(),
    }, 'instruction', step.name);
    await bridge.flushEventSink();

    const terminalMessage = out.error.mock.calls[0]?.[0] as string;
    expect(Buffer.byteLength(terminalMessage, 'utf8')).toBeLessThanOrEqual(
      MAX_TERMINAL_OUTPUT_BYTES,
    );
    expect(terminalMessage).toContain(marker);
    expect(eventSink).toHaveBeenCalledWith({
      type: 'error',
      message: error,
      step: 'review',
    });
  });

  it('rate limit の step error を provider と retry time を含む要約で端末表示する', () => {
    const errorMessage = "You've hit your usage limit. Try again at 7:04 PM";
    const { engine, out } = createBridgeHarness();
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emit('step:start', step, 1, 'instruction', { provider: 'codex', model: 'gpt-test' }, 'parent', step.name);
    engine.emit('step:complete', step, {
      persona: 'reviewer',
      status: 'rate_limited',
      content: '',
      error: errorMessage,
      errorKind: 'rate_limit',
      rateLimitInfo: {
        provider: 'codex',
        detectedAt: new Date(),
        source: 'error_text',
        resetAtRaw: '7:04 PM',
      },
      timestamp: new Date(),
    }, 'instruction', step.name);

    expect(out.error).toHaveBeenCalledOnce();
    const terminalMessage = out.error.mock.calls[0]?.[0] as string;
    expect(terminalMessage).toContain('Error: codex');
    expect(terminalMessage).toContain('retry after 7:04 PM');
    expect(terminalMessage).toContain(errorMessage);
  });

  it('UTF-8 byte budget を超える長い rate limit 要約を省き、元エラーを表示する', () => {
    const errorMessage = 'Original provider error remains visible';
    const resetAtRaw = '時'.repeat(
      Math.floor(MAX_TERMINAL_OUTPUT_BYTES / Buffer.byteLength('時', 'utf8')),
    );
    const rateLimitSummary = `codex usage limit reached — retry after ${resetAtRaw}`;
    const summarizedMessage = `${rateLimitSummary}: ${errorMessage}`;
    const outputBudgetBytes = MAX_TERMINAL_OUTPUT_BYTES - Buffer.byteLength('Error: ', 'utf8');
    const { engine, out } = createBridgeHarness();
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    expect(summarizedMessage.length).toBeLessThan(outputBudgetBytes);
    expect(Buffer.byteLength(summarizedMessage, 'utf8')).toBeGreaterThan(outputBudgetBytes);

    engine.emit('step:start', step, 1, 'instruction', { provider: 'codex', model: 'gpt-test' }, 'parent', step.name);
    engine.emit('step:complete', step, {
      persona: 'reviewer',
      status: 'rate_limited',
      content: '',
      error: errorMessage,
      errorKind: 'rate_limit',
      rateLimitInfo: {
        provider: 'codex',
        detectedAt: new Date(),
        source: 'error_text',
        resetAtRaw,
      },
      timestamp: new Date(),
    }, 'instruction', step.name);

    const terminalMessage = out.error.mock.calls[0]?.[0] as string;
    expect(terminalMessage).toBe(`Error: ${errorMessage}`);
    expect(Buffer.byteLength(terminalMessage, 'utf8')).toBeLessThanOrEqual(
      MAX_TERMINAL_OUTPUT_BYTES,
    );
  });

  it('sanitize 後に byte budget を超える rate limit 要約を省き、収まる元エラーを表示する', () => {
    const resetAtRaw = `${'\0'.repeat(1_500)} original-error-end`;
    const errorMessage = `Claude SDK rate limit event: resets ${resetAtRaw}`;
    const rateLimitSummary = `claude-sdk rate limit reached — retry after ${resetAtRaw}`;
    const summarizedMessage = `${rateLimitSummary}: ${errorMessage}`;
    const sanitizedError = sanitizeTerminalText(errorMessage);
    const sanitizedSummarizedMessage = sanitizeTerminalText(summarizedMessage);
    const outputBudgetBytes = MAX_TERMINAL_OUTPUT_BYTES - Buffer.byteLength('Error: ', 'utf8');
    const { engine, out } = createBridgeHarness();
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    expect(Buffer.byteLength(summarizedMessage, 'utf8')).toBeLessThanOrEqual(outputBudgetBytes);
    expect(Buffer.byteLength(sanitizedError, 'utf8')).toBeLessThanOrEqual(outputBudgetBytes);
    expect(Buffer.byteLength(sanitizedSummarizedMessage, 'utf8')).toBeGreaterThan(outputBudgetBytes);

    engine.emit('step:start', step, 1, 'instruction', { provider: 'claude-sdk', model: 'gpt-test' }, 'parent', step.name);
    engine.emit('step:complete', step, {
      persona: 'reviewer',
      status: 'rate_limited',
      content: '',
      error: errorMessage,
      errorKind: 'rate_limit',
      rateLimitInfo: {
        provider: 'claude-sdk',
        detectedAt: new Date(),
        source: 'error_text',
        resetAtRaw,
      },
      timestamp: new Date(),
    }, 'instruction', step.name);

    const terminalMessage = out.error.mock.calls[0]?.[0] as string;
    expect(terminalMessage).toBe(`Error: ${sanitizedError}`);
    expect(Buffer.byteLength(terminalMessage, 'utf8')).toBeLessThanOrEqual(
      MAX_TERMINAL_OUTPUT_BYTES,
    );
  });

  it('resetAtRaw のない Claude SDK 応答でも元エラーのリセット情報と原因を端末表示に残す', () => {
    const errorMessage = 'Claude SDK rate limit event: status=rejected, rateLimitType=five_hour, overageStatus=rejected, overageDisabledReason=out_of_credits, resetsAt=1775059200, overageResetsAt=1775059200, isUsingOverage=false';
    const { engine, out } = createBridgeHarness();
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emit('step:start', step, 1, 'instruction', { provider: 'claude-sdk', model: 'claude-sonnet-4-6' }, 'parent', step.name);
    engine.emit('step:complete', step, {
      persona: 'reviewer',
      status: 'rate_limited',
      content: '',
      error: errorMessage,
      errorKind: 'rate_limit',
      rateLimitInfo: {
        provider: 'claude-sdk',
        detectedAt: new Date(),
        source: 'sdk_error',
      },
      timestamp: new Date(),
    }, 'instruction', step.name);

    expect(out.error).toHaveBeenCalledOnce();
    const terminalMessage = out.error.mock.calls[0]?.[0] as string;
    expect(terminalMessage).toContain('Error: claude-sdk');
    expect(terminalMessage).toContain(errorMessage);
    expect(terminalMessage).not.toContain('retry after');
    expect(terminalMessage).not.toMatch(/[\n\r]/);
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

  it('event sink へ並列 tool result を provider の ID で対応づける', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emit('step:start', step, 1, 'instruction', { provider: 'pi', model: 'test/model' }, 'parent', step.name);
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
      data: { id: 'tool-b', content: 'content b', isError: false },
    });
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { id: 'tool-a', content: 'content a', isError: false },
    });
    await bridge.flushEventSink();

    const completedEvents = eventSink.mock.calls
      .map((call) => call[0])
      .filter((event) => event.type === 'tool_completed');
    expect(completedEvents).toEqual([
      expect.objectContaining({ toolCallId: 'tool-b', message: 'content b' }),
      expect.objectContaining({ toolCallId: 'tool-a', message: 'content a' }),
    ]);
  });

  it('対応する tool use がない ID や重複 ID を tool completion にしない', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine } = createBridgeHarness({ eventSink });
    const step = {
      name: 'review',
      personaDisplayName: 'Reviewer',
      instruction: '',
    } as WorkflowStep;

    engine.emit('step:start', step, 1, 'instruction', { provider: 'pi', model: 'test/model' }, 'parent', step.name);
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
      data: { id: 'not-started', content: 'orphan result', isError: false },
    });
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { id: 'tool-b', content: 'content b', isError: false },
    });
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { id: 'tool-b', content: 'duplicate result', isError: false },
    });
    bridge.emitProviderOutput({
      type: 'tool_result',
      data: { id: 'tool-a', content: 'content a', isError: false },
    });
    await bridge.flushEventSink();

    const completedEvents = eventSink.mock.calls
      .map((call) => call[0])
      .filter((event) => event.type === 'tool_completed');
    expect(completedEvents).toEqual([
      expect.objectContaining({ toolCallId: 'tool-b', message: 'content b' }),
      expect.objectContaining({ toolCallId: 'tool-a', message: 'content a' }),
    ]);
    expect(eventSink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'output',
      outputType: 'tool_result',
      message: 'orphan result',
    }));
    expect(eventSink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'output',
      outputType: 'tool_result',
      message: 'duplicate result',
    }));
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

  it('CT-COMP-11 should preserve companion review mode and trigger across event and analytics bridges', async () => {
    const eventSink = vi.fn().mockResolvedValue(undefined);
    const { bridge, engine, analyticsEmitter, out, sessionLogger } = createBridgeHarness({ eventSink });
    const events = [
      ['companion:start', { step: 'implement', companion: 'security-reviewer', reviewMode: 'completion' }],
      ['companion:pool_selected', {
        step: 'implement',
        selected: ['design-reviewer'],
        rationale: 'design files changed',
      }],
      ['companion:finding', {
        step: 'implement',
        companion: 'security-reviewer',
        severity: 'must_fix',
      }],
      ['companion:fix_round', { step: 'implement', sequence: 2, findingCount: 1 }],
      ['companion:complete', {
        step: 'implement',
        completionSettled: true,
        completionFailure: false,
        followUpRounds: 1,
      }],
      ['companion:review_round', {
        step: 'implement',
        reviewMode: 'live',
        companion: 'security-reviewer',
        trigger: 'quiet',
        digest: 'digest-2',
        changedLines: 12,
        findingCount: 1,
        reviewerFindings: [{
          severity: 'must_fix',
          file: 'src/private.ts',
          line: 7,
          finding: 'candidate-private-detail',
        }],
        moderator: {
          name: 'moderator',
          invoked: true,
          decisions: [{ action: 'accept', sourceIndex: 0 }],
        },
        acceptedFindings: [{
          severity: 'must_fix',
          file: 'src/private.ts',
          line: 7,
          finding: 'candidate-private-detail',
        }],
      }],
      ['companion:queue_coalesced', {
        step: 'implement',
        companion: 'security-reviewer',
        replaced: {
          trigger: 'quiet',
          digest: 'digest-1',
          changedLines: 10,
          observedGeneration: 1,
        },
        replacement: {
          trigger: 'quiet',
          digest: 'digest-2',
          changedLines: 12,
          observedGeneration: 2,
        },
      }],
    ] as const;

    for (const [name, payload] of events) {
      engine.emit(name, payload);
    }
    await bridge.flushEventSink();

    expect(eventSink.mock.calls.map(([event]) => event)).toEqual([
      { type: 'companion', action: 'start', step: 'implement', companion: 'security-reviewer', reviewMode: 'completion' },
      {
        type: 'companion',
        action: 'pool_selected',
        step: 'implement',
        selected: ['design-reviewer'],
        rationale: 'design files changed',
      },
      {
        type: 'companion',
        action: 'finding',
        step: 'implement',
        companion: 'security-reviewer',
        severity: 'must_fix',
      },
      {
        type: 'companion',
        action: 'fix_round',
        step: 'implement',
        sequence: 2,
        findingCount: 1,
      },
      {
        type: 'companion',
        action: 'complete',
        step: 'implement',
        completionSettled: true,
        completionFailure: false,
        followUpRounds: 1,
      },
      {
        type: 'companion',
        action: 'review_round',
        step: 'implement',
        reviewMode: 'live',
        companion: 'security-reviewer',
        trigger: 'quiet',
        digest: 'digest-2',
        changedLines: 12,
        findingCount: 1,
      },
      {
        type: 'companion',
        action: 'queue_coalesced',
        step: 'implement',
        companion: 'security-reviewer',
        replaced: {
          trigger: 'quiet',
          digest: 'digest-1',
          changedLines: 10,
          observedGeneration: 1,
        },
        replacement: {
          trigger: 'quiet',
          digest: 'digest-2',
          changedLines: 12,
          observedGeneration: 2,
        },
      },
    ]);
    expect(sessionLogger.onCompanionReviewRound).toHaveBeenCalledWith(events[5][1]);
    expect(sessionLogger.onCompanionReviewRound).toHaveBeenCalledWith(expect.objectContaining({
      reviewMode: 'live',
      trigger: 'quiet',
    }));
    expect(sessionLogger.onCompanionQueueCoalesced).toHaveBeenCalledWith(events[6][1]);
    expect(analyticsEmitter.onCompanionEvent.mock.calls.map(([name]) => name))
      .toEqual(events.map(([name]) => name));
    expect(analyticsEmitter.onCompanionEvent).toHaveBeenNthCalledWith(6, 'companion:review_round', {
      step: 'implement',
      reviewMode: 'live',
      companion: 'security-reviewer',
      trigger: 'quiet',
      digest: 'digest-2',
      changedLines: 12,
      findingCount: 1,
    });
    expect(JSON.stringify(eventSink.mock.calls)).not.toContain('candidate-private-detail');
    expect(JSON.stringify(analyticsEmitter.onCompanionEvent.mock.calls)).not.toContain('candidate-private-detail');
  });

  it('records a dropped model as the provider default in display and session NDJSON', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-provider-model-default-'));
    try {
      const ndjsonPath = initNdjsonLog('session-provider-model', 'task', 'parent', { logsDir });
      const sessionLogger = new SessionLogger(ndjsonPath, false);
      const { engine, out } = createBridgeHarness({
        currentProvider: 'copilot',
        configuredModel: 'opus',
        sessionLogger,
      });
      const step = {
        name: 'plan',
        personaDisplayName: 'Planner',
        instruction: '',
      } as WorkflowStep;

      engine.emit('step:start', step, 1, 'instruction', {
        provider: 'copilot',
        providerSource: 'cli',
        model: undefined,
        modelSource: 'default',
      }, 'parent', step.name);

      const infoLines = out.info.mock.calls.map(([value]) => String(value));
      expect(infoLines).toContain('Model: (default)');

      const records = readFileSync(ndjsonPath, 'utf8')
        .trim()
        .split('\n')
        .map(parseNdjsonRecord);
      const stepStart = records.find((record) => record.type === 'step_start');
      expect(stepStart).toMatchObject({
        provider: 'copilot',
        providerSource: 'cli',
        modelSource: 'default',
      });
      expect(stepStart).not.toHaveProperty('model');
      expect(stepStart).not.toHaveProperty('modelSource', 'provider_routing.tags');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

});
