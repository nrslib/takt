import { beforeEach,expect,it,vi } from 'vitest';
import { checkTaktGoalCompletion,completeTaktGoal,mergeTaktGoalTask,reopenTaktGoal } from '../features/mcp/goalIntegrationOperations.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { responseBytes, MCP_RESPONSE_MAX_BYTES } from '../features/mcp/response.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), merge: vi.fn(), complete: vi.fn(), check: vi.fn(), reopen: vi.fn(), notify: vi.fn(), config: vi.fn(), resolve: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; } }));
vi.mock('../infra/goals/integration.js', () => ({ integrateGoalTask: doubles.merge, completeGoal: doubles.complete, checkGoalCompletion: doubles.check, reopenGoal: doubles.reopen }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue: doubles.resolve }));
vi.mock('../features/mcp/operations.js', async (original) => ({ ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: vi.fn() }));
vi.mock('../features/manager/notifications.js', () => ({ resolveManagerNotificationOptions: doubles.config, sendSavedGoalNotifications: doubles.notify }));
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
const input = { cwd: '/project', goalId: goalRecord().id };
const signal = new AbortController().signal;
beforeEach(() => { vi.resetAllMocks(); doubles.get.mockResolvedValue(goalRecord()); doubles.config.mockReturnValue({ mainMerge: 'approve', policy }); doubles.resolve.mockReturnValue('ja'); doubles.merge.mockResolvedValue({ status: 'merged' }); doubles.complete.mockResolvedValue({ status: 'awaiting_merge' }); doubles.check.mockResolvedValue({ included: true }); });
it.each(['paused', 'aborted'] as const)('rejects writes against a %s goal before invoking tools', async (executionStatus) => {
  doubles.get.mockResolvedValue({ ...goalRecord(), executionStatus });
  for (const result of [await mergeTaktGoalTask({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40) }, {}, signal), await completeTaktGoal({ ...input, expectedSha: 'a'.repeat(40), summary: 'evidence' }, {}, signal), await checkTaktGoalCompletion(input, {}, signal), await reopenTaktGoal({ ...input, reason: '追加の修正' }, {}, signal)]) expect(result.isError).toBe(true);
  expect(doubles.merge).not.toHaveBeenCalled(); expect(doubles.complete).not.toHaveBeenCalled(); expect(doubles.check).not.toHaveBeenCalled();
  expect(doubles.reopen).not.toHaveBeenCalled(); expect(doubles.notify).not.toHaveBeenCalled();
});

it.each([undefined, '', ' \n\t ', 'a'.repeat(128 * 1024 + 1)])('rejects an invalid reopen reason before invoking integration', async (reason) => {
  const result = await reopenTaktGoal({ ...input, reason: reason as string }, {}, signal);
  expect(result.isError).toBe(true);
  expect(doubles.get).not.toHaveBeenCalled();
  expect(doubles.reopen).not.toHaveBeenCalled();
  expect(doubles.notify).not.toHaveBeenCalled();
});

it('passes the reason and cancellation through integration and notifies using the saved goal before responding', async () => {
  const previous = goalRecord();
  const saved = { ...previous, workLog: [{ id: '550e8400-e29b-41d4-a716-446655440001', summary: '  追加の修正  ', recordedAt: '2026-10-15T00:00:00Z' }] };
  doubles.get.mockResolvedValue(previous);
  doubles.reopen.mockImplementation(async () => {
    doubles.get.mockResolvedValue(saved);
    return { goal: saved, workLogEntryId: saved.workLog[0]!.id };
  });
  doubles.notify.mockImplementation(async (_cwd, before, current) => {
    expect(before).toEqual(previous);
    expect(current).toEqual(saved);
    expect(await doubles.get()).toEqual(saved);
  });
  const result = await reopenTaktGoal({ ...input, reason: saved.workLog[0]!.summary }, {}, signal);
  expect(result.isError).toBeUndefined();
  expect(doubles.reopen).toHaveBeenCalledExactlyOnceWith(input.cwd, input.goalId, saved.workLog[0]!.summary, signal);
  expect(doubles.notify).toHaveBeenCalledOnce();
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ goal: {
    id: saved.id, status: 'created', executionStatus: 'active', branch: saved.branch, integrationBranch: saved.integrationBranch,
  }, workLogEntryId: saved.workLog[0]!.id });
});
it('passes reviewed SHA, notification policy and cancellation directly to integration', async () => {
  await mergeTaktGoalTask({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40) }, {}, signal);
  expect(doubles.merge).toHaveBeenCalledExactlyOnceWith(input.cwd, input.goalId, 'task', 'a'.repeat(40), signal, policy, 'ja');
});
it.each(['auto', 'approve'] as const)('uses the configured %s completion policy', async (mainMerge) => {
  doubles.config.mockReturnValue({ mainMerge, policy });
  await completeTaktGoal({ ...input, expectedSha: 'a'.repeat(40), summary: 'evidence' }, {}, signal);
  expect(doubles.complete).toHaveBeenCalledExactlyOnceWith(input.cwd, input.goalId, 'a'.repeat(40), 'evidence', mainMerge, signal, policy);
});
it.each(['merge', 'complete', 'check'] as const)('bounds %s results while retaining saved state and completion instructions', async (kind) => {
  const completion = { goalBranch: 'goal', goalSha: 'a'.repeat(40), targetBranch: 'main',
    summary: '完成根拠'.repeat(20000), instructions: ['git merge ' + 'a'.repeat(40)], reason: 'human merge',
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } };
  const goal = { ...goalRecord(), status: 'awaiting_merge', completion,
    workLog: Array.from({ length: 200 }, () => ({ summary: '履歴'.repeat(20000) })) };
  doubles[kind].mockResolvedValue({ status: kind === 'merge' ? 'merged' : 'awaiting_merge', included: false, sha: 'b'.repeat(40), completion, goal });
  const result = kind === 'merge' ? await mergeTaktGoalTask({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40) }, {}, signal)
    : kind === 'complete' ? await completeTaktGoal({ ...input, summary: 'evidence', expectedSha: 'a'.repeat(40) }, {}, signal)
      : await checkTaktGoalCompletion(input, {}, signal);
  expect(result.isError).toBeUndefined();
  expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  const output = JSON.parse(firstTextContent(result.content));
  expect(output).toMatchObject({ status: kind === 'merge' ? 'merged' : 'awaiting_merge', included: false, sha: 'b'.repeat(40),
    goal: { status: 'awaiting_merge' }, completion: { goalSha: 'a'.repeat(40), targetBranch: 'main', instructions: completion.instructions, reason: 'human merge', truncated: true } });
  expect(output.goal).not.toHaveProperty('workLog');
  expect(output.completion.omissions[0].totalBytes).toBe(Buffer.byteLength(completion.summary));
});
