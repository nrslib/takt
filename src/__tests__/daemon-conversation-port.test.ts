import { tellDirectorManager } from '../features/director/tellManager.js';
import type { DaemonStateReply } from '../core/daemon/processProtocol.js';
import { expect, it, vi } from 'vitest';
import { createDaemonConversationInput } from '../features/manager/daemonConversationPort.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import type { DaemonIngress } from '../core/daemon/ports.js';
import type { ConversationSnapshot } from '../core/daemon/messages.js';
import type { Admission } from '../core/daemon/events.js';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const delivery = { deliver: vi.fn().mockResolvedValue({ kind: 'delivered' }) };
  const selected = await createTuiConversationPort('/config', delivery).resolve({ kind: 'repository', repositoryDirectory: '/repo' });
  const snapshot = (): ConversationSnapshot => ({ transferId: 'read', conversationId: selected.conversationId,
    revision: 3, stateSequence: 5, operationId: '11111111-1111-4111-8111-111111111111', generation: 7, mode: 'initial', complete: vi.fn(), cancel: vi.fn(),
    turnState: { version: 1, assignment: selected.assignment, session: { provider: 'mock', model: null, sessionId: null }, revision: 3, pending: null, approval: null },
    items: (async function* () { yield { kind: 'state' as const, state: { conversationId: selected.conversationId, assignment: selected.assignment,
      revision: 3, pending: null, approval: null, running: { operationId: '11111111-1111-4111-8111-111111111111', kind: 'message' }, interrupted: false } }; })() });
  const ingress: DaemonIngress = { accept: vi.fn().mockResolvedValue({ kind: 'accepted', eventId: 'event', operationId: 'queued', acceptedSequence: 2 }),
    snapshot: vi.fn(async () => snapshot()), control: vi.fn().mockResolvedValue({ kind: 'interrupted' }) };
  const port = createDaemonConversationInput({ ingress, resolveAssignment: async (assignment) => assignment });
  const opened = await port.open({ ...selected, agentOverrides: { provider: 'codex', model: 'selected-model' } }, delivery);
  const submit = (text: string, requestId: string) => port.submit({ attachmentId: opened.attachmentId, requestId, speaker: selected.speaker,
    command: { kind: 'message', text } });
  return { port, ingress, selected, opened, submit, delivery };
}
it('admits messages while an earlier save is paused and permits snapshot and interruption independently', async () => {
  const f = await fixture();
  const first = gate<Admission>();
  vi.mocked(f.ingress.accept).mockReturnValueOnce(first.promise);
  const waiting = f.submit('first', 'first');
  expect(await f.submit('second', 'second')).toMatchObject({ kind: 'accepted', operationId: 'queued', acceptedSequence: 2 });
  const read = await f.port.snapshot(f.opened.attachmentId);
  const items = [];
  for await (const item of read.items) items.push(item);
  expect(items[0]).toMatchObject({ kind: 'state', state: { running: { generation: 7 } } });
  expect(await f.port.submit({ attachmentId: f.opened.attachmentId, requestId: 'stop', speaker: f.selected.speaker,
    command: { kind: 'abort_turn', operationId: '11111111-1111-4111-8111-111111111111', generation: 7 } })).toMatchObject({ kind: 'accepted' });
  expect(f.ingress.control).toHaveBeenCalledExactlyOnceWith({ kind: 'interrupt', conversationId: f.selected.conversationId, operationId: '11111111-1111-4111-8111-111111111111', generation: 7 });
  expect(f.ingress.accept).toHaveBeenCalledTimes(2);
  first.resolve({ kind: 'accepted', eventId: 'first', operationId: 'first', acceptedSequence: 1 });
  expect(await waiting).toMatchObject({ kind: 'accepted', acceptedSequence: 1 });
  expect(f.ingress.accept).toHaveBeenNthCalledWith(1, expect.objectContaining({ requestId: 'first', source: 'tui', event: {
    kind: 'human_command', command: { kind: 'message', text: 'first' }, speaker: f.selected.speaker,
    agentOverrides: { provider: 'codex', model: 'selected-model' } } }));
});
it.each(['capacity', 'storage', 'stopping'] as const)('never reports a rejected %s save as accepted', async (reason) => {
  const f = await fixture();
  vi.mocked(f.ingress.accept).mockResolvedValue({ kind: 'rejected', reason });
  expect(await f.submit('not saved', 'request')).toMatchObject({ kind: 'error' });
});
it('rejects forged speakers, stale generations and attachments after detach', async () => {
  const f = await fixture();
  await expect(f.port.submit({ attachmentId: f.opened.attachmentId, requestId: 'forged', speaker: { namespace: 'agent', id: 'director' },
    command: { kind: 'message', text: 'forged' } })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(f.port.submit({ attachmentId: f.opened.attachmentId, requestId: 'stale', speaker: f.selected.speaker,
    command: { kind: 'abort_turn', operationId: '11111111-1111-4111-8111-111111111111', generation: 6 } })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(f.ingress.control).not.toHaveBeenCalled();
  expect(f.port.connectedPorts(f.selected.conversationId)).toEqual(['tui']);
  f.port.detach(f.opened.attachmentId);
  expect(f.port.connectedPorts(f.selected.conversationId)).toEqual([]);
  await expect(f.submit('after detach', 'detached')).rejects.toMatchObject({ code: 'unavailable_attachment' });
});
it('admits approval with its revision and routes inquiry answers to the human queue', async () => {
  const f = await fixture();
  const snapshot = await f.ingress.snapshot(f.selected.conversationId);
  snapshot.turnState.pending = { revision: 3, repositoryDirectory: '/repo',
    summary: { objective: 'Current proposal', outOfScope: [], acceptanceCriteria: ['Ready'], constraints: [] } };
  vi.mocked(f.ingress.snapshot).mockResolvedValueOnce(snapshot);
  await f.port.submit({ attachmentId: f.opened.attachmentId, requestId: 'approval', speaker: f.selected.speaker,
    command: { kind: 'approve_summary', revision: 3, requirePending: true } });
  expect(f.ingress.accept).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ kind: 'human_command',
    command: { kind: 'approve_summary', revision: 3, requirePending: true } }) }));
  await f.port.submit({ attachmentId: f.opened.attachmentId, requestId: 'answer', speaker: f.selected.speaker,
    command: { kind: 'answer_question', questionId: '11111111-1111-4111-8111-111111111111',
      target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: '/repo' } }, answer: { text: 'answer' } } });
  expect(f.ingress.accept).toHaveBeenLastCalledWith(expect.objectContaining({ event: expect.objectContaining({ kind: 'inquiry_answer' }) }));
});

it('rejects a withdrawn or replaced proposal before durable admission', async () => {
  const f = await fixture();
  for (const command of [{ kind: 'approve_summary' as const, revision: 3, requirePending: true },
    { kind: 'dismiss_summary' as const, revision: 2 }]) {
    expect(await f.port.submit({ attachmentId: f.opened.attachmentId, requestId: command.kind,
      speaker: f.selected.speaker, command })).toMatchObject({ kind: 'error', code: 'stale_summary' });
  }
  expect(f.ingress.accept).not.toHaveBeenCalled();
});

it('admits director messages through the bus and waits for durable admission without self IPC', async () => {
  const saved = gate<DaemonStateReply>();
  const request = vi.fn(() => saved.promise);
  const turn = { conversationId: 'director', operationId: 'turn', generation: 8 };
  const signal = new AbortController().signal;
  const pending = tellDirectorManager({ bus: { request }, turn }, 'manager', 'inspect goal', signal);
  expect(request).toHaveBeenCalledExactlyOnceWith(turn, expect.objectContaining({ kind: 'accept_director_message',
    conversationId: 'manager', text: 'inspect goal', eventId: expect.any(String), requestId: expect.any(String) }), signal);
  saved.resolve({ kind: 'event_accepted', admission: { kind: 'accepted', eventId: 'event', operationId: 'admitted', acceptedSequence: 4 } });
  expect(await pending).toMatchObject({ kind: 'accepted', operationId: 'admitted', acceptedSequence: 4, managerId: 'manager' });
});
it('does not resend a rejected director message or submit after cancellation', async () => {
  const request = vi.fn(async (): Promise<DaemonStateReply> => ({ kind: 'event_accepted', admission: { kind: 'rejected', reason: 'storage' } }));
  const turn = { conversationId: 'director', operationId: 'turn', generation: 8 };
  const controller = new AbortController();
  expect(await tellDirectorManager({ bus: { request }, turn }, 'manager', 'once', controller.signal)).toEqual({ kind: 'rejected', reason: 'storage' });
  controller.abort();
  await expect(tellDirectorManager({ bus: { request }, turn }, 'manager', 'cancelled', controller.signal)).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});
