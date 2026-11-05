import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CommandRequest } from '../core/daemon/io.js';
import type { EventInput } from '../core/daemon/events.js';
import { GOAL_PR_RETRY_DELAYS } from '../infra/goals/pull-request-failure.js';
import { GoalPullRequestRetries, type GoalPullRequestRetryTarget } from '../features/daemon/watchers/goalPullRequestRetries.js';
import { watchKey, WatchObservations, type WatchRecord, type WatchRecordStore } from '../features/daemon/watchers/observations.js';

const sha = 'a'.repeat(40);
const target: GoalPullRequestRetryTarget = { conversationId: 'manager', targetId: 'goal', generation: 'failure-generation',
  repositoryDirectory: '/repo', goalId: 'goal', expectedSha: sha, failureId: 'failure', failedAt: '2026-11-06T00:00:00.000Z', error: 'commit_refs', headBranch: 'takt/goal' };
function harness() {
  const saved = new Map<string, WatchRecord>();
  const records: WatchRecordStore = { read: async (key) => saved.get(key), write: async (key, value) => { saved.set(key, structuredClone(value)); } };
  const events: EventInput[] = [];
  const accept = vi.fn(async (input: EventInput) => {
    if (!events.some((event) => event.eventId === input.eventId)) events.push(input);
    return { kind: 'accepted' as const, eventId: input.eventId, operationId: 'op', acceptedSequence: 1 };
  });
  const observations = new WatchObservations(records, { accept }, Date.now);
  const reread = vi.fn<() => Promise<GoalPullRequestRetryTarget | undefined>>().mockResolvedValue(target);
  const notifyPullRequestRetryLimit = vi.fn(async () => true);
  const run = vi.fn(async (_request: CommandRequest) => ({ code: 0, signal: null, truncated: false,
    stdout: Buffer.from(sha), stderr: Buffer.alloc(0) }));
  const create = () => new GoalPullRequestRetries({ pullRequestRetry: reread, notifyPullRequestRetryLimit }, { run }, records, observations, Date.now);
  return { records, events, accept, reread, run, create, notifyPullRequestRetryLimit };
}
const options = () => ({ signal: new AbortController().signal, timeoutMs: 60_000 });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(target.failedAt); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('checks the goal repository tip without inherited Git repository or command configuration overrides', async () => {
  const overrides = {
    GIT_DIR: '/other/.git', GIT_WORK_TREE: '/other', GIT_COMMON_DIR: '/other/.git', GIT_INDEX_FILE: '/other/index',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: '/other',
    GIT_CONFIG_KEY_1: 'core.bare', GIT_CONFIG_VALUE_1: 'true',
    GIT_CONFIG: '/other/config', GIT_CONFIG_PARAMETERS: "'core.worktree=/other'",
  };
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  const h = harness();
  const io = options();
  vi.setSystemTime(Date.now() + 60_000);
  await h.create().observe(target, io);
  expect(h.run).toHaveBeenCalledOnce();
  const request = h.run.mock.calls[0]![0];
  expect(request.cwd).toBe(target.repositoryDirectory);
  expect(request.args).toEqual(['rev-parse', '--verify', 'refs/heads/takt/goal^{commit}']);
  for (const [key, value] of Object.entries(overrides)) {
    expect(request.env[key]).not.toBe(value);
    expect(process.env[key]).toBe(value);
  }
  expect(h.events).toHaveLength(1);
});

it('counts admission immediately and emits six events at the prescribed intervals without waiting for manager results', async () => {
  const h = harness();
  await h.create().observe(target, options());
  expect(h.run).not.toHaveBeenCalled();
  for (const [index, delay] of GOAL_PR_RETRY_DELAYS.entries()) {
    vi.setSystemTime(Date.now() + delay - 1);
    await h.create().observe(target, options());
    expect(h.events).toHaveLength(index);
    vi.setSystemTime(Date.now() + 1);
    await h.create().observe(target, options());
    expect(h.events).toHaveLength(index + 1);
    expect((await h.records.read(watchKey(target, 'goal_pr_retry')))?.retry).toEqual({ attempts: index + 1, lastAttemptAt: new Date().toISOString() });
    expect(h.events[index]?.event).toMatchObject({ kind: 'watch_observation', observation: {
      kind: 'goal_pr_retry', goalId: target.goalId, expectedSha: sha, reason: target.error, attempt: index + 1, maxAttempts: 6,
    } });
  }
  await h.create().observe(target, options());
  vi.setSystemTime(Date.now() + 86400_000);
  await h.create().observe(target, options());
  expect(h.events).toHaveLength(6);
  expect(h.notifyPullRequestRetryLimit).toHaveBeenCalledOnce();
  expect(h.notifyPullRequestRetryLimit).toHaveBeenCalledWith(target, expect.objectContaining({ timeoutMs: 60_000 }));
  expect(new Set(h.events.map((event) => event.eventId)).size).toBe(6);
  expect(h.run.mock.calls.every(([request]) => request.executable === 'git'
    && request.args.join(' ') === 'rev-parse --verify refs/heads/takt/goal^{commit}')).toBe(true);
});

it('does not emit when rereading no longer returns an eligible goal', async () => {
  const h = harness(); h.reread.mockResolvedValue(undefined);
  vi.setSystemTime(Date.now() + 60_000);
  await h.create().observe(target, options());
  expect(h.run).not.toHaveBeenCalled();
  expect(h.events).toHaveLength(0);
  expect(await h.records.read(watchKey(target, 'goal_pr_retry'))).toBeUndefined();
});

it('does not emit or consume an attempt after the branch tip changes', async () => {
  const h = harness();
  h.run.mockResolvedValue({ code: 0, signal: null, truncated: false, stdout: Buffer.from('b'.repeat(40)), stderr: Buffer.alloc(0) });
  vi.setSystemTime(Date.now() + 60_000);
  await h.create().observe(target, options());
  expect(h.events).toHaveLength(0);
  expect(await h.records.read(watchKey(target, 'goal_pr_retry'))).toBeUndefined();
});

it('rechecks state after reading the branch tip before emitting', async () => {
  const h = harness();
  h.reread.mockResolvedValueOnce(target).mockResolvedValue(undefined);
  vi.setSystemTime(Date.now() + 60_000);
  await h.create().observe(target, options());
  expect(h.run).toHaveBeenCalledOnce();
  expect(h.events).toHaveLength(0);
});

it('ignores a stale generation', async () => {
  const h = harness(); h.reread.mockResolvedValue({ ...target, generation: 'new-completion' });
  vi.setSystemTime(Date.now() + 60_000);
  await h.create().observe(target, options());
  expect(h.run).not.toHaveBeenCalled();
  expect(h.events).toHaveLength(0);
});

it.each(['ineligible', 'changed-tip'])('suppresses the limit notification for %s goals', async (state) => {
  const h = harness();
  for (const delay of GOAL_PR_RETRY_DELAYS) {
    vi.setSystemTime(Date.now() + delay);
    await h.create().observe(target, options());
  }
  if (state === 'ineligible') h.reread.mockResolvedValue(undefined);
  else h.run.mockResolvedValue({ code: 0, signal: null, truncated: false, stdout: Buffer.from('b'.repeat(40)), stderr: Buffer.alloc(0) });
  await h.create().observe(target, options());
  expect(h.events).toHaveLength(6);
  expect(h.notifyPullRequestRetryLimit).not.toHaveBeenCalled();
});

it.each([1, 6])('replays only the same pending admission for attempt %i after restart and workspace assignment', async (attempt) => {
  const h = harness();
  for (const delay of GOAL_PR_RETRY_DELAYS.slice(0, attempt - 1)) {
    vi.setSystemTime(Date.now() + delay);
    await h.create().observe(target, options());
  }
  vi.setSystemTime(Date.now() + GOAL_PR_RETRY_DELAYS[attempt - 1]!);
  const admit = h.accept.getMockImplementation()!;
  h.accept.mockImplementationOnce(async (input) => { await admit(input); throw new Error('response lost'); });
  await expect(h.create().observe(target, options())).rejects.toThrow();
  const pending = h.accept.mock.calls.at(-1)![0];
  const reassigned = { ...target, conversationId: 'workspace-manager' };
  h.reread.mockResolvedValue(reassigned);
  await h.create().observe(reassigned, options());
  expect(h.accept.mock.calls.at(-1)![0]).toEqual(pending);
  expect(h.events).toHaveLength(attempt);
  expect((await h.records.read(watchKey(reassigned, 'goal_pr_retry')))?.retry?.attempts).toBe(attempt);
});

it('does not emit if the event cannot be saved', async () => {
  const h = harness();
  vi.spyOn(h.records, 'write').mockRejectedValue(new Error('storage unavailable'));
  vi.setSystemTime(Date.now() + 60_000);
  await expect(h.create().observe(target, options())).rejects.toThrow();
  expect(h.accept).not.toHaveBeenCalled();
});

it('recovers an interrupted acceptance save with the same event ID and counts it once', async () => {
  const h = harness();
  const write = h.records.write.bind(h.records);
  vi.spyOn(h.records, 'write').mockImplementation(async (key, record) => {
    if (record.accepted) throw new Error('storage unavailable');
    await write(key, record);
  });
  vi.setSystemTime(Date.now() + 60_000);
  await expect(h.create().observe(target, options())).rejects.toThrow();
  vi.mocked(h.records.write).mockImplementation(write);
  await h.create().observe(target, options());
  await h.create().observe(target, options());
  expect(h.events).toHaveLength(1);
  expect(h.accept).toHaveBeenCalledTimes(2);
  expect(h.accept.mock.calls[0]![0]).toEqual(h.accept.mock.calls[1]![0]);
  expect((await h.records.read(watchKey(target, 'goal_pr_retry')))?.retry?.attempts).toBe(1);
});

it('checks the branch successfully before emitting and respects cancellation', async () => {
  const h = harness();
  vi.setSystemTime(Date.now() + 60_000);
  h.run.mockResolvedValueOnce({ code: 1, signal: null, truncated: false, stdout: Buffer.alloc(0), stderr: Buffer.from('missing') });
  await expect(h.create().observe(target, options())).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(h.create().observe(target, { ...options(), signal: controller.signal })).rejects.toThrow();
  expect(h.events).toHaveLength(0);
});
