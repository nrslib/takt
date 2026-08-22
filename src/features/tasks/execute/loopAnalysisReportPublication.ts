import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';

const POSIX_ABSOLUTE_PATH_PATTERN = /(?<![\w:/])\/[^\s'"`<>|]*/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /[A-Za-z]:[\\/][^\s'"`<>|]*/g;
const FILE_URL_PATTERN = /file:\/\/[^\s'"`<>|]*/gi;
const EMAIL_ADDRESS_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4_ADDRESS_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IDENTIFYING_FIELD_PATTERN = new RegExp(
  String.raw`^(\s*(?:[-*]\s*)?(?:runner[ _-]?(?:id|name|temp|tool[ _-]?cache)|host[ _-]?name|machine[ _-]?name|user[ _-]?name|e-?mail|phone|telephone|home)\s*[:=]\s*).+$`,
  'gim',
);

export function sanitizeLoopAnalysisReportForPublication(report: string): string {
  return sanitizeSensitiveText(report)
    .replace(FILE_URL_PATTERN, '[path]')
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, '[path]')
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, '[path]')
    .replace(EMAIL_ADDRESS_PATTERN, '[PII]')
    .replace(IPV4_ADDRESS_PATTERN, '[PII]')
    .replace(IDENTIFYING_FIELD_PATTERN, '$1[PII]');
}
