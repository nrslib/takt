import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReusableWorktreePath,
  inspectReusedWorktreeExecution,
  resolveReusedWorktreeExecution,
} from '../features/tasks/execute/reusedWorktree.js';
import type { TaskInfo } from '../infra/task/index.js';

const temporaryProjects: string[] = [];

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-reused-worktree-'));
  temporaryProjects.push(projectDir);
  return projectDir;
}

function makeRetryTask(worktreePath: string): TaskInfo {
  return {
    filePath: '/tmp/tasks.yaml',
    name: 'retry-task',
    content: 'Retry task',
    createdAt: '2026-08-20T00:00:00.000Z',
    status: 'running',
    worktreePath,
    resumeMode: 'retry',
    data: { worktree: true, task: 'Retry task', workflow: 'default' },
  };
}

afterEach(() => {
  for (const projectDir of temporaryProjects.splice(0)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

describe('reused worktree execution', () => {
  it('inspects a retry path without synchronizing project configuration', () => {
    const projectDir = makeProject();
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'safe');
    fs.mkdirSync(path.join(worktreePath, '.takt'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.takt', 'config.yaml'), 'sync_project_local_takt_on_retry: true\n');
    fs.writeFileSync(path.join(worktreePath, '.takt', 'config.yaml'), 'sync_project_local_takt_on_retry: false\n');
    expect(inspectReusedWorktreeExecution(projectDir, makeRetryTask(worktreePath))?.worktreePath).toBe(worktreePath);
    expect(fs.readFileSync(path.join(worktreePath, '.takt', 'config.yaml'), 'utf8')).toBe('sync_project_local_takt_on_retry: false\n');
    resolveReusedWorktreeExecution(projectDir, makeRetryTask(worktreePath), undefined, undefined, undefined, undefined);
    expect(fs.readFileSync(path.join(worktreePath, '.takt', 'config.yaml'), 'utf8')).toBe('sync_project_local_takt_on_retry: true\n');
  });

  it.each(['retry', 'requeue'] as const)('preserves the missing-worktree error for %s without falling back to a new clone', (resumeMode) => {
    const projectDir = makeProject();
    const task = { ...makeRetryTask(path.join(projectDir, '.takt', 'worktrees', 'missing')), resumeMode };
    expect(() => inspectReusedWorktreeExecution(projectDir, task)).toThrow('refusing to create a replacement clone');
    expect(inspectReusedWorktreeExecution(projectDir, { ...task, resumeMode: undefined, status: 'pending' })).toBeUndefined();
  });

  it('returns the existing in-bound worktree without creating a replacement clone', () => {
    const projectDir = makeProject();
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'safe');
    fs.mkdirSync(worktreePath, { recursive: true });

    expect(resolveReusedWorktreeExecution(
      projectDir,
      makeRetryTask(worktreePath),
      undefined,
      undefined,
      undefined,
      undefined,
    )).toEqual({
      execCwd: worktreePath,
      worktreePath,
      isWorktree: true,
    });
  });

  it('rejects an existing directory outside the clone boundary', () => {
    const projectDir = makeProject();
    const outsideWorktree = path.join(projectDir, 'outside-worktree');
    fs.mkdirSync(outsideWorktree);

    expect(() => assertReusableWorktreePath(projectDir, outsideWorktree))
      .toThrow('outside the clone base directory');
  });

  it('accepts different ancestor aliases for the same clone boundary', () => {
    const parentDir = makeProject();
    const projectDir = path.join(parentDir, 'project');
    const aliasDir = path.join(parentDir, 'project-alias');
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'safe');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.symlinkSync(projectDir, aliasDir, 'dir');

    expect(() => assertReusableWorktreePath(aliasDir, worktreePath)).not.toThrow();
    expect(() => assertReusableWorktreePath(projectDir, path.join(aliasDir, '.takt', 'worktrees', 'safe')))
      .not.toThrow();
  });

  it('rejects symlinks inside the boundary even when ancestors use aliases', () => {
    const parentDir = makeProject();
    const projectDir = path.join(parentDir, 'project');
    const aliasDir = path.join(parentDir, 'project-alias');
    const cloneBase = path.join(projectDir, '.takt', 'worktrees');
    fs.mkdirSync(path.join(cloneBase, 'safe', 'nested'), { recursive: true });
    fs.symlinkSync(projectDir, aliasDir, 'dir');
    fs.symlinkSync(path.join(cloneBase, 'safe'), path.join(cloneBase, 'linked'), 'dir');

    expect(() => assertReusableWorktreePath(aliasDir, path.join(cloneBase, 'linked', 'nested')))
      .toThrow('must not contain a symlink');
  });

  it('rejects a symlinked worktree even when its target is inside the boundary', () => {
    const projectDir = makeProject();
    const safeWorktree = path.join(projectDir, '.takt', 'worktrees', 'safe');
    const linkedWorktree = path.join(projectDir, '.takt', 'worktrees', 'linked');
    fs.mkdirSync(safeWorktree, { recursive: true });
    fs.symlinkSync(safeWorktree, linkedWorktree, 'dir');

    expect(() => assertReusableWorktreePath(projectDir, linkedWorktree))
      .toThrow('must not be a symlink');
  });

  it('fails fast instead of creating a replacement clone when the retry worktree is missing', () => {
    const projectDir = makeProject();
    const missingWorktree = path.join(projectDir, '.takt/worktrees/missing');

    expect(() => resolveReusedWorktreeExecution(
      projectDir,
      makeRetryTask(missingWorktree),
      undefined,
      undefined,
      undefined,
      undefined,
    )).toThrow('refusing to create a replacement clone');
  });

  it('fails fast when the retry worktree path is a file', () => {
    const projectDir = makeProject();
    const invalidWorktree = path.join(projectDir, '.takt', 'worktrees', 'worktree-file');
    fs.mkdirSync(path.dirname(invalidWorktree), { recursive: true });
    fs.writeFileSync(invalidWorktree, 'not a directory');

    expect(() => resolveReusedWorktreeExecution(
      projectDir,
      makeRetryTask(invalidWorktree),
      undefined,
      undefined,
      undefined,
      undefined,
    )).toThrow('refusing to create a replacement clone');
  });
});
