import { ZodError } from 'zod';
import { formatIssuePath } from '../issuePath.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';

function formatWorkflowIssuePath(path: readonly PropertyKey[]): string {
  return formatIssuePath(path)
    .replace(/^movements(?=\.|$)/, 'steps')
    .replace(/^initial_movement$/, 'initial_step');
}

export function formatPieceLoadWarning(pieceName: string, error: unknown): string {
  const safePieceName = sanitizeTerminalText(pieceName);
  if (error instanceof ZodError) {
    const firstIssue = error.issues[0];
    if (firstIssue) {
      const issuePath = sanitizeTerminalText(formatWorkflowIssuePath(firstIssue.path));
      const issueMessage = sanitizeTerminalText(firstIssue.message);
      return `Workflow "${safePieceName}" failed to load: ${issuePath}: ${issueMessage}`;
    }
  }

  return `Workflow "${safePieceName}" failed to load: ${sanitizeTerminalText(getErrorMessage(error))}`;
}
