import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { TaskRunner } from '../infra/task/runner.js';
import { saveEnqueuedTaskFile } from '../infra/task/enqueuedTaskFile.js';
import { enqueueTaskEffect } from '../infra/workflow/system/system-enqueue-effect.js';
import type { SystemStepGitProvider } from '../core/workflow/system/system-step-services.js';

vi.mock('../infra/task/summarize.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn(async () => 'storage-regression'),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBaseBranch: vi.fn((_cwd: string, branch: string) => ({ branch })),
}));

function loadTaskRecords(projectDir: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(path.join(projectDir, '.takt', 'tasks.yaml'), 'utf-8');
  return (parseYaml(raw) as { tasks: Array<Record<string, unknown>> }).tasks;
}

function createPrProvider(): SystemStepGitProvider {
  return {
    checkCliStatus: () => ({ available: true }),
    fetchPrReviewComments: (prNumber) => ({
      number: prNumber,
      title: 'Storage regression',
      body: '',
      url: `https://example.test/pull/${prNumber}`,
      headRefName: 'takt/20260717T0425-add-todo-filter-summary',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    }),
  } as SystemStepGitProvider;
}

describe('enqueueTaskEffect active target deduplication', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-enqueue-dedup-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('does not enqueue another task for a PR that already has a running task', async () => {
    await saveEnqueuedTaskFile(projectDir, 'Fix storage regression', {
      workflow: 'takt-default',
      worktree: true,
      branch: 'takt/20260717T0425-add-todo-filter-summary',
      baseBranch: 'improve',
      autoPr: false,
      shouldPublishBranchToOrigin: true,
      prNumber: 2,
    });
    new TaskRunner(projectDir).claimNextTasks(1);

    const result = await enqueueTaskEffect({
      cwd: projectDir,
      projectCwd: projectDir,
      task: 'Run improvement loop',
      gitProvider: createPrProvider(),
    }, {
      mode: 'from_pr',
      pr: 2,
      workflow: 'takt-default',
      base_branch: 'improve',
      task: 'Fix localStorage regression',
    });

    expect(result).toEqual({
      success: false,
      failed: false,
      duplicate: true,
      target: { kind: 'pr', value: 2 },
      existing_task: {
        name: expect.any(String),
        status: 'running',
      },
    });
    expect(loadTaskRecords(projectDir)).toHaveLength(1);
    expect(fs.readdirSync(path.join(projectDir, '.takt', 'tasks'))).toHaveLength(1);
  });

  it('does not enqueue another task for an Issue that already has a pending task', async () => {
    await saveEnqueuedTaskFile(projectDir, 'Fix issue regression', {
      workflow: 'takt-default',
      issue: 42,
    });

    const result = await enqueueTaskEffect({
      cwd: projectDir,
      projectCwd: projectDir,
      task: 'Run improvement loop',
    }, {
      mode: 'new',
      issue_number: 42,
      issue: { create: false },
      workflow: 'takt-default',
      task: 'Fix the same issue again',
    });

    expect(result).toEqual({
      success: false,
      failed: false,
      duplicate: true,
      target: { kind: 'issue', value: 42 },
      existing_task: {
        name: expect.any(String),
        status: 'pending',
      },
    });
    expect(loadTaskRecords(projectDir)).toHaveLength(1);
    expect(fs.readdirSync(path.join(projectDir, '.takt', 'tasks'))).toHaveLength(1);
  });

  it('returns duplicate for a known PR target even when the git provider fails', async () => {
    await saveEnqueuedTaskFile(projectDir, 'Fix storage regression', {
      workflow: 'takt-default',
      worktree: true,
      branch: 'takt/20260717T0425-add-todo-filter-summary',
      baseBranch: 'improve',
      autoPr: false,
      shouldPublishBranchToOrigin: true,
      prNumber: 2,
    });
    new TaskRunner(projectDir).claimNextTasks(1);
    const failingProvider = {
      checkCliStatus: () => ({ available: true }),
      fetchPrReviewComments: () => {
        throw new Error('git provider unavailable');
      },
    } as SystemStepGitProvider;

    const result = await enqueueTaskEffect({
      cwd: projectDir,
      projectCwd: projectDir,
      task: 'Run improvement loop',
      gitProvider: failingProvider,
    }, {
      mode: 'from_pr',
      pr: 2,
      workflow: 'takt-default',
      base_branch: 'improve',
      task: 'Fix localStorage regression',
    });

    expect(result).toEqual({
      success: false,
      failed: false,
      duplicate: true,
      target: { kind: 'pr', value: 2 },
      existing_task: {
        name: expect.any(String),
        status: 'running',
      },
    });
    expect(loadTaskRecords(projectDir)).toHaveLength(1);
  });

  it.each([
    { status: 'pending' as const, claim: false },
    { status: 'running' as const, claim: true },
  ])('does not enqueue another task for a branch that already has a $status task', async ({ claim, status }) => {
    await saveEnqueuedTaskFile(projectDir, 'Fix storage regression', {
      workflow: 'takt-default',
      worktree: true,
      branch: 'takt/20260717T0425-add-todo-filter-summary',
      baseBranch: 'improve',
      autoPr: false,
      shouldPublishBranchToOrigin: true,
    });
    if (claim) {
      new TaskRunner(projectDir).claimNextTasks(1);
    }

    const result = await enqueueTaskEffect({
      cwd: projectDir,
      projectCwd: projectDir,
      task: 'Run improvement loop',
      gitProvider: createPrProvider(),
    }, {
      mode: 'from_pr',
      pr: 7,
      workflow: 'takt-default',
      base_branch: 'improve',
      task: 'Fix the same branch again',
    });

    expect(result).toEqual({
      success: false,
      failed: false,
      duplicate: true,
      target: { kind: 'branch', value: 'takt/20260717T0425-add-todo-filter-summary' },
      existing_task: {
        name: expect.any(String),
        status,
      },
    });
    expect(loadTaskRecords(projectDir)).toHaveLength(1);
    expect(fs.readdirSync(path.join(projectDir, '.takt', 'tasks'))).toHaveLength(1);
  });
});
