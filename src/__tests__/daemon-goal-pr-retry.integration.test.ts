import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { FileWatchRecords } from '../infra/daemon/watchRecords.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { createWatchSource } from './helpers/daemon-watch-source.js';
import { watchKey, WatchObservations } from '../features/daemon/watchers/observations.js';
import { GoalPullRequestRetries } from '../features/daemon/watchers/goalPullRequestRetries.js';
import { WatchGoalReader } from '../features/daemon/watchers/goalReader.js';
import { GOAL_PR_RETRY_DELAYS } from '../infra/goals/pull-request-failure.js';
import type { Goal } from '../infra/goals/schema.js';
import type { EventInput } from '../core/daemon/events.js';
import type { ManagerTurnInput } from '../features/manager/turnExecutor.js';
import { conversationDaemon } from './helpers/conversation-daemon.js';
import { deferred } from './helpers/controlledDaemon.js';
import * as repositoryDirectory from '../infra/task/repositoryDirectory.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const daemons: Awaited<ReturnType<typeof conversationDaemon>>[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const daemon of daemons.splice(0)) await daemon.close();
  vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture() {
  const directory = getGlobalConfigDir();
  const repository = join(directory, 'repository');
  await mkdir(join(repository, '.takt'), { recursive: true });
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const conversations = new DaemonConversations(new ConversationStateStore(directory), new DaemonRouting(directory),
    new DaemonNotifications(directory), async () => {}, (error) => { throw error; });
  vi.spyOn(conversations, 'ensure').mockResolvedValue(undefined);
  return { directory, repository, conversations, id: conversationId({ kind: 'repository', repositoryDirectory: repository }) };
}

it('finds legacy PR failures, keeps their generation stable, and excludes paused, aborted, reopened and published goals', async () => {
  const f = await fixture();
  const sha = 'a'.repeat(40);
  const failure = { id: randomUUID(), recordedAt: '2026-11-06T00:00:00.000Z', summary: 'Goal PR push failed: commit_refs' };
  const goal: Goal = { ...goalRecord(), status: 'awaiting_merge', workLog: [failure], completion: {
    goalBranch: goalRecord().branch, goalSha: sha, targetBranch: 'main', summary: 'verified', humanChecks: 'Open result', instructions: [],
    changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [], truncated: false, totalsTruncated: false },
  } };
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true });
  const save = (value: Goal) => writeFile(path, JSON.stringify(value));
  const source = createWatchSource(f.conversations, async () => {}, (error) => { throw error; });
  await save(goal);
  const [target] = await source.pullRequestRetries();
  expect(target).toMatchObject({ expectedSha: sha, failureId: failure.id, error: failure.summary });
  expect(await source.pullRequestRetry(target!)).toEqual(target);
  await save({ ...goal, pullRequestFailure: { id: failure.id, recordedAt: failure.recordedAt, goalSha: sha, error: 'Goal PR creation failed: unavailable' } });
  expect((await source.pullRequestRetries())[0]?.generation).toBe(target!.generation);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(failure.recordedAt) + 60_000);
  const records = new FileWatchRecords(f.directory);
  const accept = vi.fn();
  const run = vi.fn();
  const retries = new GoalPullRequestRetries(source, { run }, records, new WatchObservations(records, { accept }, Date.now), Date.now);
  for (const changed of [
    { ...goal, executionStatus: 'paused' as const }, { ...goal, executionStatus: 'aborted' as const },
    { ...goal, status: 'created' as const }, { ...goal, workLog: [] },
    { ...goal, pullRequest: { number: 42, url: 'https://github.com/example/project/pull/42' } },
    { ...goal, pullRequestFailure: { id: failure.id, recordedAt: failure.recordedAt, goalSha: 'b'.repeat(40), error: failure.summary } },
  ]) {
    await save(changed);
    expect(await source.pullRequestRetries()).toEqual([]);
    expect(await source.pullRequestRetry(target!)).toBeUndefined();
    await retries.observe(target!, { signal: new AbortController().signal, timeoutMs: 60_000 });
  }
  expect(accept).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  await save({ ...goal, pullRequest: { number: 42, url: 'https://github.com/example/project/pull/42' } });
  expect(await source.pullRequests()).toMatchObject([{ goalId: goal.id, number: 42 }]);
});

async function retryFixture() {
  vi.spyOn(repositoryDirectory, 'resolveGitRepositoryDirectory').mockImplementation((directory) => realpath(directory));
  const directory = getGlobalConfigDir();
  const repository = join(directory, 'repository');
  await mkdir(join(repository, '.takt'), { recursive: true });
  await writeFile(join(repository, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  auto_run: false\n');
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const execute = vi.fn(async (input: ManagerTurnInput) => ({ message: 'handled', summary: null, sessionId: 'session', assignment: input.assignment }));
  const provider: Parameters<typeof conversationDaemon>[1] = { async resolve() {
    return { provider: 'mock', model: null, language: 'en', contextKey: 'retry-test', executor: { execute } };
  }, async close() {} };
  let daemon = await conversationDaemon(directory, provider);
  daemons.push(daemon);
  const failedAt = '2026-11-06T00:00:00.000Z';
  const goal: Goal = { ...goalRecord(), status: 'awaiting_merge',
    pullRequestFailure: { id: randomUUID(), recordedAt: failedAt, goalSha: 'a'.repeat(40), error: 'commit_refs' },
    completion: { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified',
      humanChecks: 'Open result', instructions: [],
      changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [], truncated: false, totalsTruncated: false } },
  };
  const goalDirectory = join(repository, '.takt', 'goals', goal.id);
  await mkdir(goalDirectory, { recursive: true });
  await writeFile(join(goalDirectory, 'goal.json'), JSON.stringify(goal));
  let source = createWatchSource(daemon.conversations, async () => {}, (error) => { throw error; });
  const target = (await source.pullRequestRetries())[0]!;
  const run = vi.fn(async () => ({ code: 0, signal: null, truncated: false,
    stdout: Buffer.from(target.expectedSha), stderr: Buffer.alloc(0) }));
  const accept = vi.fn((input: EventInput) => daemon.dispatcher.accept(input));
  const restart = () => {
    const records = new FileWatchRecords(directory);
    return new GoalPullRequestRetries(source, { run }, records,
      new WatchObservations(records, { accept }, Date.now), Date.now);
  };
  const options = { signal: new AbortController().signal, timeoutMs: 60_000 };
  const addWorkspace = async () => {
    const id = randomUUID();
    const workspaceDirectory = join(directory, 'workspaces', id);
    await mkdir(workspaceDirectory, { recursive: true });
    await writeFile(join(workspaceDirectory, 'workspace.json'), JSON.stringify({ id, name: 'retry-workspace', repositoryDirectories: [repository] }));
    const reassigned = (await source.pullRequestRetries())[0]!;
    expect(reassigned).toEqual({ ...target, conversationId: conversationId({ kind: 'workspace', workspaceId: id }) });
    expect(reassigned.conversationId).not.toBe(target.conversationId);
    return reassigned;
  };
  const saved = () => new FileWatchRecords(directory).read(watchKey(target, 'goal_pr_retry'));
  const readGoal = () => new DaemonPersistedFiles(directory).readGoal(repository, goal.id);
  const saveGoal = (value: Goal) => writeFile(join(goalDirectory, 'goal.json'), JSON.stringify(value));
  const reboot = async () => {
    await source.close();
    await daemon.close();
    daemons.splice(daemons.indexOf(daemon), 1);
    daemon = await conversationDaemon(directory, provider);
    daemons.push(daemon);
    source = createWatchSource(daemon.conversations, async () => {}, (error) => { throw error; });
  };
  return { directory, repository, get daemon() { return daemon; }, target, run, accept, execute, restart, options, addWorkspace, saved,
    readGoal, saveGoal, reboot };

}

it('persists accepted attempts and timing across daemon restarts and saves one limit notification without a manager turn', async () => {
  const h = await retryFixture();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(h.target.failedAt);
  for (const [index, delay] of GOAL_PR_RETRY_DELAYS.entries()) {
    vi.setSystemTime(Date.now() + delay - 1);
    await h.restart().observe(h.target, h.options);
    expect(h.accept).toHaveBeenCalledTimes(index);
    vi.setSystemTime(Date.now() + 1);
    await h.restart().observe(h.target, h.options);
    expect(h.accept).toHaveBeenCalledTimes(index + 1);
    expect(await h.saved()).toMatchObject({ accepted: true,
      retry: { attempts: index + 1, lastAttemptAt: new Date().toISOString() } });
    await h.daemon.settled();
    if (index === 1) await h.reboot();
  }
  await h.restart().observe(h.target, h.options);
  expect((await h.readGoal())?.notifications).toMatchObject([{ kind: 'blocked', severity: 'error' }]);
  const notifications = (await h.readGoal())!.notifications!;
  expect(notifications[0]!.body).toContain('commit_refs');
  await h.reboot();
  vi.setSystemTime(Date.now() + 86400_000);
  await h.restart().observe(h.target, h.options);
  expect(h.accept).toHaveBeenCalledTimes(6);
  expect(h.execute).toHaveBeenCalledTimes(6);
  expect((await h.readGoal())?.notifications).toEqual(notifications);
});

it.each([2, 6])('preserves the retry budget when a workspace is added after %i accepted events', async (beforeAssignment) => {
  const h = await retryFixture();
  let target = h.target;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(target.failedAt);
  for (const [index, delay] of GOAL_PR_RETRY_DELAYS.entries()) {
    if (index === beforeAssignment) target = await h.addWorkspace();
    vi.setSystemTime(Date.now() + delay);
    await h.restart().observe(target, h.options);
    await h.daemon.settled();
  }
  if (beforeAssignment === 6) target = await h.addWorkspace();
  await h.restart().observe(target, h.options);
  await h.reboot();
  await h.restart().observe(target, h.options);
  expect(h.accept).toHaveBeenCalledTimes(6);
  expect(h.accept.mock.calls.map(([event]) => event.conversationId)).toEqual(
    Array.from({ length: 6 }, (_, index) => index < beforeAssignment ? h.target.conversationId : target.conversationId));
  expect(await h.saved()).toMatchObject({ retry: { attempts: 6, limitNotified: true } });
  expect((await h.readGoal())?.notifications).toHaveLength(1);
});

it('advances to the next interval when manager turns fail instead of reissuing the same attempt', async () => {
  const h = await retryFixture();
  h.execute.mockRejectedValue(new Error('manager failed'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(h.target.failedAt);
  for (const [index, delay] of GOAL_PR_RETRY_DELAYS.entries()) {
    vi.setSystemTime(Date.now() + delay - 1);
    await h.restart().observe(h.target, h.options);
    expect(h.accept).toHaveBeenCalledTimes(index);
    vi.setSystemTime(Date.now() + 1);
    await h.restart().observe(h.target, h.options);
    await h.daemon.settled();
    expect(h.accept.mock.calls.at(-1)![0].event).toMatchObject({ observation: { attempt: index + 1 } });
  }
  await h.restart().observe(h.target, h.options);
  await h.restart().observe(h.target, h.options);
  expect(h.accept).toHaveBeenCalledTimes(6);
  expect((await h.readGoal())?.notifications).toHaveLength(7); // Six turn failures and one retry limit.
});

it.each([1, 6])('consumes attempt %i if paused after acceptance and resumes without replaying it', async (attempt) => {
  const h = await retryFixture();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(h.target.failedAt);
  for (const delay of GOAL_PR_RETRY_DELAYS.slice(0, attempt - 1)) {
    vi.setSystemTime(Date.now() + delay);
    await h.restart().observe(h.target, h.options);
    await h.daemon.settled();
  }
  const admit = h.accept.getMockImplementation()!;
  h.accept.mockImplementationOnce(async (input) => {
    await h.saveGoal({ ...(await h.readGoal())!, executionStatus: 'paused' });
    return admit(input);
  });
  vi.setSystemTime(Date.now() + GOAL_PR_RETRY_DELAYS[attempt - 1]!);
  await h.restart().observe(h.target, h.options);
  await h.daemon.settled();
  expect(h.execute).toHaveBeenCalledTimes(attempt - 1);
  expect((await h.saved())?.retry?.attempts).toBe(attempt);
  vi.setSystemTime(Date.now() + 86400_000);
  await h.restart().observe(h.target, h.options);
  expect(h.accept).toHaveBeenCalledTimes(attempt);
  expect((await h.readGoal())?.notifications ?? []).toHaveLength(0);
  await h.saveGoal({ ...(await h.readGoal())!, executionStatus: 'active' });
  await h.restart().observe(h.target, h.options);
  if (attempt === 6) {
    expect(h.accept).toHaveBeenCalledTimes(6);
    expect((await h.readGoal())?.notifications).toHaveLength(1);
  } else {
    expect(h.accept).toHaveBeenCalledTimes(2);
    expect(h.accept.mock.calls[1]![0].event).toMatchObject({ observation: { attempt: 2 } });
    await h.daemon.settled();
    await h.restart().observe(h.target, h.options);
    expect(h.accept).toHaveBeenCalledTimes(2);
  }
});

it.each([false, true])('counts an accepted event once after workspace reassignment (lost acknowledgement: %s)', async (loseAcknowledgement) => {
  const h = await retryFixture();
  const entered = deferred<void>(); const release = deferred<void>();
  releases.push(() => release.resolve());
  const snapshot = h.daemon.conversations.snapshot.bind(h.daemon.conversations);
  vi.spyOn(h.daemon.conversations, 'snapshot').mockImplementationOnce(async (id) => {
    entered.resolve(); await release.promise; return snapshot(id);
  });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(h.target.failedAt) + 60_000);
  const admit = h.accept.getMockImplementation()!;
  if (loseAcknowledgement) h.accept.mockImplementationOnce(async (input) => { await admit(input); throw new Error('response lost'); });
  if (loseAcknowledgement) await expect(h.restart().observe(h.target, h.options)).rejects.toThrow();
  else await h.restart().observe(h.target, h.options);
  await entered.promise;
  const original = (await h.saved())!.input!;
  const target = await h.addWorkspace();
  try {
    await h.restart().observe(target, h.options);
    expect((await h.saved())?.input).toEqual(original);
    expect((await h.saved())?.retry?.attempts).toBe(1);
    if (loseAcknowledgement) expect(h.accept.mock.calls[1]![0]).toEqual(original);
  } finally { release.resolve(); }
  await h.daemon.settled();
  expect(h.execute).not.toHaveBeenCalled();
  await h.restart().observe(target, h.options);
  expect((await h.saved())?.input).toEqual(original);
  vi.setSystemTime(Date.now() + GOAL_PR_RETRY_DELAYS[1]);
  await h.restart().observe(target, h.options);
  await h.daemon.settled();
  expect(h.accept.mock.calls.at(-1)![0]).toMatchObject({ conversationId: target.conversationId, event: { observation: { attempt: 2 } } });
  expect((await h.saved())?.retry?.attempts).toBe(2);
});

it('deduplicates the saved limit notification when the watch record save fails', async () => {
  const h = await retryFixture();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(h.target.failedAt);
  for (const delay of GOAL_PR_RETRY_DELAYS) {
    vi.setSystemTime(Date.now() + delay);
    await h.restart().observe(h.target, h.options);
    await h.daemon.settled();
  }
  const write = vi.spyOn(FileWatchRecords.prototype, 'write').mockRejectedValueOnce(new Error('record unavailable'));
  await expect(h.restart().observe(h.target, h.options)).rejects.toThrow();
  write.mockRestore();
  const notifications = (await h.readGoal())!.notifications!;
  expect(notifications).toHaveLength(1);
  await h.reboot();
  const target = await h.addWorkspace();
  await h.restart().observe(target, h.options);
  expect((await h.readGoal())?.notifications).toEqual(notifications);
  expect(h.accept).toHaveBeenCalledTimes(6);
});

it('leaves the limit notification pending when the goal pauses before notification persistence', async () => {
  const h = await retryFixture();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(h.target.failedAt);
  for (const delay of GOAL_PR_RETRY_DELAYS) {
    vi.setSystemTime(Date.now() + delay);
    await h.restart().observe(h.target, h.options);
    await h.daemon.settled();
  }
  const notify = WatchGoalReader.prototype.savePullRequestRetryLimit;
  vi.spyOn(WatchGoalReader.prototype, 'savePullRequestRetryLimit').mockImplementationOnce(async function (this: WatchGoalReader, ...args) {
    await h.saveGoal({ ...(await h.readGoal())!, executionStatus: 'paused' });
    return notify.apply(this, args);
  });
  await h.restart().observe(h.target, h.options);
  expect((await h.saved())?.retry?.limitNotified).toBeUndefined();
  expect((await h.readGoal())?.notifications ?? []).toHaveLength(0);
  await h.saveGoal({ ...(await h.readGoal())!, executionStatus: 'active' });
  await h.restart().observe(h.target, h.options);
  expect((await h.saved())?.retry?.limitNotified).toBe(true);
  expect((await h.readGoal())?.notifications).toHaveLength(1);
  expect(h.accept).toHaveBeenCalledTimes(6);
});
