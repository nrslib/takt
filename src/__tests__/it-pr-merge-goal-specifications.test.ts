import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/index.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/index.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { DebugLogger } from '../shared/utils/debug.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const headSha = 'a'.repeat(40);
const repositoryUrl = 'https://github.com/example/repo.git';
const specifications = {
  gherkin: 'Feature: SavedGherkinReview\n  Scenario: Export CSV\n',
  quint: 'module SavedQuintReview {}\n',
  alloy: 'sig SavedAlloyReview {}\n',
};

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../infra/github/pr.js', () => ({
  fetchPrDetails: vi.fn(async () => ({ number: 42, headBranch: goalRecord().branch, baseBranch: 'main',
    headSha, headRepositoryUrl: repositoryUrl, headRepositoryPushUrls: [repositoryUrl], sameRepository: true })),
  fetchPrStatus: vi.fn(async () => ({ merged: false, headSha })),
}));
vi.mock('../infra/task/clone-exec.js', () => ({
  cloneAndIsolateAbortable: vi.fn(async (_source: string, target: string) => { mkdirSync(target, { recursive: true }); }),
  runGitCommandAbortable: vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === 'remote' && args.length === 1) return { stdout: 'origin\n' };
    if (args[0] === 'remote' && args[1] === 'get-url') return { stdout: repositoryUrl };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: headSha };
    if (args[0] === 'remote' || args[0] === 'checkout') return { stdout: '' };
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  }),
}));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: vi.fn(async () => ({})) }));
vi.mock('../infra/workflow/system/pr-clone-git.js', () => ({
  createPrCloneGitOperations: vi.fn(async () => ({ headRepositoryUrl: repositoryUrl,
    headRepositoryPushUrls: [repositoryUrl], baseRepositoryUrl: repositoryUrl,
    operations: { fetch: vi.fn(), push: vi.fn() } })),
}));
vi.mock('../infra/goals/branch-sync.js', async (original) => ({
  ...await original<typeof import('../infra/goals/branch-sync.js')>(),
  synchronizeGoalBranch: vi.fn(async () => ({ status: 'unchanged', localSha: headSha })),
}));
vi.mock('../infra/goals/git-command.js', async (original) => ({
  ...await original<typeof import('../infra/goals/git-command.js')>(),
  hasUnpublishedPrWork: vi.fn(async () => true),
}));
import { runAgent } from '../agents/runner.js';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'takt-pr-merge-specifications-'));
  const workflows = join(project, '.takt', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
  writeFileSync(join(workflows, 'spec-review.yaml'), [
    'name: spec-review', 'max_steps: 1', 'initial_step: review', 'steps:',
    '  - name: review', '    persona: coding-reviewer', '    edit: false',
    '    instruction: Review the assigned requirements.',
    '    rules:', '      - condition: when(true)', '        next: COMPLETE',
  ].join('\n'));
  vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
    options?.onPromptResolved?.({ systemPrompt: 'reviewer', userInstruction: prompt });
    return { persona: persona!, status: 'done', content: 'Reviewed.', timestamp: new Date() };
  });
  invalidateAllResolvedConfigCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(project, { recursive: true, force: true });
  invalidateAllResolvedConfigCache();
});

it('delivers saved specifications to the reviewer when a queued finishing task runs through the task entry point', async () => {
  const writeLog = vi.spyOn(DebugLogger.prototype, 'writeLog');
  const goal = { ...goalRecord(), specifications, status: 'awaiting_merge' as const,
    pullRequest: { number: 42, url: 'https://github.com/example/repo/pull/42' },
    completion: { goalBranch: goalRecord().branch, goalSha: headSha, targetBranch: 'main', summary: 'Evidence',
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false }, instructions: [] } };
  await new GoalStore(project).create(goal);
  const runner = new TaskRunner(project);
  runner.enqueuePrMergeTask({ goalId: goal.id, prNumber: 42, prUrl: goal.pullRequest.url,
    headBranch: goal.branch, baseBranch: 'main', headSha, headRepositoryUrl: repositoryUrl,
    headRepositoryPushUrls: [repositoryUrl], until: 'prepare', workflow: 'spec-review', method: 'squash',
    worktreePath: join(project, '.takt', 'worktrees', 'clone'), threatCheckMaxDiffBytes: 1024 });
  const task = runner.claimNextTasks(1)[0]!;
  for (const body of Object.values(specifications)) expect(task.content).not.toContain(body);

  expect(await executeAndCompleteTask(task, runner, project, undefined, { outputMode: 'silent' })).toBe(true);
  expect(writeLog.mock.calls.filter(([level]) => level === 'ERROR')).toEqual([]);

  expect(runAgent).toHaveBeenCalledOnce();
  const [persona, prompt] = vi.mocked(runAgent).mock.calls[0]!;
  expect(persona).toBe('coding-reviewer');
  const saved = runner.listAllTaskItems().find((item) => item.name === task.name)!;
  expect(saved.kind).toBe('completed');
  const paths = buildRunPaths(project, saved.runSlug!);
  expect(readFileSync(paths.contextTaskOrderAbs, 'utf8')).toBe(task.content);
  const directory = join(paths.contextTaskAbs, 'specifications');
  expect(readdirSync(directory).sort()).toEqual(['alloy.als', 'gherkin.feature', 'quint.qnt']);
  for (const [file, body, marker] of [
    ['gherkin.feature', specifications.gherkin, 'SavedGherkinReview'],
    ['quint.qnt', specifications.quint, 'SavedQuintReview'],
    ['alloy.als', specifications.alloy, 'SavedAlloyReview'],
  ] as const) {
    const path = join(directory, file);
    expect(prompt).toContain(path);
    expect(readFileSync(path, 'utf8')).toBe(body);
    expect(prompt).not.toContain(body);
    expect(prompt).not.toContain(marker);
    expect(task.content).not.toContain(marker);
  }
});
