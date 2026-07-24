import { createHash } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { isReservedReportFileName, reservedReportFileNameMessage } from '../models/reserved-report-names.js';
import {
  ensurePrivateDirectory,
  readPrivateFileState,
  readRegularFileNoFollow,
  writeNewPrivateFileWithMode,
  writePrivateFile,
  writePrivateFileWithModeExpected,
} from '../../shared/utils/private-file.js';
import { runPrivateFileExclusive } from '../../shared/utils/private-file-lock.js';

const PRIVATE_REPORT_MODE = 0o600;
const PUBLICATION_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface ReportPublicationReceipt {
  publicationId: string;
  targetPath: string;
  targetDevice: string;
  targetInode: string;
  contentSha256: string;
}

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

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertRegularReport(path: string, stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Report path is not a regular file: ${path}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function capturePublicationReceipt(
  targetPath: string,
  publicationId: string,
  contentSha256: string,
  expectedStat?: Stats,
): ReportPublicationReceipt {
  const targetStat = lstatOrUndefined(targetPath);
  if (targetStat === undefined) {
    throw new Error(`Published report is missing: ${targetPath}`);
  }
  assertRegularReport(targetPath, targetStat);
  if (expectedStat !== undefined && !sameFileIdentity(expectedStat, targetStat)) {
    throw new Error(`Report path identity changed after content verification: ${targetPath}`);
  }
  const actualHash = sha256(readRegularFileNoFollow(targetPath, targetStat));
  if (actualHash !== contentSha256) {
    throw new Error(`Published report content hash mismatch: ${targetPath}`);
  }
  return {
    publicationId,
    targetPath,
    targetDevice: String(targetStat.dev),
    targetInode: String(targetStat.ino),
    contentSha256,
  };
}

function assertPublicationId(publicationId: string): void {
  if (!PUBLICATION_ID_PATTERN.test(publicationId)) {
    throw new Error(`Invalid report publication id: ${publicationId}`);
  }
}

function resolveReportTarget(reportDir: string, fileName: string): {
  baseDir: string;
  targetPath: string;
} {
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
  return { baseDir, targetPath };
}

export function writeReportFile(reportDir: string, fileName: string, content: string): string {
  const { baseDir, targetPath } = resolveReportTarget(reportDir, fileName);
  backupExistingReport(baseDir, fileName, targetPath);
  writePrivateFile(targetPath, content);
  return targetPath;
}

export function publishReportFile(input: {
  reportDir: string;
  fileName: string;
  content: string;
  publicationId: string;
  contentSha256: string;
}): ReportPublicationReceipt {
  assertPublicationId(input.publicationId);
  if (sha256(input.content) !== input.contentSha256) {
    throw new Error(`Report publication content hash mismatch for "${input.publicationId}"`);
  }
  const { baseDir, targetPath } = resolveReportTarget(input.reportDir, input.fileName);
  return runPrivateFileExclusive(`${targetPath}.publication.lock`, () => {
    const targetSnapshot = readPrivateFileState(targetPath);
    if (!targetSnapshot.state.exists) {
      writePrivateFileWithModeExpected(
        targetPath,
        input.content,
        PRIVATE_REPORT_MODE,
        targetSnapshot.state,
      );
      return capturePublicationReceipt(
        targetPath,
        input.publicationId,
        input.contentSha256,
      );
    }
    if (!('content' in targetSnapshot)) {
      throw new Error(`Report content is missing from its read snapshot: ${targetPath}`);
    }
    const targetStat = targetSnapshot.state.stat;
    assertRegularReport(targetPath, targetStat);
    const currentContent = targetSnapshot.content;
    if (sha256(currentContent) === input.contentSha256) {
      return capturePublicationReceipt(
        targetPath,
        input.publicationId,
        input.contentSha256,
        targetStat,
      );
    }

    const historyPath = resolve(
      baseDir,
      `${input.fileName}.history.${sha256([
        input.publicationId,
        sha256(currentContent),
      ].join('\0'))}`,
    );
    const historyStat = lstatOrUndefined(historyPath);
    if (historyStat === undefined) {
      writeNewPrivateFileWithMode(historyPath, currentContent, PRIVATE_REPORT_MODE);
    } else {
      assertRegularReport(historyPath, historyStat);
      const historyContent = readRegularFileNoFollow(historyPath, historyStat);
      if (!historyContent.equals(currentContent)) {
        throw new Error(
          `Report publication history conflict for "${input.publicationId}": ${historyPath}`,
        );
      }
    }
    writePrivateFileWithModeExpected(
      targetPath,
      input.content,
      PRIVATE_REPORT_MODE,
      targetSnapshot.state,
    );
    return capturePublicationReceipt(
      targetPath,
      input.publicationId,
      input.contentSha256,
    );
  });
}

export function assertReportPublication(
  receipt: ReportPublicationReceipt,
  expected: {
    targetPath: string;
    publicationId: string;
    contentSha256: string;
  },
): void {
  if (receipt.targetPath !== expected.targetPath
    || receipt.publicationId !== expected.publicationId
    || receipt.contentSha256 !== expected.contentSha256) {
    throw new Error(`Report publication receipt does not match "${expected.publicationId}"`);
  }
  const targetStat = lstatOrUndefined(expected.targetPath);
  if (targetStat === undefined) {
    throw new Error(`Published report is missing before manager finalization: ${expected.targetPath}`);
  }
  assertRegularReport(expected.targetPath, targetStat);
  if (String(targetStat.dev) !== receipt.targetDevice
    || String(targetStat.ino) !== receipt.targetInode) {
    throw new Error(`Published report identity changed before manager finalization: ${expected.targetPath}`);
  }
  if (sha256(readRegularFileNoFollow(expected.targetPath, targetStat)) !== expected.contentSha256) {
    throw new Error(`Published report content changed before manager finalization: ${expected.targetPath}`);
  }
}
