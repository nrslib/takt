import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';

const legacyEngineExport = ['Piece', 'Engine'].join('');
const legacyRuleExport = ['determineNext', 'Move', 'ment', 'ByRules'].join('');

const workflowEngineError = new Error('workflow-engine-constructor-called');
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

vi.mock('../agents/structured-caller.js', () => ({
  DefaultStructuredCaller: class {},
  PromptBasedStructuredCaller: class {},
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: vi.fn(() => ({})),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn(() => ({})),
  updateWorktreeSession: vi.fn(),
  resolveWorkflowConfigValues: vi.fn(() => ({
    provider: 'mock',
    logging: {},
    analytics: {},
  })),
  saveSessionState: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(() => ({ supportsStructuredOutput: true })),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() })),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  preventSleep: vi.fn(),
  generateReportDir: vi.fn(() => 'test-report-dir'),
  isValidReportDirName: vi.fn(() => true),
  getDebugPromptsLogFile: vi.fn(() => undefined),
}));

vi.mock('../shared/utils/providerEventLogger.js', () => ({
  createProviderEventLogger: vi.fn(() => ({
    wrapCallback: (callback: unknown) => callback,
    setStep: vi.fn(),
    setProvider: vi.fn(),
  })),
  isProviderEventsEnabled: vi.fn(() => false),
}));

vi.mock('../shared/utils/usageEventLogger.js', () => ({
  createUsageEventLogger: vi.fn(() => ({
    setStep: vi.fn(),
    setProvider: vi.fn(),
  })),
  isUsageEventsEnabled: vi.fn(() => false),
}));

vi.mock('../infra/fs/index.js', () => ({
  generateSessionId: vi.fn(() => 'session-id'),
  createSessionLog: vi.fn(() => ({ history: [] })),
  finalizeSessionLog: vi.fn(),
  initNdjsonLog: vi.fn(() => '/tmp/session.jsonl'),
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
    metaRel: '.takt/runs/test-report-dir/meta.json',
    logsAbs: '/tmp/logs',
    reportsAbs: '/tmp/reports',
    reportsRel: '.takt/runs/test-report-dir/reports',
    contextAbs: '/tmp/context',
    contextKnowledgeAbs: '/tmp/context/knowledge',
    contextPolicyAbs: '/tmp/context/policy',
    contextPreviousResponsesAbs: '/tmp/context/previous_responses',
    metaAbs: '/tmp/meta.json',
  })),
}));

vi.mock('../core/runtime/runtime-environment.js', () => ({
  resolveRuntimeConfig: vi.fn(() => undefined),
  prepareRuntimeEnvironment: vi.fn(() => undefined),
}));

vi.mock('../infra/claude/query-manager.js', () => ({
  interruptAllQueries: vi.fn(),
}));

vi.mock('../shared/utils/ruleIndex.js', () => ({
  detectRuleIndex: vi.fn(() => 0),
}));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: vi.fn(() => '/tmp/.takt'),
}));

vi.mock('../features/analytics/index.js', () => ({
  initAnalyticsWriter: vi.fn(),
}));

vi.mock('../features/tasks/execute/sessionLogger.js', () => ({
  SessionLogger: class {
    writeInteractiveMetadata() {}
    onPhaseStart() {}
    setIteration() {}
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
  AnalyticsEmitter: class {
    updateProviderInfo() {}
  },
}));

vi.mock('../features/tasks/execute/outputFns.js', () => ({
  createOutputFns: vi.fn(() => ({
    header: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  })),
  createPrefixedStreamHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../features/tasks/execute/runMeta.js', () => ({
  RunMetaManager: class {
    updateStep() {}
    finalize() {}
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

vi.mock('../features/tasks/execute/traceReportWriter.js', () => ({
  createTraceReportWriter: vi.fn(() => vi.fn()),
}));

vi.mock('../features/tasks/execute/traceReportRedaction.js', () => ({
  sanitizeTextForStorage: vi.fn((value: string) => value),
}));

describe('workflow execution canonical entrypoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should expose step-based transition APIs and hide removed legacy exports', async () => {
    // When
    const workflowModule = await vi.importActual<typeof import('../core/workflow/index.js')>(
      '../core/workflow/index.js',
    );

    // Then
    expect(typeof workflowModule.WorkflowEngine).toBe('function');
    expect(typeof workflowModule.determineNextStepByRules).toBe('function');
    expect('WorkflowEngine' in workflowModule).toBe(true);
    expect('determineNextStepByRules' in workflowModule).toBe(true);
    expect(legacyEngineExport in workflowModule).toBe(false);
    expect(legacyRuleExport in workflowModule).toBe(false);
  });

  it('should expose executeWorkflow from the workflow execution module', async () => {
    const executionModule = await import('../features/tasks/execute/workflowExecution.js');

    expect(typeof executionModule.executeWorkflow).toBe('function');
    expect('executeWorkflow' in executionModule).toBe(true);
    expect(['execute', legacyWorkflowOptionKey()].join('') in executionModule).toBe(false);
  });

  it('should expose executeWorkflow from the task feature index only', async () => {
    const tasksModule = await import('../features/tasks/index.js');

    expect(typeof tasksModule.executeWorkflow).toBe('function');
    expect('executeWorkflow' in tasksModule).toBe(true);
    expect(['execute', legacyWorkflowOptionKey()].join('') in tasksModule).toBe(false);
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
        currentTask: { issueNumber: 586 },
      }),
    );
  });
});

function legacyWorkflowOptionKey(): string {
  return ['Pi', 'ece'].join('');
}
