import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppendLoopAnalysisWorkerFailure,
  mockCommentLoopAnalysisReportOnPr,
  mockExistsSync,
  mockInitGitProvider,
  mockLstatSync,
  mockReadLoopAnalysisJob,
  mockReadLoopAnalysisPublicationMarker,
  mockRunLoopAnalysisWorkflowExecution,
} = vi.hoisted(() => ({
  mockAppendLoopAnalysisWorkerFailure: vi.fn(),
  mockCommentLoopAnalysisReportOnPr: vi.fn(),
  mockExistsSync: vi.fn(),
  mockInitGitProvider: vi.fn(),
  mockLstatSync: vi.fn(),
  mockReadLoopAnalysisJob: vi.fn(),
  mockReadLoopAnalysisPublicationMarker: vi.fn(),
  mockRunLoopAnalysisWorkflowExecution: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  lstatSync: (...args: unknown[]) => mockLstatSync(...args),
}));

vi.mock('../features/tasks/execute/loopAnalysisJob.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/tasks/execute/loopAnalysisJob.js')>()),
  appendLoopAnalysisWorkerFailure: (...args: unknown[]) =>
    mockAppendLoopAnalysisWorkerFailure(...args),
  readLoopAnalysisJob: (...args: unknown[]) => mockReadLoopAnalysisJob(...args),
  readLoopAnalysisPublicationMarker: (...args: unknown[]) =>
    mockReadLoopAnalysisPublicationMarker(...args),
}));

vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({
  runLoopAnalysisWorkflowExecution: (...args: unknown[]) =>
    mockRunLoopAnalysisWorkflowExecution(...args),
}));

vi.mock('../features/tasks/execute/postExecution.js', () => ({
  commentLoopAnalysisReportOnPr: (...args: unknown[]) =>
    mockCommentLoopAnalysisReportOnPr(...args),
}));

vi.mock('../infra/git/index.js', () => ({
  initGitProvider: (...args: unknown[]) => mockInitGitProvider(...args),
}));

import {
  PrivateArtifactPublicationConflictError,
} from '../shared/utils/private-file.js';
import {
  executeLoopAnalysisJob,
  runLoopAnalysisWorker,
} from '../features/tasks/execute/loopAnalysisWorker.js';

const baseJob = {
  version: 1 as const,
  projectCwd: '/project',
  sourceRunDirectory: '/project/.takt/runs/source-run',
  output: 'file' as const,
  parentPid: 1234,
};

describe('loop analysis worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockLstatSync.mockReturnValue({ isFile: () => true });
    mockReadLoopAnalysisJob.mockReturnValue(baseJob);
    mockRunLoopAnalysisWorkflowExecution.mockResolvedValue({
      success: true,
      runDirectory: '/project/.takt/runs/analysis-run',
      reportDirectory: '/project/.takt/runs/analysis-run/reports',
      ndjsonLogPath: '/project/.takt/runs/analysis-run/logs/session.ndjson',
    });
    mockCommentLoopAnalysisReportOnPr.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Given file output, When the worker runs, Then it saves the analysis report without PR operations', async () => {
    await executeLoopAnalysisJob('/project/source.job.json');

    expect(mockRunLoopAnalysisWorkflowExecution).toHaveBeenCalledWith({
      task: [
        'Analyze the completed run in this absolute directory:',
        '/project/.takt/runs/source-run',
        'Use its available session JSONL logs, trace, monitor data, and reports as evidence.',
      ].join('\n'),
      cwd: '/project',
      projectCwd: '/project',
      workflowIdentifier: 'loop-analysis',
      outputMode: 'silent',
    });
    expect(mockExistsSync).toHaveBeenNthCalledWith(
      1,
      '/project/.takt/runs/analysis-run/reports',
    );
    expect(mockLstatSync).toHaveBeenCalledWith(
      '/project/.takt/runs/analysis-run/reports/loop-analysis.md',
      { throwIfNoEntry: false },
    );
    expect(mockInitGitProvider).not.toHaveBeenCalled();
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });

  it('Given PR comment output without publication metadata, When the report is saved, Then it keeps the file without PR operations', async () => {
    mockReadLoopAnalysisJob.mockReturnValue({
      ...baseJob,
      output: 'pr-comment',
    });

    await executeLoopAnalysisJob('/project/source.job.json');

    expect(mockLstatSync).toHaveBeenCalledWith(
      '/project/.takt/runs/analysis-run/reports/loop-analysis.md',
      { throwIfNoEntry: false },
    );
    expect(mockReadLoopAnalysisPublicationMarker).not.toHaveBeenCalled();
    expect(mockInitGitProvider).not.toHaveBeenCalled();
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });

  it('Given PR publication is already settled, When the report is saved, Then the existing PR is searched once with the exact report path', async () => {
    mockReadLoopAnalysisJob.mockReturnValue({
      ...baseJob,
      output: 'pr-comment',
      branch: 'takt/source-run',
      publicationMarkerPath: '/project/source.publication.json',
    });
    mockReadLoopAnalysisPublicationMarker.mockReturnValue('settled');

    await executeLoopAnalysisJob('/project/source.job.json');

    expect(mockReadLoopAnalysisPublicationMarker).toHaveBeenCalledTimes(1);
    expect(mockInitGitProvider).toHaveBeenCalledWith('/project');
    expect(mockCommentLoopAnalysisReportOnPr).toHaveBeenCalledTimes(1);
    expect(mockCommentLoopAnalysisReportOnPr).toHaveBeenCalledWith({
      projectCwd: '/project',
      branch: 'takt/source-run',
      reportPath: '/project/.takt/runs/analysis-run/reports/loop-analysis.md',
    });
  });

  it('Given the report finishes before PR publication, When publication settles, Then the worker waits for the marker and comments once', async () => {
    vi.useFakeTimers();
    mockReadLoopAnalysisJob.mockReturnValue({
      ...baseJob,
      output: 'pr-comment',
      branch: 'takt/source-run',
      publicationMarkerPath: '/project/source.publication.json',
    });
    mockReadLoopAnalysisPublicationMarker
      .mockReturnValueOnce('pending')
      .mockReturnValueOnce('settled');
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    const execution = executeLoopAnalysisJob('/project/source.job.json');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await execution;

    expect(mockReadLoopAnalysisPublicationMarker).toHaveBeenCalledTimes(2);
    expect(mockCommentLoopAnalysisReportOnPr).toHaveBeenCalledTimes(1);
  });

  it('Given publication remains pending and the parent exits, When the report is saved, Then the worker performs one PR lookup without polling the PR', async () => {
    mockReadLoopAnalysisJob.mockReturnValue({
      ...baseJob,
      output: 'pr-comment',
      branch: 'takt/source-run',
      publicationMarkerPath: '/project/source.publication.json',
    });
    mockReadLoopAnalysisPublicationMarker.mockReturnValue('pending');
    const processError = Object.assign(new Error('process not found'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw processError;
    }) as typeof process.kill);

    await executeLoopAnalysisJob('/project/source.job.json');

    expect(mockReadLoopAnalysisPublicationMarker).toHaveBeenCalledTimes(1);
    expect(mockCommentLoopAnalysisReportOnPr).toHaveBeenCalledTimes(1);
  });

  it('Given publication marker reads conflict transiently, When the marker settles within the retry bound, Then the worker comments once', async () => {
    vi.useFakeTimers();
    mockReadLoopAnalysisJob.mockReturnValue({
      ...baseJob,
      output: 'pr-comment',
      branch: 'takt/source-run',
      publicationMarkerPath: '/project/source.publication.json',
    });
    mockReadLoopAnalysisPublicationMarker
      .mockImplementationOnce(() => {
        throw new PrivateArtifactPublicationConflictError('publication changed');
      })
      .mockImplementationOnce(() => {
        throw new PrivateArtifactPublicationConflictError('publication changed');
      })
      .mockReturnValueOnce('settled');

    const execution = executeLoopAnalysisJob('/project/source.job.json');
    await vi.advanceTimersByTimeAsync(20);
    await execution;

    expect(mockReadLoopAnalysisPublicationMarker).toHaveBeenCalledTimes(3);
    expect(mockCommentLoopAnalysisReportOnPr).toHaveBeenCalledTimes(1);
  });

  it('Given publication marker reads keep conflicting, When the retry bound is reached, Then the worker records the failure and stops', async () => {
    vi.useFakeTimers();
    mockReadLoopAnalysisJob.mockReturnValue({
      ...baseJob,
      output: 'pr-comment',
      branch: 'takt/source-run',
      publicationMarkerPath: '/project/source.publication.json',
    });
    mockReadLoopAnalysisPublicationMarker.mockImplementation(() => {
      throw new PrivateArtifactPublicationConflictError('publication changed');
    });

    const execution = runLoopAnalysisWorker('/project/source.job.json');
    const rejection = expect(execution).rejects.toThrow('publication changed');
    await vi.advanceTimersByTimeAsync(20);
    await rejection;

    expect(mockReadLoopAnalysisPublicationMarker).toHaveBeenCalledTimes(3);
    expect(mockAppendLoopAnalysisWorkerFailure).toHaveBeenCalledTimes(1);
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });

  it('Given publication remains pending while the parent stays alive, When the wait bound is reached, Then the worker records a timeout and stops', async () => {
    vi.useFakeTimers();
    mockReadLoopAnalysisJob.mockReturnValue({
      ...baseJob,
      output: 'pr-comment',
      branch: 'takt/source-run',
      publicationMarkerPath: '/project/source.publication.json',
    });
    mockReadLoopAnalysisPublicationMarker.mockReturnValue('pending');
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    const execution = runLoopAnalysisWorker('/project/source.job.json');
    const rejection = expect(execution).rejects.toThrow(
      'publication settlement timed out',
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await rejection;

    expect(mockAppendLoopAnalysisWorkerFailure).toHaveBeenCalledTimes(1);
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });

  it('Given analysis execution fails, When the worker terminates, Then the failure is persisted beside the private job', async () => {
    mockRunLoopAnalysisWorkflowExecution.mockResolvedValue({
      success: false,
      reason: 'review rejected',
    });

    await expect(runLoopAnalysisWorker('/project/source.job.json')).rejects.toThrow(
      'review rejected',
    );

    expect(mockAppendLoopAnalysisWorkerFailure).toHaveBeenCalledWith(
      '/project/source.job.json',
      expect.objectContaining({ message: expect.stringContaining('review rejected') }),
    );
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'file output', job: baseJob },
    {
      label: 'PR comment output without publication metadata',
      job: { ...baseJob, output: 'pr-comment' as const },
    },
    {
      label: 'PR comment output with publication metadata',
      job: {
        ...baseJob,
        output: 'pr-comment' as const,
        branch: 'takt/source-run',
        publicationMarkerPath: '/project/source.publication.json',
      },
    },
  ])('Given $label completes without a report directory, When the worker checks its required output, Then it persists the failure before PR operations', async ({ job }) => {
    mockReadLoopAnalysisJob.mockReturnValue(job);
    mockRunLoopAnalysisWorkflowExecution.mockResolvedValue({
      success: true,
      runDirectory: '/project/.takt/runs/analysis-run',
      ndjsonLogPath: '/project/.takt/runs/analysis-run/logs/session.ndjson',
    });

    await expect(runLoopAnalysisWorker('/project/source.job.json')).rejects.toThrow(
      'without a report directory',
    );

    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockAppendLoopAnalysisWorkerFailure).toHaveBeenCalledTimes(1);
    expect(mockReadLoopAnalysisPublicationMarker).not.toHaveBeenCalled();
    expect(mockInitGitProvider).not.toHaveBeenCalled();
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'file output', job: baseJob },
    {
      label: 'PR comment output without publication metadata',
      job: { ...baseJob, output: 'pr-comment' as const },
    },
    {
      label: 'PR comment output with publication metadata',
      job: {
        ...baseJob,
        output: 'pr-comment' as const,
        branch: 'takt/source-run',
        publicationMarkerPath: '/project/source.publication.json',
      },
    },
  ])('Given $label completes without the report file, When the worker checks its required output, Then it persists the failure before PR operations', async ({ job }) => {
    mockReadLoopAnalysisJob.mockReturnValue(job);
    mockLstatSync.mockReturnValue(undefined);

    await expect(runLoopAnalysisWorker('/project/source.job.json')).rejects.toThrow(
      'without a report',
    );

    expect(mockAppendLoopAnalysisWorkerFailure).toHaveBeenCalledTimes(1);
    expect(mockReadLoopAnalysisPublicationMarker).not.toHaveBeenCalled();
    expect(mockInitGitProvider).not.toHaveBeenCalled();
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'file output', job: baseJob },
    {
      label: 'PR comment output without publication metadata',
      job: { ...baseJob, output: 'pr-comment' as const },
    },
    {
      label: 'PR comment output with publication metadata',
      job: {
        ...baseJob,
        output: 'pr-comment' as const,
        branch: 'takt/source-run',
        publicationMarkerPath: '/project/source.publication.json',
      },
    },
  ])('Given $label leaves a directory at the report path, When the worker checks its required output, Then it persists the failure before PR operations', async ({ job }) => {
    mockReadLoopAnalysisJob.mockReturnValue(job);
    mockLstatSync.mockReturnValue({ isFile: () => false });

    await expect(runLoopAnalysisWorker('/project/source.job.json')).rejects.toThrow(
      'without a report',
    );

    expect(mockAppendLoopAnalysisWorkerFailure).toHaveBeenCalledTimes(1);
    expect(mockReadLoopAnalysisPublicationMarker).not.toHaveBeenCalled();
    expect(mockInitGitProvider).not.toHaveBeenCalled();
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });
});
