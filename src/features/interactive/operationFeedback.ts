import type { IssueEnqueueResult } from '../../infra/task/enqueueService.js';
import { getLabel } from '../../shared/i18n/index.js';
import { getErrorMessage, sanitizeTerminalText } from '../../shared/utils/index.js';
import type { TaskExecutionOutcome } from '../tasks/execute/selectAndExecute.js';
import type { ConversationDispatchOutcome } from './actionDispatcher.js';
import type { ConversationMessage, InteractiveModeAction } from './interactive-summary-types.js';
import { formatLiteralBlock } from './promptSections.js';

type Language = 'en' | 'ja';

const actionLabels: Record<InteractiveModeAction, string> = {
  execute: 'interactive.ui.actions.execute',
  create_issue: 'interactive.ui.actions.createIssue',
  save_task: 'interactive.ui.actions.saveTask',
  cancel: 'interactive.ui.cancelled',
};

export function describeSavedTask(
  result: { taskName: string } | { readonly kind: 'cancelled' },
  lang: Language,
): ConversationDispatchOutcome {
  return 'kind' in result
    ? { kind: 'cancelled', notice: getLabel('interactive.operation.saveCancelled', lang) }
    : { kind: 'dispatched', notice: getLabel('interactive.operation.taskSaved', lang, {
      taskName: sanitizeTerminalText(result.taskName),
    }) };
}

export function describeIssueResult(result: IssueEnqueueResult, lang: Language): ConversationDispatchOutcome {
  if (result.success) {
    return { kind: 'dispatched', notice: getLabel(result.created.issueNumber === undefined
      ? 'interactive.operation.issueSavedWithoutNumber'
      : 'interactive.operation.issueSaved', lang, {
      ...(result.created.issueNumber === undefined ? {} : { issueNumber: String(result.created.issueNumber) }),
      taskName: sanitizeTerminalText(result.created.taskName),
    }) };
  }
  const failure = result.failure;
  const reason = sanitizeTerminalText(getErrorMessage(failure.error));
  const label = !failure.issueCreated
    ? 'interactive.operation.issueFailed'
    : failure.stage === 'issue_number_parsing'
      ? 'interactive.operation.issueNumberUnknown'
      : failure.stage === 'cancelled_after_issue_creation'
        ? 'interactive.operation.issueSaveCancelled'
        : 'interactive.operation.issueNotSaved';
  return {
    kind: failure.stage === 'cancelled_after_issue_creation' ? 'cancelled' : 'dispatched',
    notice: getLabel(label, lang, {
      reason,
      ...('issueNumber' in failure ? { issueNumber: String(failure.issueNumber) } : {}),
    }),
  };
}

export function describeExecutionResult(result: TaskExecutionOutcome, lang: Language): ConversationDispatchOutcome {
  if ('kind' in result) {
    return { kind: 'cancelled', notice: getLabel('interactive.operation.executionCancelled', lang) };
  }
  const label = result.success
    ? 'interactive.operation.executionFinished'
    : result.reason === undefined
      ? 'interactive.operation.executionFailed'
      : 'interactive.operation.executionFailedWithReason';
  return { kind: 'dispatched', notice: getLabel(label, lang, {
    ...(result.reason === undefined ? {} : { reason: sanitizeTerminalText(result.reason) }),
  }) };
}

export async function runConversationOperation(
  action: InteractiveModeAction,
  lang: Language,
  operation: () => Promise<ConversationDispatchOutcome>,
): Promise<ConversationDispatchOutcome> {
  try {
    return await operation();
  } catch (caught) {
    return { kind: 'dispatched', notice: getLabel('interactive.operation.failed', lang, {
      action: getLabel(actionLabels[action], lang),
      reason: sanitizeTerminalText(getErrorMessage(caught)),
    }) };
  }
}

export function createOperationMessage(notice: string): ConversationMessage {
  return { role: 'assistant', content: notice, operationResult: true };
}

export function prependOperationResults(
  prompt: string,
  history: readonly ConversationMessage[],
  lang: Language,
): string {
  const results = history.filter((message) => message.operationResult).map((message) => message.content);
  if (results.length === 0) {
    return prompt;
  }
  return `## ${getLabel('interactive.operation.reference', lang)}\n\n${formatLiteralBlock(results.join('\n'))}\n\n---\n\n${prompt}`;
}
