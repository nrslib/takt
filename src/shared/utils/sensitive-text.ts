export const REDACTED_VALUE = '[REDACTED]';
export const SENSITIVE_TEXT_BOUNDARY_WINDOW = 256;

const SENSITIVE_KEY_PATTERN = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|token|password|secret|credentials?|access[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)[A-Za-z0-9_.-]*`;
const SENSITIVE_HEADER_KEY_PATTERN = String.raw`(?:proxy[_-]?)?authorization|(?:set[_-]?)?cookies?|session[_-]?id`;
const SENSITIVE_TEXT_KEY_PATTERN = String.raw`(?:${SENSITIVE_KEY_PATTERN}|${SENSITIVE_HEADER_KEY_PATTERN})`;
const SENSITIVE_ASSIGNMENT_KEY_PATTERN = String.raw`(?:["'](?:${SENSITIVE_TEXT_KEY_PATTERN})["']|(?!(?:${SENSITIVE_HEADER_KEY_PATTERN})\b)${SENSITIVE_KEY_PATTERN})`;
const SENSITIVE_KEY_NAME_REGEX = new RegExp(
  String.raw`^${SENSITIVE_TEXT_KEY_PATTERN}$`,
  'i',
);
const SENSITIVE_QUOTED_VALUE_PATTERN = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX = new RegExp(
  String.raw`(${SENSITIVE_ASSIGNMENT_KEY_PATTERN}\s*[:=]\s*)(${SENSITIVE_QUOTED_VALUE_PATTERN})`,
  'gi',
);
const SENSITIVE_ASSIGNMENT_BARE_VALUE_REGEX = new RegExp(
  String.raw`(${SENSITIVE_ASSIGNMENT_KEY_PATTERN}\s*[:=]\s*["']?)([^"'[,\s}\]]+)(["']?)`,
  'gi',
);
const SENSITIVE_HEADER_ASSIGNMENT_BARE_VALUE_REGEX = new RegExp(
  String.raw`((?:${SENSITIVE_HEADER_KEY_PATTERN})\s*=\s*["']?)([^"';,\s}\]]+)(["']?)`,
  'gi',
);
const SENSITIVE_HEADER_ASSIGNMENT_COLON_VALUE_REGEX = new RegExp(
  String.raw`((?:session[_-]?id)\s*:\s*["']?)([^"';,\s}\]]+)(["']?)`,
  'gi',
);
const SENSITIVE_OPTION_VALUE_REGEX = new RegExp(
  String.raw`(--(?:${SENSITIVE_KEY_PATTERN})(?:=|\s+))(${SENSITIVE_QUOTED_VALUE_PATTERN}|[^\s]+)`,
  'gi',
);
const HTTP_AUTHORIZATION_HEADER_REGEX = /\b(Authorization\s*:\s*)([^"'\r\n]+)/gi;
const HTTP_COOKIE_HEADER_REGEX = /\b((?:Set-)?Cookie\s*:\s*)([^"'\r\n]+)/gi;
const URL_USERINFO_CREDENTIALS_REGEX = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s@]+:[^/?#\s@]+)@/g;
const CURL_USER_EQUALS_REGEX = /(\B--(?:proxy-)?user=)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi;
const CURL_USER_SPACE_REGEX = /(\B(?:-u|--(?:proxy-)?user)\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi;
const CURL_SHORT_USER_COMPACT_REGEX = /(^|\s)(-u)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi;
const SENSITIVE_QUERY_VALUE_REGEX = /([?&](?:api[_-]?key|token|password|secret)=)([^&\s]+)/gi;
const KNOWN_TOKEN_REGEX = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g;
const PEM_PRIVATE_KEY_REGEX = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const POTENTIAL_TOKEN_SUFFIX_REGEX = /(?:^|[^A-Za-z0-9_])(?:s|sk|sk-[A-Za-z0-9_-]*|g|gh|ghp|ghp_[A-Za-z0-9_]*|x|xo|xox|xox[baprs]|xox[baprs]-[A-Za-z0-9-]*)$/;
const SENSITIVE_KEY_FRAGMENTS = [
  'api',
  'api_key',
  'api-key',
  'token',
  'password',
  'secret',
  'credential',
  'access',
  'access_token',
  'access-token',
  'access_key',
  'access-key',
  'refresh',
  'refresh_token',
  'refresh-token',
  'private',
  'private_key',
  'private-key',
  'authorization',
  'proxy-authorization',
  'proxy_authorization',
  'cookie',
  'set-cookie',
  'set_cookie',
  'session',
  'session_id',
  'session-id',
] as const;
const TRAILING_ASSIGNMENT_REGEX = /(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\s*[:=]\s*(?:(?:bearer|basic)\s*)?[^\r\n]*$/i;
const TRAILING_KEY_FRAGMENT_REGEX = /[A-Za-z0-9_.-]+$/;

export function sanitizeSensitiveText(text: string): string {
  if (!text) return text;
  return text
    .replace(PEM_PRIVATE_KEY_REGEX, REDACTED_VALUE)
    .replace(SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX, (_match, prefix: string, quotedValue: string) => {
      const quote = quotedValue[0];
      return `${prefix}${quote}${REDACTED_VALUE}${quote}`;
    })
    .replace(URL_USERINFO_CREDENTIALS_REGEX, `$1${REDACTED_VALUE}@`)
    .replace(HTTP_AUTHORIZATION_HEADER_REGEX, (_match, prefix: string, value: string) => {
      const leadingWhitespaceLength = value.length - value.trimStart().length;
      const leadingWhitespace = value.slice(0, leadingWhitespaceLength);
      const trimmed = value.slice(leadingWhitespaceLength);
      const authScheme = /^([A-Za-z]+)\s+/.exec(trimmed);
      return authScheme
        ? `${prefix}${leadingWhitespace}${authScheme[1]} ${REDACTED_VALUE}`
        : `${prefix}${leadingWhitespace}${REDACTED_VALUE}`;
    })
    .replace(HTTP_COOKIE_HEADER_REGEX, `$1${REDACTED_VALUE}`)
    .replace(CURL_USER_EQUALS_REGEX, `$1${REDACTED_VALUE}`)
    .replace(CURL_USER_SPACE_REGEX, `$1${REDACTED_VALUE}`)
    .replace(CURL_SHORT_USER_COMPACT_REGEX, `$1$2${REDACTED_VALUE}`)
    .replace(SENSITIVE_HEADER_ASSIGNMENT_BARE_VALUE_REGEX, `$1${REDACTED_VALUE}$3`)
    .replace(SENSITIVE_HEADER_ASSIGNMENT_COLON_VALUE_REGEX, `$1${REDACTED_VALUE}$3`)
    .replace(SENSITIVE_ASSIGNMENT_BARE_VALUE_REGEX, `$1${REDACTED_VALUE}$3`)
    .replace(SENSITIVE_OPTION_VALUE_REGEX, `$1${REDACTED_VALUE}`)
    .replace(SENSITIVE_QUERY_VALUE_REGEX, `$1${REDACTED_VALUE}`)
    .replace(KNOWN_TOKEN_REGEX, REDACTED_VALUE);
}

export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEY_NAME_REGEX.test(key);
}

export function hasPotentialSensitiveTextSuffix(text: string): boolean {
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  if (
    '-----BEGIN '.startsWith(lastLine)
    || /^-----BEGIN [A-Z0-9 ]*$/.test(lastLine)
    || (lastLine.startsWith('-----BEGIN ') && !lastLine.endsWith('-----'))
    || hasUnterminatedPrivateKeyBlock(text)
  ) {
    return true;
  }
  if (POTENTIAL_TOKEN_SUFFIX_REGEX.test(text)) {
    return true;
  }
  const assignment = TRAILING_ASSIGNMENT_REGEX.exec(text);
  if (assignment?.[1] !== undefined && isSensitiveKeyName(assignment[1])) {
    return true;
  }
  const trailingKey = TRAILING_KEY_FRAGMENT_REGEX.exec(text)?.[0].toLowerCase();
  if (trailingKey === undefined) {
    return false;
  }
  if (trailingKey.length > SENSITIVE_TEXT_BOUNDARY_WINDOW) {
    return false;
  }
  const start = Math.max(0, trailingKey.length - 32);
  for (let index = start; index < trailingKey.length; index += 1) {
    const suffix = trailingKey.slice(index);
    if (SENSITIVE_KEY_FRAGMENTS.some((fragment) => fragment.startsWith(suffix))) {
      return true;
    }
  }
  return false;
}

export function collectEmbeddedSensitiveValues(text: string, values: Set<string>): void {
  addMatches(text, PEM_PRIVATE_KEY_REGEX, 0, values);
  addMatches(text, SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX, 2, values);
  addMatches(text, SENSITIVE_ASSIGNMENT_BARE_VALUE_REGEX, 2, values);
  addMatches(text, SENSITIVE_HEADER_ASSIGNMENT_BARE_VALUE_REGEX, 2, values);
  addMatches(text, SENSITIVE_HEADER_ASSIGNMENT_COLON_VALUE_REGEX, 2, values);
  addMatches(text, SENSITIVE_OPTION_VALUE_REGEX, 2, values);
  addMatches(text, SENSITIVE_QUERY_VALUE_REGEX, 2, values);
  addMatches(text, KNOWN_TOKEN_REGEX, 0, values);
  addMatches(text, HTTP_AUTHORIZATION_HEADER_REGEX, 2, values, true);
  addMatches(text, HTTP_COOKIE_HEADER_REGEX, 2, values, true);
  addMatches(text, URL_USERINFO_CREDENTIALS_REGEX, 2, values, true);
  addMatches(text, CURL_USER_EQUALS_REGEX, 2, values, true);
  addMatches(text, CURL_USER_SPACE_REGEX, 2, values, true);
  addMatches(text, CURL_SHORT_USER_COMPACT_REGEX, 3, values, true);
}

function hasUnterminatedPrivateKeyBlock(text: string): boolean {
  const matches = [...text.matchAll(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/g)];
  const lastMatch = matches.at(-1);
  if (lastMatch === undefined || lastMatch.index === undefined) {
    return false;
  }
  return !text.slice(lastMatch.index).includes(`-----END ${lastMatch[1]}-----`);
}

export function addSensitiveValue(values: Set<string>, rawValue: string, key?: string): void {
  const value = stripMatchingQuotes(rawValue.trim());
  if (value.length === 0) return;
  values.add(value);
  const authorizationValue = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
  if (authorizationValue?.[1]) {
    values.add(authorizationValue[1]);
  }
  if (key !== undefined && /(?:set[_-]?)?cookies?/i.test(key)) {
    addCookieValues(values, value);
  }
}

export function sanitizeTextWithValues(text: string, sensitiveValues: ReadonlySet<string>): string {
  let sanitized = text;
  for (const value of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    sanitized = replaceKnownSensitiveValue(sanitized, value);
  }
  return sanitizeSensitiveText(sanitized);
}

function addMatches(
  text: string,
  pattern: RegExp,
  group: number,
  values: Set<string>,
  addCredentialParts = false,
): void {
  const matcher = new RegExp(pattern.source, pattern.flags);
  for (const match of text.matchAll(matcher)) {
    const value = match[group];
    if (value !== undefined) {
      addSensitiveValue(values, value);
      if (addCredentialParts) {
        addCredentialComponents(values, value);
      }
    }
  }
}

function addCredentialComponents(values: Set<string>, rawValue: string): void {
  const value = stripMatchingQuotes(rawValue.trim());
  const authorizationValue = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
  if (authorizationValue?.[1]) {
    values.add(authorizationValue[1]);
  }
  const separator = value.indexOf(':');
  if (separator >= 0 && separator + 1 < value.length) {
    values.add(value.slice(separator + 1));
  }
  addCookieValues(values, value);
}

function addCookieValues(values: Set<string>, value: string): void {
  for (const cookie of value.split(';')) {
    const separator = cookie.indexOf('=');
    const cookieValue = separator >= 0 ? cookie.slice(separator + 1).trim() : '';
    if (cookieValue.length > 0) {
      values.add(cookieValue);
    }
  }
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}

function replaceKnownSensitiveValue(text: string, value: string): string {
  if (value.length >= 4) {
    return text.split(value).join(REDACTED_VALUE);
  }
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bounded = new RegExp(
    String.raw`(?<![\p{L}\p{N}_])${escaped}(?![\p{L}\p{N}_])`,
    'gu',
  );
  return text.replace(bounded, REDACTED_VALUE);
}
