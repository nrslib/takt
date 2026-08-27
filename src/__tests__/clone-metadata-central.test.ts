import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupOrphanedClone, saveCloneMeta } from '../infra/task/clone.js';

const temporaryDirectories = new Set<string>();

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
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
