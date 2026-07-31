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
  isPathInside: vi.fn(() => true),
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

vi.mock('../features/tasks/execute/sessionLogger.js', () => ({
  SessionLogger: vi.fn().mockImplementation(() => ({
    writeInteractiveMetadata: vi.fn(),
  })),
}));

vi.mock('../core/runtime/runtime-environment.js', () => ({
  resolveRuntimeConfig: vi.fn(() => undefined),
}));

import {
  createWorkflowExecutionBootstrap as createWorkflowExecutionBootstrapImpl,
  resolveWorkflowExecutionResumeLineage,
} from '../features/tasks/execute/workflowExecutionBootstrap.js';
import type {
  WorkflowRunBootstrap,
} from '../features/tasks/execute/workflowRunStorage.js';
import { RunMetaManager } from '../features/tasks/execute/runMeta.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { generateExecutionReportDir } from '../core/workflow/run/run-slug.js';
import { FindingContractOperationJournal } from '../core/workflow/engine/team-leader-finding-contract-operation-journal.js';
import { ExplicitPartFailureError } from '../core/workflow/operations/operation-recovery-error.js';
import { createOperationJournalStore } from '../infra/workflow/operation-journal-store.js';
import {
  generateReportDir,
  isValidReportDirName,
} from '../shared/utils/index.js';

async function createWorkflowExecutionBootstrap(
  ...args: [
    Parameters<typeof createWorkflowExecutionBootstrapImpl>[0],
    Parameters<typeof createWorkflowExecutionBootstrapImpl>[1],
    Parameters<typeof createWorkflowExecutionBootstrapImpl>[2],
    Parameters<typeof createWorkflowExecutionBootstrapImpl>[3],
  ]
) {
  const runBootstrap = createRunBootstrap({
    backend: 'file',
    cwd: args[2],
    task: args[1],
    requestedRunSlug: args[3].reportDirName,
    resumeSource: args[3].resumeSource,
  });
  return await createWorkflowExecutionBootstrapImpl(
    ...args,
    runBootstrap,
    resolveWorkflowExecutionResumeLineage(
      args[2],
      runBootstrap.runSlug,
      args[3].resumeSource,
    ),
  );
}

function createRunBootstrap(setup: {
  readonly backend: 'file' | 'sqlite';
  readonly cwd: string;
  readonly task: string;
  readonly requestedRunSlug?: string;
  readonly resumeSource?: Parameters<typeof createWorkflowExecutionBootstrapImpl>[3]['resumeSource'];
}): WorkflowRunBootstrap {
  const runSlug = setup.requestedRunSlug
    ?? (setup.resumeSource?.sourceRunSlug === undefined
      ? generateReportDir(setup.task)
      : generateExecutionReportDir(setup.cwd, setup.task));
  if (!isValidReportDirName(runSlug)) {
    throw new Error(`Invalid reportDirName: ${runSlug}`);
  }
  if (setup.resumeSource?.sourceRunSlug === runSlug) {
    throw new Error(
      `Workflow resume requires distinct source and target run slugs: `
      + `"${runSlug}"`,
    );
  }
  return {
    runSlug,
    runPaths: buildRunPaths(setup.cwd, runSlug),
    publishRunMeta(input): RunMetaManager {
      return new RunMetaManager(
        input.runPaths,
        input.task,
        input.workflowName,
        setup.backend,
        input.resumeSource,
        input.options,
      );
    },
  };
}
import { initAnalyticsWriter } from '../features/analytics/index.js';
import {
  attachWorkflowOpaqueRef,
  attachWorkflowSourcePath,
  attachWorkflowTrustInfo,
  getAttachedWorkflowOpaqueRef,
  getAttachedWorkflowTrustInfo,
  getWorkflowSourcePath,
  inheritWorkflowConfigMetadata,
} from '../shared/workflowConfigMetadata.js';

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
        routingTier: 'high',
      },
      {
        name: 'coding',
        description: 'Implementation',
        provider: 'codex',
        model: 'gpt-5',
        routingTier: 'medium',
      },
      {
        name: 'lightweight',
        description: 'Formatting',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        routingTier: 'low',
      },
    ],
    defaultPool: 'general',
    candidatePools: { general: { candidates: ['reasoning', 'coding', 'lightweight'], fallback: 'reasoning' } },
  };
}

const temporaryDirs: string[] = [];

function createTempProject(): string {
  const projectDir = mkdtempSync(join(TEST_TMPDIR, 'takt-direct-resume-'));
  temporaryDirs.push(projectDir);
  return projectDir;
}

function seedResumeSourceRun(
  projectDir: string,
  slug = '20260524-source-run',
  options?: {
    readonly sourceRunSlug?: string;
    readonly journalRunSlug?: string;
    readonly claimToken?: string;
    readonly status?: 'running' | 'failed';
  },
): void {
  mkdirSync(
    join(projectDir, '.takt', 'runs', slug, 'reports'),
    { recursive: true },
  );
  writeFileSync(
    join(projectDir, '.takt', 'runs', slug, 'meta.json'),
    JSON.stringify({
      task: 'Resume source',
      workflow: 'default',
      runSlug: slug,
      runRoot: `.takt/runs/${slug}`,
      reportDirectory: `.takt/runs/${slug}/reports`,
      contextDirectory: `.takt/runs/${slug}/context`,
      logsDirectory: `.takt/runs/${slug}/logs`,
      storageBackend: 'file',
      status: options?.status ?? 'failed',
      startTime: '2026-05-24T00:00:00.000Z',
      operation_journal_run_slug: options?.journalRunSlug ?? '20260524-source-run',
      operation_claim_token: options?.claimToken ?? 'claim-a',
      ...(options?.sourceRunSlug === undefined
        ? {}
        : { source_run_slug: options.sourceRunSlug, resume_mode: 'requeue' }),
    }),
    'utf-8',
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

  it('preserves workflow metadata on the effective execution config', async () => {
    const projectDir = createTempProject();
    const config = attachWorkflowOpaqueRef(
      attachWorkflowTrustInfo(
        attachWorkflowSourcePath({ ...workflowConfig }, join(projectDir, '.takt', 'workflows', 'default.yaml')),
        { source: 'project' },
      ),
      'project:sha256:workflow',
    );

    const bootstrap = await createWorkflowExecutionBootstrap(config, 'Run metadata workflow', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
    });

    expect(getWorkflowSourcePath(bootstrap.effectiveWorkflowConfig)).toBe(join(projectDir, '.takt', 'workflows', 'default.yaml'));
    expect(getAttachedWorkflowTrustInfo(bootstrap.effectiveWorkflowConfig)).toEqual({ source: 'project' });
    expect(getAttachedWorkflowOpaqueRef(bootstrap.effectiveWorkflowConfig)).toBe('project:sha256:workflow');
  });

  it('keeps workflow metadata absent when the source config has no metadata', async () => {
    const projectDir = createTempProject();

    const bootstrap = await createWorkflowExecutionBootstrap(
      { ...workflowConfig },
      'Run workflow without metadata',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'mock',
      },
    );

    expect(getWorkflowSourcePath(bootstrap.effectiveWorkflowConfig)).toBeUndefined();
    expect(getAttachedWorkflowTrustInfo(bootstrap.effectiveWorkflowConfig)).toBeUndefined();
    expect(getAttachedWorkflowOpaqueRef(bootstrap.effectiveWorkflowConfig)).toBeUndefined();
  });

  it('does not replace metadata already attached to the inheritance target', () => {
    const source = attachWorkflowSourcePath({}, '/source/workflow.yaml');
    const target = attachWorkflowSourcePath({}, '/target/workflow.yaml');

    expect(() => inheritWorkflowConfigMetadata(source, target)).not.toThrow();
    expect(getWorkflowSourcePath(target)).toBe('/target/workflow.yaml');
  });

  it('deeply freezes attached trust metadata and reuses its frozen instance', () => {
    const workflow = attachWorkflowTrustInfo({}, {
      source: 'project',
      nested: { roots: ['/project'] },
    });

    const first = getAttachedWorkflowTrustInfo(workflow) as {
      nested: { roots: string[] };
    };
    const second = getAttachedWorkflowTrustInfo(workflow);

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nested)).toBe(true);
    expect(Object.isFrozen(first.nested.roots)).toBe(true);
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
            routingTier: 'medium',
          },
        ],
        defaultPool: 'general',
        candidatePools: { general: { candidates: ['coding'], fallback: 'coding' } },
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

  it('recovers an operation owner through the direct source run ancestry', async () => {
    const projectDir = createTempProject();
    seedResumeSourceRun(projectDir, 'run-a', {
      journalRunSlug: 'run-a',
      claimToken: 'claim-a',
      status: 'running',
    });
    seedResumeSourceRun(projectDir, 'run-b', {
      sourceRunSlug: 'run-a',
      journalRunSlug: 'run-a',
      claimToken: 'claim-b-never-owned',
    });
    seedResumeSourceRun(projectDir, 'run-c', {
      sourceRunSlug: 'run-b',
      journalRunSlug: 'run-a',
      claimToken: 'claim-c-never-owned',
    });
    const store = createOperationJournalStore(buildRunPaths(projectDir, 'run-a').operationJournalAbs);
    const operationA = FindingContractOperationJournal.open({
      context: { store, journalRunSlug: 'run-a', claimToken: 'claim-a' },
      workflowName: 'default',
      stepName: 'fix',
      stepIteration: 1,
      executionScope: { runPathNamespace: [], workflowStack: [] },
    });
    operationA.boundary('decomposition', 'finding_contract_decomposition').complete({ parts: [] });
    const request = {
      partId: 'p1',
      title: 'Repair',
      instruction: 'Repair finding',
      findingAssignment: {
        findingIds: ['F-0001'],
        role: 'repair' as const,
        readPaths: ['src/fix.ts'],
      },
    };
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      request,
    ).markApplied({
      part: {
        id: request.partId,
        title: request.title,
        instruction: request.instruction,
        findingContract: request.findingAssignment,
      },
      response: {
        persona: 'fix.p1',
        status: 'error',
        content: '',
        error: 'preflight failure',
        timestamp: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
    operationA.terminate(new ExplicitPartFailureError('typed failure', {
      boundaryId: 'part:p1:completion',
    }));

    const bootstrap = await createWorkflowExecutionBootstrap(
      workflowConfig,
      'Resume ancestry',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'mock',
        reportDirName: 'run-d',
        resumeSource: { sourceRunSlug: 'run-c', resumeMode: 'requeue' },
      },
    );
    expect(bootstrap.operationJournal.sourceClaimTokens).toEqual(
      new Set(['claim-c-never-owned', 'claim-b-never-owned', 'claim-a']),
    );
    const recovered = FindingContractOperationJournal.open({
      context: bootstrap.operationJournal,
      workflowName: 'default',
      stepName: 'fix',
      stepIteration: 1,
      executionScope: { runPathNamespace: [], workflowStack: [] },
    });
    expect(recovered.getChild('part:p1:completion').stage).toBe('reserved');
  });

  it('rejects a cycle in the direct source run ancestry', async () => {
    const projectDir = createTempProject();
    seedResumeSourceRun(projectDir, 'run-a', {
      sourceRunSlug: 'run-b',
      journalRunSlug: 'run-a',
      claimToken: 'claim-a',
    });
    seedResumeSourceRun(projectDir, 'run-b', {
      sourceRunSlug: 'run-a',
      journalRunSlug: 'run-a',
      claimToken: 'claim-b',
    });

    await expect(createWorkflowExecutionBootstrap(
      workflowConfig,
      'Resume cycle',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'mock',
        reportDirName: 'run-c',
        resumeSource: { sourceRunSlug: 'run-b', resumeMode: 'retry' },
      },
    )).rejects.toThrow(/ancestry contains a cycle/);
    expect(existsSync(join(projectDir, '.takt', 'runs', 'run-c'))).toBe(false);
  });

  it('rejects a restored operation journal slug that traverses outside the runs directory', async () => {
    const projectDir = createTempProject();
    seedResumeSourceRun(projectDir);
    writeFileSync(
      join(projectDir, '.takt', 'runs', '20260524-source-run', 'meta.json'),
      JSON.stringify({
        task: 'Resume tampered operation journal',
        workflow: 'default',
        runSlug: '20260524-source-run',
        runRoot: '.takt/runs/20260524-source-run',
        reportDirectory: '.takt/runs/20260524-source-run/reports',
        contextDirectory: '.takt/runs/20260524-source-run/context',
        logsDirectory: '.takt/runs/20260524-source-run/logs',
        storageBackend: 'file',
        status: 'failed',
        startTime: '2026-05-24T00:00:00.000Z',
        operation_journal_run_slug: '../outside',
        operation_claim_token: 'claim-a',
      }),
      'utf-8',
    );
    mockIsValidReportDirName.mockImplementation((slug: string) => slug !== '../outside');

    await expect(createWorkflowExecutionBootstrap(
      workflowConfig,
      'Resume tampered operation journal',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'mock',
        reportDirName: 'direct-resume',
        resumeSource: {
          sourceRunSlug: '20260524-source-run',
          resumeMode: 'retry',
        },
      },
    )).rejects.toThrow(
      'Source run "20260524-source-run" has an invalid operation journal run slug',
    );

    expect(
      existsSync(join(projectDir, '.takt', 'outside', 'operations', 'journal.json')),
    ).toBe(false);
  });

  it('rejects a File resume whose explicit target slug equals the source slug', async () => {
    const projectDir = createTempProject();
    const sharedRunSlug = '20260524-shared-run';
    seedResumeSourceRun(projectDir, sharedRunSlug, {
      journalRunSlug: sharedRunSlug,
      claimToken: 'claim-shared',
    });

    await expect(createWorkflowExecutionBootstrap(workflowConfig, 'Resume same run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: sharedRunSlug,
      resumeSource: {
        sourceRunSlug: sharedRunSlug,
        resumeMode: 'requeue',
      },
    })).rejects.toThrow(
      `Workflow resume requires distinct source and target run slugs: "${sharedRunSlug}"`,
    );
  });

  it('rejects a SQLite resume whose explicit target slug equals the source slug', async () => {
    const projectDir = createTempProject();
    const sharedRunSlug = '20260524-shared-sqlite-run';

    await expect(async () => {
      await createWorkflowExecutionBootstrapImpl(
        workflowConfig,
        'Resume same SQLite run',
        projectDir,
        {
          projectCwd: projectDir,
          provider: 'mock',
          reportDirName: sharedRunSlug,
          resumeSource: {
            sourceRunSlug: sharedRunSlug,
            resumeMode: 'retry',
          },
        },
        createRunBootstrap({
          backend: 'sqlite',
          cwd: projectDir,
          task: 'Resume same SQLite run',
          requestedRunSlug: sharedRunSlug,
          resumeSource: {
            sourceRunSlug: sharedRunSlug,
            resumeMode: 'retry',
          },
        }),
        {
          operationJournalRunSlug: sharedRunSlug,
          operationClaimToken: 'unreachable',
        },
      );
    }).rejects.toThrow(
      `Workflow resume requires distinct source and target run slugs: "${sharedRunSlug}"`,
    );
  });

  it('fails fast when a resume source run is unavailable', async () => {
    const projectDir = createTempProject();

    await expect(createWorkflowExecutionBootstrap(workflowConfig, 'Resume missing run', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: 'fallback-resume',
      resumeSource: {
        sourceRunSlug: '20260524-missing-run',
        resumeMode: 'requeue',
      },
    })).rejects.toThrow('Resume source run "20260524-missing-run" is missing');
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(existsSync(join(projectDir, '.takt', 'runs', 'fallback-resume'))).toBe(false);
  });

  it('rejects a running immediate resume source without inspecting terminal ancestors', async () => {
    const projectDir = createTempProject();
    seedResumeSourceRun(projectDir, 'running-source', {
      journalRunSlug: 'running-source',
      claimToken: 'claim-running',
      status: 'running',
    });

    await expect(createWorkflowExecutionBootstrap(
      workflowConfig,
      'Resume running source',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'mock',
        reportDirName: 'distinct-target',
        resumeSource: {
          sourceRunSlug: 'running-source',
          resumeMode: 'requeue',
        },
      },
    )).rejects.toThrow(/not in a resumable terminal status/);
    expect(existsSync(join(projectDir, '.takt', 'runs', 'distinct-target'))).toBe(false);
  });

  it('fails fast on an invalid source slug before report inheritance', async () => {
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
    })).rejects.toThrow('Resume source run slug "../invalid-source" is invalid');

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
