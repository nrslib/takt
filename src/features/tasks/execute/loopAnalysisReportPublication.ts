import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import { readPrivateFileState, writePrivateFile } from '../../../shared/utils/private-file.js';
import { sanitizePathText } from '../../../shared/utils/pathText.js';

const EMAIL_ADDRESS_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4_ADDRESS_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IDENTIFYING_FIELD_PATTERN = new RegExp(
  String.raw`^(\s*(?:[-*]\s*)?(?:runner[ _-]?(?:id|name|temp|tool[ _-]?cache)|host[ _-]?name|machine[ _-]?name|user[ _-]?name|e-?mail|phone|telephone|home)\s*[:=]\s*).+$`,
  'gim',
);

function appendLoopAnalysisSourceRunReference(
  report: string,
  sourceRunSlug: string,
): string {
  const sourceRunReference = `source run: ${sourceRunSlug}`;
  const reportWithoutTrailingNewlines = report.replace(/(?:\r\n|\n)+$/, '');
  if (
    reportWithoutTrailingNewlines === sourceRunReference
    || reportWithoutTrailingNewlines.endsWith(`\n${sourceRunReference}`)
  ) {
    return `${reportWithoutTrailingNewlines}\n`;
  }
  return `${reportWithoutTrailingNewlines}\n${sourceRunReference}\n`;
}

export function prepareLoopAnalysisReportForPublication(
  report: string,
  sourceRunSlug: string,
): string {
  return appendLoopAnalysisSourceRunReference(
    sanitizeLoopAnalysisReportForPublication(report),
    sourceRunSlug,
  );
}

export function prepareLoopAnalysisReportFileForPublication(
  reportPath: string,
  sourceRunSlug: string,
): void {
  const snapshot = readPrivateFileState(reportPath);
  if (!('content' in snapshot)) {
    throw new Error('Loop analysis report is no longer available');
  }
  const report = snapshot.content.toString('utf8');
  const preparedReport = prepareLoopAnalysisReportForPublication(report, sourceRunSlug);
  if (preparedReport !== report) {
    writePrivateFile(reportPath, preparedReport);
  }
}

export function sanitizeLoopAnalysisReportForPublication(report: string): string {
  return sanitizePathText(sanitizeSensitiveText(report))
    .replace(EMAIL_ADDRESS_PATTERN, '[PII]')
    .replace(IPV4_ADDRESS_PATTERN, '[PII]')
    .replace(IDENTIFYING_FIELD_PATTERN, '$1[PII]');
}
