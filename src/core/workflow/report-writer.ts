import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

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
  if (!existsSync(targetPath)) {
    return;
  }

  const currentContent = readFileSync(targetPath, 'utf-8');
  const timestamp = formatHistoryTimestamp(new Date());
  let sequence = 0;
  let versionedPath = resolve(reportDir, buildVersionedFileName(fileName, timestamp, sequence));
  while (existsSync(versionedPath)) {
    sequence += 1;
    versionedPath = resolve(reportDir, buildVersionedFileName(fileName, timestamp, sequence));
  }

  writeFileSync(versionedPath, currentContent);
}

export function writeReportFile(reportDir: string, fileName: string, content: string): string {
  const baseDir = resolve(reportDir);
  const targetPath = resolve(reportDir, fileName);
  const basePrefix = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (!targetPath.startsWith(basePrefix)) {
    throw new Error(`Report file path escapes report directory: ${fileName}`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  backupExistingReport(baseDir, fileName, targetPath);
  writeFileSync(targetPath, content);
  return targetPath;
}
