import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupOrphanedClone, saveCloneMeta } from '../infra/task/clone.js';
import { getCloneMetaPath, saveGeneratedCloneMeta } from '../infra/task/clone-meta.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, linkSync: vi.fn(original.linkSync), writeFileSync: vi.fn(original.writeFileSync) };
});

const temporaryDirectories = new Set<string>();

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

describe('generated clone metadata publication', () => {
  it.each(['default', 'central'] as const)('publishes complete metadata without replacing an owner in %s storage', async (storage) => {
    const root = await createTemporaryDirectory('takt-clone-publication-');
    const project = join(root, 'project');
    const directory = storage === 'central' ? join(root, 'state', 'clone-meta') : undefined;
    const branch = 'takt/1465/fix-login-bug';
    const clonePath = join(root, 'first-clone');
    const filePath = getCloneMetaPath(project, branch, directory);

    expect(saveGeneratedCloneMeta(project, branch, clonePath, directory)).toBe(true);
    const first = fs.readFileSync(filePath, 'utf8');
    expect(JSON.parse(first)).toEqual({ branch, clonePath });
    expect(fs.statSync(filePath).mode & 0o777).toBe(storage === 'central' ? 0o600 : 0o644);
    expect(fs.statSync(dirname(filePath)).mode & 0o777).toBe(storage === 'central' ? 0o700 : 0o755);
    expect(saveGeneratedCloneMeta(project, branch, join(root, 'second-clone'), directory)).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(first);
    expect(fs.readdirSync(dirname(filePath))).toEqual([basename(filePath)]);

    saveCloneMeta(project, branch, join(root, 'explicit-clone'), directory);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ branch, clonePath: join(root, 'explicit-clone') });
  });

  it.each(['EACCES', 'EIO'])('propagates publication %s and removes only its temporary file', async (code) => {
    const root = await createTemporaryDirectory('takt-clone-publication-error-');
    const branch = 'takt/1465/fix-login-bug';
    const failure = Object.assign(new Error('publication failed'), { code });
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw failure; });

    expect(() => saveGeneratedCloneMeta(root, branch, join(root, 'clone'))).toThrow(failure);

    expect(fs.readdirSync(join(root, '.takt', 'clone-meta'))).toEqual([]);
  });

  it('does not classify an EEXIST while writing the temporary file as an ownership conflict', async () => {
    const root = await createTemporaryDirectory('takt-clone-write-error-');
    const failure = Object.assign(new Error('temporary file exists'), { code: 'EEXIST' });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw failure; });
    const publish = vi.spyOn(fs, 'linkSync');

    expect(() => saveGeneratedCloneMeta(root, 'takt/1465/fix-login-bug', join(root, 'clone'))).toThrow(failure);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('central clone metadata cleanup', () => {
  it('removes the clone and metadata from their central state roots', async () => {
    const root = await createTemporaryDirectory('takt-clone-central-');
    const projectDirectory = join(root, 'project');
    const worktreeBaseDirectory = join(root, 'worktrees');
    const metadataDirectory = join(root, 'state', 'worktree-metadata');
    const clonePath = join(worktreeBaseDirectory, 'task-clone');
    await mkdir(clonePath, { recursive: true });

    saveCloneMeta(projectDirectory, 'takt/task', clonePath, metadataDirectory);
    cleanupOrphanedClone(projectDirectory, 'takt/task', {
      worktreeBaseDirectory,
      metadataDirectory,
    });

    expect(existsSync(clonePath)).toBe(false);
    expect(existsSync(join(metadataDirectory, 'takt--task.json'))).toBe(false);
  });

  it('refuses to remove the worktree root when metadata points at that root', async () => {
    const root = await createTemporaryDirectory('takt-clone-central-root-');
    const projectDirectory = join(root, 'project');
    const worktreeBaseDirectory = join(root, 'worktrees');
    const metadataDirectory = join(root, 'state', 'worktree-metadata');
    await mkdir(worktreeBaseDirectory, { recursive: true });

    saveCloneMeta(projectDirectory, 'takt/root', worktreeBaseDirectory, metadataDirectory);
    cleanupOrphanedClone(projectDirectory, 'takt/root', {
      worktreeBaseDirectory,
      metadataDirectory,
    });

    expect(existsSync(worktreeBaseDirectory)).toBe(true);
    expect(existsSync(join(metadataDirectory, 'takt--root.json'))).toBe(true);
  });
});
