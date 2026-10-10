import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { TaskRunner } from '../infra/task/runner.js';
import { saveEnqueuedTaskFile } from '../infra/task/enqueuedTaskFile.js';
import { enqueueTaskEffect } from '../infra/workflow/system/system-enqueue-effect.js';
import type { SystemStepGitProvider } from '../core/workflow/system/system-step-services.js';
import { summarizeTaskName } from '../infra/task/summarize.js';

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
    vi.mocked(summarizeTaskName).mockReset().mockResolvedValue('storage-regression');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it.each([false, true])('does not enqueue another PR task with running=%s', async (running) => {
    await saveEnqueuedTaskFile(projectDir, 'Fix storage regression', {
      workflow: 'takt-default',
      worktree: true,
      branch: 'takt/20260717T0425-add-todo-filter-summary',
      baseBranch: 'improve',
      autoPr: false,
      shouldPublishBranchToOrigin: true,
      prNumber: 2,
    });
    if (running) new TaskRunner(projectDir).claimNextTasks(1);

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
        status: running ? 'running' : 'pending',
      },
    });
    expect(loadTaskRecords(projectDir)).toHaveLength(1);
    expect(fs.readdirSync(path.join(projectDir, '.takt', 'tasks'))).toHaveLength(1);
  });

  it.each([false, true])('does not enqueue another Issue task with running=%s', async (running) => {
    await saveEnqueuedTaskFile(projectDir, 'Fix issue regression', {
      workflow: 'takt-default',
      issue: 42,
    });
    if (running) new TaskRunner(projectDir).claimNextTasks(1);

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
        status: running ? 'running' : 'pending',
      },
    });
    expect(loadTaskRecords(projectDir)).toHaveLength(1);
    expect(fs.readdirSync(path.join(projectDir, '.takt', 'tasks'))).toHaveLength(1);
  });

  it.each(['issue', 'pr', 'branch'] as const)('rejects a %s conflict inserted after the automatic precheck', async (target) => {
    const branch = 'takt/20260717T0425-add-todo-filter-summary';
    vi.mocked(summarizeTaskName).mockImplementationOnce(async () => {
      const options = target === 'issue'
        ? { issue: 42 }
        : target === 'pr'
          ? { pr_number: 2, source: 'pr_review' as const, branch, worktree: true }
          : { branch, worktree: true };
      new TaskRunner(projectDir).addTask('Task registered during summarization', options);
      return 'storage-regression';
    });

    const result = await enqueueTaskEffect({
      cwd: projectDir, projectCwd: projectDir, task: 'Run improvement loop', gitProvider: createPrProvider(),
    }, target === 'issue' ? {
      mode: 'new', workflow: 'takt-default', task: 'Fix the same Issue', issue_number: 42, issue: { create: false },
    } : {
      mode: 'from_pr', workflow: 'takt-default', task: 'Fix the same PR', pr: 2, base_branch: 'improve',
    });

    expect(result).toMatchObject({ success: false, failed: false, duplicate: true, target: { kind: target } });
    expect(loadTaskRecords(projectDir)).toHaveLength(1);
    expect(loadTaskRecords(projectDir)[0]?.content).toBe('Task registered during summarization');
    expect(fs.existsSync(path.join(projectDir, '.takt', 'tasks'))).toBe(false);
  });

  it('keeps automatic deduplication when a newly created Issue already has an active task', async () => {
    new TaskRunner(projectDir).addTask('Existing Issue task', { issue: 42 });
    const createIssue = vi.fn(() => ({ success: true as const, issueNumber: 42, url: 'https://example.test/issues/42' }));
    const gitProvider = { ...createPrProvider(), createIssue };

    const result = await enqueueTaskEffect({
      cwd: projectDir, projectCwd: projectDir, task: 'Run improvement loop', gitProvider,
    }, {
      mode: 'new', workflow: 'takt-default', task: 'Fix issue regression', issue: { create: true },
    });

    expect(createIssue).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: false });
    expect(loadTaskRecords(projectDir)).toHaveLength(1);
    expect(loadTaskRecords(projectDir)[0]?.content).toBe('Existing Issue task');
    expect(fs.existsSync(path.join(projectDir, '.takt', 'tasks'))).toBe(false);
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
