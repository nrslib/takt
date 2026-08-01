import {
  existsSync,
  readdirSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
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

interface TaskRunForceFailAdapterContext
  extends WorkflowRunForceFailContext {
  readonly projectDir: string;
  readonly cwd: string;
}

class FileTaskRunForceFailStorage implements WorkflowRunForceFailHandle {
  readonly currentStep: string | undefined;

  constructor(
    private readonly context: TaskRunForceFailAdapterContext,
  ) {
    this.currentStep = context.meta.status === 'running'
      ? context.meta.currentStep
      : undefined;
  }

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
    return result;
  }
}

export function createFileTaskRunForceFailStorage(
  context: TaskRunForceFailAdapterContext,
): WorkflowRunForceFailHandle {
  return new FileTaskRunForceFailStorage(context);
}

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
    metaSeed: {
      backend: input.meta.storageBackend,
      startedAt: input.meta.startTime,
      resumeSource: input.meta.resumeMode === undefined
        ? null
        : {
            mode: input.meta.resumeMode,
            sourceRunSlug: input.meta.sourceRunSlug ?? null,
          },
    },
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

function resolveRunNdjsonLog(
  logsDirectory: string,
  meta: RunMeta,
): string {
  if (!existsSync(logsDirectory)) {
    return createForceFailSessionLog(logsDirectory, meta);
  }
  const files = readdirSync(logsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(logsDirectory, entry.name));
  if (files.length === 0) {
    return createForceFailSessionLog(logsDirectory, meta);
  }
  const matching = files.filter((path) => {
    const sessionLog = loadSessionLog(path);
    return sessionLog !== null && sessionLogMatchesRun(sessionLog, meta);
  });
  if (matching.length !== 1) {
    throw new Error(
      `Run force-fail requires exactly one identity-matching NDJSON session log in ${logsDirectory}`,
    );
  }
  return matching[0]!;
}

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
  const sessionLog = loadSessionLog(path);
  if (sessionLog === null) {
    throw new Error(`Run force-fail session log is missing or invalid: ${path}`);
  }
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
