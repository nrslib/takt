import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';

const {
  mockWriteFileAtomic,
  mockResolveWorkflowConfigValues,
  mockCreateOutputFns,
  mockInitializeOtelFoundation,
} = vi.hoisted(() => ({
  mockWriteFileAtomic: vi.fn(),
  mockResolveWorkflowConfigValues: vi.fn(),
  mockCreateOutputFns: vi.fn(),
  mockInitializeOtelFoundation: vi.fn(),
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

const workflowConfig: WorkflowConfig = {
  name: 'default',
  initialStep: 'fix',
  maxSteps: 50,
  steps: [
    { name: 'fix', personaDisplayName: 'Fixer', instruction: 'Fix', rules: [] },
  ],
};

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
});
