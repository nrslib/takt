import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  createPrivateArtifact as createPrivateArtifactAtBoundary,
  publishPrivateArtifact as publishPrivateArtifactAtBoundary,
  PrivateArtifactPublicationConflictError,
} from './private-artifact-backend.js';
import {
  publishPrivateDirectoryBackend as publishPrivateDirectoryAtBoundary,
  removePrivateDirectoryBackend as removePrivateDirectoryAtBoundary,
} from './private-directory-backend.js';
import {
  artifactBoundary,
  assertAncestorIdentities,
  assertSafePath,
  hasMatchingDirectoryIdentity,
  hasMatchingIdentity,
  inspectPrivateArtifactPath,
  lstatOrUndefined,
  type DirectoryIdentity,
} from './private-path-identity.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;

interface ExistingFilePreparation {
  descriptor: number;
  originalMode: number;
}

export { PrivateArtifactPublicationConflictError };

export interface PrivateDirectoryReadSnapshot {
  readonly path: string;
  readonly stat: Stats;
  readonly ancestorIdentities: readonly DirectoryIdentity[];
}

function createPrivateArtifact(
  parentPath: string,
  targetPath: string,
  parentStat: Stats,
  kind: 'directory' | 'file',
  mode: number,
): Stats {
  const identity = createPrivateArtifactAtBoundary(parentPath, targetPath, parentStat, kind, mode);
  const createdStat = lstatSync(targetPath) as Stats;
  const expectedKind = kind === 'directory' ? createdStat.isDirectory() : createdStat.isFile();
  if (!expectedKind || String(createdStat.dev) !== identity.dev || String(createdStat.ino) !== identity.ino) {
    throw new Error(`Private artifact identity changed after creation: ${targetPath}`);
  }
  return createdStat;
}


export function ensurePrivateDirectory(directoryPath: string): void {
  const absolute = resolve(directoryPath);
  const { trustedRoot } = artifactBoundary(absolute);
  assertSafePath(absolute, true);
  let current = trustedRoot;
  for (const component of relative(trustedRoot, absolute).split(sep).filter(Boolean)) {
    const parentPath = current;
    const parentStat = current === trustedRoot ? statSync(current) as Stats : lstatSync(current) as Stats;
    current = join(parentPath, component);
    if (lstatOrUndefined(current) === undefined) {
      createPrivateArtifact(parentPath, current, parentStat, 'directory', PRIVATE_DIRECTORY_MODE);
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Private artifact directory is unsafe: ${current}`);
    }
  }
  setPrivateDirectoryMode(absolute);
}

export function repairPrivateDirectory(directoryPath: string): void {
  const absolute = resolve(directoryPath);
  setPrivateDirectoryMode(absolute);
}

function setPrivateDirectoryMode(directoryPath: string): void {
  const { ancestorIdentities, expectedStat } = inspectPrivateArtifactPath(directoryPath, 'directory');
  if (expectedStat === undefined) {
    throw new Error(`Private artifact path is not a directory: ${directoryPath}`);
  }
  const descriptor = openSync(
    directoryPath,
    constants.O_RDONLY | NO_FOLLOW_FLAG | DIRECTORY_FLAG,
  );
  try {
    const openedStat = fstatSync(descriptor);
    if (!openedStat.isDirectory() || !hasMatchingDirectoryIdentity(expectedStat, openedStat)) {
      throw new Error(`Private artifact directory identity changed while opening: ${directoryPath}`);
    }
    assertAncestorIdentities(ancestorIdentities);
    fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
  } finally {
    closeSync(descriptor);
  }
}

function openPrivateFileForAppend(
  filePath: string,
  mode: number,
): number {
  const absolute = resolve(filePath);
  const inspection = inspectPrivateArtifactPath(absolute, 'file');
  let expectedStat = inspection.expectedStat;
  let createdStat: Stats | undefined;
  if (expectedStat === undefined) {
    const parentIdentity = inspection.ancestorIdentities.at(-1);
    if (parentIdentity === undefined) {
      throw new Error(`Private artifact parent identity is missing: ${absolute}`);
    }
    createdStat = createPrivateArtifact(
      dirname(absolute),
      absolute,
      parentIdentity.stat,
      'file',
      mode,
    );
    expectedStat = createdStat;
    assertAncestorIdentities(inspection.ancestorIdentities);
  }
  const existingFile = inspection.expectedStat === undefined
    ? undefined
    : prepareExistingFileForWrite(absolute, inspection.expectedStat, inspection.ancestorIdentities, mode);
  let descriptor: number;
  try {
    descriptor = openSync(
      absolute,
      constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW_FLAG,
      mode,
    );
  } catch (error) {
    if (existingFile !== undefined) {
      restoreAndCloseExistingFile(existingFile);
    }
    if (createdStat !== undefined) {
      throw new Error(`Private artifact file identity changed while opening: ${absolute}`, { cause: error });
    }
    throw error;
  }
  try {
    assertOpenedFileIdentity(descriptor, absolute, expectedStat);
    assertAncestorIdentities(inspection.ancestorIdentities);
    fchmodSync(descriptor, mode);
  } catch (error) {
    restoreExistingFileAndCloseDescriptors(existingFile, descriptor);
    throw error;
  }
  closeExistingFilePreparation(existingFile, descriptor);
  return descriptor;
}

function prepareExistingFileForWrite(
  path: string,
  expectedStat: Stats,
  ancestorIdentities: readonly DirectoryIdentity[],
  mode: number,
): ExistingFilePreparation {
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW_FLAG);
  const originalMode = expectedStat.mode & 0o7777;
  let permissionMayHaveChanged = false;
  try {
    assertOpenedFileIdentity(descriptor, path, expectedStat);
    assertAncestorIdentities(ancestorIdentities);
    permissionMayHaveChanged = true;
    fchmodSync(descriptor, mode | 0o200);
    return { descriptor, originalMode };
  } catch (error) {
    try {
      if (permissionMayHaveChanged) {
        fchmodSync(descriptor, originalMode);
      }
    } finally {
      closeSync(descriptor);
    }
    throw error;
  }
}

function restoreAndCloseExistingFile(existingFile: ExistingFilePreparation): void {
  try {
    fchmodSync(existingFile.descriptor, existingFile.originalMode);
  } finally {
    closeSync(existingFile.descriptor);
  }
}

function restoreExistingFileAndCloseDescriptors(
  existingFile: ExistingFilePreparation | undefined,
  writeDescriptor: number,
): void {
  try {
    if (existingFile !== undefined) {
      fchmodSync(existingFile.descriptor, existingFile.originalMode);
    }
  } finally {
    try {
      closeSync(writeDescriptor);
    } finally {
      if (existingFile !== undefined) {
        closeSync(existingFile.descriptor);
      }
    }
  }
}

function closeExistingFilePreparation(
  existingFile: ExistingFilePreparation | undefined,
  writeDescriptor: number,
): void {
  if (existingFile === undefined) {
    return;
  }
  try {
    closeSync(existingFile.descriptor);
  } catch (error) {
    try {
      fchmodSync(writeDescriptor, existingFile.originalMode);
    } finally {
      closeSync(writeDescriptor);
    }
    throw error;
  }
}

function assertOpenedFileIdentity(descriptor: number, path: string, expectedStat: Stats | undefined): void {
  const openedStat = fstatSync(descriptor);
  if (!openedStat.isFile() || (expectedStat !== undefined && !hasMatchingIdentity(expectedStat, openedStat))) {
    throw new Error(`Private artifact file identity changed while opening: ${path}`);
  }
}

function assertPublicationTargetIdentity(path: string, expectedStat: Stats | undefined): void {
  const actualStat = lstatOrUndefined(path);
  if (expectedStat === undefined) {
    if (actualStat !== undefined) {
      throw new Error(`Private artifact file identity changed before publication: ${path}`);
    }
    return;
  }
  if (actualStat === undefined || !actualStat.isFile() || !hasMatchingIdentity(expectedStat, actualStat)) {
    throw new Error(`Private artifact file identity changed before publication: ${path}`);
  }
}

function assertTemporaryFileIdentity(path: string, expectedStat: Stats): void {
  const actualStat = lstatOrUndefined(path);
  if (actualStat === undefined || !actualStat.isFile() || !hasMatchingIdentity(expectedStat, actualStat)) {
    throw new Error(`Private artifact temporary file identity changed before publication: ${path}`);
  }
}

function verifyExistingPublicationTarget(
  path: string,
  expectedStat: Stats,
  ancestorIdentities: readonly DirectoryIdentity[],
): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW_FLAG);
  } catch (error) {
    assertAncestorIdentities(ancestorIdentities);
    throw error;
  }
  try {
    assertOpenedFileIdentity(descriptor, path, expectedStat);
    assertAncestorIdentities(ancestorIdentities);
  } finally {
    closeSync(descriptor);
  }
}

function openTemporaryPrivateFile(
  path: string,
  ancestorIdentities: readonly DirectoryIdentity[],
): number {
  try {
    return openSync(path, constants.O_WRONLY | NO_FOLLOW_FLAG);
  } catch (error) {
    assertAncestorIdentities(ancestorIdentities);
    throw error;
  }
}

function removeTemporaryFile(
  path: string,
  expectedStat: Stats,
  ancestorIdentities: readonly DirectoryIdentity[],
): void {
  const actualStat = lstatOrUndefined(path);
  if (actualStat === undefined) {
    return;
  }
  assertAncestorIdentities(ancestorIdentities);
  if (!actualStat.isFile() || !hasMatchingIdentity(expectedStat, actualStat)) {
    throw new Error(`Private artifact temporary file identity changed before cleanup: ${path}`);
  }
  unlinkSync(path);
}

function executeWithCleanup(action: () => void, cleanup: () => void, aggregateMessage: string): void {
  let actionFailed = false;
  let actionError: unknown;
  try {
    action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (actionFailed && cleanupFailed) {
    throw new AggregateError([actionError, cleanupError], aggregateMessage);
  }
  if (actionFailed) {
    throw actionError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
}

function writePrivateFileAtomically(
  filePath: string,
  content: string | Buffer,
  mode: number,
  rejectExisting: boolean,
  publicationGuard?: () => boolean,
): boolean {
  const absolute = resolve(filePath);
  const inspection = inspectPrivateArtifactPath(absolute, 'file');
  if (rejectExisting && inspection.expectedStat !== undefined) {
    throw new Error(`Private artifact file already exists: ${absolute}`);
  }
  const parentIdentity = inspection.ancestorIdentities.at(-1);
  if (parentIdentity === undefined) {
    throw new Error(`Private artifact parent identity is missing: ${absolute}`);
  }
  const temporaryPath = join(
    dirname(absolute),
    `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryStat: Stats | undefined;
  let published = false;
  executeWithCleanup(
    () => {
      if (inspection.expectedStat !== undefined) {
        verifyExistingPublicationTarget(
          absolute,
          inspection.expectedStat,
          inspection.ancestorIdentities,
        );
      }
      const createdStat = createPrivateArtifact(
        dirname(absolute),
        temporaryPath,
        parentIdentity.stat,
        'file',
        mode,
      );
      temporaryStat = createdStat;
      const descriptor = openTemporaryPrivateFile(temporaryPath, inspection.ancestorIdentities);
      executeWithCleanup(
        () => {
          assertOpenedFileIdentity(descriptor, temporaryPath, createdStat);
          assertAncestorIdentities(inspection.ancestorIdentities);
          fchmodSync(descriptor, mode);
          ftruncateSync(descriptor, 0);
          writeFileSync(descriptor, content, { encoding: 'utf-8' });
        },
        () => closeSync(descriptor),
        `Private artifact write and descriptor cleanup both failed: ${absolute}`,
      );

      assertAncestorIdentities(inspection.ancestorIdentities);
      assertPublicationTargetIdentity(absolute, inspection.expectedStat);
      assertTemporaryFileIdentity(temporaryPath, createdStat);
      if (publicationGuard !== undefined && !publicationGuard()) {
        return;
      }
      publishPrivateArtifactAtBoundary(
        dirname(absolute),
        temporaryPath,
        absolute,
        parentIdentity.stat,
        createdStat,
        inspection.expectedStat,
        mode,
      );
      published = true;
    },
    () => {
      if (!published && temporaryStat !== undefined) {
        removeTemporaryFile(temporaryPath, temporaryStat, inspection.ancestorIdentities);
      }
    },
    `Private artifact write and temporary-file cleanup both failed: ${absolute}`,
  );
  return published;
}

export function readRegularFileNoFollow(filePath: string, expectedStat: Stats): Buffer {
  const absolute = resolve(filePath);
  const descriptor = openSync(absolute, constants.O_RDONLY | NO_FOLLOW_FLAG);
  try {
    const openedStat = fstatSync(descriptor);
    if (!openedStat.isFile() || !hasMatchingIdentity(expectedStat, openedStat)) {
      throw new Error(`File identity changed while opening: ${absolute}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function capturePrivateDirectoryReadSnapshot(directoryPath: string): PrivateDirectoryReadSnapshot {
  const absolute = resolve(directoryPath);
  const inspection = inspectPrivateArtifactPath(absolute, 'directory');
  if (inspection.expectedStat === undefined) {
    throw new Error(`Private artifact path is not a directory: ${absolute}`);
  }
  return {
    path: absolute,
    stat: inspection.expectedStat,
    ancestorIdentities: inspection.ancestorIdentities,
  };
}

export function assertPrivateDirectoryReadSnapshot(snapshot: PrivateDirectoryReadSnapshot): void {
  assertAncestorIdentities(snapshot.ancestorIdentities);
  const current = lstatSync(snapshot.path) as Stats;
  if (!current.isDirectory() || !hasMatchingDirectoryIdentity(snapshot.stat, current)) {
    throw new Error(`Private artifact directory identity changed during traversal: ${snapshot.path}`);
  }
}

export function publishPrivateDirectory(
  parentPath: string,
  stagingPath: string,
  targetPath: string,
  parentStat: Stats,
  stagingStat: Stats,
  targetStat: Stats | undefined,
): void {
  publishPrivateDirectoryAtBoundary(
    parentPath,
    stagingPath,
    targetPath,
    parentStat,
    stagingStat,
    targetStat,
  );
}

export function removePrivateDirectory(
  parentPath: string,
  stagingPath: string,
  parentStat: Stats,
  stagingStat: Stats,
): void {
  removePrivateDirectoryAtBoundary(parentPath, stagingPath, parentStat, stagingStat);
}

export function appendPrivateFile(filePath: string, content: string): void {
  const descriptor = openPrivateFileForAppend(filePath, PRIVATE_FILE_MODE);
  try {
    appendFileSync(descriptor, content, { encoding: 'utf-8' });
  } finally {
    closeSync(descriptor);
  }
}

export function writePrivateFile(filePath: string, content: string): void {
  writePrivateFileWithMode(filePath, content, PRIVATE_FILE_MODE);
}

export function writePrivateFileWithMode(filePath: string, content: string | Buffer, mode: number): void {
  writePrivateFileAtomically(filePath, content, mode, false);
}

export function writePrivateFileWithModeGuarded(
  filePath: string,
  content: string | Buffer,
  mode: number,
  publicationGuard: () => boolean,
): boolean {
  return writePrivateFileAtomically(filePath, content, mode, false, publicationGuard);
}

export function writeNewPrivateFileWithMode(filePath: string, content: string | Buffer, mode: number): void {
  writePrivateFileAtomically(filePath, content, mode, true);
}
