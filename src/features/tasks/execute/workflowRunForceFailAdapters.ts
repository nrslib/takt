import {
  readdirSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import type { RunMeta } from '../../../core/workflow/run/run-meta.js';
import { loadSessionLog, type SessionLog } from '../../../infra/fs/index.js';
import {
  openRunStorage,
} from '../../../infra/run-storage/index.js';
import {
  createWorkflowTerminalPayloadFactory,
  serializeWorkflowTerminalPublication,
} from './workflowTerminalPayload.js';
import {
  createFileWorkflowRunTerminalPublisher,
} from './fileWorkflowRunTerminalPublisher.js';
import {
  reconcileWorkflowTerminalPublication,
} from './workflowTerminalPublication.js';
import type {
  WorkflowRunForceFailContext,
  WorkflowRunForceFailHandle,
} from './workflowRunAdmin.js';
import {
  RunCleanupError,
  type RunFinalization,
} from './workflowRunExecution.js';

const FORCE_FAIL_LEASE_DURATION_MS = 30_000;

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

class SqliteTaskRunForceFailStorage implements WorkflowRunForceFailHandle {
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
    const root = openRunStorage({ databasePath: runPaths.databaseAbs });
    let primaryError: unknown;
    let commitReceipt: ReturnType<typeof root.forceFailRun> | undefined;
    try {
      commitReceipt = root.forceFailRun({
        expectedRunId: this.context.meta.runSlug,
        ownerKey: `task-force-fail:${this.context.taskName}`,
        leaseDurationMs: FORCE_FAIL_LEASE_DURATION_MS,
        reason,
        iteration: payload.iterations,
        publicationPayload: serializeWorkflowTerminalPublication(payload),
      });
    } catch (error) {
      primaryError = error;
    }
    const cleanupErrors: unknown[] = [];
    try {
      root.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (primaryError !== undefined) {
      if (cleanupErrors.length === 0) {
        throw primaryError;
      }
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        errorMessage(primaryError),
        { cause: primaryError },
      );
    }
    if (commitReceipt === undefined) {
      throw new Error('SQLite force-fail terminal commit receipt is missing');
    }
    const finalization = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: this.context.meta.runSlug,
    });
    return Object.freeze({
      receipt: Object.freeze({
        runId: commitReceipt.runId,
        publicationId: commitReceipt.eventId,
        runStatus: 'failed' as const,
        iteration: commitReceipt.iteration,
        payloadSha256: commitReceipt.payloadDigest,
        proof: {
          backend: 'sqlite' as const,
          terminalAt: commitReceipt.terminalAt,
        },
      }),
      issues: Object.freeze([
        ...cleanupErrors.map((error) => new RunCleanupError(error)),
        ...finalization.issues,
      ]),
    });
  }
}

export function createFileTaskRunForceFailStorage(
  context: TaskRunForceFailAdapterContext,
): WorkflowRunForceFailHandle {
  return new FileTaskRunForceFailStorage(context);
}

export function createSqliteTaskRunForceFailStorage(
  context: TaskRunForceFailAdapterContext,
): WorkflowRunForceFailHandle {
  return new SqliteTaskRunForceFailStorage(context);
}

function buildForceFailPublicationPayload(input: {
  readonly projectDir: string;
  readonly runPaths: ReturnType<typeof buildRunPaths>;
  readonly meta: RunMeta;
  readonly reason: string;
}) {
  const ndjsonLogPath = resolveRunNdjsonLog(input.runPaths.logsAbs);
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

function resolveRunNdjsonLog(logsDirectory: string): string {
  const files = readdirSync(logsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name);
  if (files.length !== 1) {
    throw new Error(
      `Run force-fail requires exactly one NDJSON session log in ${logsDirectory}`,
    );
  }
  return join(logsDirectory, files[0]!);
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
  if (
    sessionLog.task !== meta.task
    || sessionLog.workflowName !== meta.workflow
  ) {
    throw new Error(
      `Run force-fail session log identity does not match run "${meta.runSlug}"`,
    );
  }
  return {
    ...sessionLog,
    projectDir,
  };
}

function resolveForceFailIteration(meta: RunMeta, sessionLog: SessionLog): number {
  return meta.currentIteration === undefined
    ? sessionLog.iterations
    : meta.currentIteration;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
