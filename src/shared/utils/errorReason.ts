import { toSingleLineText } from './displayText.js';
import { getErrorMessage } from './error.js';
import { sanitizeSensitiveText } from './sensitive-text.js';
import { truncateText } from './text.js';

const MAX_ERROR_REASON_WIDTH = 500;

export function normalizeErrorReason(error: unknown): string {
  const singleLine = toSingleLineText(getErrorMessage(error).replace(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/gu, ' '));
  return truncateText(sanitizeSensitiveText(singleLine), MAX_ERROR_REASON_WIDTH);
}
