import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveRuntimeProviderFile,
  mockSpawn,
  mockWorkerOnce,
  mockWorkerUnref,
  mockLogError,
} = vi.hoisted(() => ({
  mockResolveRuntimeProviderFile: vi.fn(),
  mockSpawn: vi.fn(),
  mockWorkerOnce: vi.fn(),
  mockWorkerUnref: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('../infra/config/runtime-provider/loader.js', () => ({
  resolveRuntimeProviderFile: (...args: unknown[]) => mockResolveRuntimeProviderFile(...args),
}));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => '/global/.takt',
  getProjectConfigDir: (projectCwd: string) => `${projectCwd}/.takt`,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: mockLogError,
  }),
}));

import { createLoopAnalysisScheduler } from '../features/tasks/execute/loopAnalysis.js';
import { enterCentralExecution } from '../shared/utils/child-process-env.js';
import {
  readLoopAnalysisJob,
  readLoopAnalysisPublicationMarker,
} from '../features/tasks/execute/loopAnalysisJob.js';
import {
  createLoopAnalysisPublicationCoordinator,
  settleLoopAnalysisPublication,
} from '../features/tasks/execute/loopAnalysisPublication.js';

describe('createLoopAnalysisScheduler', () => {
  const tempDirectories: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReturnValue({
      once: mockWorkerOnce,
      unref: mockWorkerUnref,
    });
  });

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createRunDirectories(): { projectCwd: string; sourceRunDirectory: string } {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-'));
    tempDirectories.push(projectCwd);
    const sourceRunDirectory = join(projectCwd, '.takt', 'runs', 'source-run');
    mkdirSync(sourceRunDirectory, { recursive: true });
    return { projectCwd, sourceRunDirectory };
  }

  function findJobPath(sourceRunDirectory: string): string {
    const directory = join(
      sourceRunDirectory,
      '.takt-report-internal',
      'loop-analysis',
    );
    const jobFile = readdirSync(directory).find((file) => file.endsWith('.job.json'));
    if (jobFile === undefined) {
      throw new Error('Loop analysis job was not created');
    }
    return join(directory, jobFile);
  }

  it.each([
    ['an absent section', undefined],
    ['a disabled section', { version: 1, loop_analysis: { enabled: false, output: 'file' } }],
  ])('Given %s, When the scheduler is configured, Then no analysis job is started', (_label, runtimeFile) => {
    mockResolveRuntimeProviderFile.mockReturnValue(runtimeFile);

    const scheduler = createLoopAnalysisScheduler({ projectCwd: '/project' });

    expect(scheduler).toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('Given file output is enabled, When a source run terminates, Then a private job is handed to a detached worker without waiting', () => {
    const { projectCwd, sourceRunDirectory } = createRunDirectories();
    mockResolveRuntimeProviderFile.mockReturnValue({
      version: 1,
      loop_analysis: { enabled: true, output: 'file' },
    });
    const scheduler = createLoopAnalysisScheduler({ projectCwd });

    const schedulingResult = scheduler?.(sourceRunDirectory);

    const jobPath = findJobPath(sourceRunDirectory);
    expect(readLoopAnalysisJob(jobPath)).toEqual({
      version: 1,
      projectCwd,
      sourceRunDirectory,
      output: 'file',
      parentPid: process.pid,
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [
        '--import',
        expect.stringMatching(/tsx[\\/]dist[\\/]esm[\\/]index\.mjs$/),
        expect.stringMatching(/loopAnalysisWorker\.ts$/),
        jobPath,
      ],
      {
        cwd: projectCwd,
        detached: true,
        stdio: 'ignore',
      },
    );
    expect(mockWorkerUnref).toHaveBeenCalledTimes(1);
    expect(schedulingResult).toBeUndefined();
    expect(mockResolveRuntimeProviderFile).toHaveBeenCalledWith({
      globalConfigDir: '/global/.takt',
      projectConfigDir: `${projectCwd}/.takt`,
    });
  });

  it('Given central execution, When the detached worker is spawned, Then ownership environment is sanitized', () => {
    const { projectCwd, sourceRunDirectory } = createRunDirectories();
    mockResolveRuntimeProviderFile.mockReturnValue({
      version: 1,
      loop_analysis: { enabled: true, output: 'file' },
    });
    const previousConfig = process.env.TAKT_CONFIG_DIR;
    const previousOwnerToken = process.env.TAKT_CENTRAL_OWNER_TOKEN;
    process.env.TAKT_CONFIG_DIR = '/private/central-config';
    process.env.TAKT_CENTRAL_OWNER_TOKEN = 'secret-owner-token';
    const leaveCentralExecution = enterCentralExecution();
    try {
      createLoopAnalysisScheduler({ projectCwd })?.(sourceRunDirectory);
    } finally {
      leaveCentralExecution();
      if (previousConfig === undefined) delete process.env.TAKT_CONFIG_DIR;
      else process.env.TAKT_CONFIG_DIR = previousConfig;
      if (previousOwnerToken === undefined) delete process.env.TAKT_CENTRAL_OWNER_TOKEN;
      else process.env.TAKT_CENTRAL_OWNER_TOKEN = previousOwnerToken;
    }

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnOptions = mockSpawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.TAKT_CONFIG_DIR).toBeUndefined();
    expect(spawnOptions.env.TAKT_CENTRAL_OWNER_TOKEN).toBeUndefined();
  });

  it('Given terminal dispatch is requested more than once, When schedulers target the same source run, Then only one job and worker are created', () => {
    const { projectCwd, sourceRunDirectory } = createRunDirectories();
    mockResolveRuntimeProviderFile.mockReturnValue({
      version: 1,
      loop_analysis: { enabled: true, output: 'file' },
    });

    createLoopAnalysisScheduler({ projectCwd })?.(sourceRunDirectory);
    createLoopAnalysisScheduler({ projectCwd })?.(sourceRunDirectory);

    const files = readdirSync(join(
      sourceRunDirectory,
      '.takt-report-internal',
      'loop-analysis',
    ));
    expect(files.filter((file) => file.endsWith('.job.json'))).toHaveLength(1);
    expect(files).toContain('dispatch.claim');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('Given PR comment output and an auto-PR branch, When a source run terminates, Then the job and pending publication marker share one coordinator', () => {
    const { projectCwd, sourceRunDirectory } = createRunDirectories();
    mockResolveRuntimeProviderFile.mockReturnValue({
      version: 1,
      loop_analysis: { enabled: true, output: 'pr-comment' },
    });
    const publication = createLoopAnalysisPublicationCoordinator('takt/source-run');
    const scheduler = createLoopAnalysisScheduler({ projectCwd, publication });

    scheduler?.(sourceRunDirectory);

    const job = readLoopAnalysisJob(findJobPath(sourceRunDirectory));
    expect(job).toEqual(expect.objectContaining({
      output: 'pr-comment',
      branch: 'takt/source-run',
      publicationMarkerPath: expect.any(String),
    }));
    expect(readLoopAnalysisPublicationMarker(job.publicationMarkerPath as string)).toBe('pending');

    publication.settle();

    expect(readLoopAnalysisPublicationMarker(job.publicationMarkerPath as string)).toBe('settled');
  });

  it('Given PR comment output without an auto-PR publication, When a source run terminates, Then no publication wait is recorded', () => {
    const { projectCwd, sourceRunDirectory } = createRunDirectories();
    mockResolveRuntimeProviderFile.mockReturnValue({
      version: 1,
      loop_analysis: { enabled: true, output: 'pr-comment' },
    });

    createLoopAnalysisScheduler({ projectCwd })?.(sourceRunDirectory);

    const job = readLoopAnalysisJob(findJobPath(sourceRunDirectory));
    expect(job.output).toBe('pr-comment');
    expect(job.branch).toBeUndefined();
    expect(job.publicationMarkerPath).toBeUndefined();
  });

  it('Given the detached worker emits a spawn error, When the source run has already continued, Then the failure is logged without throwing into the source result', () => {
    const { projectCwd, sourceRunDirectory } = createRunDirectories();
    mockResolveRuntimeProviderFile.mockReturnValue({
      version: 1,
      loop_analysis: { enabled: true, output: 'file' },
    });

    expect(() => {
      createLoopAnalysisScheduler({ projectCwd })?.(sourceRunDirectory);
    }).not.toThrow();
    const errorListener = mockWorkerOnce.mock.calls.find(
      ([event]) => event === 'error',
    )?.[1] as ((error: Error) => void) | undefined;
    expect(errorListener).toBeTypeOf('function');

    errorListener?.(new Error('spawn failed'));

    expect(mockLogError).toHaveBeenCalledWith(
      'Loop analysis worker failed to start',
      {
        sourceRunDirectory,
        error: 'spawn failed',
      },
    );
  });

  it('Given the detached worker exits unsuccessfully, When the source run has already continued, Then the exit is logged without replacing the source result', () => {
    const { projectCwd, sourceRunDirectory } = createRunDirectories();
    mockResolveRuntimeProviderFile.mockReturnValue({
      version: 1,
      loop_analysis: { enabled: true, output: 'file' },
    });

    createLoopAnalysisScheduler({ projectCwd })?.(sourceRunDirectory);
    const exitListener = mockWorkerOnce.mock.calls.find(
      ([event]) => event === 'exit',
    )?.[1] as ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    expect(exitListener).toBeTypeOf('function');

    exitListener?.(1, null);

    expect(mockLogError).toHaveBeenCalledWith(
      'Loop analysis worker exited unsuccessfully',
      {
        sourceRunDirectory,
        code: 1,
        signal: null,
      },
    );
  });

  it('Given publication settlement fails, When the source operation finalizes, Then the failure is logged without replacing the source result', () => {
    const coordinator = {
      branch: 'takt/source-run',
      register: vi.fn(),
      settle: vi.fn(() => {
        throw new Error('marker write failed');
      }),
    };

    expect(() => settleLoopAnalysisPublication(coordinator)).not.toThrow();

    expect(mockLogError).toHaveBeenCalledWith(
      'Loop analysis publication settlement failed',
      {
        branch: 'takt/source-run',
        error: 'marker write failed',
      },
    );
  });
});
