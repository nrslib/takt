vi.mock('../infra/config/runtime-provider/execution-preparation.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../infra/config/runtime-provider/execution-preparation.js')>(), checkResolvedWorkflowProviders: vi.fn(async () => undefined) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { WorkflowConfig } from '../core/models/index.js';
import type { SelectorProviderInfo } from '../core/workflow/types.js';
import type { WorkflowExecutionOptions } from '../features/tasks/execute/types.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

const workflowEngineError = new Error('workflow-engine-constructor-called');
const mockObservabilityShutdown = vi.fn().mockResolvedValue(undefined);
const mockWorkflowLoggerError = vi.fn();
const mockReportWarning = vi.fn();
const mockProjectTerminal = vi.fn();
const mockWorkflowEngine = vi.fn().mockImplementation(function MockWorkflowEngine() {
  return {
    on: vi.fn(),
    run: vi.fn().mockRejectedValue(workflowEngineError),
    removeAllListeners: vi.fn(),
  };
});

vi.mock('../core/workflow/index.js', () => ({
  WorkflowEngine: mockWorkflowEngine,
  createDenyAskUserQuestionHandler: vi.fn(() => 'deny-handler'),
}));

vi.mock('../features/tasks/execute/workflowRunLifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../features/tasks/execute/workflowRunLifecycle.js')
  >();
  const { createWorkflowRunLifecycleCompositionTestDouble } = await import(
    './helpers/run-lifecycle.js'
  );
  return {
    ...actual,
    createWorkflowRunLifecycle: (
      input: Parameters<typeof actual.createWorkflowRunLifecycle>[0],
    ) => createWorkflowRunLifecycleCompositionTestDouble(
      actual.createWorkflowRunLifecycle,
      input,
      {
        sessionId: 'session-id',
        startedAt: '2026-02-07T00:00:00.000Z',
        projectTerminalArtifacts: false,
      },
    ),
  };
});

vi.mock('../features/tasks/execute/workflowExecutionBundle.js', () => {
  let prepared: {
    rootWorkflow: WorkflowConfig;
    workflowCallResolver: unknown;
  } | undefined;
  return {
    prepareWorkflowExecutionBundle: vi.fn((input: {
      rootWorkflow: WorkflowConfig;
      workflowCallResolver: unknown;
    }) => {
      prepared = input;
      return input;
    }),
    publishWorkflowExecutionBundle: vi.fn(),
    loadWorkflowExecutionBundle: vi.fn(() => {
      if (prepared === undefined) throw new Error('Workflow execution bundle was not prepared');
      return {
        rootWorkflow: prepared.rootWorkflow,
        workflowCallResolver: prepared.workflowCallResolver,
        resourceRoot: '/tmp/workflow-bundle',
      };
    }),
  };
});

vi.mock('../agents/structured-caller.js', () => ({
  ProviderNeutralStructuredCaller: class {},
}));

vi.mock('../infra/observability/otelFoundation.js', () => ({
  initializeOtelFoundation: vi.fn().mockResolvedValue({
    shutdown: mockObservabilityShutdown,
  }),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: vi.fn(() => ({})),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn(() => ({})),
  updateWorktreeSession: vi.fn(),
  loadProjectConfig: vi.fn(() => ({})),
  loadGlobalConfig: vi.fn(() => ({})),
  resolveProviderOptionsWithTrace: vi.fn(() => ({ value: undefined, source: 'default', originResolver: undefined })),
  resolveWorkflowConfigValues: vi.fn(() => ({
    provider: 'mock',
    logging: {},
    analytics: {},
    observability: {
      enabled: false,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    },
  })),
  saveSessionState: vi.fn(),
}));

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveConfigValueWithSource: vi.fn((_cwd, key) => key === 'provider'
    ? { value: 'mock', source: 'global' }
    : { value: undefined, source: 'default' }),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(() => ({ supportsStructuredOutput: true })),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), error: mockWorkflowLoggerError })),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  preventSleep: vi.fn(),
  isDebugEnabled: vi.fn(() => false),
  generateReportDir: vi.fn(() => 'test-report-dir'),
  isValidReportDirName: vi.fn(() => true),
}));

vi.mock('../core/logging/providerEventLogger.js', () => ({
  createProviderEventLogger: vi.fn(() => ({
    logEvent: vi.fn(),
  })),
  isProviderEventsEnabled: vi.fn(() => false),
}));

vi.mock('../core/logging/usageEventLogger.js', () => ({
  createUsageEventLogger: vi.fn(() => ({
    logUsageFor: vi.fn(),
  })),
  isUsageEventsEnabled: vi.fn(() => false),
}));

vi.mock('../infra/fs/index.js', () => ({
  generateSessionId: vi.fn(() => 'session-id'),
  createSessionLog: vi.fn((
    task,
    projectDir,
    workflowName,
    options,
  ) => ({
    task,
    projectDir,
    workflowName,
    startTime: options.startTime,
    iterations: 0,
    status: 'running',
    history: [],
  })),
  finalizeSessionLog: vi.fn((log, status) => ({
    ...log,
    status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: vi.fn((
    sessionId: string,
    _task: string,
    _workflowName: string,
    options: { logsDir: string },
  ) => join(options.logsDir, `${sessionId}.jsonl`)),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../shared/ui/index.js', () => ({
  StreamDisplay: class {
    createHandler() {
      return vi.fn();
    }
  },
}));

vi.mock('../shared/ui/TaskPrefixWriter.js', () => ({
  TaskPrefixWriter: class {},
}));

vi.mock('../core/workflow/run/run-paths.js', () => ({
  buildRunPaths: vi.fn(() => ({
    slug: 'test-report-dir',
    runRootRel: '.takt/runs/test-report-dir',
    runRootAbs: '/tmp/run',
    contextRel: '.takt/runs/test-report-dir/context',
    contextKnowledgeRel: '.takt/runs/test-report-dir/context/knowledge',
    contextPolicyRel: '.takt/runs/test-report-dir/context/policy',
    contextPreviousResponsesRel: '.takt/runs/test-report-dir/context/previous_responses',
    logsRel: '.takt/runs/test-report-dir/logs',
    operationsRel: '.takt/runs/test-report-dir/operations',
    metaRel: '.takt/runs/test-report-dir/meta.json',
    operationJournalRel: '.takt/runs/test-report-dir/operations/journal.json',
    logsAbs: '/tmp/logs',
    operationsAbs: '/tmp/operations',
    reportsAbs: '/tmp/reports',
    reportsRel: '.takt/runs/test-report-dir/reports',
    contextAbs: '/tmp/context',
    contextKnowledgeAbs: '/tmp/context/knowledge',
    contextPolicyAbs: '/tmp/context/policy',
    contextPreviousResponsesAbs: '/tmp/context/previous_responses',
    metaAbs: '/tmp/meta.json',
    operationJournalAbs: '/tmp/operations/journal.json',
  })),
}));

vi.mock('../core/runtime/runtime-environment.js', () => ({
  resolveRuntimeConfig: vi.fn(() => undefined),
  prepareRuntimeEnvironment: vi.fn(() => undefined),
}));

vi.mock('../infra/claude/query-manager.js', () => ({
  interruptAllQueries: vi.fn(),
}));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: vi.fn(() => '/tmp/.takt'),
  getProjectConfigDir: vi.fn((projectDir: string) => `${projectDir}/.takt`),
}));

vi.mock('../features/analytics/index.js', () => ({
  initAnalyticsWriter: vi.fn(),
}));

vi.mock('../features/tasks/execute/sessionLogger.js', () => ({
  SessionLogger: class {
    writeInteractiveMetadata() {}
    onPhaseStart() {}
    onPhaseComplete() {}
    onJudgeStage() {}
    onStepStart() {}
    onStepComplete() {}
    onWorkflowAbort() {}
    onWorkflowComplete() {}
  },
}));

vi.mock('../features/tasks/execute/abortHandler.js', () => ({
  AbortHandler: class {
    install() {}
    cleanup() {}
  },
}));

vi.mock('../features/tasks/execute/analyticsEmitter.js', () => ({
  AnalyticsEmitter: class {},
}));

vi.mock('../features/tasks/execute/outputFns.js', () => ({
  createOutputFns: vi.fn(() => ({
    header: vi.fn(),
    info: vi.fn(),
    warn: mockReportWarning,
    error: vi.fn(),
    success: vi.fn(),
  })),
  createPrefixedStreamHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../features/tasks/execute/runMeta.js', () => ({
  RunMetaManager: class {
    updateStep() {}
    finalize() {}
    projectTerminal = mockProjectTerminal;
  },
}));

vi.mock('../features/tasks/execute/iterationLimitHandler.js', () => ({
  createIterationLimitHandler: vi.fn(() => vi.fn()),
  createUserInputHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../features/tasks/execute/workflowExecutionUtils.js', () => ({
  assertTaskPrefixPair: vi.fn(),
  truncate: vi.fn((value: string) => value),
  formatElapsedTime: vi.fn(() => '0.0s'),
  detectStepType: vi.fn(() => 'normal'),
}));

vi.mock('../features/tasks/execute/traceReportRedaction.js', () => ({
  sanitizeTextForStorage: vi.fn((value: string) => value),
}));

describe('workflow execution canonical entrypoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should expose step-based transition APIs', async () => {
    // When
    const workflowModule = await vi.importActual<typeof import('../core/workflow/index.js')>(
      '../core/workflow/index.js',
    );

    // Then
    expect(typeof workflowModule.WorkflowEngine).toBe('function');
    expect(typeof workflowModule.determineNextStepByRules).toBe('function');
    expect('WorkflowEngine' in workflowModule).toBe(true);
    expect('determineNextStepByRules' in workflowModule).toBe(true);
  });

  it('should expose executeWorkflow from the workflow execution module', async () => {
    const executionModule = await import('../features/tasks/execute/workflowExecution.js');

    expect(typeof executionModule.executeWorkflow).toBe('function');
    expect('executeWorkflow' in executionModule).toBe(true);
  });

  it('should expose executeWorkflow from the task feature index only', async () => {
    const tasksModule = await import('../features/tasks/index.js');

    expect(typeof tasksModule.executeWorkflow).toBe('function');
    expect('executeWorkflow' in tasksModule).toBe(true);
  });

  it('should construct WorkflowEngine through executeWorkflow', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    const config: WorkflowConfig = {
      name: 'default',
      description: '',
      initialStep: 'plan',
      maxSteps: 3,
      steps: [
        {
          name: 'plan',
          personaDisplayName: 'planner',
          instruction: 'Plan the work',
        },
      ],
    };

    await expect(
      executeWorkflow(config, 'task', '/tmp/project', {
        projectCwd: '/tmp/project',
        provider: 'mock' as never,
        currentTaskIssueNumber: 586,
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(mockWorkflowEngine).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'default' }),
      '/tmp/project',
      'task',
      expect.objectContaining({
        projectCwd: '/tmp/project',
        provider: 'mock',
        currentTask: {
          issueNumber: 586,
          runSlug: 'test-report-dir',
        },
      }),
    );
  });

  it.each(['normal', 'run context'] as const)('validates report paths before starting the engine through %s execution', async (entry) => {
    const { executeWorkflow, executeWorkflowForRun } = await import('../features/tasks/execute/workflowExecution.js');
    const execute = (reference: string) => {
      const config: WorkflowConfig = {
        name: 'reports', initialStep: 'work', maxSteps: 1,
        steps: [{ name: 'work', personaDisplayName: 'coder', instruction: `{report:${reference}}` }],
      };
      const options = { projectCwd: '/tmp/project', provider: 'mock' as const };
      return entry === 'normal'
        ? executeWorkflow(config, 'task', '/tmp/project', options)
        : executeWorkflowForRun(config, 'task', '/tmp/project', options, {});
    };

    await expect(execute('plan.md')).rejects.toBe(workflowEngineError);
    const engineStart = mockWorkflowEngine.mock.invocationCallOrder[0]!;
    expect(mockReportWarning).toHaveBeenCalledWith(expect.stringContaining('{report:plan.md}'));
    expect(mockReportWarning.mock.invocationCallOrder[0]).toBeLessThan(engineStart);
    mockWorkflowEngine.mockClear();
    mockProjectTerminal.mockClear();
    mockReportWarning.mockClear();

    await expect(execute('../plan.md')).rejects.toThrow();
    expect(mockWorkflowEngine).not.toHaveBeenCalled();
    expect(mockReportWarning).not.toHaveBeenCalled();
    expect(mockProjectTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', iterations: 0,
    }));
  });

  it('preserves a report validation resolver failure before engine startup', async () => {
    const bundles = await import('../features/tasks/execute/workflowExecutionBundle.js');
    const resolverError = new Error('bundle resolver failed');
    const loadBundle = vi.mocked(bundles.loadWorkflowExecutionBundle).getMockImplementation()!;
    vi.mocked(bundles.loadWorkflowExecutionBundle).mockImplementationOnce((paths) => ({
      ...loadBundle(paths),
      rootWorkflow: {
        name: 'parent', initialStep: 'delegate', maxSteps: 1,
        steps: [{ name: 'delegate', kind: 'workflow_call', call: 'child', instruction: '', personaDisplayName: 'child' }],
      },
      workflowCallResolver: () => { throw resolverError; },
      resourceRoot: '/tmp/workflow-bundle',
    }));
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    await expect(executeWorkflow({
      name: 'parent', initialStep: 'delegate', maxSteps: 1,
      steps: [{ name: 'delegate', personaDisplayName: 'coder', instruction: 'work' }],
    }, 'task', '/tmp/project', { projectCwd: '/tmp/project', provider: 'mock' })).rejects.toBe(resolverError);
    expect(mockWorkflowEngine).not.toHaveBeenCalled();
    expect(mockProjectTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', iterations: 0, reason: 'bundle resolver failed',
    }));
  });

  it.each([
    {
      name: 'resume',
      options: {
        resumePoint: {
          version: 2, iteration: 0, elapsed_ms: 0,
          stack: [{ workflow: 'reports', workflow_ref: 'test-ref', step: 'work', kind: 'agent', occurrence: 1 }],
          workflow_call_invocations: {}, workflow_step_participations: {},
        },
      },
    },
    {
      name: 'restart',
      options: { restartPoint: { stack: [{ workflow: 'reports', workflow_ref: 'test-ref', step: 'work', kind: 'agent' }] } },
    },
  ] satisfies { name: string; options: Partial<WorkflowExecutionOptions> }[])(
    'rejects invalid reports before $name restoration', async ({ options }) => {
      const bootstrapModule = await import('../features/tasks/execute/workflowExecutionBootstrap.js');
      const bootstrap = vi.spyOn(bootstrapModule, 'createWorkflowExecutionBootstrap');
      const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
      await expect(executeWorkflow({
        name: 'reports', initialStep: 'work', maxSteps: 1,
        steps: [{ name: 'work', personaDisplayName: 'coder', instruction: '{report:../plan.md}' }],
      }, 'task', '/tmp/project', { projectCwd: '/tmp/project', provider: 'mock', ...options }))
        .rejects.toThrow();
      expect(bootstrap).not.toHaveBeenCalled();
      expect(mockWorkflowEngine).not.toHaveBeenCalled();
      bootstrap.mockRestore();
    },
  );

  it('passes a configured model provider through bootstrap into WorkflowEngine', async () => {
    const configModule = await import('../infra/config/resolveConfigValue.js');
    vi.mocked(configModule.resolveConfigValueWithSource).mockImplementation((_cwd, key) => key === 'provider'
      ? { value: 'copilot', source: 'project' }
      : { value: 'opus', source: 'project', modelProvider: 'claude' });

    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    const config: WorkflowConfig = {
      name: 'default',
      description: '',
      initialStep: 'plan',
      maxSteps: 3,
      steps: [{ name: 'plan', personaDisplayName: 'planner', instruction: 'Plan the work' }],
    };

    await expect(
      executeWorkflow(config, 'task', '/tmp/project', { projectCwd: '/tmp/project' }),
    ).rejects.toBeInstanceOf(Error);

    expect(mockWorkflowEngine).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'default' }),
      '/tmp/project',
      'task',
      expect.objectContaining({
        provider: 'copilot',
        model: 'opus',
        modelProvider: 'claude',
      }),
    );
  });

  it('should preserve an explicit selector provider through bootstrap into WorkflowEngine', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    const config: WorkflowConfig = {
      name: 'dynamic',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [{
        name: 'reviewers',
        instruction: 'Review',
        parallel: {
          kind: 'dynamic',
          fixed: [],
          pool: [{
            name: 'security',
            description: 'Review security',
            instruction: 'Review security',
            personaDisplayName: 'security',
            rules: [normalizeRule({ condition: 'done' })],
          }],
          selection: { mode: 'replace' },
        },
        personaDisplayName: 'reviewers',
        rules: [normalizeRule({ condition: 'all("done")', next: 'COMPLETE' })],
      }],
    };
    const selectorProvider: SelectorProviderInfo = {
      provider: 'mock',
      model: 'explicit-selector',
      providerOptions: {},
    };

    await expect(
      executeWorkflow(config, 'task', '/tmp/project', {
        projectCwd: '/tmp/project',
        provider: 'mock',
        selectorProvider,
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(mockWorkflowEngine).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'dynamic' }),
      '/tmp/project',
      'task',
      expect.objectContaining({ selectorProvider }),
    );
  });

  it('Given a completed run, When terminal artifacts are committed, Then analysis is scheduled before observability shutdown', async () => {
    const order: string[] = [];
    mockObservabilityShutdown.mockImplementationOnce(async () => {
      order.push('observability-shutdown');
    });
    mockWorkflowEngine.mockImplementationOnce(function CompletedWorkflowEngine() {
      const engine = new EventEmitter() as EventEmitter & {
        run: () => Promise<{ status: 'completed'; iteration: number }>;
        removeAllListeners: () => EventEmitter;
      };
      engine.run = vi.fn(async () => {
        const state = { status: 'completed' as const, iteration: 1 };
        engine.emit('workflow:complete', state);
        return state;
      });
      return engine;
    });
    const loopAnalysisScheduler = vi.fn(() => {
      order.push('analysis-scheduled');
    });
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    const result = await executeWorkflow({
      name: 'default',
      initialStep: 'plan',
      maxSteps: 1,
      steps: [{ name: 'plan', personaDisplayName: 'planner', instruction: 'Plan the work' }],
    }, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      provider: 'mock',
      loopAnalysisScheduler,
    });

    expect(result.success).toBe(true);
    expect(loopAnalysisScheduler).toHaveBeenCalledOnce();
    expect(loopAnalysisScheduler).toHaveBeenCalledWith('/tmp/run');
    expect(order).toEqual(['analysis-scheduled', 'observability-shutdown']);
  });

  it('Given workflow execution fails, When terminal artifacts are finalized, Then analysis is scheduled once without replacing the failure', async () => {
    const loopAnalysisScheduler = vi.fn();
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    await expect(executeWorkflow({
      name: 'default',
      initialStep: 'plan',
      maxSteps: 1,
      steps: [{ name: 'plan', personaDisplayName: 'planner', instruction: 'Plan the work' }],
    }, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      provider: 'mock',
      loopAnalysisScheduler,
    })).rejects.toBe(workflowEngineError);

    expect(loopAnalysisScheduler).toHaveBeenCalledOnce();
    expect(loopAnalysisScheduler).toHaveBeenCalledWith('/tmp/run');
  });

  it('Given bootstrap fails after the run begins, When failure artifacts are finalized, Then analysis is scheduled once', async () => {
    const executionBundle = await import('../features/tasks/execute/workflowExecutionBundle.js');
    vi.mocked(executionBundle.publishWorkflowExecutionBundle)
      .mockImplementationOnce(() => {
        throw new Error('bundle publication failed');
      });
    const loopAnalysisScheduler = vi.fn();
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    await expect(executeWorkflow({
      name: 'default',
      initialStep: 'plan',
      maxSteps: 1,
      steps: [{ name: 'plan', personaDisplayName: 'planner', instruction: 'Plan the work' }],
    }, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      provider: 'mock',
      loopAnalysisScheduler,
    })).rejects.toThrow('bundle publication failed');

    expect(loopAnalysisScheduler).toHaveBeenCalledOnce();
    expect(loopAnalysisScheduler).toHaveBeenCalledWith('/tmp/run');
  });

  it('Given scheduling throws synchronously, When a completed source run returns, Then its successful result is preserved', async () => {
    mockWorkflowEngine.mockImplementationOnce(function CompletedWorkflowEngine() {
      const engine = new EventEmitter() as EventEmitter & {
        run: () => Promise<{ status: 'completed'; iteration: number }>;
        removeAllListeners: () => EventEmitter;
      };
      engine.run = vi.fn(async () => {
        const state = { status: 'completed' as const, iteration: 1 };
        engine.emit('workflow:complete', state);
        return state;
      });
      return engine;
    });
    const loopAnalysisScheduler = vi.fn(() => {
      throw new Error('scheduler failed');
    });
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    const result = await executeWorkflow({
      name: 'default',
      initialStep: 'plan',
      maxSteps: 1,
      steps: [{ name: 'plan', personaDisplayName: 'planner', instruction: 'Plan the work' }],
    }, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      provider: 'mock',
      loopAnalysisScheduler,
    });

    expect(result.success).toBe(true);
    expect(loopAnalysisScheduler).toHaveBeenCalledOnce();
    expect(mockWorkflowLoggerError).toHaveBeenCalledWith(
      expect.stringMatching(/loop analysis/i),
      expect.objectContaining({ error: 'scheduler failed' }),
    );
  });
});
