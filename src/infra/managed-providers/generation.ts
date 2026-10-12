import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

interface ManagedGenerationOptions {
  platform: NodeJS.Platform;
  signal?: AbortSignal;
}

const CURRENT = 'sdk';
const BACKUP = '.sdk-previous';
const JOURNAL = '.sdk-publication.json';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function validateGeneration(root: string, directory: string): Promise<string> {
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (dirname(realDirectory) !== realRoot || !basename(realDirectory).startsWith('sdk-')
    || !(await lstat(realDirectory)).isDirectory()) {
    throw new Error('Managed generation must be a directory inside its managed root.');
  }
  return realDirectory;
}

export async function recoverManagedPublication(root: string, options: ManagedGenerationOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const journalPath = join(root, JOURNAL);
  if (!await exists(journalPath)) return;
  const record: unknown = JSON.parse(await readFile(journalPath, 'utf8'));
  if (typeof record !== 'object' || record === null || !('pending' in record)
    || typeof record.pending !== 'string' || !/^\.sdk-link-[a-f0-9-]+$/u.test(record.pending)) {
    throw new Error('Invalid managed publication recovery record.');
  }
  const current = join(root, CURRENT);
  const backup = join(root, BACKUP);
  if (await exists(backup)) {
    await validateGeneration(root, await realpath(backup));
    if (!await exists(current)) await rename(backup, current);
    else {
      await validateGeneration(root, await realpath(current));
      await rm(backup);
    }
  }
  await rm(join(root, record.pending), { force: true });
  await rm(journalPath);
}

export async function resolveManagedGeneration(root: string, options: ManagedGenerationOptions): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  const current = join(root, CURRENT);
  if (!await exists(current)) {
    const backup = join(root, BACKUP);
    if (await exists(join(root, JOURNAL)) && await exists(backup)) return validateGeneration(root, await realpath(backup));
    return undefined;
  }
  if (!(await lstat(current)).isSymbolicLink()) throw new Error('Managed current generation is not a link.');
  return validateGeneration(root, await realpath(current));
}

export async function publishManagedGeneration(root: string, generationDirectory: string, options: ManagedGenerationOptions): Promise<void> {
  options.signal?.throwIfAborted();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await validateGeneration(root, resolve(generationDirectory));
  await recoverManagedPublication(root, options);
  const pendingName = `.sdk-link-${randomUUID()}`;
  const pending = join(root, pendingName);
  const current = join(root, CURRENT);
  const backup = join(root, BACKUP);
  const journalPath = join(root, JOURNAL);
  let published = false;
  try {
    await symlink(options.platform === 'win32' ? directory : relative(root, directory), pending,
      options.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(journalPath, JSON.stringify({ pending: pendingName }), { flag: 'wx', mode: 0o600 });
    options.signal?.throwIfAborted();
    if (options.platform === 'win32' && await exists(current)) {
      await validateGeneration(root, await realpath(current));
      await rename(current, backup);
    }
    options.signal?.throwIfAborted();
    await rename(pending, current);
    published = true;
  } finally {
    if (!published && await exists(backup) && !await exists(current)) await rename(backup, current);
    if (published) await rm(backup, { force: true });
    await rm(pending, { force: true });
    await rm(journalPath, { force: true });
  }
}
