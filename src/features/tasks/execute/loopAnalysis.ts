import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeProviderFile } from '../../../infra/config/runtime-provider/loader.js';
import {
  getGlobalConfigDir,
  getProjectConfigDir,
} from '../../../infra/config/paths.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import {
  createLoopAnalysisJobPaths,
  writeLoopAnalysisJob,
  type LoopAnalysisJob,
} from './loopAnalysisJob.js';
import type { LoopAnalysisPublicationCoordinator } from './loopAnalysisPublication.js';
import type { LoopAnalysisScheduler } from './types.js';

export const LOOP_ANALYSIS_WORKFLOW = 'loop-analysis';
export const LOOP_ANALYSIS_REPORT_FILE = 'loop-analysis.md';

const LOOP_ANALYSIS_WORKER_PATH = fileURLToPath(
  new URL('./loopAnalysisWorker.js', import.meta.url),
);
const log = createLogger('loopAnalysis');

export interface CreateLoopAnalysisSchedulerOptions {
  projectCwd: string;
  publication?: LoopAnalysisPublicationCoordinator;
}

export function createLoopAnalysisScheduler(
  options: CreateLoopAnalysisSchedulerOptions,
): LoopAnalysisScheduler | undefined {
  const runtimeFile = resolveRuntimeProviderFile({
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(options.projectCwd),
  });
  const loopAnalysis = runtimeFile?.loop_analysis;
  if (loopAnalysis?.enabled !== true) {
    return undefined;
  }

  return (sourceRunDirectory): void => {
    const paths = createLoopAnalysisJobPaths(sourceRunDirectory);
    const publication = loopAnalysis.output === 'pr-comment'
      ? registerPublication(options.publication, paths.publicationMarkerPath)
      : undefined;
    const job: LoopAnalysisJob = {
      version: 1,
      projectCwd: options.projectCwd,
      sourceRunDirectory,
      output: loopAnalysis.output,
      parentPid: process.pid,
      ...(publication === undefined ? {} : publication),
    };
    writeLoopAnalysisJob(paths.jobPath, job);
    startLoopAnalysisWorker(options.projectCwd, paths.jobPath, sourceRunDirectory);
  };
}

function registerPublication(
  coordinator: LoopAnalysisPublicationCoordinator | undefined,
  publicationMarkerPath: string,
): Pick<LoopAnalysisJob, 'branch' | 'publicationMarkerPath'> | undefined {
  if (coordinator === undefined) {
    return undefined;
  }
  coordinator.register(publicationMarkerPath);
  return {
    branch: coordinator.branch,
    publicationMarkerPath,
  };
}

function startLoopAnalysisWorker(
  projectCwd: string,
  jobPath: string,
  sourceRunDirectory: string,
): void {
  const worker = spawn(process.execPath, [LOOP_ANALYSIS_WORKER_PATH, jobPath], {
    cwd: projectCwd,
    detached: true,
    stdio: 'ignore',
  });
  worker.once('error', (error) => {
    log.error('Loop analysis worker failed to start', {
      sourceRunDirectory,
      error: getErrorMessage(error),
    });
  });
  worker.unref();
}
