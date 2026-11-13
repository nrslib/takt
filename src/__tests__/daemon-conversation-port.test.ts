import { tellDirectorManager } from '../features/director/tellManager.js';
import type { DaemonStateReply } from '../core/daemon/processProtocol.js';
import { expect, it, vi } from 'vitest';
import { createDaemonConversationInput } from '../features/manager/daemonConversationPort.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import type { DaemonIngress } from '../core/daemon/ports.js';
import type { ConversationSnapshot } from '../core/daemon/messages.js';
import type { Admission } from '../core/daemon/events.js';
import { ToolActivityHistory } from '../shared/tool-activity/history.js';

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

it.each(['tui', 'slack'] as const)('exposes tool history through live output and snapshots only to TUI attachments (port: %s)', async (port) => {
  const f = await fixture(); f.opened.read.cancel();
  const snapshot = await f.ingress.snapshot(f.selected.conversationId);
  const source = new ToolActivityHistory();
  source.apply({ type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: { command: 'private-tool-input' } },
    toolActivity: { callId: 'call', operationId: snapshot.operationId!, generation: snapshot.generation! } });
  const history = { operationId: snapshot.operationId!, generation: snapshot.generation!, finished: false, history: source.snapshot() };
  vi.mocked(f.ingress.snapshot).mockImplementation(async () => ({ ...snapshot, items: (async function* () {
    yield { kind: 'tool_history' as const, history };
  })() }));
  const delivery = { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) };
  const opened = await f.port.open({ ...f.selected, binding: { ...f.selected.binding, port } }, delivery);
  const items = [];
  for await (const item of opened.read.items) items.push(item);
  opened.read.complete();
  expect(items.filter((item) => item.kind === 'tool_history')).toEqual(port === 'tui' ? [{ kind: 'tool_history', history }] : []);
  const output = { kind: 'tool_history' as const, history };
  const version = { revision: 3, stateSequence: 6, operationId: history.operationId };
  await f.port.deliver(f.selected.conversationId, output, version);
  const update = { kind: 'tool_history_update' as const, update: { operationId: history.operationId, generation: history.generation,
    previousSequence: 0, sequence: history.history.sequence, entries: history.history.entries } };
  await f.port.deliver(f.selected.conversationId, update, { ...version, stateSequence: 7 });
  if (port === 'tui') {
    expect(delivery.deliver.mock.calls).toEqual([[f.selected.conversationId, output, version],
      [f.selected.conversationId, update, { ...version, stateSequence: 7 }]]);
  } else expect(delivery.deliver).not.toHaveBeenCalled();
  f.port.close();
});

it('sends tool history on open and on a requested read but not on periodic refreshes, without removing it from the client', async () => {
  const f = await fixture(); f.opened.read.cancel();
  const snapshot = await f.ingress.snapshot(f.selected.conversationId);
  const source = new ToolActivityHistory();
  const toolActivity = { callId: 'call', operationId: snapshot.operationId!, generation: snapshot.generation! };
  const states = Array.from({ length: 6 }, (_, index) => {
    source.apply({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: `${index}\n` }, toolActivity });
    return { operationId: snapshot.operationId!, generation: snapshot.generation!, finished: false, history: source.snapshot() };
  });
  let current = 0;
  vi.mocked(f.ingress.snapshot).mockImplementation(async () => {
    const history = states[current]!;
    return { ...snapshot, items: (async function* () { yield { kind: 'tool_history' as const, history }; })() };
  });
  const delivery = { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) };
  const read = async (value: Awaited<ReturnType<typeof f.port.snapshot>>) => {
    const items = [];
    for await (const item of value.items) items.push(item);
    value.complete();
    return items.filter((item) => item.kind === 'tool_history' || item.kind === 'remove' && item.key === 'tool_history');
  };
  const opened = await f.port.open(f.selected, delivery);
  expect(await read(opened.read)).toEqual([{ kind: 'tool_history', history: states[0] }]);
  for (const index of [1, 2, 3]) {
    current = index;
    expect(await read(await f.port.snapshot(opened.attachmentId))).toEqual([]);
  }
  current = 4;
  expect(await read(await f.port.snapshot(opened.attachmentId, { toolHistory: true }))).toEqual([{ kind: 'tool_history', history: states[4] }]);
  current = 5;
  expect(await read(await f.port.snapshot(opened.attachmentId))).toEqual([]);
  f.port.close();
});

it('delivers activity only to TUI attachments of the same conversation', async () => {
  const f = await fixture();
  const slack = { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) };
  const other = { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) };
  const slackOpen = await f.port.open({ ...f.selected, binding: { ...f.selected.binding, port: 'slack' } }, slack);
  const otherSelected = await createTuiConversationPort('/config', other).resolve({ kind: 'repository', repositoryDirectory: '/other' });
  const snapshot = await f.ingress.snapshot(f.selected.conversationId);
  vi.mocked(f.ingress.snapshot).mockResolvedValueOnce({ ...snapshot, conversationId: otherSelected.conversationId,
    turnState: { ...snapshot.turnState, assignment: otherSelected.assignment },
    items: (async function* () { yield { kind: 'state' as const, state: {
      conversationId: otherSelected.conversationId, assignment: otherSelected.assignment,
      revision: 3, pending: null, approval: null, running: null, interrupted: false,
    } }; })() });
  const otherOpen = await f.port.open(otherSelected, other);
  const output = { kind: 'activity' as const, operationId: '11111111-1111-4111-8111-111111111111', generation: 7,
    activity: { kind: 'tool' as const, tool: 'Bash' } };
  const version = { revision: 3, stateSequence: 6, operationId: output.operationId };
  await f.port.deliver(f.selected.conversationId, output, version);
  expect(f.delivery.deliver).toHaveBeenCalledExactlyOnceWith(f.selected.conversationId, output, version);
  expect(slack.deliver).not.toHaveBeenCalled();
  expect(other.deliver).not.toHaveBeenCalled();
  slackOpen.read.cancel(); otherOpen.read.cancel(); f.opened.read.cancel();
});

it('replays only the latest activity once after a new TUI finishes its initial read', async () => {
  const f = await fixture();
  f.port.detach(f.opened.attachmentId);
  const output = { kind: 'activity' as const, operationId: '11111111-1111-4111-8111-111111111111', generation: 7,
    activity: { kind: 'tool' as const, tool: 'CurrentTool' } };
  const version = { revision: 3, stateSequence: 7, operationId: output.operationId };
  await f.port.deliver(f.selected.conversationId, { ...output, activity: { kind: 'thinking' } }, { ...version, stateSequence: 6 });
  await f.port.deliver(f.selected.conversationId, output, version);
  await f.port.deliver(f.selected.conversationId, { ...output, activity: { kind: 'thinking' } }, { ...version, stateSequence: 6 });
  const tui = { deliver: vi.fn().mockResolvedValue({ kind: 'delivered' }) };
  const slack = { deliver: vi.fn().mockResolvedValue({ kind: 'delivered' }) };
  for (const [port, delivery] of [['tui', tui], ['slack', slack]] as const) {
    const opened = await f.port.open({ ...f.selected, binding: { ...f.selected.binding, port } }, delivery);
    expect(delivery.deliver).not.toHaveBeenCalled();
    for await (const _item of opened.read.items) { /* 初期状態の配送完了を再現する。 */ }
    opened.read.complete();
    opened.read.complete();
    const refresh = await f.port.snapshot(opened.attachmentId);
    for await (const _item of refresh.items) { /* 定期更新では再送しない。 */ }
    refresh.complete();
  }
  expect(tui.deliver).toHaveBeenCalledExactlyOnceWith(f.selected.conversationId, output, version);
  expect(slack.deliver).not.toHaveBeenCalled();
  expect(f.delivery.deliver).not.toHaveBeenCalled();
  f.port.close();
});

it.each(['pending', 'result', 'running', 'generation', 'cancelled', 'detached'] as const)(
  'does not replay obsolete activity after %s', async (change) => {
    const f = await fixture();
    const output = { kind: 'activity' as const, operationId: '11111111-1111-4111-8111-111111111111', generation: 7,
      activity: { kind: 'tool' as const, tool: 'OldTool' } };
    const version = { revision: 3, stateSequence: 6, operationId: output.operationId };
    await f.port.deliver(f.selected.conversationId, output, version);
    if (change === 'pending' || change === 'running') {
      await f.port.deliver(f.selected.conversationId, { kind: change, state: {
        conversationId: f.selected.conversationId, assignment: f.selected.assignment, revision: 3, pending: null, approval: null,
        running: change === 'pending' ? null : { operationId: output.operationId, kind: 'turn', generation: 8 }, interrupted: false,
      } }, version);
    } else if (change === 'result') {
      await f.port.deliver(f.selected.conversationId, { kind: 'result', operationId: output.operationId,
        result: { kind: 'reply', message: 'done' } }, version);
    } else if (change === 'generation') {
      const snapshot = await f.ingress.snapshot(f.selected.conversationId);
      vi.mocked(f.ingress.snapshot).mockResolvedValueOnce({ ...snapshot, generation: 8 });
    }
    const delivery = { deliver: vi.fn().mockResolvedValue({ kind: 'delivered' }) };
    const opened = await f.port.open(f.selected, delivery);
    for await (const _item of opened.read.items) { /* 初期状態の配送完了を再現する。 */ }
    if (change === 'cancelled') opened.read.cancel();
    if (change === 'detached') f.port.detach(opened.attachmentId);
    opened.read.complete();
    expect(delivery.deliver).not.toHaveBeenCalled();
    f.port.close();
  },
);

it('does not replay an activity that was already delivered while the initial snapshot was being read', async () => {
  const f = await fixture();
  const delivery = { deliver: vi.fn().mockResolvedValue({ kind: 'delivered' }) };
  const opened = await f.port.open(f.selected, delivery);
  const output = { kind: 'activity' as const, operationId: '11111111-1111-4111-8111-111111111111', generation: 7,
    activity: { kind: 'tool' as const, tool: 'CurrentTool' } };
  const version = { revision: 3, stateSequence: 6, operationId: output.operationId };
  await f.port.deliver(f.selected.conversationId, output, version);
  for await (const _item of opened.read.items) { /* 初期状態の配送完了を再現する。 */ }
  opened.read.complete();
  expect(delivery.deliver).toHaveBeenCalledExactlyOnceWith(f.selected.conversationId, output, version);
  f.port.close();
});

it('replays cached activity after a cancelled initial read succeeds on retry, without repeating it on refresh', async () => {
  const f = await fixture();
  f.port.detach(f.opened.attachmentId);
  f.opened.read.cancel();
  const output = { kind: 'activity' as const, operationId: '11111111-1111-4111-8111-111111111111', generation: 7,
    activity: { kind: 'tool' as const, tool: 'RetriedTool' } };
  const version = { revision: 3, stateSequence: 6, operationId: output.operationId };
  await f.port.deliver(f.selected.conversationId, output, version);
  const delivery = { deliver: vi.fn().mockResolvedValue({ kind: 'delivered' }) };
  const opened = await f.port.open(f.selected, delivery);
  for await (const _item of opened.read.items) { /* 最後のフレームの配送失敗を再現する。 */ }
  opened.read.cancel();
  opened.read.complete();
  expect(delivery.deliver).not.toHaveBeenCalled();
  const retry = await f.port.snapshot(opened.attachmentId);
  for await (const _item of retry.items) { /* 再取得した状態の配送完了を再現する。 */ }
  retry.complete();
  retry.complete();
  expect(delivery.deliver).toHaveBeenCalledExactlyOnceWith(f.selected.conversationId, output, version);
  const refresh = await f.port.snapshot(opened.attachmentId);
  for await (const _item of refresh.items) { /* 定期更新では再送しない。 */ }
  refresh.complete();
  expect(delivery.deliver).toHaveBeenCalledOnce();
  f.port.close();
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
  const pending = tellDirectorManager({ bus: { request }, turn }, 'manager', 'inspect goal', 'human', signal);
  expect(request).toHaveBeenCalledExactlyOnceWith(turn, expect.objectContaining({ kind: 'accept_director_message',
    conversationId: 'manager', text: 'inspect goal', origin: 'human', eventId: expect.any(String), requestId: expect.any(String) }), signal);
  saved.resolve({ kind: 'event_accepted', admission: { kind: 'accepted', eventId: 'event', operationId: 'admitted', acceptedSequence: 4 } });
  expect(await pending).toMatchObject({ kind: 'accepted', operationId: 'admitted', acceptedSequence: 4, managerId: 'manager' });
});
it('does not resend a rejected director message or submit after cancellation', async () => {
  const request = vi.fn(async (): Promise<DaemonStateReply> => ({ kind: 'event_accepted', admission: { kind: 'rejected', reason: 'storage' } }));
  const turn = { conversationId: 'director', operationId: 'turn', generation: 8 };
  const controller = new AbortController();
  expect(await tellDirectorManager({ bus: { request }, turn }, 'manager', 'once', 'director', controller.signal)).toEqual({ kind: 'rejected', reason: 'storage' });
  controller.abort();
  await expect(tellDirectorManager({ bus: { request }, turn }, 'manager', 'cancelled', 'director', controller.signal)).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});

it('limits progress per attachment while always delivering final results to both slow and fast attachments', async () => {
  const f = await fixture();
  const stalled = gate<void>();
  const slow = { deliver: vi.fn(async () => { await stalled.promise; return { kind: 'delivered' as const }; }) };
  const opened = await f.port.open(f.selected, slow); opened.read.cancel();
  const version = { revision: 3, stateSequence: 6, operationId: '11111111-1111-4111-8111-111111111111' };
  const progress = Array.from({ length: 40 }, () => f.port.deliver(f.selected.conversationId,
    { kind: 'progress', operationId: version.operationId, message: 'progress' }, version));
  // 速い接続は次の発言の配送までに完了する。
  await Promise.resolve(); await Promise.resolve();
  const final = f.port.deliver(f.selected.conversationId, { kind: 'result', operationId: version.operationId,
    result: { kind: 'reply', message: 'final' } }, version);
  expect(slow.deliver).toHaveBeenCalledTimes(33);
  expect(f.delivery.deliver).toHaveBeenLastCalledWith(f.selected.conversationId, expect.objectContaining({ kind: 'result' }), version);
  stalled.resolve(); await Promise.all([...progress, final]); f.port.close();
});

it('forwards the latest activity even when the attachment has reached its progress limit', async () => {
  const f = await fixture();
  const stalled = gate<void>();
  f.delivery.deliver.mockImplementation(async (_id, output) => {
    if (output.kind === 'progress') await stalled.promise;
    return { kind: 'delivered' };
  });
  const version = { revision: 3, stateSequence: 6, operationId: '11111111-1111-4111-8111-111111111111' };
  const progress = Array.from({ length: 40 }, () => f.port.deliver(f.selected.conversationId,
    { kind: 'progress', operationId: version.operationId, message: 'progress' }, version));
  const activity = { kind: 'activity' as const, operationId: version.operationId, generation: 7,
    activity: { kind: 'tool' as const, tool: 'LatestTool' } };
  try {
    await f.port.deliver(f.selected.conversationId, activity, { ...version, stateSequence: 7 });
    expect(f.delivery.deliver).toHaveBeenCalledTimes(33);
    expect(f.delivery.deliver).toHaveBeenLastCalledWith(f.selected.conversationId, activity, { ...version, stateSequence: 7 });
  } finally { stalled.resolve(); await Promise.all(progress); f.port.close(); }
});
