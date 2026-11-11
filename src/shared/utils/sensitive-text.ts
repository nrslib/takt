export const REDACTED_VALUE = '[REDACTED]';
export const SENSITIVE_TEXT_BOUNDARY_WINDOW = 256;

const SENSITIVE_KEY_CHAR_PATTERN = String.raw`[A-Za-z0-9_.-]`;
const SENSITIVE_KEY_WORD_PATTERN = String.raw`api[_-]?key|token|password|secret|credentials?|access[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key`;
// A sensitive key is a maximal run of key characters that contains a sensitive
// key word. A key can only end where the run ends (every follower — quote,
// `:`/`=`, whitespace — is a non-key character), so the atomic lookahead
// locates the key word in a single pass and `+` then consumes the whole run.
// The previous form (`chars* keyword chars*`) re-scanned the remainder of a
// run from every backtracking position, which made sanitization O(n^2) on
// long uniform runs (~5s for 64KB of base64-like output).
const SENSITIVE_KEY_PATTERN = String.raw`(?=${SENSITIVE_KEY_CHAR_PATTERN}*(?:${SENSITIVE_KEY_WORD_PATTERN}))${SENSITIVE_KEY_CHAR_PATTERN}+`;
const SENSITIVE_HEADER_KEY_PATTERN = String.raw`(?:proxy[_-]?)?authorization|(?:set[_-]?)?cookies?|session[_-]?id`;
const SENSITIVE_TEXT_KEY_PATTERN = String.raw`(?:${SENSITIVE_KEY_PATTERN}|${SENSITIVE_HEADER_KEY_PATTERN})`;
// Bare (unquoted) assignment keys anchor to the start of a key-character run:
// a match can never start mid-run (the leading `chars*` of the original
// pattern always absorbed the run prefix), so rejecting mid-run start
// positions with the lookbehind is behavior-preserving and stops the engine
// from re-attempting every interior position of a long run. The skip loop
// preserves the original handling of runs that begin with a header key
// (e.g. `authorization-token=v`): header-key prefixes are consumed character
// by character until the header exclusion no longer blocks the key.
const SENSITIVE_BARE_ASSIGNMENT_KEY_PATTERN = String.raw`(?<!${SENSITIVE_KEY_CHAR_PATTERN})(?:(?=(?:${SENSITIVE_HEADER_KEY_PATTERN})\b)${SENSITIVE_KEY_CHAR_PATTERN})*(?!(?:${SENSITIVE_HEADER_KEY_PATTERN})\b)${SENSITIVE_KEY_PATTERN}`;
const SENSITIVE_ASSIGNMENT_KEY_PATTERN = String.raw`(?:["'](?:${SENSITIVE_TEXT_KEY_PATTERN})["']|${SENSITIVE_BARE_ASSIGNMENT_KEY_PATTERN})`;
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
  String.raw`(${SENSITIVE_ASSIGNMENT_KEY_PATTERN}\s*[:=]\s*["']?)([^"'[{,\s}\]]+)(["']?)`,
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
// `(?<!-)` skips `--` start positions preceded by another `-`: such a match
// could only exist if the attempt one character earlier (also `--`) had
// already failed, and that failure implies this one fails too. This keeps
// long `-` runs (separator lines) linear instead of quadratic.
const SENSITIVE_OPTION_VALUE_REGEX = new RegExp(
  String.raw`((?<!-)--(?:${SENSITIVE_KEY_PATTERN})(?:=|\s+))(${SENSITIVE_QUOTED_VALUE_PATTERN}|[^\s]+)`,
  'gi',
);
const HTTP_HEADER_PREFIX_REGEX = /\b(Authorization|(?:Set-)?Cookie)\s*:\s*/gi;
const URL_USERINFO_CREDENTIALS_REGEX = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s@]+:[^/?#\s@]+)@/g;
const CURL_USER_VALUE_PATTERN = [
  String.raw`(?<=\\")(?!\+)[^":]*:[^"]*?(?=\\")`,
  String.raw`"(?!\+)[^":]*:[^"]*"`,
  String.raw`'(?!\+)[^':]*:[^']*'`,
  String.raw`(?<!\\")(?![+"']|\\")[^\s:]*:[^\s]*`,
].join('|');
const CURL_USER_EQUALS_REGEX = new RegExp(
  String.raw`(\B--(?:proxy-)?user=)(?:\\")?(${CURL_USER_VALUE_PATTERN})(?:\\")?`,
  'gi',
);
const CURL_USER_SPACE_REGEX = new RegExp(
  String.raw`(\B(?:-u|--(?:proxy-)?user)\s+)(?:\\")?(${CURL_USER_VALUE_PATTERN})(?:\\")?`,
  'gi',
);
const CURL_SHORT_USER_COMPACT_REGEX = new RegExp(
  String.raw`(^|\s)(-u)(?:\\")?(${CURL_USER_VALUE_PATTERN})(?:\\")?`,
  'gi',
);
const SENSITIVE_QUERY_VALUE_REGEX = /([?&](?:api[_-]?key|token|password|secret)=)([^&\s]+)/gi;
const KNOWN_TOKEN_REGEX = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g;
const PEM_PRIVATE_KEY_REGEX = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
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

interface HttpHeaderValue {
  start: number;
  end: number;
  scheme: string | undefined;
}

type ShellHeaderQuote = "'" | '"' | '\\"';

function* httpHeaderValues(text: string): Generator<HttpHeaderValue> {
  const headers = new RegExp(HTTP_HEADER_PREFIX_REGEX.source, HTTP_HEADER_PREFIX_REGEX.flags);
  const quotedAssignments = text.matchAll(SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX);
  let quotedAssignment = quotedAssignments.next().value;
  const authScheme = /([A-Za-z]+)[ \t]+/y;
  for (let match = headers.exec(text); match !== null; match = headers.exec(text)) {
    while (quotedAssignment !== undefined && quotedAssignment.index + quotedAssignment[0].length <= match.index) {
      quotedAssignment = quotedAssignments.next().value;
    }
    if (quotedAssignment !== undefined && quotedAssignment.index <= match.index) {
      // Quoted assignments use the same boundary as display redaction.
      headers.lastIndex = quotedAssignment.index + quotedAssignment[0].length;
      continue;
    }
    const start = headers.lastIndex;
    authScheme.lastIndex = start;
    const scheme = match[1]!.toLowerCase() === 'authorization' ? authScheme.exec(text) : null;
    const credentialStart = scheme === null ? start : authScheme.lastIndex;
    const enclosingQuote = text[match.index - 1];
    const shellQuote = enclosingQuote === '"' && text[match.index - 2] === '\\'
      ? '\\"'
      : enclosingQuote === '"' || enclosingQuote === "'" ? enclosingQuote : undefined;
    const end = httpHeaderValueEnd(text, credentialStart, shellQuote);
    if (end > start) {
      yield { start, end, scheme: scheme?.[1] };
    }
    // Consumed values can contain header-like text; never restart a scan inside them.
    headers.lastIndex = end;
  }
}

function httpHeaderValueEnd(text: string, start: number, shellQuote: ShellHeaderQuote | undefined): number {
  let valueQuote: string | undefined;
  let previousNonSpace: string | undefined;
  let cursor = start;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === '\r' || char === '\n') break;
    if (shellQuote === '\\"' && char === '\\') {
      let slashEnd = cursor + 1;
      while (text[slashEnd] === '\\') slashEnd += 1;
      // JSON doubles shell backslashes and adds one before a quote.
      if (text[slashEnd] === '"' && (slashEnd - cursor) % 4 === 1) return slashEnd - 1;
      cursor = slashEnd;
      if (text[cursor] === '"') cursor += 1;
      continue;
    }
    if (char === '\\' && shellQuote !== "'" && text[cursor + 1] !== '\r' && text[cursor + 1] !== '\n') {
      cursor = Math.min(cursor + 2, text.length);
      continue;
    }
    if (shellQuote !== undefined) {
      if (char === shellQuote || (shellQuote === '\\"' && char === '"')) break;
    } else if (valueQuote !== undefined) {
      if (char === valueQuote) valueQuote = undefined;
    } else if (char === '"' || char === "'") {
      if (cursor !== start && previousNonSpace !== '=') break;
      valueQuote = char;
    }
    if (char !== ' ' && char !== '\t') previousNonSpace = char;
    cursor += 1;
  }
  return cursor;
}

function redactHttpHeaders(text: string): string {
  const parts: string[] = [];
  let copiedThrough = 0;
  for (const { start, end, scheme } of httpHeaderValues(text)) {
    parts.push(text.slice(copiedThrough, start), scheme === undefined ? REDACTED_VALUE : scheme + ' ' + REDACTED_VALUE);
    copiedThrough = end;
  }
  parts.push(text.slice(copiedThrough));
  return parts.join('');
}

export function sanitizeSensitiveText(text: string): string {
  if (!text) return text;
  const sanitized = text
    .replace(PEM_PRIVATE_KEY_REGEX, REDACTED_VALUE)
    .replace(SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX, (_match, prefix: string, quotedValue: string) => {
      const quote = quotedValue[0];
      return `${prefix}${quote}${REDACTED_VALUE}${quote}`;
    })
    .replace(URL_USERINFO_CREDENTIALS_REGEX, `$1${REDACTED_VALUE}@`);
  return redactHttpHeaders(sanitized)
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
  for (const match of text.matchAll(SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX)) {
    const quotedValue = match[2]!;
    addSensitiveValue(values, quotedValue);
    // Embedded credentials stay within the assignment's quote boundary.
    collectHttpHeaderSensitiveValues(quotedValue.slice(1, -1), values);
  }
  addMatches(text, SENSITIVE_ASSIGNMENT_BARE_VALUE_REGEX, 2, values);
  addMatches(text, SENSITIVE_HEADER_ASSIGNMENT_BARE_VALUE_REGEX, 2, values);
  addMatches(text, SENSITIVE_HEADER_ASSIGNMENT_COLON_VALUE_REGEX, 2, values);
  addMatches(text, SENSITIVE_OPTION_VALUE_REGEX, 2, values);
  addMatches(text, SENSITIVE_QUERY_VALUE_REGEX, 2, values);
  addMatches(text, KNOWN_TOKEN_REGEX, 0, values);
  collectHttpHeaderSensitiveValues(text, values);
  addMatches(text, URL_USERINFO_CREDENTIALS_REGEX, 2, values, true);
  addMatches(text, CURL_USER_EQUALS_REGEX, 2, values, true);
  addMatches(text, CURL_USER_SPACE_REGEX, 2, values, true);
  addMatches(text, CURL_SHORT_USER_COMPACT_REGEX, 3, values, true);
}

function collectHttpHeaderSensitiveValues(text: string, values: Set<string>): void {
  for (const { start, end } of httpHeaderValues(text)) {
    const value = text.slice(start, end);
    addSensitiveValue(values, value);
    addCredentialComponents(values, value);
  }
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
