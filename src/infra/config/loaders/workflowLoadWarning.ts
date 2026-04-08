import { ZodError } from 'zod';
import { formatIssuePath } from '../issuePath.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';

function formatWorkflowIssuePath(path: readonly PropertyKey[]): string {
  return formatIssuePath(path)
    .replace(/^steps(?=\.|$)/, 'steps');
}

export function formatWorkflowLoadWarning(workflowName: string, error: unknown): string {
  const safeWorkflowName = sanitizeTerminalText(workflowName);
  if (error instanceof ZodError) {
    const firstIssue = error.issues[0];
    if (firstIssue) {
      const issuePath = sanitizeTerminalText(formatWorkflowIssuePath(firstIssue.path));
      const issueMessage = sanitizeTerminalText(firstIssue.message);
      return `Workflow "${safeWorkflowName}" failed to load: ${issuePath}: ${issueMessage}`;
    }
  }

  return `Workflow "${safeWorkflowName}" failed to load: ${sanitizeTerminalText(getErrorMessage(error))}`;
}
