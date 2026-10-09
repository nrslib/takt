import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import type { WorkflowRunBootstrap } from '../features/tasks/execute/workflowRunLifecycle.js';
import type { RunMetaManager } from '../features/tasks/execute/runMeta.js';
import type { ResumeReportSnapshotManifest } from '../core/workflow/run/resume-report-snapshot.js';

const mocks = vi.hoisted(() => ({
  inherit: vi.fn(),
  consumer: vi.fn(),
  published: false,
  out: {
    header: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    success: vi.fn(), status: vi.fn(), blankLine: vi.fn(), logLine: vi.fn(),
  },
}));

vi.mock('../core/workflow/run/resume-report-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/run/resume-report-snapshot.js')>()),
  inheritResumeReportSnapshot: mocks.inherit,
}));
vi.mock('../core/workflow/run/resume-report-reference-snapshot.js', () => ({
  buildResumeReportSnapshotConsumerEntry: mocks.consumer,
}));
vi.mock('../features/tasks/execute/outputFns.js', () => ({
  createOutputFns: () => mocks.out,
  createPrefixedStreamHandler: vi.fn(),
}));
vi.mock('../infra/config/index.js', () => ({
  loadGlobalConfig: () => ({}), loadProjectConfig: () => ({}),
  loadPersonaSessions: () => ({}), loadWorktreeSessions: () => ({}),
  updatePersonaSession: vi.fn(), updateWorktreeSession: vi.fn(),
  resolveWorkflowConfigValues: () => ({
    notificationSound: false, logging: {}, analytics: { enabled: false },
    observability: { enabled: false },
  }),
}));
vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValueWithSource: () => ({ value: undefined, source: 'default' }),
  toProviderResolutionSource: (source: string) => source,
}));
vi.mock('../infra/config/runtime-provider/provider-environment.js', () => ({
  resolveRuntimeEnvironment: () => ({
    providerEnvironment: { provider: 'mock', providerSource: 'cli', modelSource: 'default', tagConflictPolicy: 'error' },
    companionEnabled: false, companionReviewMode: 'completion', companionFixPolicy: 'single', providerConfigMode: 'legacy',
  }),
}));
vi.mock('../infra/config/loaders/workflowResolver.js', () => ({ validateWorkflowCallContracts: vi.fn() }));
vi.mock('../infra/config/workflowSelectorResolution.js', () => ({ resolveWorkflowSelector: () => ({ applies: false }) }));
vi.mock('../infra/config/paths.js', () => ({ getGlobalConfigDir: () => '/isolated-config' }));
vi.mock('../infra/fs/index.js', () => ({
  createSessionLog: () => ({ history: [] }), initNdjsonLog: () => '/isolated-session.ndjson',
}));
vi.mock('../infra/workflow/operation-journal-store.js', () => ({ createOperationJournalStore: vi.fn() }));
vi.mock('../infra/task/projectLocalTaktSync.js', () => ({ ensureWorktreeTaktRuntimeProtection: vi.fn() }));
vi.mock('../infra/observability/otelFoundation.js', () => ({
  initializeOtelFoundation: async () => ({ shutdown: vi.fn() }),
}));
vi.mock('../core/logging/providerEventLogger.js', () => ({
  createProviderEventLogger: () => ({}), isProviderEventsEnabled: () => false,
}));
vi.mock('../core/logging/usageEventLogger.js', () => ({
  createUsageEventLogger: () => ({}), isUsageEventsEnabled: () => false,
}));
vi.mock('../features/analytics/index.js', () => ({ initAnalyticsWriter: vi.fn() }));
vi.mock('../features/tasks/execute/sessionLogger.js', () => ({ SessionLogger: class {} }));
vi.mock('../features/tasks/execute/analyticsEmitter.js', () => ({ AnalyticsEmitter: class {} }));
vi.mock('../agents/structured-caller.js', () => ({ ProviderNeutralStructuredCaller: class {} }));

import { createWorkflowExecutionBootstrap } from '../features/tasks/execute/workflowExecutionBootstrap.js';
import { ResumeReportSnapshotSourceError } from '../core/workflow/run/resume-report-snapshot.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';

const cwd = '/bootstrap-project';
const sourceRunSlug = 'source-run';
const targetRunSlug = 'target-run';
const workflow: WorkflowConfig = { name: 'test', maxSteps: 4, initialStep: 'fix', steps: [{
  name: 'fix', personaDisplayName: 'fixer', instruction: 'Fix', rules: [],
}] };

function manifest(skippedEntries: NonNullable<ResumeReportSnapshotManifest['skippedEntries']>): ResumeReportSnapshotManifest {
  return {
    version: 2, sourceRunSlug, targetRunSlug, createdAt: '2026-10-09T00:00:00.000Z',
    files: [{ path: 'plan.md', size: 4, sha256: 'a'.repeat(64) }],
    resumeReportConsumers: [], skippedEntries,
  };
}

function bootstrap(mode: 'retry' | 'requeue') {
  const publishRunMeta = vi.fn<WorkflowRunBootstrap['publishRunMeta']>().mockReturnValue({} as RunMetaManager);
  const runBootstrap: WorkflowRunBootstrap = {
    runSlug: targetRunSlug, runPaths: buildRunPaths(cwd, targetRunSlug),
    startedAt: '2026-10-09T00:00:00.000Z', sessionId: 'session', publishRunMeta,
  };
  const result = createWorkflowExecutionBootstrap(workflow, 'task', cwd, {
    projectCwd: cwd, provider: 'mock', resumeSource: { sourceRunSlug, resumeMode: mode },
    resumePoint: {
      version: 2, stack: [{ workflow: 'test', workflow_ref: 'test', step: 'fix', kind: 'agent', occurrence: 1 }],
      iteration: 1, elapsed_ms: 0, workflow_call_invocations: {}, workflow_step_participations: {},
    },
  }, runBootstrap, {
    sourceRunSlug, operationJournalRunSlug: targetRunSlug, operationClaimToken: 'claim',
  });
  return { result, publishRunMeta };
}

describe('workflow bootstrap report inheritance', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.published = false;
    mocks.inherit.mockImplementation(() => {
      mocks.published = true;
      return manifest([]);
    });
  });

  it.each(['retry', 'requeue'] as const)('notifies the skipped-entry count after publication for %s', async (mode) => {
    mocks.inherit.mockImplementation(() => {
      mocks.published = true;
      return manifest([
        { path: 'file-link', reason: 'symlink' },
        { path: 'nested/directory-link', reason: 'symlink' },
        { path: 'nested/pipe', reason: 'non_regular' },
      ]);
    });
    mocks.out.warn.mockImplementation(() => { expect(mocks.published).toBe(true); });

    const { result, publishRunMeta } = bootstrap(mode);
    await result;

    expect(mocks.out.warn).toHaveBeenCalledTimes(1);
    const notice = String(mocks.out.warn.mock.calls[0]![0]);
    expect(notice).toMatch(/skip|飛ば|除外/i);
    expect(notice).toMatch(/\b3\b/);
    expect(mocks.out.error).not.toHaveBeenCalled();
    expect(publishRunMeta).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ resumeArtifactsRel: '.takt/runs/target-run/reports/resume-artifacts.json' }),
    }));
  });

  it('does not emit a skipped-entry notice when no entries were skipped', async () => {
    await bootstrap('retry').result;
    expect(mocks.out.warn).not.toHaveBeenCalled();
    expect(mocks.out.error).not.toHaveBeenCalled();
  });

  it.each([
    ['retry', 'source run does not exist'],
    ['requeue', 'source reports does not exist'],
    ['retry', 'EACCES reading reports'],
  ] as const)('rejects %s inheritance failure and displays the source run and cause: %s', async (mode, reason) => {
    mocks.inherit.mockImplementation(() => { throw new ResumeReportSnapshotSourceError(reason); });

    const { result, publishRunMeta } = bootstrap(mode);
    await expect(result).rejects.toThrow(reason);

    expect(mocks.out.error).toHaveBeenCalled();
    const errors = mocks.out.error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(errors).toContain(sourceRunSlug);
    expect(errors).toContain(reason);
    expect(publishRunMeta).not.toHaveBeenCalled();
    expect(mocks.out.warn).not.toHaveBeenCalled();
  });

  it('displays a publication failure without issuing a skipped-entry success notice', async () => {
    mocks.inherit.mockImplementation(() => { throw new Error('publication failed'); });
    const { result } = bootstrap('requeue');
    await expect(result).rejects.toThrow('publication failed');
    expect(mocks.out.warn).not.toHaveBeenCalled();
    const errors = mocks.out.error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(errors).toContain(sourceRunSlug);
    expect(errors).toContain('publication failed');
  });

  it('reports source access failure during consumer mapping before attempting inheritance', async () => {
    mocks.consumer.mockImplementation(() => { throw Object.assign(new Error('EACCES reading source manifest'), { code: 'EACCES' }); });
    const { result } = bootstrap('retry');
    await expect(result).rejects.toThrow('EACCES reading source manifest');
    expect(mocks.inherit).not.toHaveBeenCalled();
    expect(mocks.out.warn).not.toHaveBeenCalled();
    const errors = mocks.out.error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(errors).toContain(sourceRunSlug);
    expect(errors).toContain('EACCES reading source manifest');
  });
});
