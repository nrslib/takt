import { createHash } from 'node:crypto';
import {
  readPrivateFileState,
  writePrivateFileWithModeExpected,
} from '../../../shared/utils/private-file.js';
import type { TraceReportMode } from './traceReport.js';
import {
  assertTraceParams,
  renderTraceReportFromLogs,
} from './traceReport.js';

interface WriteTraceReportInput {
  status: 'completed' | 'aborted' | 'failed';
  iterations: number;
  endTime: string;
  reason?: string;
}

const TRACE_MODE = 0o600;
const TRACE_PUBLICATION_PATTERN =
  /^<!-- terminal-publication:([^ ]+) sha256:([a-f0-9]{64}) -->\n/;

export function writeTerminalTraceReport(input: {
  readonly ndjsonLogPath: string;
  readonly tracePath: string;
  readonly workflowName: string;
  readonly task: string;
  readonly runSlug: string;
  readonly publicationId: string;
  readonly promptLogPath?: string;
  readonly mode: TraceReportMode;
  readonly terminal: WriteTraceReportInput;
}): void {
  const traceParams = {
    tracePath: input.tracePath,
    workflowName: input.workflowName,
    task: input.task,
    runSlug: input.runSlug,
    status: input.terminal.status,
    iterations: input.terminal.iterations,
    reason: input.terminal.reason,
    endTime: input.terminal.endTime,
  } as const;
  assertTraceParams(traceParams);
  const markdown = renderTraceReportFromLogs(
    traceParams,
    input.ndjsonLogPath,
    input.promptLogPath,
    input.mode,
  );
  if (markdown !== undefined) {
    const markdownSha256 = createHash('sha256').update(markdown).digest('hex');
    const content = `<!-- terminal-publication:${input.publicationId} `
      + `sha256:${markdownSha256} -->\n${markdown}`;
    const snapshot = readPrivateFileState(input.tracePath);
    if (snapshot.state.exists) {
      if (!('content' in snapshot)) {
        throw new Error(`Terminal trace content is missing: ${input.tracePath}`);
      }
      const existing = snapshot.content.toString('utf-8');
      const marker = TRACE_PUBLICATION_PATTERN.exec(existing);
      if (
        marker?.[1] === input.publicationId
        && marker[2] === markdownSha256
        && existing === content
      ) {
        return;
      }
      throw new Error(
        `Terminal trace publication conflicts with "${input.publicationId}"`,
      );
    }
    writePrivateFileWithModeExpected(
      input.tracePath,
      content,
      TRACE_MODE,
      snapshot.state,
    );
  }
}
