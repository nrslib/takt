import { toDisplayText, toSingleLineText } from './displayText.js';
import { getErrorMessage } from './error.js';
import { sanitizeSensitiveText } from './sensitive-text.js';
import { truncateText } from './text.js';

const MAX_ERROR_REASON_WIDTH = 500;

export function normalizeErrorReason(error: unknown): string {
  const displayText = toDisplayText(getErrorMessage(error).replace(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/gu, '\n'));
  // Unfold the credential before sanitizing, but keep subsequent diagnostic lines separate.
  const unfolded = displayText.replace(/(\bAuthorization\s*:\s*(?:Bearer|Basic))\s+(\S+)/giu, '$1 $2');
  return truncateText(toSingleLineText(sanitizeSensitiveText(unfolded)), MAX_ERROR_REASON_WIDTH);
}
