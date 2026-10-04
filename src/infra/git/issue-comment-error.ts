import { containsRateLimitError } from '../rate-limit/detection.js';

const ISSUE_COMMENT_FAILURE_FALLBACK = 'Issue comment command failed';
const ISSUE_COMMENT_FAILURE_REASONS = {
  authentication: 'authentication failed',
  permission: 'permission denied',
  notFound: 'issue not found',
  rateLimit: 'rate limit exceeded',
  network: 'network error',
  remoteService: 'remote service error',
} as const;

// stderr は診断入力として扱い、失敗処理の計算量が入力全体に無制限に依存しないよう上限を設ける。
const ISSUE_COMMENT_ERROR_MAX_LENGTH = 16_384;

const ISSUE_COMMENT_STATUS_CODES = new Set(['401', '403', '404', '500', '502', '503', '504']);

// gh/glab の失敗メッセージは実装上英語前提とし、英語以外は汎用フォールバックにする。
const AUTHENTICATION_MESSAGE_PATTERN = /\b(?:authentication(?: required| failed)?|unauthorized|not authenticated|bad credentials|invalid token|login required)\b/i;
const PERMISSION_MESSAGE_PATTERN = /\b(?:forbidden|permission denied|access denied)\b/i;
const ISSUE_NOT_FOUND_MESSAGE_PATTERN = /\b(?:not found|does not exist|could not resolve to an issue)\b/i;
const NETWORK_MESSAGE_PATTERN = /\b(?:network(?: error| unreachable)?|connection (?:refused|reset|timed out)|timed out|timeout|could not resolve (?:host|hostname|address)|failed to connect|econnreset|econnrefused|eai_again|enotfound|etimedout)\b/i;
const REMOTE_SERVICE_MESSAGE_PATTERN = /\b(?:internal server error|bad gateway|service unavailable)\b/i;

function isAsciiWordCharacter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || character === '_';
}

function readStatusCode(token: string | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }

  const code = token.slice(0, 3);
  if (!ISSUE_COMMENT_STATUS_CODES.has(code) || isAsciiWordCharacter(token[3])) {
    return undefined;
  }

  return code;
}

function collectStatusCodes(text: string): Set<string> {
  const tokens = text.replace(/[=:]/g, ' ').split(' ').filter((token) => token.length > 0);
  const statusCodes = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }

    let codeIndex: number | undefined;

    if (token === 'http' || token.startsWith('http/')) {
      codeIndex = index + 1;
    } else if (token === 'status') {
      codeIndex = index + 1;
      if (tokens[codeIndex] === 'code') {
        codeIndex += 1;
      }
      if (tokens[codeIndex] === 'is') {
        codeIndex += 1;
      }
    }

    const code = readStatusCode(codeIndex === undefined ? undefined : tokens[codeIndex]);
    if (code !== undefined) {
      statusCodes.add(code);
    }
  }

  return statusCodes;
}

export function getIssueCommentFailureReason(error: unknown, _body: string): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return ISSUE_COMMENT_FAILURE_FALLBACK;
  }

  const stderr = typeof error.stderr === 'string'
    ? error.stderr.slice(0, ISSUE_COMMENT_ERROR_MAX_LENGTH).trim()
    : '';
  if (stderr.length === 0) {
    return ISSUE_COMMENT_FAILURE_FALLBACK;
  }

  const normalizedStderr = stderr.replace(/\s+/g, ' ').toLowerCase();
  const statusCodes = collectStatusCodes(normalizedStderr);

  // Rate limit must take precedence over permission because APIs may report both on one failure.
  if (containsRateLimitError(normalizedStderr)) {
    return ISSUE_COMMENT_FAILURE_REASONS.rateLimit;
  }
  if (statusCodes.has('401') || AUTHENTICATION_MESSAGE_PATTERN.test(normalizedStderr)) {
    return ISSUE_COMMENT_FAILURE_REASONS.authentication;
  }
  if (statusCodes.has('403') || PERMISSION_MESSAGE_PATTERN.test(normalizedStderr)) {
    return ISSUE_COMMENT_FAILURE_REASONS.permission;
  }
  if (statusCodes.has('404') || ISSUE_NOT_FOUND_MESSAGE_PATTERN.test(normalizedStderr)) {
    return ISSUE_COMMENT_FAILURE_REASONS.notFound;
  }
  if (NETWORK_MESSAGE_PATTERN.test(normalizedStderr)) {
    return ISSUE_COMMENT_FAILURE_REASONS.network;
  }
  if (statusCodes.has('500') || statusCodes.has('502') || statusCodes.has('503') || statusCodes.has('504') || REMOTE_SERVICE_MESSAGE_PATTERN.test(normalizedStderr)) {
    return ISSUE_COMMENT_FAILURE_REASONS.remoteService;
  }

  return ISSUE_COMMENT_FAILURE_FALLBACK;
}
