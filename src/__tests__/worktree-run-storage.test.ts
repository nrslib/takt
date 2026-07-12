import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { readRunContextOrderContent } from '../core/workflow/run/order-content.js';
import { readRunMetaBySlug } from '../core/workflow/run/run-meta.js';
import { initializeWorktreeRunStorage } from '../infra/task/worktree-run-storage.js';

describe('initializeWorktreeRunStorage', () => {
  let root: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-run-store-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = join(root, 'global');
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function createClone(name: string): string {
    const clonePath = join(root, name);
    mkdirSync(join(clonePath, '.takt'), { recursive: true });
    return clonePath;
  }

  it('isolates equal run slugs across clones and survives clone deletion', () => {
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    const first = initializeWorktreeRunStorage(projectDir, createClone('clone-a'), 'feature/a');
    const second = initializeWorktreeRunStorage(projectDir, createClone('clone-b'), 'feature/b');

    expect(first.cloneId).not.toBe(second.cloneId);
    expect(realpathSync(first.linkPath)).not.toBe(realpathSync(second.linkPath));

    const firstRun = join(first.linkPath, 'same-slug', 'meta.json');
    const secondRun = join(second.linkPath, 'same-slug', 'meta.json');
    mkdirSync(join(first.linkPath, 'same-slug'), { recursive: true });
    mkdirSync(join(second.linkPath, 'same-slug'), { recursive: true });
    writeFileSync(firstRun, 'first');
    writeFileSync(secondRun, 'second');
    expect(readFileSync(join(first.storePath, 'same-slug', 'meta.json'), 'utf8')).toBe('first');
    expect(readFileSync(join(second.storePath, 'same-slug', 'meta.json'), 'utf8')).toBe('second');

    rmSync(join(root, 'clone-a'), { recursive: true, force: true });
    expect(readFileSync(join(first.storePath, 'same-slug', 'meta.json'), 'utf8')).toBe('first');
  });

  it('migrates an existing runs directory without losing its contents', () => {
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    const clonePath = createClone('clone');
    const runsPath = join(clonePath, '.takt', 'runs');
    mkdirSync(runsPath);
    writeFileSync(join(runsPath, 'keep.txt'), 'keep');

    const storage = initializeWorktreeRunStorage(projectDir, clonePath, 'feature/existing');
    expect(readFileSync(join(runsPath, 'keep.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(join(storage.storePath, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('stores only hashed project identity in the manifest', () => {
    const projectDir = join(root, 'sensitive-project-name');
    mkdirSync(projectDir);
    const storage = initializeWorktreeRunStorage(projectDir, createClone('clone'), 'feature/private');
    const manifest = readFileSync(join(storage.storePath, '..', 'store.json'), 'utf8');

    expect(manifest).not.toContain(projectDir);
    expect(manifest).not.toContain('sensitive-project-name');
    expect(manifest).toContain(storage.cloneId);
  });

  it('reuses an already initialized store without allocating another clone id', () => {
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    const clonePath = createClone('clone');
    const first = initializeWorktreeRunStorage(projectDir, clonePath, 'feature/retry');
    const second = initializeWorktreeRunStorage(projectDir, clonePath, 'feature/retry');

    expect(second).toEqual(first);
  });

  it('restricts every run-store directory that exposes project or clone identities', () => {
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    const storage = initializeWorktreeRunStorage(projectDir, createClone('clone'), 'feature/private');
    const cloneStore = join(storage.storePath, '..');
    const projectStore = join(cloneStore, '..');
    const runStore = join(projectStore, '..');

    for (const directory of [runStore, projectStore, cloneStore, storage.storePath]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it('supports the canonical run path, metadata, and order readers through the link', () => {
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    const clonePath = createClone('clone');
    const storage = initializeWorktreeRunStorage(projectDir, clonePath, 'feature/readers');
    const paths = buildRunPaths(clonePath, 'run-1');
    mkdirSync(paths.contextTaskAbs, { recursive: true });
    writeFileSync(paths.contextTaskOrderAbs, '# order\n');
    writeFileSync(paths.metaAbs, JSON.stringify({
      task: 'task',
      workflow: 'workflow',
      runSlug: 'run-1',
      runRoot: paths.runRootRel,
      reportDirectory: paths.reportsRel,
      contextDirectory: paths.contextRel,
      logsDirectory: paths.logsRel,
      status: 'completed',
      startTime: '2026-07-12T00:00:00.000Z',
    }));

    expect(readRunContextOrderContent(clonePath, 'run-1')).toBe('# order\n');
    expect(readRunMetaBySlug(clonePath, 'run-1')?.status).toBe('completed');
    expect(readFileSync(join(storage.storePath, 'run-1', 'meta.json'), 'utf8')).toContain('completed');
  });
});
