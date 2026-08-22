import { sanitizeSensitiveText } from './sensitiveText.js';

const MAX_LOG_METADATA_TEXT_LENGTH = 1_000;
const TRUNCATED_LOG_TEXT_MARKER = '...[truncated]';
const REDACTED_LOG_VALUE = '[REDACTED]';

const SENSITIVE_LOG_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'accesskey',
  'privatekey',
]);

function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_LOG_KEYS.has(normalized)
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('token')
    || normalized.endsWith('apikey')
    || normalized.endsWith('privatekey');
}

export function truncateLogText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength - TRUNCATED_LOG_TEXT_MARKER.length) + TRUNCATED_LOG_TEXT_MARKER;
}

export function normalizeLogMetadata(value: string): string {
  return truncateLogText(sanitizeSensitiveText(value), MAX_LOG_METADATA_TEXT_LENGTH);
}

export function normalizeLogValue(key: string, value: unknown): unknown {
  if (isSensitiveLogKey(key)) {
    return REDACTED_LOG_VALUE;
  }
  return typeof value === 'string' ? normalizeLogMetadata(value) : value;
}
