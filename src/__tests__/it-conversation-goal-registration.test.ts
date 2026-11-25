import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerReservedGoal } from '../infra/goals/service.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { goalRecord, goalInput } from './helpers/goal-fixtures.js';
import { GoalStore } from '../infra/goals/store.js';
import { conversationId } from '../infra/conversations/identity.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { conversationDaemon } from './helpers/conversation-daemon.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { receiveInboxChange } from '../features/daemon/inbox.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import type { ConversationCommand } from '../features/manager/conversationPort.js';
import type { PreparedConversationRuntime } from '../features/manager/conversationRuntime.js';

let repository: string;
function git(...args: string[]) { return execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function request() { return { cwd: repository, ...goalInput(), id: goalRecord().id, startBranch: 'main', integrationBranch: 'main' }; }
function savedPath() { return join(repository, '.takt', 'goals', goalRecord().id, 'goal.json'); }
beforeEach(() => {
  repository = join(getGlobalConfigDir(), 'repository'); mkdirSync(repository);
  git('init', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
});

it('reuses the exact reserved goal without another branch, goal or registration event', async () => {
  const created = await registerReservedGoal(request());
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  const events = readManagerEvents(repository);
  const bytes = readFileSync(savedPath());
  expect(await registerReservedGoal(request())).toEqual(created);
  expect(readFileSync(savedPath())).toEqual(bytes);
  expect(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(refs);
  expect(readManagerEvents(repository)).toEqual(events);
  expect(events.filter(({ event }) => event.kind === 'registered' && event.goalId === created.id)).toHaveLength(1);
  expect(readdirSync(join(repository, '.takt', 'goals'))).toEqual([created.id]);
});

it('reports a conflicting existing goal without overwriting it or issuing another event', async () => {
  await registerReservedGoal(request());
  const bytes = readFileSync(savedPath()); const events = readManagerEvents(repository);
  await expect(registerReservedGoal({ ...request(), objective: 'Different proposal' })).rejects.toMatchObject({ code: 'registration_recovery' });
  expect(readFileSync(savedPath())).toEqual(bytes); expect(readManagerEvents(repository)).toEqual(events);
});

it('reports a branch left before goal persistence without creating another timestamped branch', async () => {
  git('branch', `takt/20261024T0000-goal-${goalRecord().id.slice(0, 8)}`);
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  await expect(registerReservedGoal(request())).rejects.toMatchObject({ code: 'registration_recovery' });
  expect(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(refs);
  expect(readManagerEvents(repository)).toEqual([]);
});

it('preserves an existing goal with ambiguous event delivery until its registration can be reconciled', async () => {
  const goal = goalRecord(); const path = savedPath(); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(goal));
  const bytes = readFileSync(path);
  await expect(registerReservedGoal(request())).rejects.toMatchObject({ code: 'registration_recovery' });
  expect(readFileSync(path)).toEqual(bytes); expect(readManagerEvents(repository)).toEqual([]);
  saveManagerEvent(repository, { kind: 'registered', goalId: goal.id });
  const events = readManagerEvents(repository);
  expect(await registerReservedGoal(request())).toEqual(goal);
  expect(readManagerEvents(repository)).toEqual(events); expect(readFileSync(path)).toEqual(bytes);
});

it('does not treat a corrupt saved goal as absence or start any new Git side effects', async () => {
  const path = savedPath(); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '{broken');
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  await expect(registerReservedGoal(request())).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe('{broken');
  expect(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(refs);
  expect(readManagerEvents(repository)).toEqual([]);
});

it('persists the approved director proposal reference and director question route in the registered goal', async () => {
  const directorProposal = { conversationId: conversationId({ kind: 'daemon' }), revision: 4 };
  const input = { ...request(), creationOrigin: 'director' as const, directorProposal };
  await registerReservedGoal(input);

  expect(new GoalStore(repository).getSync(input.id)).toMatchObject({ ...goalInput(),
    creationOrigin: 'director', questionRoute: 'director', directorProposal });
  expect(JSON.parse(readFileSync(savedPath(), 'utf8'))).toMatchObject({ directorProposal });
  const bytes = readFileSync(savedPath());
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  const events = readManagerEvents(repository);
  expect(await registerReservedGoal(input)).toEqual(new GoalStore(repository).getSync(input.id));
  expect(readFileSync(savedPath())).toEqual(bytes);
  expect(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(refs);
  expect(readManagerEvents(repository)).toEqual(events);
});

it('rejects a different approved director revision when reusing a reserved goal', async () => {
  const directorProposal = { conversationId: conversationId({ kind: 'daemon' }), revision: 4 };
  const input = { ...request(), creationOrigin: 'director' as const, directorProposal };
  await registerReservedGoal(input);
  const before = readFileSync(savedPath());
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  const events = readManagerEvents(repository);
  const changed = { ...input, directorProposal: { ...directorProposal, revision: 5 } };
  await expect(registerReservedGoal(changed)).rejects.toThrow();
  expect(readFileSync(savedPath())).toEqual(before);
  expect(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(refs);
  expect(readManagerEvents(repository)).toEqual(events);
});

it('hands a director goal to the selected manager through the registration inbox after one TUI approval', async () => {
  const directory = getGlobalConfigDir();
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const managerId = conversationId({ kind: 'repository', repositoryDirectory: repository });
  const summary = { ...goalInput(), managerId, repositoryDirectory: repository, startBranch: 'main', integrationBranch: 'main' };
  const directorExecute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async () => ({ message: '登録案', summary, sessionId: undefined, assignment: undefined }));
  const managerExecute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async () => ({ message: '作業を開始します', summary: null, sessionId: undefined, assignment: undefined }));
  const daemon = await conversationDaemon(directory, { close: async () => {},
    async resolve(assignment) { return { provider: 'mock', model: null, contextKey: 'test', language: 'en',
      executor: { execute: assignment.kind === 'daemon' ? directorExecute : managerExecute } }; } });
  const delivery = { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) };
  const selected = await createTuiConversationPort(directory, delivery).resolve({ kind: 'daemon' });
  const opened = await daemon.input.open(selected, delivery);
  opened.read.cancel();
  let requestNumber = 0;
  const submit = (command: ConversationCommand) => daemon.input.submit({ attachmentId: opened.attachmentId,
    requestId: `request-${++requestNumber}`, speaker: selected.speaker, command });
  try {
    expect(await submit({ kind: 'message', text: 'ブログに記事一覧を足して' })).toMatchObject({ kind: 'accepted' });
    await daemon.settled();
    const proposed = await daemon.store.read(selected.conversationId);
    expect(proposed?.state.pending).toMatchObject({ managerId, repositoryDirectory: repository });
    expect(await new GoalStore(repository).list()).toEqual({ goals: [], errors: [] });
    expect(managerExecute).not.toHaveBeenCalled();
    if (proposed?.state.pending == null) throw new Error('Expected a saved director proposal');
    const revision = proposed.state.pending.revision;

    expect(await submit({ kind: 'approve_summary', revision, conversationId: selected.conversationId })).toMatchObject({ kind: 'accepted' });
    await daemon.settled();
    const state = (await daemon.store.read(selected.conversationId))!.state;
    expect(state).toMatchObject({ pending: null, approval: { state: 'registered', revision } });
    if (state.approval === null) throw new Error('Expected a saved registration receipt');
    expect(new GoalStore(repository).getSync(state.approval.goalId)).toMatchObject({ ...goalInput(),
      creationOrigin: 'director', questionRoute: 'director', directorProposal: { conversationId: selected.conversationId, revision } });

    const inbox = readManagerEvents(repository);
    expect(inbox).toHaveLength(1);
    const saved = inbox[0]!;
    await receiveInboxChange({ target: { kind: 'inbox', targetId: repository, generation: '1', conversationId: managerId,
      directory: dirname(saved.filePath) }, path: saved.filePath, generation: '1', value: saved.event, removed: false },
    new DaemonPersistedFiles(directory), daemon.conversations, daemon.dispatcher);
    await daemon.settled();
    expect(managerExecute).toHaveBeenCalledOnce();
    expect(managerExecute.mock.calls[0]![0].assignment).toEqual({ kind: 'repository', repositoryDirectory: repository });
    const prompt = managerExecute.mock.calls[0]![0].prompt;
    expect(JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)).event).toMatchObject({
      kind: 'goal_registered', repositoryDirectory: repository, goalId: state.approval.goalId });
    expect((await daemon.store.read(managerId))?.state).toMatchObject({ pending: null, approval: null });
    expect(directorExecute).toHaveBeenCalledOnce();
  } finally { await daemon.close(); }
});
