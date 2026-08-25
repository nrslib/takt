import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export interface BrowsedDirectory {
  readonly path: string;
  readonly parent: string | null;
  readonly directories: readonly {
    readonly name: string;
    readonly path: string;
  }[];
}

export function parseDirectoryBrowseRequest(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }
  const path = (value as Readonly<Record<string, unknown>>).path;
  if (path === undefined) return homedir();
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw new Error('path must be an absolute directory path');
  }
  return path;
}

async function isDirectoryEntry(parent: string, name: string, symbolicLink: boolean): Promise<boolean> {
  if (!symbolicLink) return true;
  try {
    return (await stat(join(parent, name))).isDirectory();
  } catch {
    return false;
  }
}

export async function browseDirectory(requestedPath: string): Promise<BrowsedDirectory> {
  const path = await realpath(requestedPath);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Selected path must resolve to a directory');
  }
  const entries = await readdir(path, { withFileTypes: true });
  const directories = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map(async (entry) => ({
      entry,
      accepted: await isDirectoryEntry(path, entry.name, entry.isSymbolicLink()),
    }))))
    .filter((result) => result.accepted)
    .map(({ entry }) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    directories,
  };
}
