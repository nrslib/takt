import { getErrorMessage } from './error.js';
import { sanitizeSensitiveText } from './sensitiveText.js';

const POSIX_ABSOLUTE_PATH_PATTERN = /(?<![\w:/])\/[^\s'"`<>|]*/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /[A-Za-z]:\\[^\s'"`<>|]*/g;
const FILE_URL_PATTERN = /file:\/\/[^\s'"`<>|]*/gi;

function sanitizePathText(text: string): string {
  return text
    .replace(FILE_URL_PATTERN, '[path]')
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, '[path]')
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, '[path]');
}

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
