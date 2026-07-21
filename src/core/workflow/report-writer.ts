import { lstatSync, type Stats } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { isReservedReportFileName, reservedReportFileNameMessage } from '../models/reserved-report-names.js';
import {
  ensurePrivateDirectory,
  readRegularFileNoFollow,
  writeNewPrivateFileWithMode,
  writePrivateFile,
} from '../../shared/utils/private-file.js';

const PRIVATE_REPORT_MODE = 0o600;

function formatHistoryTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

function buildVersionedFileName(fileName: string, timestamp: string, sequence: number): string {
  const duplicateSuffix = sequence === 0 ? '' : `.${sequence}`;
  return `${fileName}.${timestamp}${duplicateSuffix}`;
}

function backupExistingReport(reportDir: string, fileName: string, targetPath: string): void {
  const targetStat = lstatOrUndefined(targetPath);
  if (targetStat === undefined) {
    return;
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`Report path is not a regular file: ${targetPath}`);
  }

  const currentContent = readRegularFileNoFollow(targetPath, targetStat);
  const timestamp = formatHistoryTimestamp(new Date());
  let sequence = 0;
  let versionedPath = resolve(reportDir, buildVersionedFileName(fileName, timestamp, sequence));
  while (lstatOrUndefined(versionedPath) !== undefined) {
    sequence += 1;
    versionedPath = resolve(reportDir, buildVersionedFileName(fileName, timestamp, sequence));
  }

  writeNewPrivateFileWithMode(versionedPath, currentContent, PRIVATE_REPORT_MODE);
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path) as Stats;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
}

export function writeReportFile(reportDir: string, fileName: string, content: string): string {
  // 予約名（resume スナップショット manifest）への書き込みは防御の第二層と
  // して明示エラーで拒否する（第一層は出力契約の Zod 検証）。
  if (isReservedReportFileName(fileName)) {
    throw new Error(`Cannot write report: ${reservedReportFileNameMessage(fileName)}`);
  }
  const baseDir = resolve(reportDir);
  const targetPath = resolve(reportDir, fileName);
  const basePrefix = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (!targetPath.startsWith(basePrefix)) {
    throw new Error(`Report file path escapes report directory: ${fileName}`);
  }
  ensurePrivateDirectory(dirname(targetPath));
  backupExistingReport(baseDir, fileName, targetPath);
  writePrivateFile(targetPath, content);
  return targetPath;
}
