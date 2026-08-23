import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeProviderFile } from '../../../infra/config/runtime-provider/loader.js';
import {
  getGlobalConfigDir,
  getProjectConfigDir,
} from '../../../infra/config/paths.js';
import { createLogger } from '../../../shared/utils/index.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import {
  claimLoopAnalysisDispatch,
  createLoopAnalysisJobPaths,
  writeLoopAnalysisJob,
  type LoopAnalysisJob,
} from './loopAnalysisJob.js';
import type { LoopAnalysisPublicationCoordinator } from './loopAnalysisPublication.js';
import type { LoopAnalysisScheduler } from './types.js';

export const LOOP_ANALYSIS_WORKFLOW = 'loop-analysis';
export const LOOP_ANALYSIS_REPORT_FILE = 'loop-analysis.md';

const log = createLogger('loopAnalysis');
const require = createRequire(import.meta.url);

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
    if (!claimLoopAnalysisDispatch(sourceRunDirectory)) {
      return;
    }
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
  const launch = resolveWorkerLaunch(jobPath);
  const worker = spawn(process.execPath, launch.arguments, {
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
  worker.once('exit', (code, signal) => {
    if (code === 0) {
      return;
    }
    log.error('Loop analysis worker exited unsuccessfully', {
      sourceRunDirectory,
      code,
      signal,
    });
  });
  worker.unref();
}

function resolveWorkerLaunch(jobPath: string): { readonly arguments: string[] } {
  const modulePath = fileURLToPath(import.meta.url);
  const sourceExecution = modulePath.endsWith('.ts');
  const workerPath = fileURLToPath(new URL(
    sourceExecution ? './loopAnalysisWorker.ts' : './loopAnalysisWorker.js',
    import.meta.url,
  ));
  return {
    arguments: sourceExecution
      ? ['--import', require.resolve('tsx/esm'), workerPath, jobPath]
      : [workerPath, jobPath],
  };
}

export function scheduleLoopAnalysis(
  scheduler: LoopAnalysisScheduler | undefined,
  runDirectory: string,
): void {
  if (scheduler === undefined) {
    return;
  }
  try {
    scheduler(runDirectory);
  } catch (error) {
    log.error('Loop analysis scheduling failed', {
      runDirectory,
      error: getErrorMessage(error),
    });
  }
}
