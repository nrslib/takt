import { join } from 'node:path';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import {
  projectTerminalSessionRecord,
} from './sessionLogger.js';
import {
  persistWorkflowSessionState,
} from './workflowExecutionReporting.js';
import type {
  WorkflowTerminalPublicationPayload,
} from './workflowTerminalPayload.js';
import { writeTerminalTraceReport } from './traceReportWriter.js';

export type WorkflowTerminalProjectionStage =
  | 'meta'
  | 'session'
  | 'trace';

export interface WorkflowTerminalMetaProjection {
  project(
    payload: WorkflowTerminalPublicationPayload,
    runPaths: RunPaths,
    publicationId: string,
  ): void;
}

interface WorkflowTerminalProjectionContext {
  readonly runPaths: RunPaths;
  readonly metaProjection: WorkflowTerminalMetaProjection;
  readonly publicationId: string;
}

export function projectWorkflowTerminalStage(
  stage: WorkflowTerminalProjectionStage,
  payload: WorkflowTerminalPublicationPayload,
  context: WorkflowTerminalProjectionContext,
): void {
  switch (stage) {
    case 'meta':
      context.metaProjection.project(
        payload,
        context.runPaths,
        context.publicationId,
      );
      return;
    case 'session':
      persistWorkflowSessionState(
        payload.projectCwd,
        context.publicationId,
        payload.sessionState,
      );
      projectTerminalSessionRecord(
        join(context.runPaths.logsAbs, payload.ndjsonLogFile),
        {
          task: payload.task,
          workflowName: payload.workflowName,
          startTime: payload.sessionLog.startTime,
        },
        {
          ...payload.sessionRecord,
          publicationId: context.publicationId,
        },
      );
      return;
    case 'trace':
      writeTerminalTraceReport({
        ndjsonLogPath: join(
          context.runPaths.logsAbs,
          payload.ndjsonLogFile,
        ),
        tracePath: join(context.runPaths.runRootAbs, 'trace.md'),
        workflowName: payload.workflowName,
        task: payload.task,
        runSlug: payload.runSlug,
        publicationId: context.publicationId,
        ...(payload.promptLogPath === undefined
          ? {}
          : { promptLogPath: payload.promptLogPath }),
        mode: payload.traceReportMode,
        terminal: {
          status: payload.status,
          iterations: payload.iterations,
          ...(payload.reason === undefined
            ? {}
            : { reason: payload.reason }),
          endTime: payload.endTime,
        },
      });
  }
}
