import { readFileSync } from 'node:fs';
import type { ProviderUsageSnapshot } from '../../../core/models/response.js';
import type { SessionLog } from '../../../infra/fs/index.js';
import { saveSessionState, type SessionState } from '../../../infra/config/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { notifyError, notifySuccess } from '../../../shared/utils/index.js';
import { USAGE_MISSING_REASONS } from '../../../core/logging/contracts.js';
import { createOutputFns } from './outputFns.js';
import { formatElapsedTime, truncate } from './workflowExecutionUtils.js';

type WorkflowExecutionWarningHandler = (warning: string) => void;

function buildSessionStateWarning(
  projectCwd: string,
  workflowName: string,
  task: string,
  error: unknown,
): string {
  return [
    `Failed to save session state for workflow "${workflowName}"`,
    `task "${truncate(task, 200)}"`,
    `in ${projectCwd}: ${getErrorMessage(error)}`,
  ].join(' ');
}

export function finalizeWorkflowSuccess(
  sessionLog: SessionLog,
  task: string,
  workflowName: string,
  lastStepContent: string | undefined,
  lastStepName: string | undefined,
  projectCwd: string,
  onWarning?: WorkflowExecutionWarningHandler,
): SessionLog {
  const finalized = {
    ...sessionLog,
    status: 'completed' as const,
    endTime: new Date().toISOString(),
  };
  try {
    saveSessionState(projectCwd, {
      status: 'success',
      taskResult: truncate(lastStepContent ?? '', 1000),
      timestamp: new Date().toISOString(),
      workflowName,
      taskContent: truncate(task, 200),
      lastStep: lastStepName,
    } satisfies SessionState);
  } catch (error) {
    onWarning?.(buildSessionStateWarning(projectCwd, workflowName, task, error));
  }
  return finalized;
}

export function finalizeWorkflowAbort(
  sessionLog: SessionLog,
  reason: string,
  task: string,
  workflowName: string,
  lastStepName: string | undefined,
  projectCwd: string,
  onWarning?: WorkflowExecutionWarningHandler,
): SessionLog {
  const finalized = {
    ...sessionLog,
    status: 'aborted' as const,
    endTime: new Date().toISOString(),
  };
  try {
    saveSessionState(projectCwd, {
      status: reason === 'user_interrupted' ? 'user_stopped' : 'error',
      errorMessage: reason,
      timestamp: new Date().toISOString(),
      workflowName,
      taskContent: truncate(task, 200),
      lastStep: lastStepName,
    } satisfies SessionState);
  } catch (error) {
    onWarning?.(buildSessionStateWarning(projectCwd, workflowName, task, error));
  }
  return finalized;
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
): void {
  const elapsed = sessionLog.endTime ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime) : '';
  out.success(`Workflow completed (${iteration} iterations${elapsed ? `, ${elapsed}` : ''})`);
  out.info(`Session log: ${ndjsonLogPath}`);
  if (shouldNotifyWorkflowComplete) {
    notifySuccess('TAKT', getLabel('workflow.notifyComplete', undefined, { iteration: String(iteration) }));
  }
}

export function reportWorkflowAbort(
  out: ReturnType<typeof createOutputFns>,
  sessionLog: SessionLog,
  iteration: number,
  reason: string,
  ndjsonLogPath: string,
  shouldNotifyWorkflowAbort: boolean,
): void {
  const elapsed = sessionLog.endTime ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime) : '';
  out.error(`Workflow aborted after ${iteration} iterations${elapsed ? ` (${elapsed})` : ''}: ${reason}`);
  out.info(`Session log: ${ndjsonLogPath}`);
  if (shouldNotifyWorkflowAbort) {
    notifyError('TAKT', getLabel('workflow.notifyAbort', undefined, { reason }));
  }
}

export function updateUsageForStepCompletion(
  usageEventLogger: {
    logUsage: (usage: {
      success: boolean;
      usage: ProviderUsageSnapshot;
    }) => void;
  },
  response: { status: string; providerUsage?: ProviderUsageSnapshot },
): void {
  usageEventLogger.logUsage({
    success: response.status === 'done',
    usage: response.providerUsage ?? { usageMissing: true, reason: USAGE_MISSING_REASONS.NOT_AVAILABLE },
  });
}
