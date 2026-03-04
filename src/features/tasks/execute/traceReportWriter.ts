import { writeFileAtomic } from '../../../infra/config/index.js';
import type { SessionLogger } from './sessionLogger.js';
import type { TraceReportMode } from './traceReport.js';
import {
  assertTraceParams,
  renderTraceReportFromLogs,
  renderTraceReportFromRecords,
} from './traceReport.js';

interface TraceReportWriterParams {
  sessionLogger: SessionLogger;
  ndjsonLogPath: string;
  tracePath: string;
  pieceName: string;
  task: string;
  runSlug: string;
  promptLogPath?: string;
  mode: TraceReportMode;
  logger: {
    info: (message: string, data?: unknown) => void;
  };
}

interface WriteTraceReportInput {
  status: 'completed' | 'aborted';
  iterations: number;
  endTime: string;
  reason?: string;
}

export function createTraceReportWriter(params: TraceReportWriterParams): (input: WriteTraceReportInput) => void {
  let traceReportWritten = false;

  return (input: WriteTraceReportInput): void => {
    if (traceReportWritten) {
      params.logger.info('Trace report write skipped because it has already been written', {
        status: input.status,
        iterations: input.iterations,
      });
      return;
    }
    traceReportWritten = true;
    const traceParams = {
      tracePath: params.tracePath,
      pieceName: params.pieceName,
      task: params.task,
      runSlug: params.runSlug,
      status: input.status,
      iterations: input.iterations,
      reason: input.reason,
      endTime: input.endTime,
    } as const;
    assertTraceParams(traceParams);

    let markdown: string | undefined;
    try {
      markdown = renderTraceReportFromLogs(
        traceParams,
        params.ndjsonLogPath,
        params.promptLogPath,
        params.mode,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('No session records found for trace report:')) {
        throw error;
      }
      markdown = renderTraceReportFromRecords(
        traceParams,
        params.sessionLogger.getNdjsonRecords(),
        params.sessionLogger.getPromptRecords(),
        params.mode,
      );
    }

    if (!markdown) {
      return;
    }
    writeFileAtomic(params.tracePath, markdown);
  };
}
