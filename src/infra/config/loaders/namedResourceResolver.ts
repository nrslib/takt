import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

interface ResolveNamedResourceOptions {
  candidateDirs: readonly string[];
  extensions: readonly string[];
  fileAccess?: NamedResourceFileAccess;
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
  isSymlink: (path) => lstatSync(path).isSymbolicLink(),
};

function assertBareResourceName(name: string): void {
  if (
    name.length === 0
    || isAbsolute(name)
    || name.includes('/')
    || name.includes('\\')
    || name.includes('..')
  ) {
    throw new Error(`Configuration error: named resource must be a bare name: ${name}`);
  }
}

function isPathInsideDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function assertResourceStaysInsideCandidateDir(
  name: string,
  filePath: string,
  candidateDir: string,
  fileAccess: NamedResourceFileAccess,
): void {
  if (fileAccess.isSymlink?.(candidateDir) === true) {
    throw new Error(`Configuration error: named resource candidate directory must not be a symlink: ${name}`);
  }

  const realFilePath = fileAccess.realpath(filePath);
  const realCandidateDir = fileAccess.realpath(candidateDir);
  if (!isPathInsideDirectory(realFilePath, realCandidateDir)) {
    throw new Error(`Configuration error: named resource must stay inside its candidate directory: ${name}`);
  }
}

export function resolveNamedResourceWithSource(
  name: string,
  options: ResolveNamedResourceOptions,
): ResolvedNamedResource | undefined {
  assertBareResourceName(name);
  const fileAccess = options.fileAccess ?? nodeFileAccess;

  for (const [candidateDirIndex, dir] of options.candidateDirs.entries()) {
    for (const extension of options.extensions) {
      const filePath = resolve(dir, `${name}${extension}`);
      if (fileAccess.exists(filePath)) {
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
