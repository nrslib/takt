const SENSITIVE_KEY_PATTERN = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|token|password|secret|access[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)[A-Za-z0-9_.-]*`;
const SENSITIVE_QUOTED_VALUE_PATTERN = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX = new RegExp(
  String.raw`(["']?(?:${SENSITIVE_KEY_PATTERN})["']?\s*[:=]\s*)(${SENSITIVE_QUOTED_VALUE_PATTERN})`,
  'gi',
);
const SENSITIVE_ASSIGNMENT_BARE_VALUE_REGEX = new RegExp(
  String.raw`(["']?(?:${SENSITIVE_KEY_PATTERN})["']?\s*[:=]\s*["']?)([^"'[,\s}\]]+)(["']?)`,
  'gi',
);
const SENSITIVE_OPTION_VALUE_REGEX = new RegExp(
  String.raw`(--(?:${SENSITIVE_KEY_PATTERN})(?:=|\s+))(${SENSITIVE_QUOTED_VALUE_PATTERN}|[^\s]+)`,
  'gi',
);
const HTTP_AUTHORIZATION_HEADER_REGEX = /\b(Authorization\s*:\s*)([^"'\r\n]+)/gi;
const HTTP_COOKIE_HEADER_REGEX = /\b((?:Set-)?Cookie\s*:\s*)([^"'\r\n]+)/gi;
const URL_USERINFO_CREDENTIALS_REGEX = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s@]+:[^/?#\s@]+)@/g;
const CURL_USER_EQUALS_REGEX = /(\B--(?:proxy-)?user=)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi;
const CURL_USER_SPACE_REGEX = /(\B(?:-u|--(?:proxy-)?user)\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi;
const CURL_SHORT_USER_COMPACT_REGEX = /(^|\s)(-u)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi;

export function sanitizeSensitiveText(text: string): string {
  if (!text) return text;
  return text
    .replace(SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX, (_match, prefix: string, quotedValue: string) => {
      const quote = quotedValue[0];
      return `${prefix}${quote}[REDACTED]${quote}`;
    })
    .replace(URL_USERINFO_CREDENTIALS_REGEX, '$1[REDACTED]@')
    .replace(HTTP_AUTHORIZATION_HEADER_REGEX, (_match, prefix: string, value: string) => {
      const leadingWhitespaceLength = value.length - value.trimStart().length;
      const leadingWhitespace = value.slice(0, leadingWhitespaceLength);
      const trimmed = value.slice(leadingWhitespaceLength);
      const authScheme = /^([A-Za-z]+)\s+/.exec(trimmed);
      if (authScheme) {
        return `${prefix}${leadingWhitespace}${authScheme[1]} [REDACTED]`;
      }
      return `${prefix}${leadingWhitespace}[REDACTED]`;
    })
    .replace(HTTP_COOKIE_HEADER_REGEX, '$1[REDACTED]')
    .replace(CURL_USER_EQUALS_REGEX, '$1[REDACTED]')
    .replace(CURL_USER_SPACE_REGEX, '$1[REDACTED]')
    .replace(CURL_SHORT_USER_COMPACT_REGEX, '$1$2[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT_BARE_VALUE_REGEX, '$1[REDACTED]$3')
    .replace(SENSITIVE_OPTION_VALUE_REGEX, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)([^&\s]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED]');
}
