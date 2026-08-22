import { createHash } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import {
  classifyReportRelativePath,
  REPORT_INTERNAL_NAMESPACE,
  reportPathRejectionMessage,
} from '../models/reserved-report-names.js';
import {
  ensurePrivateDirectory,
  readPrivateFileState,
  readRegularFileNoFollow,
  publishPrivateFileWithModeExpected,
  writeNewPrivateFileWithMode,
  writePrivateFile,
} from '../../shared/utils/private-file.js';
import { runPrivateFileExclusive } from '../../shared/utils/private-file-lock.js';
import type { ReportPublicationReceipt } from './report-publication.js';

const PRIVATE_REPORT_MODE = 0o600;
const PUBLICATION_ID_PATTERN = /^[a-f0-9]{64}$/;

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

function reportInternalRoot(reportDir: string): string {
  return resolve(reportDir, REPORT_INTERNAL_NAMESPACE);
}

function reportHistoryRoot(reportDir: string, targetPath: string): string {
  return resolve(
    reportInternalRoot(reportDir),
    'history',
    reportStreamId(targetPath),
  );
}

function backupExistingReport(
  reportDir: string,
  fileName: string,
  targetPath: string,
  sanitizeContent?: (content: string) => string,
): void {
  const targetStat = lstatOrUndefined(targetPath);
  if (targetStat === undefined) {
    return;
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`Report path is not a regular file: ${targetPath}`);
  }

  const currentContent = readRegularFileNoFollow(targetPath, targetStat);
  const timestamp = formatHistoryTimestamp(new Date());
  const historyRoot = resolve(reportHistoryRoot(reportDir, targetPath), 'writer');
  ensurePrivateDirectory(historyRoot);
  let sequence = 0;
  let versionedPath = resolve(
    historyRoot,
    buildVersionedFileName(basename(fileName), timestamp, sequence),
  );
  while (lstatOrUndefined(versionedPath) !== undefined) {
    sequence += 1;
    versionedPath = resolve(
      historyRoot,
      buildVersionedFileName(basename(fileName), timestamp, sequence),
    );
  }

  const historyContent = sanitizeContent === undefined
    ? currentContent
    : Buffer.from(sanitizeContent(currentContent.toString('utf8')), 'utf8');
  writeNewPrivateFileWithMode(versionedPath, historyContent, PRIVATE_REPORT_MODE);
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

function reportStreamId(targetPath: string): string {
  return sha256(['filesystem-report', resolve(targetPath)].join('\0'));
}

export function reportPublicationStreamId(targetPath: string): string {
  return reportStreamId(targetPath);
}

function runReportPublicationExclusive<Result>(
  reportDir: string,
  targetPath: string,
  action: () => Result,
): Result {
  const lockRoot = resolve(reportInternalRoot(reportDir), 'locks');
  ensurePrivateDirectory(lockRoot);
  return runPrivateFileExclusive(
    resolve(lockRoot, `${reportStreamId(targetPath)}.lock`),
    action,
  );
}

function capturePublicationReceipt(
  targetPath: string,
  publicationId: string,
  contentSha256: string,
): ReportPublicationReceipt {
  const targetSnapshot = readPrivateFileState(targetPath);
  if (!targetSnapshot.state.exists) {
    throw new Error(`Published report is missing: ${targetPath}`);
  }
  if (!('content' in targetSnapshot)) {
    throw new Error(`Published report content is missing: ${targetPath}`);
  }
  const targetStat = targetSnapshot.state.stat;
  assertRegularReport(targetPath, targetStat);
  const actualHash = sha256(targetSnapshot.content);
  if (actualHash !== contentSha256) {
    throw new Error(`Published report content hash mismatch: ${targetPath}`);
  }
  return {
    publicationId,
    streamId: reportStreamId(targetPath),
    revision: contentSha256,
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
  normalizedFileName: string;
} {
  const classification = classifyReportRelativePath(fileName);
  if (classification.kind !== 'public') {
    throw new Error(`Cannot write report: ${reportPathRejectionMessage(fileName)}`);
  }
  const baseDir = resolve(reportDir);
  const targetPath = resolve(reportDir, classification.normalizedPath);
  const basePrefix = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (!targetPath.startsWith(basePrefix)) {
    throw new Error(`Report file path escapes report directory: ${fileName}`);
  }
  ensurePrivateDirectory(dirname(targetPath));
  return {
    baseDir,
    targetPath,
    normalizedFileName: classification.normalizedPath,
  };
}

export function writeReportFile(
  reportDir: string,
  fileName: string,
  content: string,
  sanitizeContent?: (content: string) => string,
): string {
  const { baseDir, targetPath, normalizedFileName } = resolveReportTarget(reportDir, fileName);
  return runReportPublicationExclusive(baseDir, targetPath, () => {
    const persistedContent = sanitizeContent === undefined ? content : sanitizeContent(content);
    backupExistingReport(baseDir, normalizedFileName, targetPath, sanitizeContent);
    writePrivateFile(targetPath, persistedContent);
    return targetPath;
  });
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
  return runReportPublicationExclusive(baseDir, targetPath, () => {
    const targetSnapshot = readPrivateFileState(targetPath);
    if (!targetSnapshot.state.exists) {
      publishPrivateFileWithModeExpected(
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
      );
    }

    const historyRoot = resolve(reportHistoryRoot(baseDir, targetPath), 'publication');
    ensurePrivateDirectory(historyRoot);
    const historyPath = resolve(
      historyRoot,
      sha256([
        input.publicationId,
        sha256(currentContent),
      ].join('\0')),
    );
    const historySnapshot = readPrivateFileState(historyPath);
    if (!historySnapshot.state.exists) {
      writeNewPrivateFileWithMode(historyPath, currentContent, PRIVATE_REPORT_MODE);
    } else {
      if (!('content' in historySnapshot)) {
        throw new Error(`Report publication history content is missing: ${historyPath}`);
      }
      const historyStat = historySnapshot.state.stat;
      assertRegularReport(historyPath, historyStat);
      const historyContent = historySnapshot.content;
      if (!historyContent.equals(currentContent)) {
        throw new Error(
          `Report publication history conflict for "${input.publicationId}": ${historyPath}`,
        );
      }
    }
    publishPrivateFileWithModeExpected(
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

function assertReportPublicationLocked(
  receipt: ReportPublicationReceipt,
  expected: {
    reportDir: string;
    targetPath: string;
    publicationId: string;
    contentSha256: string;
  },
): void {
  if (receipt.publicationId !== expected.publicationId
    || receipt.streamId !== reportStreamId(expected.targetPath)
    || receipt.revision !== expected.contentSha256
    || receipt.contentSha256 !== expected.contentSha256) {
    throw new Error(`Report publication receipt does not match "${expected.publicationId}"`);
  }
  const targetSnapshot = readPrivateFileState(expected.targetPath);
  if (!targetSnapshot.state.exists) {
    throw new Error(`Published report is missing before manager finalization: ${expected.targetPath}`);
  }
  if (!('content' in targetSnapshot)) {
    throw new Error(`Published report content is missing before manager finalization: ${expected.targetPath}`);
  }
  const targetStat = targetSnapshot.state.stat;
  assertRegularReport(expected.targetPath, targetStat);
  if (sha256(targetSnapshot.content) !== expected.contentSha256) {
    throw new Error(`Published report content changed before manager finalization: ${expected.targetPath}`);
  }
}

export function finalizeReportPublication<Result>(
  receipt: ReportPublicationReceipt,
  expected: {
    reportDir: string;
    targetPath: string;
    publicationId: string;
    contentSha256: string;
  },
  finalize: () => Result,
): Result {
  const resolvedTarget = resolveReportTarget(
    expected.reportDir,
    relative(resolve(expected.reportDir), resolve(expected.targetPath)),
  );
  return runReportPublicationExclusive(
    resolvedTarget.baseDir,
    resolvedTarget.targetPath,
    () => {
      assertReportPublicationLocked(receipt, expected);
      return finalize();
    },
  );
}
