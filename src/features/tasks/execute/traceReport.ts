import type { NdjsonRecord } from '../../../shared/utils/index.js';
import type {
  TraceReportMode,
  TraceReportParams,
  TraceStep,
  TracePhase,
} from './traceReportTypes.js';
import { parseJsonl, buildTraceFromRecords, type PromptRecord } from './traceReportParser.js';
import { cloneStepsForMode, sanitizeTraceParamsForMode } from './traceReportRedaction.js';
import { assertTraceParams, renderTraceReportMarkdown } from './traceReportRenderer.js';
import type { PromptLogRecord } from './promptLog.js';

export type {
  TraceReportMode,
  TraceReportParams,
  TraceStep,
  TracePhase,
};

export { assertTraceParams, renderTraceReportMarkdown };

export function renderTraceReportFromLogs(
  params: TraceReportParams,
  ndjsonLogPath: string,
  promptLogPath: string | undefined,
  mode: TraceReportMode,
): string | undefined {
  if (mode === 'off') {
    return undefined;
  }
  const records = parseJsonl<NdjsonRecord>(ndjsonLogPath);
  if (records.length === 0) {
    return undefined;
  }
  const promptRecords = promptLogPath ? parseJsonl<PromptRecord>(promptLogPath) : [];
  return renderTraceReportFromRecords(params, records, promptRecords, mode);
}

export function renderTraceReportFromRecords(
  params: TraceReportParams,
  records: NdjsonRecord[],
  promptRecords: PromptRecord[] | PromptLogRecord[],
  mode: TraceReportMode,
): string | undefined {
  if (mode === 'off') {
    return undefined;
  }
  if (records.length === 0) {
    return undefined;
  }

  const trace = buildTraceFromRecords(records, promptRecords as PromptRecord[], params.endTime);
  const paramsForMode = sanitizeTraceParamsForMode(params, mode);
  const stepsForMode = cloneStepsForMode(trace.steps, mode);
  return renderTraceReportMarkdown(paramsForMode, trace.traceStartedAt, stepsForMode);
}
