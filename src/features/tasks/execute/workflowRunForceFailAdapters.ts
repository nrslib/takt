import {
  existsSync,
  readdirSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { SESSION_LOG_SIDECAR_SUFFIXES } from '../../../core/logging/contracts.js';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import type { RunMeta } from '../../../core/workflow/run/run-meta.js';
import {
  initNdjsonLog,
  loadSessionLog,
  type SessionLog,
} from '../../../infra/fs/index.js';
import {
  createWorkflowTerminalPayloadFactory,
} from './workflowTerminalPayload.js';
import {
  createFileWorkflowRunTerminalPublisher,
} from './fileWorkflowRunTerminalPublisher.js';
import type {
  WorkflowRunForceFailContext,
  WorkflowRunForceFailHandle,
} from './workflowRunAdmin.js';
import type { RunFinalization } from './workflowRunExecution.js';
import type { LoopAnalysisScheduler } from './types.js';
import {
  settleLoopAnalysisPublication,
  type LoopAnalysisPublicationCoordinator,
} from './loopAnalysisPublication.js';
import { scheduleLoopAnalysis } from './loopAnalysis.js';

interface TaskRunForceFailAdapterContext
  extends WorkflowRunForceFailContext {
  readonly projectDir: string;
  readonly cwd: string;
  readonly loopAnalysisScheduler?: LoopAnalysisScheduler;
  readonly loopAnalysisPublication?: LoopAnalysisPublicationCoordinator;
}

class FileTaskRunForceFailStorage implements WorkflowRunForceFailHandle {
  readonly currentStep: string | undefined;

  /**
   * Initialize a file-backed force-fail storage adapter for a task run.
   *
   * @param context - Task-run context used to expose the current step and publish terminal state
   */
  constructor(
    private readonly context: TaskRunForceFailAdapterContext,
  ) {
    this.currentStep = context.meta.status === 'running'
      ? context.meta.currentStep
      : undefined;
  }

  /**
   * Publish a failed terminal state and schedule its follow-up analysis when a scheduler is configured.
   *
   * @param reason - Non-empty reason for force-failing the run
   * @returns The finalization result returned by the terminal publisher
   * @throws Error if reason is empty, the session log cannot be resolved or is invalid, or terminal publication fails
   */
  async terminalize(reason: string): Promise<RunFinalization> {
    const runPaths = buildRunPaths(this.context.cwd, this.context.meta.runSlug);
    const payload = buildForceFailPublicationPayload({
      projectDir: this.context.projectDir,
      runPaths,
      meta: this.context.meta,
      reason,
    });
    const publisher = createFileWorkflowRunTerminalPublisher({
      runPaths,
    });
    const result = await publisher.finish({
      status: 'failed',
      iteration: payload.iterations,
      reason,
    }, payload);
    scheduleLoopAnalysis(
      this.context.loopAnalysisScheduler,
      runPaths.runRootAbs,
    );
    settleLoopAnalysisPublication(this.context.loopAnalysisPublication);
    return result;
  }
}

/**
 * Create a file-backed storage handle for force-failing a task run.
 *
 * @param context - Task-run context used to resolve and publish terminal state
 * @returns A force-fail handle backed by the run's filesystem artifacts
 */
export function createFileTaskRunForceFailStorage(
  context: TaskRunForceFailAdapterContext,
): WorkflowRunForceFailHandle {
  return new FileTaskRunForceFailStorage(context);
}

/**
 * Build the terminal publication payload for a force-failed run.
 *
 * @param input - Run context and a non-empty force-fail reason
 * @returns Terminal publication payload derived from the matching session log
 * @throws Error if the session log cannot be resolved, is invalid, or does not match the run, if the reason is missing or empty, or if terminal payload construction or validation fails
 */
function buildForceFailPublicationPayload(input: {
  readonly projectDir: string;
  readonly runPaths: ReturnType<typeof buildRunPaths>;
  readonly meta: RunMeta;
  readonly reason: string;
}) {
  const ndjsonLogPath = resolveRunNdjsonLog(
    input.runPaths.logsAbs,
    input.meta,
  );
  const sessionLog = requireSessionLog(
    ndjsonLogPath,
    input.meta,
    input.projectDir,
  );
  const lastStep = sessionLog.history.at(-1);
  return createWorkflowTerminalPayloadFactory({
    runSlug: input.runPaths.slug,
    projectCwd: input.projectDir,
    task: input.meta.task,
    workflowName: input.meta.workflow,
    sessionLog,
    sessionId: basename(
      ndjsonLogPath,
      extname(ndjsonLogPath),
    ),
    ndjsonLogPath,
    traceReportMode: 'redacted',
    ...(input.meta.observability?.traceDiscovery === undefined
      ? {}
      : { traceDiscovery: input.meta.observability.traceDiscovery }),
  }).create({
    status: 'failed',
    iterations: resolveForceFailIteration(input.meta, sessionLog),
    reason: input.reason,
    lastStepContent: lastStep?.content,
    lastStepName: input.meta.currentStep,
    endTime: new Date().toISOString(),
  });
}

/**
 * Resolve the NDJSON session log to use for force-failing a run.
 *
 * @param logsDirectory - Run logs directory
 * @param meta - Run metadata used to identify the session log
 * @returns Path to the matching session log, creating one when no primary log exists
 * @throws Error if existing primary logs are invalid or do not resolve to exactly one matching log
 */
function resolveRunNdjsonLog(
  logsDirectory: string,
  meta: RunMeta,
): string {
  if (!existsSync(logsDirectory)) {
    return createForceFailSessionLog(logsDirectory, meta);
  }
  const files = readdirSync(logsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSessionLogFileName(entry.name))
    .map((entry) => join(logsDirectory, entry.name));
  if (files.length === 0) {
    return createForceFailSessionLog(logsDirectory, meta);
  }
  const matching = files.filter((path) => sessionLogMatchesRun(
    loadRequiredSessionLog(path),
    meta,
  ));
  if (matching.length !== 1) {
    throw new Error(
      `Run force-fail requires exactly one identity-matching NDJSON session log in ${logsDirectory}`,
    );
  }
  return matching[0]!;
}

/**
 * Determine whether a filename is a primary NDJSON session log rather than a sidecar artifact.
 *
 * @param name - Filename to inspect
 * @returns true if the filename ends in .jsonl and does not use a known session-log sidecar suffix; otherwise false
 */
function isSessionLogFileName(name: string): boolean {
  return name.endsWith('.jsonl')
    && SESSION_LOG_SIDECAR_SUFFIXES.every((suffix) => !name.endsWith(suffix));
}

/**
 * Initialize a session log for a run that has no primary log yet.
 *
 * @param logsDirectory - Run logs directory
 * @param meta - Run metadata used to initialize the session identity
 * @returns Path to the initialized session log
 * @throws Error if creating the log directory or writing the initial workflow-start record fails
 */
function createForceFailSessionLog(
  logsDirectory: string,
  meta: RunMeta,
): string {
  return initNdjsonLog(
    `force-fail-${meta.runSlug}`,
    meta.task,
    meta.workflow,
    {
      logsDir: logsDirectory,
      startTime: meta.startTime,
    },
  );
}

function requireSessionLog(
  path: string,
  meta: RunMeta,
  projectDir: string,
): SessionLog {
  const sessionLog = loadRequiredSessionLog(path);
  if (!sessionLogMatchesRun(sessionLog, meta)) {
    throw new Error(
      `Run force-fail session log identity does not match run "${meta.runSlug}"`,
    );
  }
  return {
    ...sessionLog,
    projectDir,
  };
}

function loadRequiredSessionLog(path: string): SessionLog {
  const sessionLog = loadSessionLog(path);
  if (sessionLog === null) {
    throw new Error(`Run force-fail session log is missing or invalid: ${path}`);
  }
  return sessionLog;
}

function sessionLogMatchesRun(
  sessionLog: SessionLog,
  meta: RunMeta,
): boolean {
  return sessionLog.task === meta.task
    && sessionLog.workflowName === meta.workflow
    && sessionLog.startTime === meta.startTime;
}

function resolveForceFailIteration(meta: RunMeta, sessionLog: SessionLog): number {
  return meta.currentIteration === undefined
    ? sessionLog.iterations
    : meta.currentIteration;
}
