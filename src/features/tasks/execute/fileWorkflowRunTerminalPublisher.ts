import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import { writeFileAtomic } from '../../../infra/config/index.js';
import { appendNdjsonLine } from '../../../infra/fs/index.js';
import {
  finalizeFileRunMeta,
} from './runMeta.js';
import type {
  RunCommitFinalization,
  WorkflowRunTerminalOutcome,
} from './workflowRunExecution.js';
import type {
  WorkflowTerminalPublicationPayload,
} from './workflowTerminalPayload.js';
import {
  assertTraceParams,
  renderTraceReportFromLogs,
} from './traceReport.js';
import {
  persistWorkflowSessionState,
} from './workflowExecutionReporting.js';

export interface FileWorkflowRunTerminalPublisher {
  finish(
    outcome: WorkflowRunTerminalOutcome,
    payload: WorkflowTerminalPublicationPayload,
  ): Promise<RunCommitFinalization>;
}

export function createFileWorkflowRunTerminalPublisher(input: {
  readonly runPaths: RunPaths;
}): FileWorkflowRunTerminalPublisher {
  return Object.freeze({
    async finish(
      outcome: WorkflowRunTerminalOutcome,
      payload: WorkflowTerminalPublicationPayload,
    ): Promise<RunCommitFinalization> {
      assertTerminalIdentity(input.runPaths, outcome, payload);
      const payloadSha256 = sha256(JSON.stringify(payload));
      const publicationId =
        `file-terminal:${input.runPaths.slug}:${payloadSha256}`;
      finalizeFileRunMeta({
        runPaths: input.runPaths,
        status: payload.status,
        iterations: payload.iterations,
        ...(payload.reason === undefined
          ? {}
          : { reason: payload.reason }),
        ...(payload.failure === undefined
          ? {}
          : { failure: payload.failure }),
        endTime: payload.endTime,
      });
      persistWorkflowSessionState(
        payload.projectCwd,
        publicationId,
        payload.sessionState,
        payload.sessionStorageDirectory,
      );
      const ndjsonLogPath = join(
        input.runPaths.logsAbs,
        payload.ndjsonLogFile,
      );
      appendNdjsonLine(ndjsonLogPath, payload.sessionRecord);
      writeFileTrace(input.runPaths, ndjsonLogPath, payload);

      return Object.freeze({
        receipt: Object.freeze({
          runId: input.runPaths.slug,
          publicationId,
          runStatus: outcome.status,
          iteration: outcome.iteration,
          payloadSha256,
        }),
        issues: Object.freeze([]),
      });
    },
  });
}

function writeFileTrace(
  runPaths: RunPaths,
  ndjsonLogPath: string,
  payload: WorkflowTerminalPublicationPayload,
): void {
  const tracePath = join(runPaths.runRootAbs, 'trace.md');
  const params = {
    tracePath,
    workflowName: payload.workflowName,
    task: payload.task,
    runSlug: payload.runSlug,
    status: payload.status,
    iterations: payload.iterations,
    reason: payload.reason,
    endTime: payload.endTime,
  } as const;
  assertTraceParams(params);
  const markdown = renderTraceReportFromLogs(
    params,
    ndjsonLogPath,
    payload.promptLogPath,
    payload.traceReportMode,
  );
  if (markdown !== undefined) {
    writeFileAtomic(tracePath, markdown);
  }
}

function assertTerminalIdentity(
  runPaths: RunPaths,
  outcome: WorkflowRunTerminalOutcome,
  payload: WorkflowTerminalPublicationPayload,
): void {
  const expectedPayloadStatus =
    outcome.status === 'cancelled' ? 'aborted' : outcome.status;
  if (
    payload.runSlug !== runPaths.slug
    || payload.status !== expectedPayloadStatus
    || payload.iterations !== outcome.iteration
    || payload.reason !== outcome.reason
  ) {
    throw new Error(
      `File terminal payload does not match run "${runPaths.slug}"`,
    );
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
