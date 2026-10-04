import { readFileSync } from 'node:fs';
import type { ProviderUsageSnapshot } from '../../../core/models/response.js';
import type { UsageEventLogContext } from '../../../core/logging/usageEventLogger.js';
import type { SessionLog } from '../../../infra/fs/index.js';
import {
  saveSessionState,
  type SessionState,
} from '../../../infra/config/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { notifyError, notifySuccess } from '../../../shared/utils/index.js';
import {
  MAX_TERMINAL_OUTPUT_BYTES,
  sanitizeTerminalText,
  sanitizeTerminalTextWithinBytes,
} from '../../../shared/utils/text.js';
import { USAGE_MISSING_REASONS } from '../../../core/logging/contracts.js';
import type { WorkflowTraceDiscovery } from '../../../core/workflow/observability/traceDiscovery.js';
import { createOutputFns } from './outputFns.js';
import { formatElapsedTime, truncate } from './workflowExecutionUtils.js';

export interface WorkflowSessionFinalization {
  readonly sessionLog: SessionLog;
  readonly sessionState: SessionState;
}

export function buildWorkflowSuccessSessionFinalization(input: {
  readonly sessionLog: SessionLog;
  readonly task: string;
  readonly workflowName: string;
  readonly lastStepContent: string | undefined;
  readonly lastStepName: string | undefined;
  readonly endTime: string;
}): WorkflowSessionFinalization {
  return {
    sessionLog: {
      ...input.sessionLog,
      status: 'completed' as const,
      endTime: input.endTime,
    },
    sessionState: {
      status: 'success',
      taskResult: truncate(input.lastStepContent ?? '', 1000),
      timestamp: input.endTime,
      workflowName: input.workflowName,
      taskContent: truncate(input.task, 200),
      lastStep: input.lastStepName,
    },
  };
}

export function persistWorkflowSessionState(
  projectCwd: string,
  publicationId: string,
  sessionState: SessionState,
  sessionStorageDirectory?: string,
): void {
  saveSessionState(projectCwd, publicationId, sessionState, sessionStorageDirectory);
}

export function buildWorkflowAbortSessionFinalization(input: {
  readonly sessionLog: SessionLog;
  readonly reason: string;
  readonly task: string;
  readonly workflowName: string;
  readonly lastStepName: string | undefined;
  readonly endTime: string;
}): WorkflowSessionFinalization {
  return {
    sessionLog: {
      ...input.sessionLog,
      status: 'aborted' as const,
      endTime: input.endTime,
    },
    sessionState: {
      status: input.reason === 'user_interrupted' ? 'user_stopped' : 'error',
      errorMessage: input.reason,
      timestamp: input.endTime,
      workflowName: input.workflowName,
      taskContent: truncate(input.task, 200),
      lastStep: input.lastStepName,
    },
  };
}

export function reportStepFile(filePath: string, fileName: string, out: ReturnType<typeof createOutputFns>): void {
  out.logLine(`\n📄 Report: ${fileName}\n`);
  out.logLine(readFileSync(filePath, 'utf-8'));
}

export function reportWorkflowCompletion(
  out: ReturnType<typeof createOutputFns>,
  sessionLog: SessionLog,
  iteration: number,
  ndjsonLogPath: string,
  shouldNotifyWorkflowComplete: boolean,
  traceDiscovery?: Pick<WorkflowTraceDiscovery, 'queries'>,
): void {
  const elapsed = sessionLog.endTime ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime) : '';
  out.success(`Workflow completed (${iteration} iterations${elapsed ? `, ${elapsed}` : ''})`);
  out.info(`Session log: ${ndjsonLogPath}`);
  reportTraceDiscovery(out, traceDiscovery);
  if (shouldNotifyWorkflowComplete) {
    notifySuccess('TAKT', getLabel('workflow.notifyComplete', undefined, { iteration: String(iteration) }));
  }
}

export function reportWorkflowFailure(
  out: ReturnType<typeof createOutputFns>,
  sessionLog: SessionLog,
  iteration: number,
  reason: string,
  status: 'aborted' | 'failed',
  ndjsonLogPath: string,
  shouldNotifyWorkflowAbort: boolean,
  traceDiscovery?: Pick<WorkflowTraceDiscovery, 'queries'>,
): void {
  const elapsed = sessionLog.endTime ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime) : '';
  const statusLabel = status === 'failed' ? 'failed' : 'aborted';
  const prefix = `Workflow ${statusLabel} after ${iteration} iterations${elapsed ? ` (${elapsed})` : ''}: `;
  out.error(`${prefix}${sanitizeTerminalTextWithinBytes(
    reason,
    MAX_TERMINAL_OUTPUT_BYTES - Buffer.byteLength(prefix, 'utf8'),
  )}`);
  out.info(`Session log: ${ndjsonLogPath}`);
  reportTraceDiscovery(out, traceDiscovery);
  if (shouldNotifyWorkflowAbort) {
    const label = status === 'failed'
      ? 'workflow.notifyFailed'
      : 'workflow.notifyAbort';
    notifyError('TAKT', getLabel(label, undefined, { reason }));
  }
}

function reportTraceDiscovery(
  out: ReturnType<typeof createOutputFns>,
  traceDiscovery: Pick<WorkflowTraceDiscovery, 'queries'> | undefined,
): void {
  if (!traceDiscovery || traceDiscovery.queries.length === 0) {
    return;
  }
  out.info('TraceQL discovery:');
  for (const query of traceDiscovery.queries) {
    out.info(`  ${sanitizeTerminalText(query)}`);
  }
}

export function updateUsageForStepCompletion(
  usageEventLogger: {
    logUsageFor: (context: UsageEventLogContext, usage: {
      success: boolean;
      usage: ProviderUsageSnapshot;
    }) => void;
  },
  context: UsageEventLogContext,
  response: { status: string; providerUsage?: ProviderUsageSnapshot },
): void {
  usageEventLogger.logUsageFor(context, {
    success: response.status === 'done',
    usage: response.providerUsage ?? { usageMissing: true, reason: USAGE_MISSING_REASONS.NOT_AVAILABLE },
  });
}
