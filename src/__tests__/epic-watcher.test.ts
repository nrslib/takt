import { describe, expect, it, vi } from 'vitest';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import { epicEvents } from '../features/daemon/epicEvents.js';
import { createDaemonStateRequests } from '../features/daemon/stateRequests.js';
import type { DaemonIngress } from '../core/daemon/ports.js';
import { conversationId } from '../infra/conversations/identity.js';
import { startEpicWatcher } from '../features/daemon/epicWatcher.js';
import { epicRecord } from './helpers/epic-fixtures.js';
import { buildTurnBusinessContext } from '../features/daemonTurn/turnContext.js';
import { beginEpicVerification, applyEpicVerificationResult, finishEpic, epicView } from '../infra/epics/state.js';
import { verificationRunId, verificationStartedAt, secondGoalId, verificationResultFor } from './helpers/epic-fixtures.js';
import { deferred } from './helpers/daemon-turn.js';

const doubles = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), observe: undefined as ((signal: AbortSignal) => Promise<void>) | undefined }));
vi.mock('../infra/daemon/epicFiles.js', () => ({ DaemonEpicFiles: class { async *list(workspaceId: string) { yield* await doubles.list(workspaceId); } get = doubles.get; } }));
vi.mock('../features/daemon/watchers/loop.js', () => ({ WATCH_INTERVALS: { files: 5000 }, startWatchLoop: (_interval: number, observe: typeof doubles.observe) => { doubles.observe = observe; return { close: vi.fn() }; } }));

describe('Epic persisted state watcher', () => {
  it('authenticates MCP event publication before reading Epic state and preserves the operation reason', async () => {
    const member = { repositoryDirectory: '/repo', goalId: secondGoalId };
    const started = beginEpicVerification({ ...epicRecord(), members: [member], targets: [{ ...member, targetSha: 'b'.repeat(40) }] }, verificationRunId, verificationStartedAt);
    const epic = applyEpicVerificationResult(started.epic, verificationResultFor(started.run));
    doubles.get.mockClear().mockResolvedValue(epicView(epic));
    const owner = { kind: 'workspace' as const, workspaceId: epic.workspaceId };
    const conversations = { store: { read: async () => ({ state: { assignment: owner } }) },
      routing: { directory: '/config', permits: async () => true } } as unknown as DaemonConversations;
    const accept = vi.fn<DaemonIngress['accept']>(async (event) => ({ kind: 'accepted', eventId: event.eventId, operationId: verificationRunId, acceptedSequence: 1 }));
    const handler = createDaemonStateRequests({ conversations, ingress: { accept }, connectedPorts: () => [] });
    const turn = { conversationId: conversationId(owner), operationId: verificationRunId, generation: 1 };
    const request = { kind: 'publish_epic_events' as const, workspaceId: epic.workspaceId, epicId: epic.id, reason: '結果を確認した' };
    expect(await handler.handle(turn, request, new AbortController().signal)).toEqual({ kind: 'epic_events_published' });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ operation: { reason: request.reason }, epicId: epic.id }) }));
    doubles.get.mockClear(); accept.mockClear();
    expect(await handler.handle(turn, { ...request, workspaceId: secondGoalId }, new AbortController().signal)).toMatchObject({ kind: 'error', code: 'forbidden' });
    expect(doubles.get).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
  it.each([false, true])('saves the durable Epic notification and ends the conversation operation (completed: %s)', async (completed) => {
    const member = { repositoryDirectory: '/repo', goalId: secondGoalId };
    const started = beginEpicVerification({ ...epicRecord(), members: [member], targets: [{ ...member, targetSha: 'b'.repeat(40) }] }, verificationRunId, verificationStartedAt);
    const verified = applyEpicVerificationResult(started.epic, verificationResultFor(started.run));
    const epic = completed ? finishEpic(verified) : verified;
    doubles.get.mockResolvedValue(epicView(epic));
    const event = epicEvents(epic).at(-1)!;
    const id = conversationId({ kind: 'workspace', workspaceId: epic.workspaceId });
    const store = { apply: vi.fn(), read: vi.fn(async () => ({ state: { assignment: { kind: 'workspace', workspaceId: epic.workspaceId }, revision: 0, pending: null, approval: null } })) };
    const routing = { directory: '/config', permits: vi.fn(async () => true) };
    const save = vi.fn(async () => true);
    const outputs: PortOutput[] = [];
    const conversations = new DaemonConversations(store as unknown as ConstructorParameters<typeof DaemonConversations>[0],
      routing as unknown as ConstructorParameters<typeof DaemonConversations>[1], { save } as unknown as ConstructorParameters<typeof DaemonConversations>[2],
      async (_id, output) => { outputs.push(output); }, vi.fn());
    await conversations.apply({ conversationId: id, operationId: verificationRunId, generation: 1,
      event: { ...event, operationId: verificationRunId, acceptedSequence: 1, lane: 'other' },
      outcome: { kind: 'completed', result: { kind: 'notice', message: '' } } });
    await conversations.close();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: event.eventId, conversationId: id }), expect.any(AbortSignal));
    expect(outputs).toContainEqual(expect.objectContaining({ kind: 'pending', state: expect.objectContaining({ running: null }) }));
    expect(outputs.map(({ kind }) => kind)).toEqual(['pending', 'result']);
  });
  it('includes saved Epic evidence and running recovery in an empty-workspace manager context', async () => {
    const member = { repositoryDirectory: '/removed', goalId: secondGoalId };
    const { epic, run } = beginEpicVerification({ ...epicRecord(), members: [member], targets: [{ ...member, targetSha: 'b'.repeat(40) }] }, verificationRunId, verificationStartedAt);
    const first = { ...epicRecord(), id: secondGoalId };
    doubles.list.mockResolvedValue([first, epicView(epic)]);
    const assignment = { kind: 'workspace' as const, workspaceId: epic.workspaceId, name: 'workspace', repositoryDirectories: [] };
    const context = JSON.parse(await buildTurnBusinessContext(assignment, null, '/config'));
    expect(context.epics).toEqual([{ epic: first, recovery: [] }, { epic: epicView(epic), recovery: [run] }]);
    expect(context.assignment.repositoryDirectories).toEqual([]);
    const verified = epicView(applyEpicVerificationResult(epic, verificationResultFor(run)));
    doubles.list.mockResolvedValue([first, verified]);
    expect(JSON.parse(await buildTurnBusinessContext(assignment, null, '/config')).epics)
      .toEqual([{ epic: first, recovery: [] }, { epic: verified, recovery: [] }]);
  });
  it('refreshes the same conversation on invalidation, suppresses unchanged reads and reports failures', async () => {
    const epic = epicRecord();
    const second = { ...epic, id: secondGoalId };
    doubles.list.mockResolvedValue([epic, second]);
    const send = vi.fn();
    let notices: { conversationId: string; id: string }[] = [];
    const conversations = { notifications: { async *iterate() { yield* notices; } }, routing: { directory: '/config', assignments: async () => [{ kind: 'workspace', workspaceId: epic.workspaceId }] },
      ensure: vi.fn(), snapshot: vi.fn(async () => ({ revision: 0, stateSequence: 1 })), send } as unknown as DaemonConversations;
    const onError = vi.fn();
    startEpicWatcher(conversations, { accept: vi.fn() }, onError);
    const signal = new AbortController().signal;
    await doubles.observe!(signal);
    await doubles.observe!(signal);
    expect(send).toHaveBeenCalledTimes(1);
    doubles.list.mockResolvedValue([epic, { ...second, revision: 2 }]);
    await doubles.observe!(signal);
    expect(send).toHaveBeenCalledTimes(2);
    notices = [{ conversationId: send.mock.calls[0]![0], id: 'verification-notice' }];
    await doubles.observe!(signal);
    expect(send).toHaveBeenCalledTimes(3);
    await doubles.observe!(signal);
    expect(send).toHaveBeenCalledTimes(3);
    doubles.list.mockRejectedValue(new Error('unreadable Epic'));
    await doubles.observe!(signal);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'unreadable Epic' }));
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('validates all records before publishing and retries after read or admission failure', async () => {
    const member = { repositoryDirectory: '/removed', goalId: secondGoalId };
    const started = beginEpicVerification({ ...epicRecord(), members: [member], targets: [{ ...member, targetSha: 'b'.repeat(40) }] }, verificationRunId, verificationStartedAt);
    const first = epicView(applyEpicVerificationResult(started.epic, verificationResultFor(started.run)));
    const second = { ...first, id: secondGoalId };
    const failure = new Error('later read failed');
    doubles.list.mockImplementation(async function* () { yield first; throw failure; });
    const send = vi.fn();
    const conversations = { notifications: { async *iterate() {} }, routing: { directory: '/config', assignments: async () => [{ kind: 'workspace', workspaceId: first.workspaceId }] },
      ensure: vi.fn(), snapshot: vi.fn(async () => ({ revision: 0, stateSequence: 1 })), send } as unknown as DaemonConversations;
    const accept = vi.fn<DaemonIngress['accept']>(async (event) => ({ kind: 'accepted', eventId: event.eventId, operationId: event.eventId, acceptedSequence: 1 }));
    const onError = vi.fn();
    startEpicWatcher(conversations, { accept }, onError);
    const signal = new AbortController().signal;
    await doubles.observe!(signal);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(accept).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    doubles.list.mockResolvedValue([first, second]);
    await doubles.observe!(signal);
    expect(accept.mock.calls.map(([event]) => event.event)).toMatchObject([{ epicId: first.id }, { epicId: second.id }]);
    expect(send).toHaveBeenCalledTimes(1);
    doubles.list.mockResolvedValue([first, { ...second, objective: 'changed' }]);
    accept.mockResolvedValueOnce({ kind: 'rejected', reason: 'storage' });
    await doubles.observe!(signal);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenLastCalledWith(expect.any(Error));
    await doubles.observe!(signal);
    expect(send).toHaveBeenCalledTimes(2);
    await doubles.observe!(signal);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('awaits each event admission before consuming the next Epic body for publication', async () => {
    const member = { repositoryDirectory: '/repo', goalId: secondGoalId };
    const started = beginEpicVerification({ ...epicRecord(), members: [member], targets: [{ ...member, targetSha: 'b'.repeat(40) }] }, verificationRunId, verificationStartedAt);
    const first = epicView(applyEpicVerificationResult(started.epic, verificationResultFor(started.run)));
    const second = { ...first, id: secondGoalId };
    let consumed = 0;
    doubles.list.mockImplementation(async function* () { for (const epic of [first, second]) { consumed++; yield epic; } });
    const admitted = deferred<void>();
    const pending = deferred<void>();
    const accept = vi.fn<DaemonIngress['accept']>(async (event) => {
      if (event.event.kind === 'epic_verification_result' && event.event.epicId === first.id) {
        pending.resolve();
        await admitted.promise;
      }
      return { kind: 'accepted', eventId: event.eventId, operationId: event.eventId, acceptedSequence: 1 };
    });
    const conversations = { notifications: { async *iterate() {} }, routing: { directory: '/config', assignments: async () => [{ kind: 'workspace', workspaceId: first.workspaceId }] },
      ensure: vi.fn(), snapshot: vi.fn(async () => ({ revision: 0, stateSequence: 1 })), send: vi.fn() } as unknown as DaemonConversations;
    startEpicWatcher(conversations, { accept }, vi.fn());
    const observing = doubles.observe!(new AbortController().signal);
    await pending.promise;
    expect(consumed).toBe(3);
    expect(accept).toHaveBeenCalledTimes(1);
    admitted.resolve();
    await observing;
    expect(consumed).toBe(4);
    expect(accept).toHaveBeenCalledTimes(2);
  });
});
