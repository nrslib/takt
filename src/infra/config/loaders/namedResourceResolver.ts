import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isPathInside } from '../../../shared/utils/pathBoundary.js';

interface ResolveNamedResourceOptions {
  candidateDirs: readonly string[];
  extensions: readonly string[];
  fileAccess?: NamedResourceFileAccess;
  rejectSymlinkedCandidateDirs?: boolean;
}

export interface ResolvedNamedResource {
  path: string;
  candidateDir: string;
  candidateDirIndex: number;
}

export interface NamedResourceFileAccess {
  exists(path: string): boolean;
  realpath(path: string): string;
  isSymlink?(path: string): boolean;
}

const nodeFileAccess: NamedResourceFileAccess = {
  exists: (path) => existsSync(path),
  realpath: (path) => realpathSync(path),
  isSymlink: (path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
};

function assertBareResourceName(name: string): void {
  if (
    name.length === 0
    || isAbsolute(name)
    || name.includes('/')
    || name.includes('\\')
    || name.includes('..')
    || name.trim() !== name
    // eslint-disable-next-line no-control-regex
    || /[\u0000-\u001f\u007f-\u009f]/.test(name)
  ) {
    throw new Error(`Configuration error: named resource must be a bare name: ${name}`);
  }
}

function assertResourceStaysInsideCandidateDir(
  name: string,
  filePath: string,
  candidateDir: string,
  fileAccess: NamedResourceFileAccess,
): void {
  const realFilePath = fileAccess.realpath(filePath);
  const realCandidateDir = fileAccess.realpath(candidateDir);
  if (!isPathInside(realCandidateDir, realFilePath)) {
    throw new Error(`Configuration error: named resource must stay inside its candidate directory: ${name} (candidate file: ${filePath}; candidate root: ${candidateDir})`);
  }
}

function assertCandidateDirIsNotSymlink(
  name: string,
  candidateDir: string,
  fileAccess: NamedResourceFileAccess,
): void {
  const isSymlink = fileAccess.isSymlink?.(candidateDir) === true;
  if (isSymlink) {
    throw new Error(`Configuration error: named resource candidate directory must not be a symlink: ${name} (candidate root: ${candidateDir})`);
  }
}

export function resolveNamedResourceWithSource(
  name: string,
  options: ResolveNamedResourceOptions,
): ResolvedNamedResource | undefined {
  assertBareResourceName(name);
  const fileAccess = options.fileAccess ?? nodeFileAccess;

  for (const [candidateDirIndex, dir] of options.candidateDirs.entries()) {
    if (options.rejectSymlinkedCandidateDirs) {
      assertCandidateDirIsNotSymlink(name, dir, fileAccess);
    }
    for (const extension of options.extensions) {
      const filePath = resolve(dir, `${name}${extension}`);
      if (fileAccess.exists(filePath)) {
        assertCandidateDirIsNotSymlink(name, dir, fileAccess);
        assertResourceStaysInsideCandidateDir(name, filePath, dir, fileAccess);
        return {
          path: filePath,
          candidateDir: dir,
          candidateDirIndex,
        };
      }
    }
  }

  return undefined;
}
