import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type BigIntStats,
} from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './canonical-json.js';

interface MetadataSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface DirectoryEntrySnapshot {
  readonly name: string;
  readonly kind: 'directory' | 'file';
}

interface DirectorySnapshot extends MetadataSnapshot {
  readonly path: string;
  readonly entries: ReadonlyArray<DirectoryEntrySnapshot>;
}

export interface ArtifactFileSnapshot extends MetadataSnapshot {
  readonly path: string;
}

export interface ArtifactFileDigest {
  readonly path: string;
  readonly digest: string;
}

export interface ArtifactTreeSnapshot {
  readonly directories: ReadonlyArray<DirectorySnapshot>;
  readonly files: ReadonlyArray<ArtifactFileSnapshot>;
  readonly digests: ReadonlyArray<ArtifactFileDigest>;
}

interface MutableArtifactTree {
  readonly directories: DirectorySnapshot[];
  readonly files: ArtifactFileSnapshot[];
  readonly digests: ArtifactFileDigest[];
}

function errorCode(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, 'code') : undefined;
}

function metadataSnapshot(metadata: BigIntStats): MetadataSnapshot {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

function sameMetadata(
  left: MetadataSnapshot,
  right: MetadataSnapshot,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertRegularFile(path: string, metadata: BigIntStats): void {
  if (metadata.isSymbolicLink()) {
    throw new Error(`TAKT engine artifact contains a symbolic link: ${path}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`TAKT engine artifact path is not a regular file: ${path}`);
  }
}

export function readStableRegularFile(
  path: string,
  expected: BigIntStats,
): { readonly bytes: Buffer; readonly snapshot: ArtifactFileSnapshot } {
  assertRegularFile(path, expected);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ELOOP') {
      throw new Error(`TAKT engine artifact contains a symbolic link: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== expected.dev
      || opened.ino !== expected.ino
    ) {
      throw new Error(`TAKT engine artifact path changed before read: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    const openedSnapshot = metadataSnapshot(opened);
    if (
      !sameMetadata(openedSnapshot, metadataSnapshot(afterRead))
      || !sameMetadata(openedSnapshot, metadataSnapshot(afterPath))
    ) {
      throw new Error(`TAKT engine artifact path changed during read: ${path}`);
    }
    return {
      bytes,
      snapshot: { path, ...openedSnapshot },
    };
  } finally {
    closeSync(descriptor);
  }
}

function directoryEntries(path: string): ReadonlyArray<DirectoryEntrySnapshot> {
  return readdirSync(path)
    .sort()
    .map((name) => {
      const childPath = join(path, name);
      const metadata = lstatSync(childPath, { bigint: true });
      if (metadata.isSymbolicLink()) {
        throw new Error(`TAKT engine artifact contains a symbolic link: ${childPath}`);
      }
      if (metadata.isDirectory()) {
        return { name, kind: 'directory' as const };
      }
      if (metadata.isFile()) {
        return { name, kind: 'file' as const };
      }
      throw new Error(`TAKT engine artifact contains a special file: ${childPath}`);
    });
}

function sameEntries(
  left: ReadonlyArray<DirectoryEntrySnapshot>,
  right: ReadonlyArray<DirectoryEntrySnapshot>,
): boolean {
  return left.length === right.length
    && left.every((entry, index) => (
      entry.name === right[index]?.name
      && entry.kind === right[index]?.kind
    ));
}

function captureDirectory(
  tree: MutableArtifactTree,
  directory: string,
  relativePath: (path: string) => string,
  runtimeDirectoryName: 'src' | 'dist',
): void {
  const before = lstatSync(directory, { bigint: true });
  if (before.isSymbolicLink()) {
    throw new Error(`TAKT engine artifact contains a symbolic link: ${directory}`);
  }
  if (!before.isDirectory()) {
    throw new Error(`TAKT engine artifact path is not a directory: ${directory}`);
  }
  const entries = directoryEntries(directory);
  tree.directories.push({
    path: directory,
    entries,
    ...metadataSnapshot(before),
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const canonicalPath = relativePath(path);
    if (entry.kind === 'directory') {
      if (
        entry.name !== '__tests__'
        || !canonicalPath.startsWith(`${runtimeDirectoryName}/`)
      ) {
        captureDirectory(tree, path, relativePath, runtimeDirectoryName);
      }
      continue;
    }
    if (canonicalPath.endsWith('.test.ts')) {
      continue;
    }
    const read = readStableRegularFile(
      path,
      lstatSync(path, { bigint: true }),
    );
    tree.files.push(read.snapshot);
    tree.digests.push({
      path: canonicalPath,
      digest: sha256(read.bytes),
    });
  }
  if (!sameMetadata(metadataSnapshot(before), metadataSnapshot(
    lstatSync(directory, { bigint: true }),
  ))) {
    throw new Error(`TAKT engine artifact directory changed during read: ${directory}`);
  }
}

export function captureArtifactTree(
  directories: ReadonlyArray<string>,
  relativePath: (path: string) => string,
  runtimeDirectoryName: 'src' | 'dist',
): ArtifactTreeSnapshot {
  const tree: MutableArtifactTree = {
    directories: [],
    files: [],
    digests: [],
  };
  for (const directory of directories) {
    captureDirectory(tree, directory, relativePath, runtimeDirectoryName);
  }
  return {
    directories: Object.freeze(tree.directories),
    files: Object.freeze(tree.files),
    digests: Object.freeze(
      tree.digests.sort((left, right) => (
        left.path < right.path ? -1 : Number(left.path > right.path)
      )),
    ),
  };
}

export function assertFileSnapshot(snapshot: ArtifactFileSnapshot): void {
  const metadata = lstatSync(snapshot.path, { bigint: true });
  assertRegularFile(snapshot.path, metadata);
  if (!sameMetadata(snapshot, metadataSnapshot(metadata))) {
    throw new Error(`TAKT engine artifact file changed after hash: ${snapshot.path}`);
  }
}

export function verifyArtifactTree(snapshot: ArtifactTreeSnapshot): void {
  // The second pass detects ordinary concurrent build mutations.
  for (const file of snapshot.files) {
    assertFileSnapshot(file);
  }
  for (const directory of snapshot.directories) {
    const metadata = lstatSync(directory.path, { bigint: true });
    if (
      !metadata.isDirectory()
      || !sameMetadata(directory, metadataSnapshot(metadata))
      || !sameEntries(directory.entries, directoryEntries(directory.path))
    ) {
      throw new Error(
        `TAKT engine artifact directory changed after hash: ${directory.path}`,
      );
    }
  }
}
