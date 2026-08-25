import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';

const {
  mockAppendLoopAnalysisWorkerFailure,
  mockArchiveLoopAnalysisReport,
  mockCommentLoopAnalysisReportOnPr,
  mockExistsSync,
  mockInitGitProvider,
  mockLstatSync,
  mockReadLoopAnalysisJob,
  mockReadLoopAnalysisPublicationMarker,
  mockPrepareLoopAnalysisReportFileForPublication,
  mockRecordLoopAnalysisPullRequest,
  mockRunLoopAnalysisWorkflowExecution,
} = vi.hoisted(() => ({
  mockAppendLoopAnalysisWorkerFailure: vi.fn(),
  mockArchiveLoopAnalysisReport: vi.fn(),
  mockCommentLoopAnalysisReportOnPr: vi.fn(),
  mockExistsSync: vi.fn(),
  mockInitGitProvider: vi.fn(),
  mockLstatSync: vi.fn(),
  mockReadLoopAnalysisJob: vi.fn(),
  mockReadLoopAnalysisPublicationMarker: vi.fn(),
  mockPrepareLoopAnalysisReportFileForPublication: vi.fn(),
  mockRecordLoopAnalysisPullRequest: vi.fn(),
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

vi.mock('../features/tasks/execute/loopAnalysisArchive.js', () => ({
  archiveLoopAnalysisReport: (...args: unknown[]) => mockArchiveLoopAnalysisReport(...args),
  recordLoopAnalysisPullRequest: (...args: unknown[]) => mockRecordLoopAnalysisPullRequest(...args),
}));

vi.mock('../features/tasks/execute/loopAnalysisReportPublication.js', () => ({
  prepareLoopAnalysisReportFileForPublication: (...args: unknown[]) =>
    mockPrepareLoopAnalysisReportFileForPublication(...args),
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
import type { LoopAnalysisJob } from '../features/tasks/execute/loopAnalysisJob.js';
import type { CommentLoopAnalysisReportOptions } from '../features/tasks/execute/postExecution.js';

const baseJob = {
  version: 1 as const,
  projectCwd: '/project',
  sourceRunDirectory: '/project/.takt/runs/source-run',
  output: 'file' as const,
  parentPid: 1234,
};

describe('loop analysis worker', () => {
  const temporaryDirectories: string[] = [];
  const workerEvents: string[] = [];

  async function configureActualReportArtifacts(
    rootDirectory: string,
    sourceRunSlug: string,
    fullReport: string,
    job: LoopAnalysisJob,
  ): Promise<{
    jobPath: string;
    reportPath: string;
    archivedReportPath: string;
    sourceMetadataPath: string;
    failureLogPath: string;
  }> {
    const sourceRunDirectory = join(rootDirectory, '.takt', 'runs', sourceRunSlug);
    const reportDirectory = join(
      rootDirectory,
      '.takt',
      'runs',
      'analysis-run',
      'reports',
    );
    const reportPath = join(reportDirectory, 'loop-analysis.md');
    const jobPath = join(rootDirectory, 'source.job.json');
    mkdirSync(sourceRunDirectory, { recursive: true });
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(reportPath, fullReport, { mode: 0o600 });

    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const actualArchive = await vi.importActual<typeof import('../features/tasks/execute/loopAnalysisArchive.js')>(
      '../features/tasks/execute/loopAnalysisArchive.js',
    );
    const actualJob = await vi.importActual<typeof import('../features/tasks/execute/loopAnalysisJob.js')>(
      '../features/tasks/execute/loopAnalysisJob.js',
    );
    const actualPublication = await vi.importActual<typeof import('../features/tasks/execute/loopAnalysisReportPublication.js')>(
      '../features/tasks/execute/loopAnalysisReportPublication.js',
    );

    mockExistsSync.mockImplementation((filePath: string) => actualFs.existsSync(filePath));
    mockLstatSync.mockImplementation((filePath: string) => actualFs.lstatSync(filePath));
    mockArchiveLoopAnalysisReport.mockImplementation((
      options: Parameters<typeof actualArchive.archiveLoopAnalysisReport>[0],
    ) => {
      workerEvents.push('archive');
      return actualArchive.archiveLoopAnalysisReport(options);
    });
    mockPrepareLoopAnalysisReportFileForPublication.mockImplementation((
      path: string,
      sourceRunSlug: string,
    ) => {
      workerEvents.push('marker-append');
      return actualPublication.prepareLoopAnalysisReportFileForPublication(path, sourceRunSlug);
    });
    mockAppendLoopAnalysisWorkerFailure.mockImplementation((
      failedJobPath: string,
      error: unknown,
    ) => {
      workerEvents.push('failure');
      return actualJob.appendLoopAnalysisWorkerFailure(failedJobPath, error);
    });
    mockReadLoopAnalysisJob.mockReturnValue({
      ...job,
      projectCwd: rootDirectory,
      sourceRunDirectory,
    });
    mockRunLoopAnalysisWorkflowExecution.mockResolvedValue({
      success: true,
      runDirectory: join(rootDirectory, '.takt', 'runs', 'analysis-run'),
      reportDirectory,
      ndjsonLogPath: join(rootDirectory, '.takt', 'runs', 'analysis-run', 'logs', 'session.ndjson'),
    });

    const archiveDirectory = join(getGlobalConfigDir(), 'loop-analysis', sourceRunSlug);
    return {
      jobPath,
      reportPath,
      archivedReportPath: join(archiveDirectory, 'loop-analysis.md'),
      sourceMetadataPath: join(archiveDirectory, 'source.json'),
      failureLogPath: join(rootDirectory, 'worker-errors.jsonl'),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    workerEvents.length = 0;
    mockExistsSync.mockReturnValue(true);
    mockLstatSync.mockReturnValue({ isFile: () => true });
    mockReadLoopAnalysisJob.mockReturnValue(baseJob);
    mockArchiveLoopAnalysisReport.mockReturnValue({
      sourceMetadataPath: '/global/.takt/loop-analysis/source-run/source.json',
      metadata: {
        version: 1,
        sourceRunDirectory: baseJob.sourceRunDirectory,
        projectCwd: baseJob.projectCwd,
        analysisReportPath: '/project/.takt/runs/analysis-run/reports/loop-analysis.md',
        archivedAt: '2026-08-25T00:00:00.000Z',
      },
    });
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
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
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
    expect(mockArchiveLoopAnalysisReport).toHaveBeenCalledWith({
      sourceRunDirectory: '/project/.takt/runs/source-run',
      projectCwd: '/project',
      analysisReportPath: '/project/.takt/runs/analysis-run/reports/loop-analysis.md',
    });
    expect(mockPrepareLoopAnalysisReportFileForPublication).toHaveBeenCalledWith(
      '/project/.takt/runs/analysis-run/reports/loop-analysis.md',
      'source-run',
    );
    expect(mockInitGitProvider).not.toHaveBeenCalled();
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });

  it('Given a raw report, When the worker archives and publishes it, Then the archive keeps the full report and the run report is sanitized', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-worker-content-'));
    temporaryDirectories.push(rootDirectory);
    const fullReport = [
      '# Loop analysis',
      'api_key=loop-analysis-secret',
      'Evidence: /Users/jane/private/report.md',
      'Relative: reports/subworkflows/**/plan.md',
    ].join('\n') + '\n';
    const context = await configureActualReportArtifacts(
      rootDirectory,
      'source-run',
      fullReport,
      baseJob,
    );

    await executeLoopAnalysisJob(context.jobPath);

    expect(readFileSync(context.archivedReportPath, 'utf8')).toBe(fullReport);
    const publishedReport = readFileSync(context.reportPath, 'utf8');
    expect(publishedReport).not.toContain('/Users/jane/private/report.md');
    expect(publishedReport).toContain('[path]');
    expect(publishedReport).toContain('reports/subworkflows/**/plan.md');
    expect(publishedReport).toContain('[REDACTED]');
    expect(publishedReport).toContain('source run: source-run');
    expect(publishedReport.match(/^source run: source-run$/gm)).toEqual([
      'source run: source-run',
    ]);
  });

  it('Given a valid PR comment job finds no PR, When the report is saved, Then the private artifacts remain without PR metadata', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-worker-no-pr-'));
    temporaryDirectories.push(rootDirectory);
    const fullReport = 'Evidence: /Users/jane/no-pr.md\nRelative: reports/subworkflows/**/plan.md\n';
    const context = await configureActualReportArtifacts(
      rootDirectory,
      'no-pr-run',
      fullReport,
      {
        ...baseJob,
        output: 'pr-comment',
        branch: 'takt/no-pr-run',
        publicationMarkerPath: join(rootDirectory, 'source.publication.json'),
      },
    );
    mockReadLoopAnalysisPublicationMarker.mockReturnValue('settled');
    mockCommentLoopAnalysisReportOnPr.mockResolvedValue(undefined);

    await executeLoopAnalysisJob(context.jobPath);

    expect(readFileSync(context.archivedReportPath, 'utf8')).toBe(fullReport);
    const publishedReport = readFileSync(context.reportPath, 'utf8');
    expect(publishedReport).toContain('[path]');
    expect(publishedReport).toContain('reports/subworkflows/**/plan.md');
    expect(publishedReport.match(/^source run: no-pr-run$/gm)).toEqual([
      'source run: no-pr-run',
    ]);
    expect(JSON.parse(readFileSync(context.sourceMetadataPath, 'utf8'))).not.toHaveProperty(
      'pullRequest',
    );
    expect(mockCommentLoopAnalysisReportOnPr).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopAnalysisPullRequest).not.toHaveBeenCalled();
  });

  it('Given PR publication is already settled, When the report is saved, Then publication is attempted once with the exact report path', async () => {
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
      sourceRunSlug: 'source-run',
    });
  });

  it('Given the PR comment succeeds, When the worker completes, Then it preserves raw content and records the PR after publication', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-worker-pr-'));
    temporaryDirectories.push(rootDirectory);
    const fullReport = [
      '# Loop analysis',
      'Evidence: /Users/jane/pr.md',
      'Relative: reports/subworkflows/**/plan.md',
    ].join('\n') + '\n';
    const context = await configureActualReportArtifacts(
      rootDirectory,
      'pr-run',
      fullReport,
      {
        ...baseJob,
        output: 'pr-comment',
        branch: 'takt/pr-run',
        publicationMarkerPath: join(rootDirectory, 'source.publication.json'),
      },
    );
    const actualArchive = await vi.importActual<typeof import('../features/tasks/execute/loopAnalysisArchive.js')>(
      '../features/tasks/execute/loopAnalysisArchive.js',
    );
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const postedReports: Array<{ reportPath: string; content: string }> = [];
    mockReadLoopAnalysisPublicationMarker.mockImplementation(() => {
      workerEvents.push('marker');
      return 'settled';
    });
    mockCommentLoopAnalysisReportOnPr.mockImplementation(async (
      options: CommentLoopAnalysisReportOptions,
    ) => {
      workerEvents.push('comment');
      postedReports.push({
        reportPath: options.reportPath,
        content: actualFs.readFileSync(options.reportPath, 'utf8'),
      });
      return {
        number: 41,
        url: 'https://github.com/org/repo/pull/41',
      };
    });
    mockRecordLoopAnalysisPullRequest.mockImplementation((
      archive: Parameters<typeof actualArchive.recordLoopAnalysisPullRequest>[0],
      pullRequest: Parameters<typeof actualArchive.recordLoopAnalysisPullRequest>[1],
    ) => {
      workerEvents.push('record');
      return actualArchive.recordLoopAnalysisPullRequest(archive, pullRequest);
    });

    await executeLoopAnalysisJob(context.jobPath);

    expect(workerEvents).toEqual([
      'archive',
      'marker-append',
      'marker',
      'comment',
      'record',
    ]);
    expect(readFileSync(context.archivedReportPath, 'utf8')).toBe(fullReport);
    const publishedReport = readFileSync(context.reportPath, 'utf8');
    expect(postedReports).toEqual([
      { reportPath: context.reportPath, content: publishedReport },
    ]);
    expect(publishedReport).not.toContain('/Users/jane/pr.md');
    expect(publishedReport).toContain('reports/subworkflows/**/plan.md');
    expect(publishedReport.match(/^source run: pr-run$/gm)).toEqual([
      'source run: pr-run',
    ]);
    expect(JSON.parse(readFileSync(context.sourceMetadataPath, 'utf8'))).toMatchObject({
      pullRequest: {
        number: 41,
        url: 'https://github.com/org/repo/pull/41',
      },
    });
  });

  it('Given PR comment posting fails, When the worker terminates, Then the archive, sanitized report, and failure log remain', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-worker-post-failure-'));
    temporaryDirectories.push(rootDirectory);
    const fullReport = 'Evidence: /Users/jane/post-failure.md\n';
    const context = await configureActualReportArtifacts(
      rootDirectory,
      'post-failure-run',
      fullReport,
      {
        ...baseJob,
        output: 'pr-comment',
        branch: 'takt/post-failure-run',
        publicationMarkerPath: join(rootDirectory, 'source.publication.json'),
      },
    );
    mockReadLoopAnalysisPublicationMarker.mockImplementation(() => {
      workerEvents.push('marker');
      return 'settled';
    });
    mockCommentLoopAnalysisReportOnPr.mockImplementation(async () => {
      workerEvents.push('comment');
      throw new Error('comment rejected');
    });

    await expect(runLoopAnalysisWorker(context.jobPath)).rejects.toThrow('comment rejected');

    expect(workerEvents).toEqual([
      'archive',
      'marker-append',
      'marker',
      'comment',
      'failure',
    ]);
    expect(readFileSync(context.archivedReportPath, 'utf8')).toBe(fullReport);
    expect(readFileSync(context.reportPath, 'utf8')).toContain('[path]');
    expect(readFileSync(context.reportPath, 'utf8')).toContain('source run: post-failure-run');
    expect(JSON.parse(readFileSync(context.sourceMetadataPath, 'utf8'))).not.toHaveProperty(
      'pullRequest',
    );
    expect(readFileSync(context.failureLogPath, 'utf8')).toContain('comment rejected');
    expect(mockRecordLoopAnalysisPullRequest).not.toHaveBeenCalled();
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

  it('Given publication marker reads keep conflicting, When the retry bound is reached, Then saved artifacts and the failure log remain', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-worker-conflict-'));
    temporaryDirectories.push(rootDirectory);
    const fullReport = 'Evidence: /Users/jane/conflict.md\n';
    const context = await configureActualReportArtifacts(
      rootDirectory,
      'conflict-run',
      fullReport,
      {
        ...baseJob,
        output: 'pr-comment',
        branch: 'takt/conflict-run',
        publicationMarkerPath: join(rootDirectory, 'source.publication.json'),
      },
    );
    vi.useFakeTimers();
    mockReadLoopAnalysisPublicationMarker.mockImplementation(() => {
      workerEvents.push('marker');
      throw new PrivateArtifactPublicationConflictError('publication changed');
    });

    const execution = runLoopAnalysisWorker(context.jobPath);
    const rejection = expect(execution).rejects.toThrow('publication changed');
    await vi.advanceTimersByTimeAsync(20);
    await rejection;

    expect(mockReadLoopAnalysisPublicationMarker).toHaveBeenCalledTimes(3);
    expect(mockAppendLoopAnalysisWorkerFailure).toHaveBeenCalledTimes(1);
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
    expect(workerEvents).toEqual([
      'archive',
      'marker-append',
      'marker',
      'marker',
      'marker',
      'failure',
    ]);
    expect(readFileSync(context.archivedReportPath, 'utf8')).toBe(fullReport);
    expect(readFileSync(context.reportPath, 'utf8')).toContain('[path]');
    expect(readFileSync(context.reportPath, 'utf8')).toContain('source run: conflict-run');
    expect(JSON.parse(readFileSync(context.sourceMetadataPath, 'utf8'))).not.toHaveProperty(
      'pullRequest',
    );
    expect(readFileSync(context.failureLogPath, 'utf8')).toContain('publication changed');
  });

  it('Given a publication marker is invalid, When it is read, Then the worker fails without retrying it as a publication conflict', async () => {
    mockReadLoopAnalysisJob.mockReturnValue({
      ...baseJob,
      output: 'pr-comment',
      branch: 'takt/source-run',
      publicationMarkerPath: '/project/source.publication.json',
    });
    mockReadLoopAnalysisPublicationMarker.mockImplementation(() => {
      throw new Error('Invalid loop analysis publication marker state');
    });

    await expect(runLoopAnalysisWorker('/project/source.job.json')).rejects.toThrow(
      'Invalid loop analysis publication marker state',
    );

    expect(mockReadLoopAnalysisPublicationMarker).toHaveBeenCalledTimes(1);
    expect(mockAppendLoopAnalysisWorkerFailure).toHaveBeenCalledTimes(1);
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
  });

  it('Given publication remains pending while the parent stays alive, When the wait bound is reached, Then saved artifacts and the timeout failure remain', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-worker-timeout-'));
    temporaryDirectories.push(rootDirectory);
    const fullReport = 'Evidence: /Users/jane/timeout.md\n';
    const context = await configureActualReportArtifacts(
      rootDirectory,
      'timeout-run',
      fullReport,
      {
        ...baseJob,
        output: 'pr-comment',
        branch: 'takt/timeout-run',
        publicationMarkerPath: join(rootDirectory, 'source.publication.json'),
      },
    );
    vi.useFakeTimers();
    mockReadLoopAnalysisPublicationMarker.mockReturnValue('pending');
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    const execution = runLoopAnalysisWorker(context.jobPath);
    const rejection = expect(execution).rejects.toThrow(
      'publication settlement timed out',
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await rejection;

    expect(mockAppendLoopAnalysisWorkerFailure).toHaveBeenCalledTimes(1);
    expect(mockCommentLoopAnalysisReportOnPr).not.toHaveBeenCalled();
    expect(workerEvents).toEqual(['archive', 'marker-append', 'failure']);
    expect(readFileSync(context.archivedReportPath, 'utf8')).toBe(fullReport);
    expect(readFileSync(context.reportPath, 'utf8')).toContain('[path]');
    expect(readFileSync(context.reportPath, 'utf8')).toContain('source run: timeout-run');
    expect(JSON.parse(readFileSync(context.sourceMetadataPath, 'utf8'))).not.toHaveProperty(
      'pullRequest',
    );
    expect(readFileSync(context.failureLogPath, 'utf8')).toContain(
      'Loop analysis publication settlement timed out',
    );
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
