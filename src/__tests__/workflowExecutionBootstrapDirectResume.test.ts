import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';

const {
  mockWriteFileAtomic,
  mockResolveWorkflowConfigValues,
  mockCreateOutputFns,
  mockInitializeOtelFoundation,
  mockEnsureWorktreeTaktGitignore,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockWriteFileAtomic: vi.fn(),
  mockResolveWorkflowConfigValues: vi.fn(),
  mockCreateOutputFns: vi.fn(),
  mockInitializeOtelFoundation: vi.fn(),
  mockEnsureWorktreeTaktGitignore: vi.fn(),
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
  resolveConfigValueWithSource: vi.fn(() => ({ value: 'mock', source: 'global' })),
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
  isValidReportDirName: vi.fn(() => true),
  preventSleep: vi.fn(),
}));

vi.mock('../shared/utils/providerEventLogger.js', () => ({
  createProviderEventLogger: vi.fn(() => ({
    wrapCallback: (handler: unknown) => handler,
  })),
  isProviderEventsEnabled: vi.fn(() => false),
}));

vi.mock('../shared/utils/usageEventLogger.js', () => ({
  createUsageEventLogger: vi.fn(() => ({})),
  isUsageEventsEnabled: vi.fn(() => false),
}));

vi.mock('../infra/observability/otelFoundation.js', () => ({
  initializeOtelFoundation: mockInitializeOtelFoundation,
}));

vi.mock('../infra/task/projectLocalTaktSync.js', () => ({
  ensureWorktreeTaktGitignore: mockEnsureWorktreeTaktGitignore,
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
  const projectDir = mkdtempSync(join(tmpdir(), 'takt-direct-resume-'));
  temporaryDirs.push(projectDir);
  return projectDir;
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
    mockLogWarn.mockReset();
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

  it('Given workflow provider auto and autoStrategy, When bootstrap resolves config, Then strategy override applies without ignored warning', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'auto',
      autoRouting: createAutoRoutingConfig(),
    }, 'Run auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('performance');
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given workflow provider auto and autoStrategy requires a missing tier, When bootstrap resolves config, Then it fails fast', async () => {
    await expect(createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'auto',
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
    })).rejects.toThrow(/performance|high|candidate/i);
  });

  it('Given workflow-level provider auto and no config provider, When bootstrap resolves provider, Then workflow provider is used', async () => {
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
      provider: 'auto',
      autoRouting: createAutoRoutingConfig(),
    }, 'Run workflow-level auto provider', '/project', {
      projectCwd: '/project',
    });

    expect(bootstrap.currentProvider).toBe('auto');
    expect(bootstrap.currentProviderSource).toBe('workflow');
  });

  it('Given no effective auto provider and autoStrategy, When bootstrap resolves config, Then strategy override is ignored with warning', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
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
    }, 'Run concrete workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(bootstrap.autoStrategyOverride).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given CLI provider is concrete and global provider is auto, When bootstrap resolves config, Then autoStrategy is ignored with warning', async () => {
    mockResolveWorkflowConfigValues.mockReturnValueOnce({
      provider: 'auto',
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
    expect(bootstrap.autoStrategyOverride).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given CLI provider is concrete and workflow-level provider auto is inherited by a step, When bootstrap resolves config, Then autoStrategy is ignored with warning', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'auto',
      autoRouting: createAutoRoutingConfig(),
      steps: [
        {
          name: 'fix',
          provider: 'auto',
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
    expect(bootstrap.autoStrategyOverride).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given CLI provider is concrete and workflow-level provider auto is inherited by a parallel sub-step, When bootstrap resolves config, Then autoStrategy is ignored with warning', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      provider: 'auto',
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
              provider: 'auto',
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
    expect(bootstrap.autoStrategyOverride).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given a step-level auto provider and autoStrategy, When bootstrap resolves config, Then strategy override applies', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      autoRouting: createAutoRoutingConfig(),
      steps: [
        { name: 'fix', provider: 'auto', personaDisplayName: 'Fixer', instruction: 'Fix', rules: [] },
      ],
    }, 'Run step auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given a parallel sub-step auto provider and autoStrategy, When bootstrap resolves config, Then strategy override applies', async () => {
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
            { name: 'coding-review', provider: 'auto', persona: 'reviewer', instruction: 'Review code' },
          ],
          rules: [],
        },
      ],
    }, 'Run parallel auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given a workflow_call override auto provider and autoStrategy, When bootstrap resolves config, Then strategy override applies', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      initialStep: 'call-child',
      autoRouting: createAutoRoutingConfig(),
      steps: [
        {
          name: 'call-child',
          kind: 'workflow_call',
          call: 'child',
          overrides: { provider: 'auto' },
          rules: [],
        },
      ],
    }, 'Run workflow call auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given only a child workflow uses provider auto and autoStrategy, When bootstrap resolves config, Then it does not warn that the strategy is ignored', async () => {
    const childWorkflow: WorkflowConfig = {
      ...workflowConfig,
      name: 'child',
      provider: 'auto',
      autoRouting: createAutoRoutingConfig(),
    };
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      initialStep: 'call-child',
      autoRouting: createAutoRoutingConfig(),
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

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given a parallel workflow_call child workflow uses provider auto and autoStrategy, When bootstrap resolves config, Then strategy override applies', async () => {
    const childWorkflow: WorkflowConfig = {
      ...workflowConfig,
      name: 'child',
      provider: 'auto',
      autoRouting: createAutoRoutingConfig(),
    };
    const parentWorkflow = {
      ...workflowConfig,
      initialStep: 'reviewers',
      autoRouting: createAutoRoutingConfig(),
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

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('performance');
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given workflow_call concrete provider override and child top-level provider auto, When bootstrap resolves config, Then strategy override is ignored', async () => {
    const childWorkflow: WorkflowConfig = {
      ...workflowConfig,
      name: 'child',
      provider: 'auto',
      autoRouting: createAutoRoutingConfig(),
    };
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
    }, 'Run child auto workflow with concrete override', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
      workflowCallResolver: () => childWorkflow,
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('cost');
    expect(bootstrap.autoStrategyOverride).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given workflow_call concrete provider override and child step provider auto, When bootstrap resolves config, Then strategy override applies', async () => {
    const childWorkflow: WorkflowConfig = {
      ...workflowConfig,
      name: 'child',
      initialStep: 'child-auto',
      autoRouting: createAutoRoutingConfig(),
      steps: [
        { name: 'child-auto', provider: 'auto', personaDisplayName: 'Child', instruction: 'Run child auto', rules: [] },
      ],
    };
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
    }, 'Run child explicit step auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
      workflowCallResolver: () => childWorkflow,
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('performance');
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given a same-name child workflow has a different reference and provider auto, When bootstrap checks auto usage, Then strategy override applies', async () => {
    const parentWorkflow = attachWorkflowOpaqueRef({
      ...workflowConfig,
      initialStep: 'call-child',
      autoRouting: createAutoRoutingConfig(),
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
      provider: 'auto',
      autoRouting: createAutoRoutingConfig(),
    }, 'project:sha256:child');

    const bootstrap = await createWorkflowExecutionBootstrap(parentWorkflow, 'Run same-name child auto workflow', '/project', {
      projectCwd: '/project',
      autoStrategy: 'performance',
      workflowCallResolver: () => childWorkflow,
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('performance');
    expect(bootstrap.autoStrategyOverride).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
  });

  it('Given CLI provider override is concrete and a step uses auto, When bootstrap resolves config, Then strategy override applies', async () => {
    const bootstrap = await createWorkflowExecutionBootstrap({
      ...workflowConfig,
      autoRouting: createAutoRoutingConfig(),
      steps: [
        { name: 'fix', provider: 'auto', personaDisplayName: 'Fixer', instruction: 'Fix', rules: [] },
      ],
    }, 'Run CLI override workflow', '/project', {
      projectCwd: '/project',
      provider: 'mock',
      autoStrategy: 'performance',
    });

    expect(bootstrap.effectiveWorkflowConfig.autoRouting?.strategy).toBe('performance');
    expect(mockLogWarn).not.toHaveBeenCalledWith('--auto-strategy is ignored unless the effective provider is auto');
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

  it('Given directResume is passed, When bootstrap creates run meta, Then source metadata is persisted in meta.json', async () => {
    await createWorkflowExecutionBootstrap(workflowConfig, 'Resume direct run', '/project', {
      projectCwd: '/project',
      provider: 'mock',
      reportDirName: 'direct-resume',
      directResume: {
        sourceRunSlug: '20260524-source-run',
        resumeMode: 'retry',
      },
    });

    const metaWrite = mockWriteFileAtomic.mock.calls.find((call) =>
      call[0] === '/project/.takt/runs/direct-resume/meta.json'
    );
    expect(metaWrite).toBeDefined();
    const meta = JSON.parse(String(metaWrite![1])) as {
      source_run_slug?: string;
      resume_mode?: string;
    };
    expect(meta.source_run_slug).toBe('20260524-source-run');
    expect(meta.resume_mode).toBe('retry');
  });

  it('Given no tasks.yaml exists, When direct resume bootstrap runs, Then tasks.yaml is not created', async () => {
    const projectDir = createTempProject();

    await createWorkflowExecutionBootstrap(workflowConfig, 'Resume direct run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'direct-resume',
      directResume: {
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

    await createWorkflowExecutionBootstrap(workflowConfig, 'Resume direct run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'direct-resume',
      directResume: {
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

    expect(mockEnsureWorktreeTaktGitignore).toHaveBeenCalledTimes(1);
    expect(mockEnsureWorktreeTaktGitignore).toHaveBeenCalledWith(worktreeDir);
  });

  it('Given cwd equals projectCwd, When bootstrap runs, Then worktree .takt/.gitignore is not ensured', async () => {
    const projectDir = createTempProject();

    await createWorkflowExecutionBootstrap(workflowConfig, 'Run in project', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'project-run',
    });

    expect(mockEnsureWorktreeTaktGitignore).not.toHaveBeenCalled();
  });
});
