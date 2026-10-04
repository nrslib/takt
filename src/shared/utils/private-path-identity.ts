import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';

export interface DirectoryIdentity {
  path: string;
  stat: Stats;
  followSymbolicLink: boolean;
}

export interface PrivateFileInspection {
  ancestorIdentities: DirectoryIdentity[];
  expectedStat: Stats | undefined;
}

export class PrivateArtifactAncestorIdentityMismatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PrivateArtifactAncestorIdentityMismatchError';
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function lstatOrUndefined(path: string): Stats | undefined {
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

function resolveFilesystemRootAlias(targetPath: string): string {
  const absolute = resolve(targetPath);
  const { root } = parse(absolute);
  const [rootEntry, ...remainingComponents] = relative(root, absolute).split(sep).filter(Boolean);
  if (rootEntry === undefined) return absolute;

  const rootEntryPath = join(root, rootEntry);
  if (!lstatOrUndefined(rootEntryPath)?.isSymbolicLink()) return absolute;
  return join(realpathSync(rootEntryPath), ...remainingComponents);
}

export function artifactBoundary(targetPath: string): {
  targetPath: string;
  trustedRoot: string;
  rejectTrustedRootSymlink: boolean;
} {
  const absolute = resolveFilesystemRootAlias(targetPath);
  const { root } = parse(absolute);
  const components = relative(root, absolute).split(sep).filter(Boolean);
  const taktIndex = components.indexOf('.takt');
  if (taktIndex >= 0) {
    return {
      targetPath: absolute,
      trustedRoot: join(root, ...components.slice(0, taktIndex)),
      rejectTrustedRootSymlink: false,
    };
  }
  return { targetPath: absolute, trustedRoot: root, rejectTrustedRootSymlink: true };
}

export function assertSafePath(targetPath: string, targetIsDirectory: boolean): void {
  const boundary = artifactBoundary(targetPath);
  targetPath = boundary.targetPath;
  const { trustedRoot, rejectTrustedRootSymlink } = boundary;
  const rootLinkStat = lstatSync(trustedRoot);
  if (rejectTrustedRootSymlink && rootLinkStat.isSymbolicLink()) {
    throw new Error(`Private artifact trusted root is a symlink: ${trustedRoot}`);
  }
  const rootStat = statSync(trustedRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Private artifact trusted root is not a directory: ${trustedRoot}`);
  }

  let current = trustedRoot;
  for (const component of relative(trustedRoot, targetPath).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatOrUndefined(current);
    if (stat === undefined) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`Private artifact path contains a symlink: ${current}`);
    }
    const isTarget = current === targetPath;
    if ((!isTarget || targetIsDirectory) && !stat.isDirectory()) {
      throw new Error(`Private artifact path contains a non-directory: ${current}`);
    }
    if (isTarget && !targetIsDirectory && !stat.isFile()) {
      throw new Error(`Private artifact path is not a regular file: ${current}`);
    }
  }
}

export function inspectPrivateArtifactPath(
  targetPath: string,
  targetKind: 'file' | 'directory',
): PrivateFileInspection {
  const { targetPath: absolute, trustedRoot, rejectTrustedRootSymlink } = artifactBoundary(targetPath);
  const rootLinkStat = lstatSync(trustedRoot) as Stats;
  if (rejectTrustedRootSymlink && rootLinkStat.isSymbolicLink()) {
    throw new Error(`Private artifact trusted root is a symlink: ${trustedRoot}`);
  }
  const rootStat = statSync(trustedRoot) as Stats;
  if (!rootStat.isDirectory()) {
    throw new Error(`Private artifact trusted root is not a directory: ${trustedRoot}`);
  }

  const identities: DirectoryIdentity[] = [
    { path: trustedRoot, stat: rootStat, followSymbolicLink: true },
  ];
  let current = trustedRoot;
  const components = relative(trustedRoot, absolute).split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const stat = lstatOrUndefined(current);
    const isTarget = index === components.length - 1;
    if (stat === undefined) {
      if (isTarget && targetKind === 'file') {
        return { ancestorIdentities: identities, expectedStat: undefined };
      }
      throw new Error(`Private artifact ancestor does not exist: ${current}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Private artifact path contains a symlink: ${current}`);
    }
    if (isTarget) {
      if (targetKind === 'file' && !stat.isFile()) {
        throw new Error(`Private artifact path is not a regular file: ${current}`);
      }
      if (targetKind === 'directory' && !stat.isDirectory()) {
        throw new Error(`Private artifact path is not a directory: ${current}`);
      }
      return { ancestorIdentities: identities, expectedStat: stat };
    }
    if (!stat.isDirectory()) {
      throw new Error(`Private artifact ancestor is unsafe: ${current}`);
    }
    identities.push({ path: current, stat, followSymbolicLink: false });
  }
  throw new Error(`Private artifact path is not a ${targetKind}: ${absolute}`);
}

export function hasMatchingIdentity(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.isFile() === actual.isFile();
}

export function hasMatchingDirectoryIdentity(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.isDirectory() === actual.isDirectory();
}

export function assertAncestorIdentities(identities: readonly DirectoryIdentity[]): void {
  for (const identity of identities) {
    let current: Stats;
    try {
      current = identity.followSymbolicLink
        ? statSync(identity.path) as Stats
        : lstatSync(identity.path) as Stats;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      throw new PrivateArtifactAncestorIdentityMismatchError(
        `Private artifact ancestor disappeared while opening: ${identity.path}`,
        { cause: error },
      );
    }
    if (!current.isDirectory() || !hasMatchingDirectoryIdentity(identity.stat, current)) {
      throw new PrivateArtifactAncestorIdentityMismatchError(
        `Private artifact ancestor identity changed while opening: ${identity.path}`,
      );
    }
  }
}
