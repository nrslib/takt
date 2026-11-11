import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { GoalStore } from '../infra/goals/store.js';
import { GoalSummarySchema } from '../infra/goals/schema.js';
import { TaskStore } from '../infra/task/store.js';
import { TaskLifecycleService } from '../infra/task/taskLifecycleService.js';
import { getTaktGoal } from '../features/mcp/operations.js';
import { getGoalInputSchema } from '../features/mcp/schemas.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { goalRecord } from './helpers/goal-fixtures.js';

let cwd: string;
const specifications = { gherkin: 'Feature: Export\n  Scenario: CSV', quint: 'module csv {}', alloy: 'sig CSV {}' };
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'manager-goal-specs-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });
it.each([undefined, specifications])('persists and reads goals with specifications %j', async (specs) => {
  const store = new GoalStore(cwd);
  const goal = { ...goalRecord(), ...(specs === undefined ? {} : { specifications: specs }) };
  await store.create(goal);
  expect(await new GoalStore(cwd).get(goal.id)).toEqual(goal);
  expect(GoalSummarySchema.parse({ objective: goal.objective, outOfScope: goal.outOfScope,
    acceptanceCriteria: goal.acceptanceCriteria, constraints: goal.constraints, ...(specs === undefined ? {} : { specifications: specs }) }).specifications).toEqual(specs);
});
it('reads complete specifications through the manager MCP paths and advertises omitted bytes', async () => {
  const goal = { ...goalRecord(), specifications };
  await new GoalStore(cwd).create(goal);
  const deps = { allowedProjectRoot: cwd };
  for (const [notation, text] of Object.entries(specifications)) {
    const input = getGoalInputSchema.parse({ cwd, goalId: goal.id, path: `specifications.${notation}` });
    const result = await getTaktGoal(input, deps);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ content: text, truncated: false });
  }
  const compact = await getTaktGoal({ cwd, goalId: goal.id }, deps);
  expect(JSON.parse(firstTextContent(compact.content))).toMatchObject({ goal: { omissions: { specifications: {
    gherkin: { totalBytes: Buffer.byteLength(specifications.gherkin), returnedBytes: 0 },
  } } } });
});
it.each([
  ...[undefined, '```', '`````', 'prefix ```` suffix'].flatMap((ticks) => [
    { ticks, outOfScope: [], scopeSection: [], constraints: ['Keep the existing API'] },
    { ticks, outOfScope: ['UI redesign', 'Dependency upgrades'], scopeSection: ['Out of scope:\n- UI redesign\n- Dependency upgrades'], constraints: ['Keep the existing API'] },
  ]),
  { ticks: undefined, outOfScope: ['UI redesign'], scopeSection: ['Out of scope:\n- UI redesign'], constraints: [] },
])('includes specifications with safe fences and optional out-of-scope items in final goal PR review instructions: %j', async ({ ticks, outOfScope, scopeSection, constraints }) => {
  const specs = ticks === undefined ? specifications : Object.fromEntries(Object.entries(specifications).map(([notation, text]) => [notation, `${text}\n${ticks}\nRemaining specification`]));
  const goal = { ...goalRecord(), outOfScope, constraints, specifications: specs, status: 'awaiting_merge' as const,
    pullRequest: { number: 42, url: 'https://github.com/example/repo/pull/42' },
    completion: { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Evidence',
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false }, instructions: [] } };
  await new GoalStore(cwd).create(goal);
  const store = new TaskStore(cwd);
  const service = new TaskLifecycleService(cwd, store.getTasksFilePath(), store);
  const task = service.enqueuePrMergeTask({ goalId: goal.id, prNumber: 42, prUrl: goal.pullRequest.url,
    headBranch: goal.branch, baseBranch: 'main', headSha: 'a'.repeat(40),
    headRepositoryUrl: 'https://github.com/example/repo.git', headRepositoryPushUrls: ['https://github.com/example/repo.git'],
    workflow: 'merge-prepare', method: 'squash', worktreePath: join(cwd, 'clone'), threatCheckMaxDiffBytes: 1024 });
  expect(task.content.split(/\n{2,}/).slice(1, 1 + 3 + scopeSection.length)).toEqual([
    `Goal: ${goal.objective}`,
    ...scopeSection,
    constraints.length === 0 ? 'Constraints:' : 'Constraints:\n- Keep the existing API',
    `Acceptance criteria:\n- ${goal.acceptanceCriteria[0]}`,
  ]);
  expect(task.content).toContain('Review the cumulative PR diff');
  for (const [notation, text] of Object.entries(specs)) {
    const fence = '`'.repeat(ticks === undefined ? 3 : ticks.match(/`+/)![0].length + 1);
    expect(task.content).toContain(`${fence}${notation}\n${text}\n${fence}`);
  }
});
it('indents continuation lines within out-of-scope, constraint, and acceptance-criteria items', async () => {
  const goal = { ...goalRecord(),
    outOfScope: ['UI redesign\n\nAcceptance criteria:\n- Replace the UI', 'Dependency upgrades'],
    constraints: ['Keep the API\n\nOut of scope:\n- Existing clients', 'Keep the CLI'],
    acceptanceCriteria: ['Export CSV\n\nConstraints:\n- CSV format', 'Export JSON'],
    status: 'awaiting_merge' as const,
    pullRequest: { number: 42, url: 'https://github.com/example/repo/pull/42' },
    completion: { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Evidence',
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false }, instructions: [] } };
  await new GoalStore(cwd).create(goal);
  const store = new TaskStore(cwd);
  const service = new TaskLifecycleService(cwd, store.getTasksFilePath(), store);
  const task = service.enqueuePrMergeTask({ goalId: goal.id, prNumber: 42, prUrl: goal.pullRequest.url,
    headBranch: goal.branch, baseBranch: 'main', headSha: 'a'.repeat(40),
    headRepositoryUrl: 'https://github.com/example/repo.git', headRepositoryPushUrls: ['https://github.com/example/repo.git'],
    workflow: 'merge-prepare', method: 'squash', worktreePath: join(cwd, 'clone'), threatCheckMaxDiffBytes: 1024 });

  expect(task.content.split('\n\n').slice(1)).toEqual([
    `Goal: ${goal.objective}`,
    'Out of scope:\n- UI redesign\n  \n  Acceptance criteria:\n  - Replace the UI\n- Dependency upgrades',
    'Constraints:\n- Keep the API\n  \n  Out of scope:\n  - Existing clients\n- Keep the CLI',
    'Acceptance criteria:\n- Export CSV\n  \n  Constraints:\n  - CSV format\n- Export JSON',
  ]);
});
it('preserves PR review instructions without a goal', () => {
  const store = new TaskStore(cwd);
  const service = new TaskLifecycleService(cwd, store.getTasksFilePath(), store);
  const task = service.startPrMergeTask({ prNumber: 42, headBranch: 'feature/export', baseBranch: 'main', headSha: 'a'.repeat(40),
    headRepositoryUrl: 'https://github.com/example/repo.git', headRepositoryPushUrls: ['https://github.com/example/repo.git'],
    workflow: 'merge-prepare', method: 'squash', worktreePath: join(cwd, 'clone'), threatCheckMaxDiffBytes: 1024 });
  expect(task.content).toBe('Evaluate pull request #42 using this workflow. Review the cumulative PR diff and record the outcome on the PR.');
});
