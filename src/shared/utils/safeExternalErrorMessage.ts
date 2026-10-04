import { getErrorMessage } from './error.js';
import { sanitizeSensitiveText } from './sensitiveText.js';
import { sanitizePathText } from './pathText.js';

export function safeExternalErrorMessage(error: unknown): string {
  const message = sanitizeSensitiveText(getErrorMessage(error));
  if (/EACCES|EPERM|permission denied/i.test(message)) {
    return 'permission denied';
  }
  if (/ENOENT|no such file or directory/i.test(message)) {
    return 'not found';
  }
  return sanitizePathText(message);
}
