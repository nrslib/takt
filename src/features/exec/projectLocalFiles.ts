import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { assertPathSegmentsAreSafe, isRealPathInside, lstatIfExists } from '../../shared/utils/index.js';

const OPEN_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function buildBoundaryError(label: string, path: string): Error {
  return new Error(`Project-local ${label} must stay inside the project and must not use symlinks: ${path}`);
}

function assertExistingSegmentsAreSafe(cwd: string, targetPath: string, label: string): void {
  assertPathSegmentsAreSafe(
    cwd,
    targetPath,
    (_violation, segmentPath) => buildBoundaryError(label, segmentPath),
    { rejectSamePath: true },
  );
}

function prepareProjectLocalDirectory(cwd: string, dirPath: string, label: string): void {
  assertExistingSegmentsAreSafe(cwd, dirPath, label);
  mkdirSync(dirPath, { recursive: true });
  assertExistingSegmentsAreSafe(cwd, dirPath, label);
  const stats = lstatSync(dirPath);
  if (!stats.isDirectory()) {
    throw buildBoundaryError(label, dirPath);
  }
  if (!isRealPathInside(cwd, dirPath)) {
    throw buildBoundaryError(label, dirPath);
  }
}

function assertProjectLocalFileTarget(cwd: string, filePath: string, label: string): void {
  assertExistingSegmentsAreSafe(cwd, filePath, label);
  if (!isRealPathInside(cwd, dirname(filePath))) {
    throw buildBoundaryError(label, filePath);
  }
  const stats = lstatIfExists(filePath);
  if (stats === null) {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw buildBoundaryError(label, filePath);
  }
}

export function projectLocalFileExists(cwd: string, filePath: string, label: string): boolean {
  const stats = lstatIfExists(filePath);
  if (stats === null) {
    assertExistingSegmentsAreSafe(cwd, filePath, label);
    return false;
  }
  assertProjectLocalFileTarget(cwd, filePath, label);
  return true;
}

export function listProjectLocalDirectoryEntries(cwd: string, dirPath: string, label: string): string[] {
  assertExistingSegmentsAreSafe(cwd, dirPath, label);
  if (!existsSync(dirPath)) {
    return [];
  }
  const stats = lstatSync(dirPath);
  if (!stats.isDirectory() || !isRealPathInside(cwd, dirPath)) {
    throw buildBoundaryError(label, dirPath);
  }
  return readdirSync(dirPath);
}

export function readProjectLocalTextFile(cwd: string, filePath: string, label: string): string {
  let fileDescriptor: number | undefined;
  try {
    assertProjectLocalFileTarget(cwd, filePath, label);
    fileDescriptor = openSync(filePath, constants.O_RDONLY | OPEN_NOFOLLOW);
    const stats = fstatSync(fileDescriptor);
    if (!stats.isFile()) {
      throw buildBoundaryError(label, filePath);
    }
    return readFileSync(fileDescriptor, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw buildBoundaryError(label, filePath);
    }
    throw error;
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

export function writeProjectLocalTextFile(cwd: string, filePath: string, content: string, label: string): void {
  const parentDir = dirname(filePath);
  prepareProjectLocalDirectory(cwd, parentDir, label);
  assertProjectLocalFileTarget(cwd, filePath, label);

  const tempPath = join(parentDir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | OPEN_NOFOLLOW, 0o600);
    writeFileSync(fileDescriptor, content, 'utf-8');
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    assertProjectLocalFileTarget(cwd, filePath, label);
    renameSync(tempPath, filePath);
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
    rmSync(tempPath, { force: true });
  }
}

export function deleteProjectLocalFile(cwd: string, filePath: string, label: string): void {
  assertProjectLocalFileTarget(cwd, filePath, label);
  unlinkSync(filePath);
}
