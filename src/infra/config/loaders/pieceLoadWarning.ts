import { ZodError } from 'zod';
import { formatIssuePath } from '../issuePath.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';

export function formatPieceLoadWarning(pieceName: string, error: unknown): string {
  const safePieceName = sanitizeTerminalText(pieceName);
  if (error instanceof ZodError) {
    const firstIssue = error.issues[0];
    if (firstIssue) {
      const issuePath = sanitizeTerminalText(formatIssuePath(firstIssue.path));
      const issueMessage = sanitizeTerminalText(firstIssue.message);
      return `Piece "${safePieceName}" failed to load: ${issuePath}: ${issueMessage}`;
    }
  }

  return `Piece "${safePieceName}" failed to load: ${sanitizeTerminalText(getErrorMessage(error))}`;
}
