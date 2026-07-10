const SENSITIVE_KEY_PATTERN = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|token|password|secret|access[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)[A-Za-z0-9_.-]*`;
// HTTP ヘッダー名は SENSITIVE_KEY_PATTERN の語彙（api_key/token/password 等）に
// 含まれないため、オブジェクトのキー名として判定する isSensitiveKeyName() 用に
// 別途列挙する（"Authorization" 自体は "token" 等の部分文字列を含まない）。
const SENSITIVE_HEADER_KEY_PATTERN = String.raw`authorization|(?:set-)?cookie`;
// オブジェクトのキー名がまるごと機密キーに一致するかどうかの判定用。
// SENSITIVE_KEY_PATTERN は「キー: 値」というテキスト中の並びを検出するために
// 前後の余分な文字を許容する形（部分一致寄り）で作られているため、そのまま
// 完全一致判定に使ってもキー名の判定として機能する。
const SENSITIVE_KEY_NAME_REGEX = new RegExp(
  String.raw`^(?:${SENSITIVE_KEY_PATTERN}|${SENSITIVE_HEADER_KEY_PATTERN})$`,
  'i',
);
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

/**
 * オブジェクトのキー名が機密情報を保持するキーかどうかを判定する。
 *
 * sanitizeSensitiveText() はテキスト全体の中で「キー名: 値」という並びを
 * 正規表現で見つけてマスクする実装であり、値を単独の文字列として渡すと
 * キーの文脈が失われる（実測: sanitizeSensitiveText("hunter2") や
 * sanitizeSensitiveText("Bearer opaque-value") はマスクされない）。オブジェクトを
 * 再帰的に走査してログへ残す場合は、この関数でキー名から機密性を判定し、
 * 該当すれば値の形式によらず丸ごとマスクする必要がある。
 */
export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEY_NAME_REGEX.test(key);
}
