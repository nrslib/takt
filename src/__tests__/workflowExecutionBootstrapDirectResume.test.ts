import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';

const TEST_TMPDIR = realpathSync(tmpdir());

const {
  mockWriteFileAtomic,
  mockResolveWorkflowConfigValues,
  mockResolveConfigValueWithSource,
  mockCreateOutputFns,
  mockInitializeOtelFoundation,
  mockEnsureWorktreeTaktRuntimeProtection,
  mockIsValidReportDirName,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockWriteFileAtomic: vi.fn(),
  mockResolveWorkflowConfigValues: vi.fn(),
  mockResolveConfigValueWithSource: vi.fn(),
  mockCreateOutputFns: vi.fn(),
  mockInitializeOtelFoundation: vi.fn(),
  mockEnsureWorktreeTaktRuntimeProtection: vi.fn(),
  mockIsValidReportDirName: vi.fn((_slug: string) => true),
  mockLogWarn: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  ensureDir: vi.fn(),
  loadPersonaSessions: vi.fn(() => ({})),
  loadWorktreeSessions: vi.fn(() => ({})),
  resolveWorkflowConfigValues: mockResolveWorkflowConfigValues,
  updatePersonaSession: vi.fn(),
  updateWorktreeSession: vi.fn(),
  writeFileAtomic: mockWriteFileAtomic,
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValueWithSource: mockResolveConfigValueWithSource,
  resolveProviderOptionsWithTrace: vi.fn(() => ({
    value: undefined,
    source: 'default',
    originResolver: undefined,
  })),
}));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: vi.fn(() => '/tmp/.takt'),
}));

vi.mock('../infra/fs/index.js', () => ({
  createSessionLog: vi.fn(() => ({ history: [] })),
  generateSessionId: vi.fn(() => 'session-1'),
  initNdjsonLog: vi.fn(() => '/project/.takt/runs/direct-resume/logs/session.ndjson'),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../shared/ui/index.js', () => ({
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn(() => vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/ui/TaskPrefixWriter.js', () => ({
  TaskPrefixWriter: vi.fn().mockImplementation(() => ({
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: mockLogWarn,
  })),
  generateReportDir: vi.fn(() => 'generated-run'),
  getDebugPromptsLogFile: vi.fn(() => undefined),
  isValidReportDirName: mockIsValidReportDirName,
  preventSleep: vi.fn(),
}));

vi.mock('../core/logging/providerEventLogger.js', () => ({
  createProviderEventLogger: vi.fn(() => ({
    logEvent: vi.fn(),
  })),
  isProviderEventsEnabled: vi.fn(() => false),
}));

vi.mock('../core/logging/usageEventLogger.js', () => ({
  createUsageEventLogger: vi.fn(() => ({})),
  isUsageEventsEnabled: vi.fn(() => false),
}));

vi.mock('../infra/observability/otelFoundation.js', () => ({
  initializeOtelFoundation: mockInitializeOtelFoundation,
}));

vi.mock('../infra/task/projectLocalTaktSync.js', () => ({
  ensureWorktreeTaktRuntimeProtection: mockEnsureWorktreeTaktRuntimeProtection,
}));

vi.mock('../features/analytics/index.js', () => ({
  initAnalyticsWriter: vi.fn(),
}));

vi.mock('../features/tasks/execute/analyticsEmitter.js', () => ({
  AnalyticsEmitter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../agents/structured-caller.js', () => ({
  CapabilityAwareStructuredCaller: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../features/tasks/execute/outputFns.js', () => ({
  createOutputFns: mockCreateOutputFns,
  createPrefixedStreamHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../features/tasks/execute/traceReportWriter.js', () => ({
  createTraceReportWriter: vi.fn(() => vi.fn()),
}));

vi.mock('../features/tasks/execute/sessionLogger.js', () => ({
  SessionLogger: vi.fn().mockImplementation(() => ({
    writeInteractiveMetadata: vi.fn(),
  })),
}));

vi.mock('../core/runtime/runtime-environment.js', () => ({
  resolveRuntimeConfig: vi.fn(() => undefined),
}));

import { createWorkflowExecutionBootstrap } from '../features/tasks/execute/workflowExecutionBootstrap.js';
import { initAnalyticsWriter } from '../features/analytics/index.js';

const workflowConfig: WorkflowConfig = {
  name: 'default',
  initialStep: 'fix',
  maxSteps: 50,
  steps: [
    { name: 'fix', personaDisplayName: 'Fixer', instruction: 'Fix', rules: [] },
  ],
};

function createAutoRoutingConfig(): NonNullable<WorkflowConfig['autoRouting']> {
  return {
    strategy: 'cost',
    router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
    candidates: [
      {
        name: 'reasoning',
        description: 'Reasoning',
        provider: 'claude-sdk',
        model: 'claude-opus-4-20250514',
        costTier: 'high',
      },
      {
        name: 'coding',
        description: 'Implementation',
        provider: 'codex',
        model: 'gpt-5',
        costTier: 'medium',
      },
      {
        name: 'lightweight',
        description: 'Formatting',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        costTier: 'low',
      },
    ],
  };
}

const temporaryDirs: string[] = [];

function createTempProject(): string {
  const projectDir = mkdtempSync(join(TEST_TMPDIR, 'takt-direct-resume-'));
  temporaryDirs.push(projectDir);
  return projectDir;
}

function seedResumeSourceRun(projectDir: string): void {
  mkdirSync(
    join(projectDir, '.takt', 'runs', '20260524-source-run', 'reports'),
    { recursive: true },
  );
}

function hasTasksYamlWrite(): boolean {
  return mockWriteFileAtomic.mock.calls.some((call) => String(call[0]).endsWith('/.takt/tasks.yaml'));
}

describe('createWorkflowExecutionBootstrap direct resume metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateOutputFns.mockReturnValue({
      header: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      blankLine: vi.fn(),
      result: vi.fn(),
    });
    mockInitializeOtelFoundation.mockResolvedValue({ shutdown: vi.fn() });
    mockIsValidReportDirName.mockReset();
    mockIsValidReportDirName.mockReturnValue(true);
    mockLogWarn.mockReset();
    mockResolveConfigValueWithSource.mockReset();
    mockResolveConfigValueWithSource.mockImplementation((
      _projectCwd: string,
      key: 'provider' | 'model',
      config?: { workflowContext?: { provider?: string; model?: string } },
    ) => {
      const workflowValue = config?.workflowContext?.[key];
      if (workflowValue !== undefined) {
        return { value: workflowValue, source: 'workflow' };
      }
      return key === 'provider'
        ? { value: 'mock', source: 'global' }
        : { value: undefined, source: 'default' };
    });
    mockResolveWorkflowConfigValues.mockReturnValue({
      provider: 'mock',
      model: undefined,
      language: 'en',
      notificationSound: false,
      notificationSoundEvents: {},
      rateLimitFallback: undefined,
      runtime: undefined,
      preventSleep: false,
      logging: {},
      analytics: { enabled: false },
      observability: {},
      personaProviders: {},
      providerProfiles: undefined,
    });
  });

  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Given workflow auto_routing and a strategy override, When bootstrap resolves config, Then it delegates override application to the engine', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'mock',
      autoRouting: createAutoRoutingConfig(),
    }, 'Run auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given a strategy override requires a missing tier, When bootstrap resolves config, Then it delegates validation to the engine', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'mock',
      autoRouting: {
        strategy: 'cost',
        router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
        candidates: [
          {
            name: 'coding',
            description: 'Implementation',
            provider: 'codex',
            model: 'gpt-5',
            costTier: 'medium',
          },
        ],
      },
    }, 'Run auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(bootstrap.autoStrategyOverride).toBe('performance');
  });

  it('Given a workflow-level concrete provider and no config provider, When bootstrap resolves provider, Then workflow provider is used', async () => {
    mockResolveWorkflowConfigValues.mockReturnValueOnce({
      provider: undefined,
      model: undefined,
      language: 'en',
      notificationSound: false,
      notificationSoundEvents: {},
      rateLimitFallback: undefined,
      runtime: undefined,
      preventSleep: false,
      logging: {},
      analytics: { enabled: false },
      observability: {},
      personaProviders: {},
      providerProfiles: undefined,
    });

    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'claude',
      autoRouting: createAutoRoutingConfig(),
    }, 'Run workflow-level auto provider', '/project', {
      projectCwd: '/project',
    });

    expect(bootstrap.currentProvider).toBe('claude');
    expect(bootstrap.currentProviderSource).toBe('workflow');
  });

  it('provider と model の value/source を同じ traced resolution から保持する', async () => {
    mockResolveConfigValueWithSource.mockImplementation((
      _projectCwd: string,
      key: 'provider' | 'model',
    ) => key === 'provider'
      ? { value: 'codex', source: 'project' }
      : { value: 'project-model', source: 'project' });

    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'claude',
      model: 'workflow-model',
    }, 'Run traced provider resolution', '/project', {
      projectCwd: '/project',
    });

    expect(bootstrap.currentProvider).toBe('codex');
    expect(bootstrap.currentProviderSource).toBe('project');
    expect(bootstrap.configuredModel).toBe('project-model');
    expect(bootstrap.configuredModelSource).toBe('project');
  });

  it('traced provider resolution の設定エラーを握りつぶさない', async () => {
    mockResolveConfigValueWithSource.mockImplementation(() => {
      throw new Error('invalid traced config');
    });

    await expect(createWorkflowExecutionBootstrap(workflowConfig, 'Run invalid config', '/project', {
      projectCwd: '/project',
    })).rejects.toThrow('invalid traced config');
  });

  it('Given no effective auto_routing and autoStrategy, When bootstrap resolves config, Then strategy override is ignored with warning', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap(workflowConfig, 'Run concrete workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting).toBeUndefined();
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    bootstrap.warnIfAutoStrategyUnused();
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringMatching(/auto_routing/i));
  });

  it('Given CLI provider is concrete and config-level auto_routing exists, When bootstrap resolves config, Then autoStrategy applies', async () => {
    mockResolveWorkflowConfigValues.mockReturnValueOnce({
      provider: 'mock',
      model: undefined,
      language: 'en',
      notificationSound: false,
      notificationSoundEvents: {},
      rateLimitFallback: undefined,
      runtime: undefined,
      preventSleep: false,
      logging: {},
      analytics: { enabled: false },
      observability: {},
      autoRouting: createAutoRoutingConfig(),
      personaProviders: {},
      providerProfiles: undefined,
    });

    const bootstrap = await createWorkflowExecutionBootstrap(workflowConfig, 'Run concrete CLI provider', '/project', {
      projectCwd: '/project',
      provider: 'mock',
      autoStrategy: 'performance',
    });

    expect(bootstrap.currentProvider).toBe('mock');
    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given CLI provider and workflow auto_routing coexist, When bootstrap resolves config, Then autoStrategy applies independently of provider', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'mock',
      autoRouting: createAutoRoutingConfig(),
      steps: [
        {
          name: 'fix',
          provider: 'mock',
          providerSpecified: false,
          personaDisplayName: 'Fixer',
          instruction: 'Fix',
          rules: [],
        },
      ],
    }, 'Run workflow-level auto with concrete CLI provider', '/project', {
      projectCwd: '/project',
      provider: 'mock',
      autoStrategy: 'performance',
    });

    expect(bootstrap.currentProvider).toBe('mock');
    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given a parallel workflow and effective auto_routing, When bootstrap resolves config, Then autoStrategy applies', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'mock',
      initialStep: 'reviewers',
      autoRouting: createAutoRoutingConfig(),
      steps: [
        {
          name: 'reviewers',
          personaDisplayName: 'Reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'coding-review',
              provider: 'mock',
              providerSpecified: false,
              persona: 'reviewer',
              instruction: 'Review code',
            },
          ],
          rules: [],
        },
      ],
    }, 'Run inherited parallel auto with concrete CLI provider', '/project', {
      projectCwd: '/project',
      provider: 'mock',
      autoStrategy: 'performance',
    });

    expect(bootstrap.currentProvider).toBe('mock');
    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given a concrete step and effective auto_routing, When bootstrap resolves config, Then it delegates strategy override application', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      autoRouting: createAutoRoutingConfig(),
      steps: [
        { name: 'fix', provider: 'mock', personaDisplayName: 'Fixer', instruction: 'Fix', rules: [] },
      ],
    }, 'Run step auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given a concrete parallel sub-step and effective auto_routing, When bootstrap resolves config, Then it delegates strategy override application', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      initialStep: 'reviewers',
      autoRouting: createAutoRoutingConfig(),
      steps: [
        {
          name: 'reviewers',
          personaDisplayName: 'Reviewers',
          instruction: 'Run reviewers',
          parallel: [
            { name: 'coding-review', provider: 'mock', persona: 'reviewer', instruction: 'Review code' },
          ],
          rules: [],
        },
      ],
    }, 'Run parallel auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given a concrete workflow_call override and effective auto_routing, When bootstrap resolves config, Then it delegates strategy override application', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      initialStep: 'call-child',
      autoRouting: createAutoRoutingConfig(),
      steps: [
        {
          name: 'call-child',
          kind: 'workflow_call',
          call: 'child',
          overrides: { provider: 'mock' },
          rules: [],
        },
      ],
    }, 'Run workflow call auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given autoStrategy and an unreachable workflow_call, When bootstrap resolves config, Then it does not resolve the child', async () => {
    const workflowCallResolver = vi.fn(() => {
      throw new Error('unreachable child resolver invoked');
    });

    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      steps: [
        ...workflowConfig.steps,
        {
          name: 'unreachable-child',
          kind: 'workflow_call',
          call: 'child',
          rules: [],
        },
      ],
    }, 'Run workflow without strategy override', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
      workflowCallResolver,
    });

    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(workflowCallResolver).not.toHaveBeenCalled();
    bootstrap.warnIfAutoStrategyUnused();
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringMatching(/auto_routing/i));
  });

  it('Given a child workflow has auto_routing and autoStrategy, When bootstrap resolves config, Then it does not warn', async () => {
    const childWorkflow: WorkflowConfig = {
      ...workflowConfig,
      name: 'child',
      provider: 'mock',
      autoRouting: createAutoRoutingConfig(),
    };
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      initialStep: 'call-child',
      steps: [
        {
          name: 'call-child',
          kind: 'workflow_call',
          call: 'child',
          rules: [],
        },
      ],
    }, 'Run child auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
      workflowCallResolver: () => childWorkflow,
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting).toBeUndefined();
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given a parallel workflow_call child has auto_routing and autoStrategy, When bootstrap resolves config, Then strategy override applies', async () => {
    const childWorkflow: WorkflowConfig = {
      ...workflowConfig,
      name: 'child',
      provider: 'mock',
      autoRouting: createAutoRoutingConfig(),
    };
    const parentWorkflow = {
      ...workflowConfig,
      initialStep: 'reviewers',
      steps: [
        {
          name: 'reviewers',
          personaDisplayName: 'Reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'call-child',
              personaDisplayName: 'Call child',
              instruction: '',
              kind: 'workflow_call',
              call: 'child',
              rules: [],
            },
          ],
          rules: [],
        },
      ],
    } as unknown as WorkflowConfig;

    const bootstrap = await createWorkflowExecutionBootstrap(parentWorkflow, 'Run parallel child auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
      workflowCallResolver: () => childWorkflow,
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting).toBeUndefined();
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given workflow_call concrete provider override and effective auto_routing, When bootstrap resolves config, Then strategy override still applies', async () => {
    const childWorkflow: WorkflowConfig = {
      ...workflowConfig,
      name: 'child',
      provider: 'mock',
      autoRouting: createAutoRoutingConfig(),
    };
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      initialStep: 'call-child',
      steps: [
        {
          name: 'call-child',
          kind: 'workflow_call',
          call: 'child',
          overrides: { provider: 'mock' },
          rules: [],
        },
      ],
    }, 'Run child auto workflow with concrete override', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
      workflowCallResolver: () => childWorkflow,
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting).toBeUndefined();
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given workflow_call concrete provider override and child auto_routing, When bootstrap resolves config, Then strategy override applies', async () => {
    const childWorkflow: WorkflowConfig = {
      ...workflowConfig,
      name: 'child',
      initialStep: 'child-auto',
      autoRouting: createAutoRoutingConfig(),
      steps: [
        { name: 'child-auto', provider: 'mock', personaDisplayName: 'Child', instruction: 'Run child auto', rules: [] },
      ],
    };
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      initialStep: 'call-child',
      steps: [
        {
          name: 'call-child',
          kind: 'workflow_call',
          call: 'child',
          overrides: { provider: 'mock' },
          rules: [],
        },
      ],
    }, 'Run child explicit step auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
      workflowCallResolver: () => childWorkflow,
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting).toBeUndefined();
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given a same-name child workflow has a different reference and auto_routing, When bootstrap resolves config, Then strategy override applies', async () => {
    const parentWorkflow = attachWorkflowOpaqueRef({
      ...workflowConfig,
      initialStep: 'call-child',
      steps: [
        {
          name: 'call-child',
          kind: 'workflow_call',
          call: 'child',
          rules: [],
        },
      ],
    }, 'project:sha256:parent');
    const childWorkflow = attachWorkflowOpaqueRef({
      ...workflowConfig,
      name: parentWorkflow.name,
      provider: 'mock',
      autoRouting: createAutoRoutingConfig(),
    }, 'project:sha256:child');

    const bootstrap = await createWorkflowExecutionBootstrap(parentWorkflow, 'Run same-name child auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
      workflowCallResolver: () => childWorkflow,
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting).toBeUndefined();
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given CLI provider override and effective auto_routing, When bootstrap resolves config, Then it delegates strategy override application', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      autoRouting: createAutoRoutingConfig(),
      steps: [
        { name: 'fix', provider: 'mock', personaDisplayName: 'Fixer', instruction: 'Fix', rules: [] },
      ],
    }, 'Run CLI override workflow', '/project', {
      projectCwd: '/project',
      provider: 'mock',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('Given routing telemetry is enabled, When bootstrap initializes analytics, Then project .takt/events is passed for local routing decisions', async () => {
    const projectDir = createTempProject();
    mockResolveWorkflowConfigValues.mockReturnValue({
      provider: 'mock',
      model: undefined,
      language: 'en',
      notificationSound: false,
      notificationSoundEvents: {},
      rateLimitFallback: undefined,
      runtime: undefined,
      preventSleep: false,
      logging: {},
      analytics: { enabled: false },
      telemetry: { routingDecisions: true },
      observability: {},
      personaProviders: {},
      providerProfiles: undefined,
    });

    await createWorkflowExecutionBootstrap(workflowConfig, 'Run with routing telemetry', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'routing-telemetry-enabled',
    });

    expect(initAnalyticsWriter).toHaveBeenCalledWith(
      false,
      '/tmp/.takt/analytics/events',
      { routingEventsDir: join(projectDir, '.takt', 'events') },
    );
  });

  it('Given telemetry config is omitted, When bootstrap initializes analytics, Then routing event directory is not passed by default', async () => {
    const projectDir = createTempProject();
    mockResolveWorkflowConfigValues.mockReturnValue({
      provider: 'mock',
      model: undefined,
      language: 'en',
      notificationSound: false,
      notificationSoundEvents: {},
      rateLimitFallback: undefined,
      runtime: undefined,
      preventSleep: false,
      logging: {},
      analytics: { enabled: false },
      observability: {},
      personaProviders: {},
      providerProfiles: undefined,
    });

    await createWorkflowExecutionBootstrap(workflowConfig, 'Run with default routing telemetry', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'routing-telemetry-default',
    });

    const options = vi.mocked(initAnalyticsWriter).mock.calls[0]?.[2];
    expect(options ?? {}).not.toHaveProperty('routingEventsDir');
  });

  it('Given routing telemetry is disabled, When bootstrap initializes analytics, Then routing event directory is not passed', async () => {
    const projectDir = createTempProject();
    mockResolveWorkflowConfigValues.mockReturnValue({
      provider: 'mock',
      model: undefined,
      language: 'en',
      notificationSound: false,
      notificationSoundEvents: {},
      rateLimitFallback: undefined,
      runtime: undefined,
      preventSleep: false,
      logging: {},
      analytics: { enabled: false },
      telemetry: { routingDecisions: false },
      observability: {},
      personaProviders: {},
      providerProfiles: undefined,
    });

    await createWorkflowExecutionBootstrap(workflowConfig, 'Run without routing telemetry', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'routing-telemetry-disabled',
    });

    const options = vi.mocked(initAnalyticsWriter).mock.calls[0]?.[2];
    expect(options ?? {}).not.toHaveProperty('routingEventsDir');
  });

  it('Given resumeSource is passed, When bootstrap creates run meta, Then source metadata is persisted in meta.json', async () => {
    const projectDir = createTempProject();
    seedResumeSourceRun(projectDir);

    await createWorkflowExecutionBootstrap(workflowConfig, 'Resume direct run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'direct-resume',
      resumeSource: {
        sourceRunSlug: '20260524-source-run',
        resumeMode: 'retry',
      },
    });

    const metaWrite = mockWriteFileAtomic.mock.calls.find((call) =>
      call[0] === join(projectDir, '.takt', 'runs', 'direct-resume', 'meta.json')
    );
    expect(metaWrite).toBeDefined();
    const meta = JSON.parse(String(metaWrite![1])) as {
      source_run_slug?: string;
      resume_mode?: string;
    };
    expect(meta.source_run_slug).toBe('20260524-source-run');
    expect(meta.resume_mode).toBe('retry');
  });

  it('Given auto requeue reuses the source run slug, When bootstrap resumes, Then it skips snapshot inheritance', async () => {
    const projectDir = createTempProject();
    const sharedRunSlug = '20260524-shared-run';
    mkdirSync(join(projectDir, '.takt', 'runs', sharedRunSlug, 'reports'), { recursive: true });

    await expect(createWorkflowExecutionBootstrap(workflowConfig, 'Resume same run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: sharedRunSlug,
      resumeSource: {
        sourceRunSlug: sharedRunSlug,
        resumeMode: 'requeue',
      },
    })).resolves.toBeDefined();

    const metaWrite = mockWriteFileAtomic.mock.calls.find((call) =>
      call[0] === join(projectDir, '.takt', 'runs', sharedRunSlug, 'meta.json')
    );
    expect(metaWrite).toBeDefined();
    const meta = JSON.parse(String(metaWrite![1])) as {
      source_run_slug?: string;
      resume_artifacts?: unknown;
    };
    expect(meta.source_run_slug).toBe(sharedRunSlug);
    expect(meta).not.toHaveProperty('resume_artifacts');
  });

  it('Given the source run is unavailable, When bootstrap resumes, Then it records fallback and continues', async () => {
    const projectDir = createTempProject();

    await expect(createWorkflowExecutionBootstrap(workflowConfig, 'Resume missing run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'fallback-resume',
      resumeSource: {
        sourceRunSlug: '20260524-missing-run',
        resumeMode: 'requeue',
      },
    })).resolves.toBeDefined();

    expect(mockLogWarn).toHaveBeenCalledWith(
      'Resume report snapshot source unavailable; continuing without inherited snapshot',
      expect.objectContaining({
        sourceRunSlug: '20260524-missing-run',
        targetRunSlug: 'fallback-resume',
        reason: expect.stringContaining('does not exist'),
        fallbackUsed: true,
      }),
    );
    const metaWrite = mockWriteFileAtomic.mock.calls.find((call) =>
      call[0] === join(projectDir, '.takt', 'runs', 'fallback-resume', 'meta.json')
    );
    const meta = JSON.parse(String(metaWrite![1])) as { resume_artifacts?: unknown };
    expect(meta).not.toHaveProperty('resume_artifacts');
  });

  it('Given the source slug is invalid and target reports are non-empty, When bootstrap resumes, Then target safety still fails fast', async () => {
    const projectDir = createTempProject();
    mockIsValidReportDirName.mockImplementation((slug: string) => slug !== '../invalid-source');
    const targetReports = join(projectDir, '.takt', 'runs', 'conflicting-resume', 'reports');
    mkdirSync(targetReports, { recursive: true });
    writeFileSync(join(targetReports, 'existing.md'), 'existing report', 'utf-8');

    await expect(createWorkflowExecutionBootstrap(workflowConfig, 'Resume conflicting run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'conflicting-resume',
      resumeSource: {
        sourceRunSlug: '../invalid-source',
        resumeMode: 'retry',
      },
    })).rejects.toThrow(/already has a non-empty reports directory/);

    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(readFileSync(join(targetReports, 'existing.md'), 'utf-8')).toBe('existing report');
  });

  it('Given no tasks.yaml exists, When direct resume bootstrap runs, Then tasks.yaml is not created', async () => {
    const projectDir = createTempProject();
    seedResumeSourceRun(projectDir);

    await createWorkflowExecutionBootstrap(workflowConfig, 'Resume direct run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'direct-resume',
      resumeSource: {
        sourceRunSlug: '20260524-source-run',
        resumeMode: 'requeue',
      },
    });

    expect(existsSync(join(projectDir, '.takt', 'tasks.yaml'))).toBe(false);
    expect(hasTasksYamlWrite()).toBe(false);
  });

  it('Given tasks.yaml already exists, When direct resume bootstrap runs, Then tasks.yaml remains unchanged', async () => {
    const projectDir = createTempProject();
    const tasksDir = join(projectDir, '.takt');
    const tasksPath = join(tasksDir, 'tasks.yaml');
    const initialTasks = 'tasks:\n  - name: keep-existing\n    status: pending\n';
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(tasksPath, initialTasks, 'utf-8');
    seedResumeSourceRun(projectDir);

    await createWorkflowExecutionBootstrap(workflowConfig, 'Resume direct run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'direct-resume',
      resumeSource: {
        sourceRunSlug: '20260524-source-run',
        resumeMode: 'instruct',
      },
    });

    expect(readFileSync(tasksPath, 'utf-8')).toBe(initialTasks);
    expect(hasTasksYamlWrite()).toBe(false);
  });

  it('Given cwd differs from projectCwd, When bootstrap runs, Then worktree .takt/.gitignore is ensured', async () => {
    const projectDir = createTempProject();
    const worktreeDir = createTempProject();

    await createWorkflowExecutionBootstrap(workflowConfig, 'Run in worktree', worktreeDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'worktree-run',
    });

    expect(mockEnsureWorktreeTaktRuntimeProtection).toHaveBeenCalledTimes(1);
    expect(mockEnsureWorktreeTaktRuntimeProtection).toHaveBeenCalledWith(worktreeDir);
  });

  it('Given cwd equals projectCwd, When bootstrap runs, Then worktree .takt/.gitignore is not ensured', async () => {
    const projectDir = createTempProject();

    await createWorkflowExecutionBootstrap(workflowConfig, 'Run in project', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'project-run',
    });

    expect(mockEnsureWorktreeTaktRuntimeProtection).not.toHaveBeenCalled();
  });
});
