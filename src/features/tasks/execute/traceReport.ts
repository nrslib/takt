import type { NdjsonRecord, PromptLogRecord } from '../../../shared/utils/index.js';
import type {
  TraceReportMode,
  TraceReportParams,
  TraceMovement,
  TracePhase,
} from './traceReportTypes.js';
import { parseJsonl, buildTraceFromRecords, type PromptRecord } from './traceReportParser.js';
import { cloneMovementsForMode, sanitizeTraceParamsForMode } from './traceReportRedaction.js';
import { assertTraceParams, renderTraceReportMarkdown } from './traceReportRenderer.js';

export type {
  TraceReportMode,
  TraceReportParams,
  TraceMovement,
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
    throw new Error(`No session records found for trace report: ${ndjsonLogPath}`);
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
    throw new Error('No session records found for trace report from records');
  }

  const trace = buildTraceFromRecords(records, promptRecords as PromptRecord[], params.endTime);
  const paramsForMode = sanitizeTraceParamsForMode(params, mode);
  const movementsForMode = cloneMovementsForMode(trace.movements, mode);
  return renderTraceReportMarkdown(paramsForMode, trace.traceStartedAt, movementsForMode);
}
