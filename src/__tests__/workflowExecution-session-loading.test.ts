/**
 * Tests: session loading behavior in executeWorkflow().
 *
 * Normal runs pass empty sessions to WorkflowEngine;
 * retry runs (startStep / retryNote) load persisted sessions.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';
import type { WorkflowConfig } from '../core/models/index.js';

const {
  MockWorkflowEngine,
  mockLoadPersonaSessions,
  mockLoadWorktreeSessions,
  mockCreateUsageEventLogger,
  mockUsageLogger,
  mockStepResponse,
  mockInitializeOtelFoundation,
  mockObservabilityShutdown,
  mockResolveConfigValueWithSource,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  const mockLoadPersonaSessions = vi.fn().mockReturnValue({ coder: 'saved-session-id' });
  const mockLoadWorktreeSessions = vi.fn().mockReturnValue({ coder: 'worktree-session-id' });
  const mockUsageLogger = {
    filepath: '/tmp/test-usage-events.jsonl',
    logUsageFor: vi.fn(),
  };
  const mockCreateUsageEventLogger = vi.fn().mockReturnValue(mockUsageLogger);
  const mockObservabilityShutdown = vi.fn().mockResolvedValue(undefined);
  const mockResolveConfigValueWithSource = vi.fn();
  const mockInitializeOtelFoundation = vi.fn().mockResolvedValue({
    shutdown: mockObservabilityShutdown,
  });
  const mockStepResponse: {
    providerUsage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      usageMissing: boolean;
      reason?: string;
    } | undefined;
  } = {
    providerUsage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      usageMissing: false,
    },
  };
  type MockWorkflowOutcome =
    | { status: 'completed' }
    | { status: 'aborted'; reason: string };

  type PersonaProviderMap = Record<string, { provider?: string; model?: string }>;

  function resolveProviderInfo(
    step: { personaDisplayName?: string; provider?: string; model?: string },
    opts: Record<string, unknown>,
  ): { provider: string | undefined; model: string | undefined } {
    const personaProviders = opts.personaProviders as PersonaProviderMap | undefined;
    const personaEntry = personaProviders?.[step.personaDisplayName ?? ''];
    const provider = personaEntry?.provider ?? step.provider ?? opts.provider as string | undefined;
    const model = personaEntry?.model ?? step.model ?? opts.model as string | undefined;
    return { provider, model };
  }

  class MockWorkflowEngine extends EE {
    static lastInstance: MockWorkflowEngine;
    static runError: Error | undefined;
    static runOutcome: MockWorkflowOutcome;
    readonly receivedOptions: Record<string, unknown>;
    private readonly config: WorkflowConfig;

    constructor(config: WorkflowConfig, _cwd: string, _task: string, options: Record<string, unknown>) {
      super();
      this.config = config;
      this.receivedOptions = options;
      MockWorkflowEngine.lastInstance = this;
    }

    abort(): void {}

    async run(): Promise<{ status: string; iteration: number }> {
      if (MockWorkflowEngine.runError) {
        throw MockWorkflowEngine.runError;
      }

      const firstStep = this.config.steps[0];
      if (firstStep) {
        const providerInfo = resolveProviderInfo(firstStep, this.receivedOptions);
        this.emit('step:start', firstStep, 1, firstStep.instruction, providerInfo);
        this.emit('step:complete', firstStep, {
          persona: firstStep.personaDisplayName,
          status: 'done',
          content: 'ok',
          timestamp: new Date('2026-03-04T00:00:00.000Z'),
          sessionId: 'step-session',
          providerUsage: mockStepResponse.providerUsage,
        }, firstStep.instruction);
      }
      if (MockWorkflowEngine.runOutcome.status === 'aborted') {
        this.emit(
          'workflow:abort',
          { status: 'aborted', iteration: 1 },
          MockWorkflowEngine.runOutcome.reason,
        );
        return { status: 'aborted', iteration: 1 };
      }

      this.emit('workflow:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: 1 };
    }
  }
  MockWorkflowEngine.runOutcome = { status: 'completed' };

  return {
    MockWorkflowEngine,
    mockLoadPersonaSessions,
    mockLoadWorktreeSessions,
    mockCreateUsageEventLogger,
    mockUsageLogger,
    mockStepResponse,
    mockInitializeOtelFoundation,
    mockObservabilityShutdown,
    mockResolveConfigValueWithSource,
  };
});

vi.mock('../core/workflow/index.js', async () => {
  const errorModule = await import('../core/workflow/ask-user-question-error.js');
  return {
    WorkflowEngine: MockWorkflowEngine,
    createDenyAskUserQuestionHandler: errorModule.createDenyAskUserQuestionHandler,
  };
});

vi.mock('../infra/claude/query-manager.js', () => ({
  interruptAllQueries: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: mockLoadPersonaSessions,
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: mockLoadWorktreeSessions,
  updateWorktreeSession: vi.fn(),
  resolveWorkflowConfigValues: vi.fn().mockReturnValue({
    notificationSound: true,
    notificationSoundEvents: {},
    provider: 'claude',
    runtime: undefined,
    preventSleep: false,
    model: undefined,
    logging: undefined,
    analytics: undefined,
    observability: {
      enabled: false,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    },
  }),
  saveSessionState: vi.fn(),
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveConfigValueWithSource: mockResolveConfigValueWithSource,
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn().mockReturnValue(vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../infra/fs/index.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockReturnValue({
    startTime: new Date().toISOString(),
    iterations: 0,
  }),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({
    ...log,
    status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test-log.jsonl'),
  appendNdjsonLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  preventSleep: vi.fn(),
  isDebugEnabled: vi.fn().mockReturnValue(false),
  writePromptLog: vi.fn(),
  getDebugPromptsLogFile: vi.fn().mockReturnValue(null),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  isValidReportDirName: vi.fn().mockReturnValue(true),
  playWarningSound: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));
vi.mock('../core/logging/usageEventLogger.js', () => ({
  createUsageEventLogger: mockCreateUsageEventLogger,
  isUsageEventsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/observability/otelFoundation.js', () => ({
  initializeOtelFoundation: mockInitializeOtelFoundation,
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import { resolveWorkflowConfigValues, writeFileAtomic } from '../infra/config/index.js';
import { info } from '../shared/ui/index.js';

const defaultResolvedConfigValues = {
  notificationSound: true,
  notificationSoundEvents: {},
  provider: 'claude',
  runtime: undefined,
  preventSleep: false,
  model: undefined,
  logging: undefined,
  analytics: undefined,
  observability: {
    enabled: false,
    monitor: false,
    sessionLogExporter: false,
    usageEventsPhase: false,
  },
};

function makeConfig(): WorkflowConfig {
  return {
    name: 'test-workflow',
    maxSteps: 5,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        persona: '../agents/coder.md',
        personaDisplayName: 'coder',
        instruction: 'Implement task',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

function makeConfigWithStep(overrides: Record<string, unknown>): WorkflowConfig {
  const baseStep = makeConfig().steps[0];
  if (!baseStep) {
    throw new Error('Base step is required');
  }
  return {
    ...makeConfig(),
    steps: [{ ...baseStep, ...overrides }],
  };
}

describe('executeWorkflow session loading', () => {
  const temporaryDirs: string[] = [];
  const restoredEnvKeys = [
    'TAKT_OBSERVABILITY',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
    'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
    'OTEL_EXPORTER_OTLP_TIMEOUT',
    'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
    'OTEL_EXPORTER_OTLP_METRICS_TIMEOUT',
    'OTEL_EXPORTER_OTLP_COMPRESSION',
    'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION',
    'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION',
    'OTEL_EXPORTER_OTLP_CERTIFICATE',
    'OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE',
    'OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE',
    'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE',
    'OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE',
    'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
    'OTEL_EXPORTER_OTLP_CLIENT_KEY',
    'OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY',
    'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
    'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
  ] as const;
  const originalEnv = new Map(restoredEnvKeys.map((key) => [key, process.env[key]]));

  function restoreEnv(): void {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  function clearRestoredEnv(): void {
    for (const key of restoredEnvKeys) {
      delete process.env[key];
    }
  }

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv();
    clearRestoredEnv();
    mockCreateUsageEventLogger.mockReturnValue(mockUsageLogger);
    mockInitializeOtelFoundation.mockResolvedValue({
      shutdown: mockObservabilityShutdown,
    });
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({ ...defaultResolvedConfigValues });
    mockResolveConfigValueWithSource.mockImplementation((_cwd, key) => key === 'provider'
      ? { value: 'claude', source: 'global' }
      : { value: undefined, source: 'default' });
    mockLoadPersonaSessions.mockReturnValue({ coder: 'saved-session-id' });
    mockLoadWorktreeSessions.mockReturnValue({ coder: 'worktree-session-id' });
    MockWorkflowEngine.runError = undefined;
    MockWorkflowEngine.runOutcome = { status: 'completed' };
    mockStepResponse.providerUsage = {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      usageMissing: false,
    };
  });

  afterEach(() => {
    restoreEnv();
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should pass empty initialSessions on normal run', async () => {
    // Given: normal execution (no startStep, no retryNote)
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // Then: WorkflowEngine receives empty sessions
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
    expect(mockLoadWorktreeSessions).not.toHaveBeenCalled();
    expect(MockWorkflowEngine.lastInstance.receivedOptions.initialSessions).toEqual({});
  });

  it('should log usage events on step completion when usage logging is enabled', async () => {
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockCreateUsageEventLogger).toHaveBeenCalledOnce();
    expect(mockUsageLogger.logUsageFor).toHaveBeenCalledWith({
      provider: 'claude',
      providerModel: '(default)',
      step: 'implement',
      stepType: 'normal',
    }, {
      success: true,
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        usageMissing: false,
      },
    });
  });

  it('should log usage_missing reason when provider usage is unavailable', async () => {
    mockStepResponse.providerUsage = undefined;

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockUsageLogger.logUsageFor).toHaveBeenCalledWith(expect.objectContaining({
      step: 'implement',
      stepType: 'normal',
    }), {
      success: true,
      usage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
      },
    });
  });

  it('should load persisted sessions when startStep is set (retry)', async () => {
    // Given: retry execution with startStep
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      startStep: 'implement',
    });

    // Then: loadPersonaSessions is called to load saved sessions
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should load persisted sessions when retryNote is set (retry)', async () => {
    // Given: retry execution with retryNote
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      retryNote: 'Fix the failing test',
    });

    // Then: loadPersonaSessions is called to load saved sessions
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should load worktree sessions on retry when cwd differs from projectCwd', async () => {
    // Given: retry execution in a worktree (cwd !== projectCwd)
    const projectDir = createTempDir('takt-session-project-');
    const worktreeDir = createTempDir('takt-session-worktree-');

    await executeWorkflow(makeConfig(), 'task', worktreeDir, {
      projectCwd: projectDir,
      startStep: 'implement',
    });

    // Then: loadWorktreeSessions is called instead of loadPersonaSessions
    expect(mockLoadWorktreeSessions).toHaveBeenCalledWith(projectDir, worktreeDir, 'claude');
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
  });

  it('should not load sessions for worktree normal run', async () => {
    // Given: normal execution in a worktree (no retry)
    const projectDir = createTempDir('takt-session-project-');
    const worktreeDir = createTempDir('takt-session-worktree-');

    await executeWorkflow(makeConfig(), 'task', worktreeDir, {
      projectCwd: projectDir,
    });

    // Then: neither session loader is called
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
    expect(mockLoadWorktreeSessions).not.toHaveBeenCalled();
  });

  it('should load sessions when both startStep and retryNote are set', async () => {
    // Given: retry with both flags
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      startStep: 'implement',
      retryNote: 'Fix issue',
    });

    // Then: sessions are loaded
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should log provider and model per step with global defaults', async () => {
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('Provider: claude');
    expect(mockInfo).toHaveBeenCalledWith('Model: (default)');
  });

  it('should resolve logging config from workflow config values', async () => {
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    const calls = vi.mocked(resolveWorkflowConfigValues).mock.calls;
    expect(calls).toHaveLength(1);
    const keys = calls[0]?.[1];
    expect(Array.isArray(keys)).toBe(true);
    expect(keys).toContain('logging');
    expect(keys).toContain('observability');
  });

  it('should initialize and shutdown observability when enabled in resolved config', async () => {
    const observability = {
      enabled: true,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockInitializeOtelFoundation).toHaveBeenCalledWith(observability, undefined);
    expect(MockWorkflowEngine.lastInstance.receivedOptions.observability).toBe(observability);
    expect(mockObservabilityShutdown).toHaveBeenCalledOnce();
  });

  it('Given observability is enabled at workflow entry, When workflow completes, Then persists and prints the same TraceQL discovery queries', async () => {
    const observability = {
      enabled: true,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      reportDirName: 'trace-discovery-run',
      traceTaskMetadata: {
        taskSource: 'pr_review',
        issueNumber: 792,
        prNumber: 826,
        gitBranch: 'takt/843/add-trace-discovery',
        gitBaseBranch: 'main',
      },
    });

    const metaWrites = vi.mocked(writeFileAtomic).mock.calls.filter(([path]) => (
      path === '/tmp/project/.takt/runs/trace-discovery-run/meta.json'
    ));
    expect(metaWrites.length).toBeGreaterThan(0);
    const finalMetaWrite = metaWrites.at(-1);
    if (!finalMetaWrite) {
      throw new Error('Expected run meta to be written');
    }
    const finalMeta = JSON.parse(String(finalMetaWrite[1])) as {
      observability?: {
        traceDiscovery?: {
          queries?: string[];
        };
      };
    };
    const metaQueries = finalMeta.observability?.traceDiscovery?.queries;
    expect(metaQueries).toEqual([
      '{ resource.service.name = "takt" && span."takt.run.id" = "trace-discovery-run" }',
      '{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }',
      '{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }',
      '{ resource.service.name = "takt" && span."takt.git.branch" = "takt/843/add-trace-discovery" }',
    ]);

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('TraceQL discovery:');
    expect(mockInfo.mock.calls.map(([line]) => line).filter((line) => line.startsWith('  {'))).toEqual(
      metaQueries?.map((query) => `  ${query}`),
    );
  });

  it('Given observability is disabled at workflow entry, When trace metadata is present, Then omits TraceQL discovery output and metadata', async () => {
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability: {
        enabled: false,
        monitor: false,
        sessionLogExporter: false,
        usageEventsPhase: false,
      },
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      reportDirName: 'trace-discovery-disabled-run',
      traceTaskMetadata: {
        taskSource: 'pr_review',
        issueNumber: 792,
        prNumber: 826,
        gitBranch: 'takt/843/add-trace-discovery',
        gitBaseBranch: 'main',
      },
    });

    const metaWrites = vi.mocked(writeFileAtomic).mock.calls.filter(([path]) => (
      path === '/tmp/project/.takt/runs/trace-discovery-disabled-run/meta.json'
    ));
    expect(metaWrites.length).toBeGreaterThan(0);
    const finalMetaWrite = metaWrites.at(-1);
    if (!finalMetaWrite) {
      throw new Error('Expected run meta to be written');
    }
    const finalMeta = JSON.parse(String(finalMetaWrite[1])) as {
      observability?: {
        traceDiscovery?: {
          queries?: string[];
        };
      };
    };

    expect(finalMeta.observability?.traceDiscovery).toBeUndefined();
    expect(vi.mocked(info)).not.toHaveBeenCalledWith('TraceQL discovery:');
  });

  it('Given observability is enabled at workflow entry, When workflow aborts, Then persists and prints the same TraceQL discovery queries', async () => {
    const observability = {
      enabled: true,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });
    MockWorkflowEngine.runOutcome = {
      status: 'aborted',
      reason: 'step_failed',
    };

    const result = await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      reportDirName: 'trace-discovery-abort-run',
      traceTaskMetadata: {
        taskSource: 'pr_review',
        issueNumber: 792,
        prNumber: 826,
        gitBranch: 'takt/843/add-trace-discovery',
        gitBaseBranch: 'main',
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('step_failed');

    const metaWrites = vi.mocked(writeFileAtomic).mock.calls.filter(([path]) => (
      path === '/tmp/project/.takt/runs/trace-discovery-abort-run/meta.json'
    ));
    expect(metaWrites.length).toBeGreaterThan(0);
    const finalMetaWrite = metaWrites.at(-1);
    if (!finalMetaWrite) {
      throw new Error('Expected run meta to be written');
    }
    const finalMeta = JSON.parse(String(finalMetaWrite[1])) as {
      status?: string;
      observability?: {
        traceDiscovery?: {
          queries?: string[];
        };
      };
    };
    const metaQueries = finalMeta.observability?.traceDiscovery?.queries;
    expect(finalMeta.status).toBe('aborted');
    expect(metaQueries).toEqual([
      '{ resource.service.name = "takt" && span."takt.run.id" = "trace-discovery-abort-run" }',
      '{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }',
      '{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }',
      '{ resource.service.name = "takt" && span."takt.git.branch" = "takt/843/add-trace-discovery" }',
    ]);

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('TraceQL discovery:');
    expect(mockInfo.mock.calls.map(([line]) => line).filter((line) => line.startsWith('  {'))).toEqual(
      metaQueries?.map((query) => `  ${query}`),
    );
  });

  it('Given observability is enabled at workflow entry, When workflow run rejects without an abort event, Then persists and prints TraceQL discovery queries', async () => {
    const observability = {
      enabled: true,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });
    MockWorkflowEngine.runError = new Error('workflow engine failed');

    await expect(
      executeWorkflow(makeConfig(), 'task', '/tmp/project', {
        projectCwd: '/tmp/project',
        reportDirName: 'trace-discovery-error-run',
        traceTaskMetadata: {
          taskSource: 'pr_review',
          issueNumber: 792,
          prNumber: 826,
          gitBranch: 'takt/843/add-trace-discovery',
          gitBaseBranch: 'main',
        },
      }),
    ).rejects.toThrow('workflow engine failed');

    const metaWrites = vi.mocked(writeFileAtomic).mock.calls.filter(([path]) => (
      path === '/tmp/project/.takt/runs/trace-discovery-error-run/meta.json'
    ));
    expect(metaWrites.length).toBeGreaterThan(0);
    const finalMetaWrite = metaWrites.at(-1);
    if (!finalMetaWrite) {
      throw new Error('Expected run meta to be written');
    }
    const finalMeta = JSON.parse(String(finalMetaWrite[1])) as {
      status?: string;
      observability?: {
        traceDiscovery?: {
          queries?: string[];
        };
      };
    };
    const metaQueries = finalMeta.observability?.traceDiscovery?.queries;
    expect(finalMeta.status).toBe('aborted');
    expect(metaQueries).toEqual([
      '{ resource.service.name = "takt" && span."takt.run.id" = "trace-discovery-error-run" }',
      '{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }',
      '{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }',
      '{ resource.service.name = "takt" && span."takt.git.branch" = "takt/843/add-trace-discovery" }',
    ]);

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('TraceQL discovery:');
    expect(mockInfo.mock.calls.map(([line]) => line).filter((line) => line.startsWith('  {'))).toEqual(
      metaQueries?.map((query) => `  ${query}`),
    );
  });

  it('Given workflow run rejects, When event sink is delayed, Then flushes failure events in order before rejecting', async () => {
    MockWorkflowEngine.runError = new Error('workflow engine failed');
    const delivered: string[] = [];
    let releaseRunStarted: (() => void) | undefined;
    const runStartedDispatched = new Promise<void>((resolve) => {
      releaseRunStarted = resolve;
    });
    const eventSink = vi.fn(async (event: { type: string }) => {
      if (event.type === 'run_started') {
        await runStartedDispatched;
      }
      delivered.push(event.type);
    });

    const runPromise = executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      eventSink,
    });
    await Promise.resolve();
    expect(delivered).toEqual([]);

    releaseRunStarted?.();
    await expect(runPromise).rejects.toThrow('workflow engine failed');

    expect(delivered).toEqual(['run_started', 'completed']);
    expect(eventSink).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'completed',
      success: false,
      reason: 'workflow engine failed',
    }));
  });

  it('Given workflow run rejects, When flushing failure event sink fails, Then preserves the workflow error', async () => {
    MockWorkflowEngine.runError = new Error('workflow engine failed');
    const eventSink = vi.fn(async (event: { type: string }) => {
      if (event.type === 'completed') {
        throw new Error('session/update failed');
      }
    });

    await expect(
      executeWorkflow(makeConfig(), 'task', '/tmp/project', {
        projectCwd: '/tmp/project',
        eventSink,
      }),
    ).rejects.toThrow('workflow engine failed');

    expect(eventSink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'completed',
      success: false,
      reason: 'workflow engine failed',
    }));
  });

  it('Given enabled observability and an existing child env snapshot, When executing workflow, Then passes run-local child process env without mutating process env', async () => {
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ' https://collector.example.test ';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://collector.example.test/custom/traces';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer%20token';
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-trace=enabled';
    process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'x-metric=enabled';
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '15000';
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = '12000';
    process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT = '13000';
    process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'gzip';
    process.env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION = 'none';
    process.env.OTEL_EXPORTER_OTLP_METRICS_COMPRESSION = 'gzip';
    process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = '/certs/root.pem';
    process.env.OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE = '/certs/traces-root.pem';
    process.env.OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE = '/certs/metrics-root.pem';
    process.env.OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE = '/certs/client.pem';
    process.env.OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE = '/certs/traces-client.pem';
    process.env.OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE = '/certs/metrics-client.pem';
    process.env.OTEL_EXPORTER_OTLP_CLIENT_KEY = '/certs/client.key';
    process.env.OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY = '/certs/traces-client.key';
    process.env.OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY = '/certs/metrics-client.key';
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'delta';
    const observability = {
      enabled: true,
      monitor: true,
      sessionLogExporter: true,
      usageEventsPhase: true,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(MockWorkflowEngine.lastInstance.receivedOptions.childProcessEnv).toEqual({
      TAKT_OBSERVABILITY: JSON.stringify({
        enabled: true,
        monitor: true,
        session_log_exporter: true,
        usage_events_phase: true,
      }),
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example.test/custom/traces',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://collector.example.test/v1/metrics',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20token',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-trace=enabled',
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'x-metric=enabled',
      OTEL_EXPORTER_OTLP_TIMEOUT: '15000',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '12000',
      OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: '13000',
      OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
      OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: 'none',
      OTEL_EXPORTER_OTLP_METRICS_COMPRESSION: 'gzip',
      OTEL_EXPORTER_OTLP_CERTIFICATE: '/certs/root.pem',
      OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE: '/certs/traces-root.pem',
      OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE: '/certs/metrics-root.pem',
      OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: '/certs/client.pem',
      OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE: '/certs/traces-client.pem',
      OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE: '/certs/metrics-client.pem',
      OTEL_EXPORTER_OTLP_CLIENT_KEY: '/certs/client.key',
      OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY: '/certs/traces-client.key',
      OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY: '/certs/metrics-client.key',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    });
    expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(' https://collector.example.test ');
    expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('https://collector.example.test/custom/traces');
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('authorization=Bearer%20token');
  });

  it('Given enabled observability and only unsafe signal endpoints, When executing workflow, Then omits raw endpoints from child process env', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://user:pass@collector.example.test/v1/traces?token=top-secret';
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://collector.example.test/v1/metrics#top-secret';
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = '12000';
    const observability = {
      enabled: true,
      monitor: true,
      sessionLogExporter: true,
      usageEventsPhase: true,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(MockWorkflowEngine.lastInstance.receivedOptions.childProcessEnv).toEqual({
      TAKT_OBSERVABILITY: JSON.stringify({
        enabled: true,
        monitor: true,
        session_log_exporter: true,
        usage_events_phase: true,
      }),
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '12000',
    });
  });

  it('Given disabled observability and no child env snapshot, When executing workflow, Then does not create TAKT_OBSERVABILITY', async () => {
    delete process.env.TAKT_OBSERVABILITY;
    const observability = {
      enabled: false,
      monitor: true,
      sessionLogExporter: true,
      usageEventsPhase: true,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(MockWorkflowEngine.lastInstance.receivedOptions.childProcessEnv).toBeUndefined();
    expect(process.env.TAKT_OBSERVABILITY).toBeUndefined();
  });

  it('Given enabled observability and workflow failure, When executing workflow, Then keeps process env unchanged', async () => {
    process.env.TAKT_OBSERVABILITY = '{"enabled":false,"monitor":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector.example.test:4318';
    const observability = {
      enabled: true,
      monitor: false,
      sessionLogExporter: true,
      usageEventsPhase: false,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });
    MockWorkflowEngine.runError = new Error('workflow engine failed');

    await expect(
      executeWorkflow(makeConfig(), 'task', '/tmp/project', {
        projectCwd: '/tmp/project',
      }),
    ).rejects.toThrow('workflow engine failed');

    expect(MockWorkflowEngine.lastInstance.receivedOptions.childProcessEnv).toEqual({
      TAKT_OBSERVABILITY: JSON.stringify({
        enabled: true,
        monitor: false,
        session_log_exporter: true,
        usage_events_phase: false,
      }),
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.test:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector.example.test:4318/v1/traces',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://collector.example.test:4318/v1/metrics',
    });
    expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false,"monitor":false}');
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector.example.test:4318');
  });

  it('should pass shadow session log exporter options when observability exporter is enabled', async () => {
    const observability = {
      enabled: true,
      monitor: false,
      sessionLogExporter: true,
      usageEventsPhase: false,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockInitializeOtelFoundation).toHaveBeenCalledWith(
      observability,
      {
        sessionLogExporter: {
          runId: 'test-report-dir',
          shadowLogPath: '/tmp/project/.takt/runs/test-report-dir/logs/test-session-id-otel-session-shadow.jsonl',
          sanitizedTask: 'task',
          workflowName: 'test-workflow',
        },
      },
    );
  });

  it('should pass monitor JSON exporter options when observability monitor is enabled', async () => {
    const observability = {
      enabled: true,
      monitor: true,
      sessionLogExporter: false,
      usageEventsPhase: false,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockInitializeOtelFoundation).toHaveBeenCalledWith(
      observability,
      {
        monitorJsonExporter: {
          runId: 'test-report-dir',
          monitorPath: '/tmp/project/.takt/runs/test-report-dir/monitor.json',
        },
      },
    );
  });

  it('should shutdown observability when workflow execution throws', async () => {
    const observability = {
      enabled: true,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });
    MockWorkflowEngine.runError = new Error('workflow engine failed');

    await expect(
      executeWorkflow(makeConfig(), 'task', '/tmp/project', {
        projectCwd: '/tmp/project',
      }),
    ).rejects.toThrow('workflow engine failed');

    expect(mockInitializeOtelFoundation).toHaveBeenCalledWith(observability, undefined);
    expect(mockObservabilityShutdown).toHaveBeenCalledOnce();
  });

  it('should preserve the workflow error when observability shutdown rejects', async () => {
    const observability = {
      enabled: true,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    };
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      observability,
    });
    MockWorkflowEngine.runError = new Error('workflow engine failed');
    mockObservabilityShutdown.mockRejectedValueOnce(new Error('shutdown failed'));

    await expect(
      executeWorkflow(makeConfig(), 'task', '/tmp/project', {
        projectCwd: '/tmp/project',
      }),
    ).rejects.toThrow('workflow engine failed');

    expect(mockInitializeOtelFoundation).toHaveBeenCalledWith(observability, undefined);
    expect(mockObservabilityShutdown).toHaveBeenCalledOnce();
  });

  it('should log configured model from global/project settings when step model is unresolved', async () => {
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      model: 'gpt-4.1',
    });
    mockResolveConfigValueWithSource.mockImplementation((_cwd, key) => key === 'provider'
      ? { value: 'claude', source: 'global' }
      : { value: 'gpt-4.1', source: 'global' });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('Model: gpt-4.1');
  });

  it('should pass resolved global provider/model to WorkflowEngine for step-level resolution', async () => {
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      provider: 'claude',
      model: 'gpt-5.4',
    });
    mockResolveConfigValueWithSource.mockImplementation((_cwd, key) => key === 'provider'
      ? { value: 'claude', source: 'global' }
      : { value: 'gpt-5.4', source: 'global' });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      personaProviders: { coder: { provider: 'codex', model: 'o3' } },
    });

    expect(MockWorkflowEngine.lastInstance.receivedOptions.provider).toBe('claude');
    expect(MockWorkflowEngine.lastInstance.receivedOptions.model).toBe('gpt-5.4');
    expect(MockWorkflowEngine.lastInstance.receivedOptions.personaProviders).toEqual({
      coder: { provider: 'codex', model: 'o3' },
    });
  });

  it('should log provider and model per step with overrides', async () => {
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      provider: 'codex',
      model: 'gpt-5',
      personaProviders: { coder: { provider: 'opencode' } },
    });

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('Provider: opencode');
    expect(mockInfo).toHaveBeenCalledWith('Model: gpt-5');
  });

  it('should pass step type to usage logger for parallel step', async () => {
    await executeWorkflow(makeConfigWithStep({ parallel: { branches: [] } }), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockUsageLogger.logUsageFor).not.toHaveBeenCalled();
  });

  it('should pass step type to usage logger for arpeggio step', async () => {
    await executeWorkflow(makeConfigWithStep({ arpeggio: { source: './items.csv' } }), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockUsageLogger.logUsageFor).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'implement', stepType: 'arpeggio' }),
      expect.any(Object),
    );
  });

  it('should pass step type to usage logger for team leader step', async () => {
    await executeWorkflow(
      makeConfigWithStep({ teamLeader: { output: { mode: 'summary' } } }),
      'task',
      '/tmp/project',
      {
        projectCwd: '/tmp/project',
      },
    );

    expect(mockUsageLogger.logUsageFor).not.toHaveBeenCalled();
  });
});
