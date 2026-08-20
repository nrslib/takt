import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { initGitProvider } from '../../../infra/git/index.js';
import { isDirectEntrypoint } from '../../../shared/utils/entrypoint.js';
import { commentLoopAnalysisReportOnPr } from './postExecution.js';
import {
  appendLoopAnalysisWorkerFailure,
  readLoopAnalysisJob,
  readLoopAnalysisPublicationMarker,
  type LoopAnalysisJob,
} from './loopAnalysisJob.js';
import {
  LOOP_ANALYSIS_REPORT_FILE,
  LOOP_ANALYSIS_WORKFLOW,
} from './loopAnalysis.js';
import { runLoopAnalysisWorkflowExecution } from './workflowExecutionApi.js';

const PUBLICATION_MARKER_POLL_INTERVAL_MS = 100;

export async function executeLoopAnalysisJob(jobPath: string): Promise<void> {
  const job = readLoopAnalysisJob(jobPath);
  const result = await runLoopAnalysisWorkflowExecution({
    task: [
      'Analyze the completed run in this absolute directory:',
      job.sourceRunDirectory,
      'Use its available session JSONL logs, trace, monitor data, and reports as evidence.',
    ].join('\n'),
    cwd: job.projectCwd,
    projectCwd: job.projectCwd,
    workflowIdentifier: LOOP_ANALYSIS_WORKFLOW,
    outputMode: 'silent',
  });

  if (!result.success) {
    throw new Error(
      result.reason === undefined
        ? 'Loop analysis workflow did not complete successfully'
        : `Loop analysis workflow did not complete successfully: ${result.reason}`,
    );
  }
  if (result.reportDirectory === undefined || !existsSync(result.reportDirectory)) {
    throw new Error('Loop analysis completed without a report directory');
  }
  const reportPath = join(result.reportDirectory, LOOP_ANALYSIS_REPORT_FILE);
  if (!lstatSync(reportPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Loop analysis completed without a report');
  }
  if (job.branch === undefined || job.publicationMarkerPath === undefined) {
    return;
  }

  await waitForPublicationSettlement(job);
  initGitProvider(job.projectCwd);
  await commentLoopAnalysisReportOnPr({
    projectCwd: job.projectCwd,
    branch: job.branch,
    reportPath,
  });
}

export async function runLoopAnalysisWorker(jobPath: string): Promise<void> {
  try {
    await executeLoopAnalysisJob(jobPath);
  } catch (error) {
    appendLoopAnalysisWorkerFailure(jobPath, error);
    throw error;
  }
}

async function waitForPublicationSettlement(job: LoopAnalysisJob): Promise<void> {
  const markerPath = job.publicationMarkerPath;
  if (markerPath === undefined) {
    return;
  }
  while (readLoopAnalysisPublicationMarker(markerPath) !== 'settled') {
    if (!isProcessRunning(job.parentPid)) {
      return;
    }
    await wait(PUBLICATION_MARKER_POLL_INTERVAL_MS);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EPERM') {
      return true;
    }
    if (isNodeError(error) && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

async function main(): Promise<void> {
  const jobPath = process.argv[2];
  if (jobPath === undefined) {
    process.exitCode = 1;
    return;
  }
  try {
    await runLoopAnalysisWorker(jobPath);
  } catch {
    process.exitCode = 1;
  }
}

if (isDirectEntrypoint(import.meta.url)) {
  await main();
}
