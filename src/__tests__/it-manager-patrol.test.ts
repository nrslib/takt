import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enqueueDueGoalPatrols } from '../features/manager/patrol.js';
import { createRunEventManager } from '../features/manager/runEventManager.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { GoalStore } from '../infra/goals/store.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { MockProvider } from '../infra/providers/mock.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { checkTaktGoalCompletion } from '../features/mcp/goalIntegrationOperations.js';
import { TaskRunner } from '../infra/task/runner.js';
import type { ProviderAgent } from '../infra/providers/types.js';

const github = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('../infra/github/pr-command.js', () => ({ runPrCommand: github.command }));
vi.mock('../infra/goals/git-command.js', async (original) => ({
  ...await original<typeof import('../infra/goals/git-command.js')>(),
  fetchGoalIntegrationBranchSha: vi.fn(async () => 'b'.repeat(40)),
  isGoalContentIncluded: vi.fn(async () => false),
}));

vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({
  ...await original<typeof import('../infra/task/repositoryDirectory.js')>(),
  resolveGitRepositoryDirectory: async (path: string) => path,
}));
vi.mock('../features/manager/managerMcp.js', async (original) => ({
  ...await original<typeof import('../features/manager/managerMcp.js')>(),
  connectManagerMcp: async () => ({ servers: {}, dispose: async () => {} }),
}));
vi.mock('../features/manager/conversationPlan.js', () => ({
  createManagerConversationPlan: () => ({
    ctx: { provider: new MockProvider(), providerType: 'mock', lang: 'ja' },
    strategy: { systemPrompt: 'manager patrol fixture' },
  }),
}));

let root: string;
let cwd: string;
let manager: ReturnType<typeof createRunEventManager>;
beforeEach(async () => {
  github.command.mockReset().mockRejectedValue(new Error('GitHub fake is unavailable'));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-patrol-')));
  cwd = join(root, 'project');
  mkdirSync(join(cwd, '.takt'), { recursive: true });
  vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T01:00:00Z');
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  patrol_interval: 1800\n');
  invalidateGlobalConfigCache();
  await new GoalStore(cwd).create({ ...goalRecord(), createdAt: '2026-10-14T00:00:00Z' });
  manager = createRunEventManager(cwd);
});
afterEach(async () => {
  await manager.close(); resetScenario(); invalidateGlobalConfigCache();
  vi.restoreAllMocks();
  vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
const signal = new AbortController().signal;
function reply(message: string) {
  const structuredOutput = { message, summary: null };
  return { status: 'done' as const, content: JSON.stringify(structuredOutput), structuredOutput };
}

it('refreshes PR status on the same manager across patrols and completes an externally merged goal without tasks', async () => {
  const store = new GoalStore(cwd);
  const pullRequest = { number: 1950, url: 'https://github.com/example/project/pull/1950' };
  const goal = await store.update(goalRecord().id, (current) => ({ ...current,
    status: 'awaiting_merge', pullRequest,
    completion: { goalBranch: current.branch, goalSha: 'a'.repeat(40), targetBranch: 'main',
      summary: '確認が完了した', instructions: [], changeSummary: { filesChanged: 1, additions: 1,
        deletions: 0, files: [], truncated: false, totalsTruncated: false } },
  }));
  let state = 'OPEN';
  github.command.mockImplementation(async (args: string[], directory: string) => {
    expect(directory).toBe(cwd);
    expect(args.slice(0, 3)).toEqual(['pr', 'view', pullRequest.url]);
    return JSON.stringify({ ...pullRequest, headRefName: goal.branch, baseRefName: 'main',
      headRefOid: 'c'.repeat(40), baseRefOid: 'b'.repeat(40), mergeCommit: state === 'MERGED' ? { oid: 'b'.repeat(40) } : null, state });
  });
  const completionResults: Awaited<ReturnType<typeof checkTaktGoalCompletion>>[] = [];
  const prompts: string[] = [];
  const mergedStatus = /"[^"]+"\s*:\s*"merged"|"merged"\s*:\s*true/i;
  const call = vi.fn<ProviderAgent['call']>().mockImplementation(async (prompt) => {
    prompts.push(prompt);
    if (mergedStatus.test(prompt)) {
      completionResults.push(await checkTaktGoalCompletion({ cwd, goalId: goal.id }, {}, signal));
    }
    return { persona: 'manager', timestamp: new Date(), ...reply('巡回を確認した') };
  });
  const setup = vi.spyOn(MockProvider.prototype, 'setup').mockReturnValue({ call });
  const tasks = new TaskRunner(cwd).listTaskStateItems();

  await enqueueDueGoalPatrols(cwd, 1800);
  await manager.processPending(signal, 10);
  expect(prompts).toHaveLength(1);
  expect(JSON.parse(prompts[0]!).goal.id).toBe(goal.id);
  expect(prompts[0]).toMatch(/\bopen\b|"merged"\s*:\s*false/i);
  expect(await store.get(goal.id)).toMatchObject({ status: 'awaiting_merge' });
  expect(completionResults).toEqual([]);

  state = 'MERGED';
  vi.setSystemTime('2026-10-14T01:30:00Z');
  await enqueueDueGoalPatrols(cwd, 1800);
  await manager.processPending(signal, 10);

  expect(prompts).toHaveLength(2);
  expect(JSON.parse(prompts[1]!).goal.id).toBe(goal.id);
  expect(prompts[1]).toMatch(mergedStatus);
  expect(setup).toHaveBeenCalledOnce();
  expect(completionResults).toHaveLength(1);
  expect(completionResults[0]!.isError).toBeUndefined();
  expect(await store.get(goal.id)).toMatchObject({ status: 'completed',
    completion: { goalSha: 'a'.repeat(40), targetSha: 'b'.repeat(40) } });
  expect(new TaskRunner(cwd).listTaskStateItems()).toEqual(tasks);
  expect(readManagerEvents(cwd)).toEqual([]);
});

it('persists successful patrols and schedules the next one from the saved completion time after reopening', async () => {
  await enqueueDueGoalPatrols(cwd, 1800); await enqueueDueGoalPatrols(cwd, 1800);
  expect(readManagerEvents(cwd)).toHaveLength(1);
  setMockScenario([reply('点検を終えました')]);
  await manager.processPending(signal, 10);
  expect(readManagerEvents(cwd)).toEqual([]);
  const saved = await new GoalStore(cwd).get(goalRecord().id);
  expect(saved.lastPatrolCompletedAt).toBe('2026-10-14T01:00:00.000Z');
  expect(saved.workLog).toEqual([expect.objectContaining({ kind: 'patrol' })]);
  await manager.close(); manager = createRunEventManager(cwd);
  vi.setSystemTime('2026-10-14T01:29:59Z'); await enqueueDueGoalPatrols(cwd, 1800);
  expect(readManagerEvents(cwd)).toEqual([]);
  vi.setSystemTime('2026-10-14T01:30:00Z'); await enqueueDueGoalPatrols(cwd, 1800);
  expect(readManagerEvents(cwd)).toEqual([expect.objectContaining({ event: expect.objectContaining({ kind: 'patrol' }) })]);
});

it('retries retained ordinary failures during patrol and persists failed patrol timing and blocked notification', async () => {
  saveManagerEvent(cwd, { kind: 'registered', goalId: goalRecord().id });
  setMockScenario([{ status: 'error', content: '', error: 'registration failed' }]);
  await manager.processPending(signal, 10);
  expect(readManagerEvents(cwd)).toHaveLength(1);
  setMockScenario([reply('登録を処理しました'), { status: 'error', content: '', error: 'patrol failed' }]);
  await manager.processPending(signal, 10);
  expect(readManagerEvents(cwd)).toHaveLength(1);
  await enqueueDueGoalPatrols(cwd, 1800);
  await manager.processPending(signal, 10);
  expect(readManagerEvents(cwd)).toEqual([]);
  const saved = await new GoalStore(cwd).get(goalRecord().id);
  expect(saved.lastPatrolCompletedAt).toBe('2026-10-14T01:00:00.000Z');
  expect(saved.notifications?.map((notification) => notification.kind)).toEqual(['blocked', 'blocked']);
  expect(saved.workLog).toEqual([expect.objectContaining({ summary: '登録を処理しました' })]);
  vi.setSystemTime('2026-10-14T01:29:59Z'); await enqueueDueGoalPatrols(cwd, 1800);
  expect(readManagerEvents(cwd)).toEqual([]);
});
