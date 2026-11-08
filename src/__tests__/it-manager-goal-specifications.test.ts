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
it.each([undefined, '```', '`````', 'prefix ```` suffix'])('includes specifications with safe fences in final goal PR review instructions: %s', async (ticks) => {
  const specs = ticks === undefined ? specifications : Object.fromEntries(Object.entries(specifications).map(([notation, text]) => [notation, `${text}\n${ticks}\nRemaining specification`]));
  const goal = { ...goalRecord(), specifications: specs, status: 'awaiting_merge' as const,
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
  expect(task.content).toContain(goal.acceptanceCriteria[0]);
  for (const [notation, text] of Object.entries(specs)) {
    const fence = '`'.repeat(ticks === undefined ? 3 : ticks.match(/`+/)![0].length + 1);
    expect(task.content).toContain(`${fence}${notation}\n${text}\n${fence}`);
  }
});
