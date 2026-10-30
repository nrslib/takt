import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ConversationTransferReceiver, type ConversationReadMetadata } from '../features/manager/conversationTransferReceiver.js';
import { ConversationFrameDecoder, conversationTransferFrames, encodeConversationFrame, MAX_CONVERSATION_FRAME_BYTES } from '../features/daemon/conversationFrames.js';
import { SnapshotChanges, snapshotItemKey, orderSnapshotItems } from '../features/manager/snapshotChanges.js';
import type { SnapshotValue, ConversationState } from '../features/manager/conversationPort.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';

function fixture() {
  const record = conversationRecord('/repository');
  const state: ConversationState = { conversationId: record.id, assignment: record.assignment, revision: 4,
    pending: record.pending, approval: null, running: null, interrupted: false };
  const observer = { state: vi.fn(), item: vi.fn(), output: vi.fn(), read: vi.fn(), remove: vi.fn() };
  const receiver = new ConversationTransferReceiver(record.id, observer);
  const metadata = (revision: number, stateSequence: number, operationId: string | null = null): ConversationReadMetadata => ({
    conversationId: record.id, transferId: randomUUID(), revision, stateSequence, operationId, mode: 'initial',
  });
  const event = (output: unknown) => ({ protocolVersion: 1, type: 'event', conversationId: record.id, output });
  const frames = async (read: ConversationReadMetadata, items: unknown[], purpose: 'snapshot' | 'output' = 'snapshot') => {
    const values: unknown[] = [];
    for await (const { frame } of conversationTransferFrames(record.id, purpose === 'snapshot' ? read : { ...read, mode: undefined }, purpose, (async function* () { yield* items; })())) values.push(frame);
    return values;
  };
  return { receiver, observer, state, metadata, event, frames };
}

it('validates and delivers a user message with the matching operation identity', async () => {
  const { receiver, observer, metadata, frames } = fixture();
  const operationId = randomUUID();
  const message = { kind: 'user_message', operationId, message: 'Shared input' };
  const read = metadata(5, 2, operationId);
  for (const frame of await frames(read, [message], 'output')) receiver.receive(frame);
  expect(observer.output).toHaveBeenCalledExactlyOnceWith(message, expect.objectContaining({ operationId }));
});

it('rejects a user message belonging to a different operation', async () => {
  const { receiver, observer, metadata, frames } = fixture();
  const read = metadata(5, 2, randomUUID());
  const message = { kind: 'user_message', operationId: randomUUID(), message: 'Wrong operation' };
  const values = await frames(read, [message], 'output');
  expect(() => { for (const frame of values) receiver.receive(frame); }).toThrow();
  expect(observer.output).not.toHaveBeenCalled();
});

it.each([
  { responseAfter: 'start', frameCount: 1 },
  { responseAfter: 'an item', frameCount: 3 },
  { responseAfter: 'completion', frameCount: 4 },
])('completes the same snapshot without losing items when its response arrives after $responseAfter', async ({ frameCount }) => {
  const { receiver, observer, state, metadata, frames } = fixture();
  const read = metadata(4, 1);
  const item = { kind: 'display_event', event: { id: 'event-before-response', message: 'Received conversation information' } };
  const values = await frames(read, [{ kind: 'state', state }, item]);

  values.slice(0, frameCount).forEach((frame) => receiver.receive(frame));
  receiver.expectRead(read);
  values.slice(frameCount).forEach((frame) => receiver.receive(frame));

  expect(observer.read.mock.calls).toEqual([['reading', read.transferId, 'initial'], ['complete', read.transferId, 'initial']]);
  expect(observer.state).toHaveBeenCalledExactlyOnceWith(state, read);
  expect(observer.item).toHaveBeenCalledExactlyOnceWith(item, read.transferId);
});

it.each([
  { revision: 5 },
  { stateSequence: 2 },
  { operationId: '550e8400-e29b-41d4-a716-446655440000' },
])('rejects mismatched metadata in a response arriving after snapshot start: %j', async (mismatch) => {
  const { receiver, observer, state, metadata, frames } = fixture();
  const read = metadata(4, 1);
  const values = await frames(read, [{ kind: 'state', state }]);
  receiver.receive(values[0]);

  expect(() => receiver.expectRead({ ...read, ...mismatch })).toThrow();
  expect(observer.state).not.toHaveBeenCalled();
  expect(observer.read.mock.calls.some(([status]) => status === 'complete')).toBe(false);
});

it('keeps an early failed read incomplete after its response and completes a replacement read', async () => {
  const { receiver, observer, state, metadata, frames, event } = fixture();
  const read = metadata(4, 1);
  const values = await frames(read, [{ kind: 'state', state }]);
  receiver.receive(values[0]);
  receiver.receive(event({ kind: 'transfer_error', transferId: read.transferId, code: 'read_failed' }));

  receiver.expectRead(read);
  values.slice(1).forEach((frame) => receiver.receive(frame));
  expect(observer.read.mock.calls).toEqual([['reading', read.transferId, 'initial'], ['incomplete', read.transferId, 'initial']]);
  expect(observer.state).not.toHaveBeenCalled();

  const replacement = metadata(4, 2);
  receiver.expectRead(replacement);
  for (const frame of await frames(replacement, [{ kind: 'state', state }])) receiver.receive(frame);
  expect(observer.read).toHaveBeenLastCalledWith('complete', replacement.transferId, 'initial');
  expect(observer.state).toHaveBeenCalledExactlyOnceWith(state, replacement);
});

it('accepts an early snapshot with a restarted sequence after reauthentication on the same receiver', async () => {
  const { receiver, observer, state, metadata, frames } = fixture();
  const old = metadata(4, 10);
  receiver.expectRead(old);
  for (const frame of await frames(old, [{ kind: 'state', state }])) receiver.receive(frame);
  receiver.disconnect();
  receiver.authenticated();
  const read = metadata(4, 0);
  const values = await frames(read, [{ kind: 'state', state }]);

  receiver.receive(values[0]);
  receiver.expectRead(read);
  values.slice(1).forEach((frame) => receiver.receive(frame));

  expect(observer.read).toHaveBeenLastCalledWith('complete', read.transferId, 'initial');
  expect(observer.state).toHaveBeenLastCalledWith(state, read);
  expect(observer.state).toHaveBeenCalledTimes(2);
});

it.each([7, 9])('reassembles a pending proposal with %s large constraints across split and coalesced physical frames', async (count) => {
  const { receiver, observer, state, metadata, frames } = fixture();
  const read = metadata(4, 1);
  state.pending!.summary.constraints = Array.from({ length: count }, (_, index) => String(index) + 'x'.repeat(128 * 1024 - 1));
  receiver.expectRead(read);
  const decoder = new ConversationFrameDecoder();
  const values = await frames(read, [{ kind: 'state', state }]);
  const wire = Buffer.concat(values.map((frame) => {
    const encoded = encodeConversationFrame(frame);
    expect(encoded.length).toBeLessThanOrEqual(MAX_CONVERSATION_FRAME_BYTES);
    return encoded;
  }));
  for (let offset = 0; offset < wire.length; offset += 73_777) {
    for (const frame of decoder.decode(wire.subarray(offset, offset + 73_777))) receiver.receive(frame);
  }
  expect(observer.state).toHaveBeenCalledExactlyOnceWith(state, read);
  expect(observer.read).toHaveBeenLastCalledWith('complete', read.transferId, 'initial');
});

it('keeps revision five when an old read ends and when late revision four output arrives', async () => {
  const { receiver, observer, state, metadata, frames } = fixture();
  const old = metadata(4, 1);
  receiver.expectRead(old);
  const oldFrames = await frames(old, [{ kind: 'state', state }]);
  oldFrames.slice(0, -1).forEach((frame) => receiver.receive(frame));
  const next = { ...state, revision: 5, pending: { ...state.pending!, revision: 5, summary: { ...state.pending!.summary, objective: 'new proposal' } } };
  for (const frame of await frames(metadata(5, 3), [{ kind: 'pending', state: next }], 'output')) receiver.receive(frame);
  receiver.receive(oldFrames.at(-1));
  for (const frame of await frames(metadata(4, 2), [{ kind: 'pending', state }], 'output')) receiver.receive(frame);
  expect(observer.state.mock.calls.map(([value]) => value.revision)).toEqual([4, 5]);
  expect(observer.state).toHaveBeenLastCalledWith(next, expect.objectContaining({ stateSequence: 3 }));
});

it('does not let an older idle state clear a newer running operation in the same revision', async () => {
  const { receiver, observer, state, metadata, frames } = fixture();
  const operationId = randomUUID();
  const running = { ...state, running: { operationId, kind: 'approve_summary' } };
  for (const frame of await frames(metadata(4, 3, operationId), [{ kind: 'running', state: running }], 'output')) receiver.receive(frame);
  for (const frame of await frames(metadata(4, 2), [{ kind: 'pending', state }], 'output')) receiver.receive(frame);
  expect(observer.state).toHaveBeenCalledExactlyOnceWith(running, expect.objectContaining({ stateSequence: 3 }));
});

it('discards partial bytes on disconnect and accepts a new authenticated read without rolling durable revision back', async () => {
  const { receiver, observer, state, metadata, frames, event } = fixture();
  const read = metadata(4, 10);
  receiver.expectRead(read);
  const { conversationId: _id, ...start } = read;
  receiver.receive(event({ kind: 'transfer_start', purpose: 'snapshot', ...start }));
  receiver.receive(event({ kind: 'transfer_data', transferId: read.transferId, itemIndex: 0, fragmentIndex: 0, finalFragment: false, data: 'ew==' }));
  receiver.disconnect();
  expect(observer.state).not.toHaveBeenCalled();
  expect(observer.read).toHaveBeenLastCalledWith('incomplete', read.transferId, 'initial');
  receiver.authenticated();
  const next = metadata(4, 0); receiver.expectRead(next);
  for (const frame of await frames(next, [{ kind: 'state', state }])) receiver.receive(frame);
  expect(observer.state).toHaveBeenCalledOnce();
  for (const frame of await frames(metadata(3, 1), [{ kind: 'pending', state: { ...state, revision: 3, pending: null } }], 'output')) receiver.receive(frame);
  expect(observer.state).toHaveBeenCalledOnce();
});

it.each(['index', 'fragment', 'base64', 'utf8', 'json', 'schema', 'identity', 'count'] as const)('rejects %s corruption without applying a partial state', async (corruption) => {
  const { receiver, observer, state, metadata, event } = fixture();
  const read = metadata(4, 1); receiver.expectRead(read);
  const { conversationId: _id, ...start } = read;
  receiver.receive(event({ kind: 'transfer_start', purpose: 'snapshot', ...start }));
  let bytes = Buffer.from(JSON.stringify({ kind: 'state', state }));
  if (corruption === 'utf8') bytes = Buffer.from([0xff]);
  if (corruption === 'json') bytes = Buffer.from('{');
  if (corruption === 'schema') bytes = Buffer.from(JSON.stringify({ kind: 'state', state: { ...state, pending: 'invalid' } }));
  if (corruption === 'identity') bytes = Buffer.from(JSON.stringify({ kind: 'state', state: { ...state, assignment: { kind: 'repository', repositoryDirectory: '/other' } } }));
  if (corruption === 'count') {
    expect(() => receiver.receive(event({ kind: 'transfer_end', transferId: read.transferId, itemCount: 1 }))).toThrow();
  } else {
    expect(() => receiver.receive(event({ kind: 'transfer_data', transferId: read.transferId,
      itemIndex: corruption === 'index' ? 1 : 0, fragmentIndex: corruption === 'fragment' ? 1 : 0,
      finalFragment: true, data: corruption === 'base64' ? 'e!===' : bytes.toString('base64') }))).toThrow();
  }
  expect(observer.state).not.toHaveBeenCalled();
  receiver.disconnect();
  expect(observer.read).toHaveBeenLastCalledWith('incomplete', read.transferId, 'initial');
});

it('matches snapshot response metadata and discards cancelled transfer data', async () => {
  const { receiver, observer, state, metadata, frames, event } = fixture();
  const read = metadata(4, 1); receiver.expectRead(read);
  const { conversationId: _id, ...start } = read;
  expect(() => receiver.receive(event({ kind: 'transfer_start', purpose: 'snapshot', ...start, revision: 5 }))).toThrow();
  const oldFrames = await frames(read, [{ kind: 'state', state }]);
  const replacement = metadata(4, 2); receiver.expectRead(replacement);
  oldFrames.forEach((frame) => receiver.receive(frame));
  expect(observer.state).not.toHaveBeenCalled();
  for (const frame of await frames(replacement, [{ kind: 'state', state }])) receiver.receive(frame);
  expect(observer.state).toHaveBeenCalledOnce();
  expect(observer.read).toHaveBeenLastCalledWith('complete', replacement.transferId, 'initial');
});

it('requires a goal objective in a snapshot inquiry before publishing it to the view', async () => {
  const { receiver, observer, state, metadata, frames } = fixture();
  const read = metadata(4, 1); receiver.expectRead(read);
  const values = await frames(read, [{ kind: 'state', state },
    { kind: 'assignment', assignment: { ...state.assignment, repositoryDirectories: ['/repository'] } },
    { kind: 'inquiry', inquiry: { target: { goalId: randomUUID(), repositoryDirectory: '/repository' },
      question: { id: randomUUID(), recipient: 'human', status: 'pending', body: 'Choose a format' } } }]);
  expect(() => values.forEach((value) => receiver.receive(value))).toThrow();
  expect(observer.item.mock.calls.some(([item]) => item.kind === 'inquiry')).toBe(false);
  expect(observer.read).toHaveBeenLastCalledWith('incomplete', read.transferId, 'initial');
});

function changeRead(changes: SnapshotChanges, values: SnapshotValue[]) {
  return changes.read({ transferId: randomUUID(), conversationId: 'conversation', revision: 0, stateSequence: 0, operationId: null },
    (async function* () { yield* values; })());
}
async function consumeChanges(read: ReturnType<typeof changeRead>) {
  const values = [];
  for await (const value of read.items) values.push(value);
  return values;
}
it('sends only changed values and removed keys after explicit completion and permits an empty delta', async () => {
  const changes = new SnapshotChanges();
  const first: SnapshotValue = { kind: 'display_event', event: { id: 'first', message: 'Original' } };
  const second: SnapshotValue = { kind: 'display_event', event: { id: 'second', message: 'Retained' } };
  const initial = changeRead(changes, [first, second]);
  expect(initial.mode).toBe('initial');
  expect(await consumeChanges(initial)).toEqual([first, second]);
  initial.complete();
  const unchanged = changeRead(changes, [first, second]);
  expect(unchanged.mode).toBe('delta');
  expect(await consumeChanges(unchanged)).toEqual([]);
  unchanged.complete();
  const changed = { ...first, event: { ...first.event, message: 'Updated' } };
  const delta = changeRead(changes, [changed]);
  expect(await consumeChanges(delta)).toEqual([changed, { kind: 'remove', key: snapshotItemKey(second) }]);
  delta.complete();
  expect(await consumeChanges(changeRead(changes, [changed]))).toEqual([]);
});
it.each(['unconsumed', 'cancelled', 'replaced'] as const)('does not commit an %s read or a late completion', async (failure) => {
  const changes = new SnapshotChanges();
  const event: SnapshotValue = { kind: 'display_event', event: { id: 'change', message: 'Visible' } };
  const read = changeRead(changes, [event]);
  if (failure !== 'unconsumed') await consumeChanges(read);
  if (failure === 'cancelled') read.cancel();
  if (failure === 'replaced') changeRead(changes, []);
  read.complete();
  const retry = changeRead(changes, [event]);
  expect(retry.mode).toBe('initial');
  expect(await consumeChanges(retry)).toEqual([event]);
});
it('rejects duplicate source keys instead of committing an ambiguous snapshot', async () => {
  const changes = new SnapshotChanges();
  const event: SnapshotValue = { kind: 'display_event', event: { id: 'same', message: 'Visible' } };
  const read = changeRead(changes, [event, event]);
  await expect(consumeChanges(read)).rejects.toThrow('Repeated snapshot item');
  read.complete();
  expect(changeRead(changes, []).mode).toBe('initial');
});
it('uses canonical inquiry identity and preserves assignment repository order and inquiry creation order', () => {
  const question = { id: randomUUID(), body: 'Choose', recipient: 'human' as const, status: 'pending' as const };
  const inquiry: SnapshotValue = { kind: 'inquiry', inquiry: { target: { goalId: 'goal', repositoryDirectory: '/second' }, question, objective: 'Goal' } };
  expect(snapshotItemKey(inquiry)).toBe(snapshotItemKey({ kind: 'inquiry', inquiry: { ...inquiry.inquiry,
    target: { repositoryDirectory: '/second', goalId: 'goal' } } }));
  const values: Exclude<SnapshotValue, { kind: 'state' }>[] = [
    { kind: 'goal', goal: { id: 'a', objective: 'Second', repositoryDirectory: '/second', status: 'created', executionStatus: 'active' } },
    inquiry,
    { kind: 'assignment', assignment: { kind: 'repository', repositoryDirectory: '/first', repositoryDirectories: ['/first', '/second'] } },
    { kind: 'goal', goal: { id: 'z', objective: 'First', repositoryDirectory: '/first', status: 'created', executionStatus: 'active' } },
    { kind: 'inquiry', inquiry: { ...inquiry.inquiry, question: { ...question, id: randomUUID(), createdAt: '2026-01-01T00:00:00Z' } } },
  ];
  expect(orderSnapshotItems(new Map(values.map((value) => [snapshotItemKey(value), value])))).toEqual([
    values[2], values[3], values[0], values[4], values[1],
  ]);
});
it('accepts empty deltas and validates changed repositories against the completed assignment', async () => {
  const { receiver, observer, metadata, state, frames } = fixture();
  const initial = metadata(4, 1);
  for (const frame of await frames(initial, [{ kind: 'state', state },
    { kind: 'assignment', assignment: { ...state.assignment, repositoryDirectories: ['/repository'] } }])) receiver.receive(frame);
  const delta = { ...metadata(4, 1), mode: 'delta' as const };
  receiver.expectRead(delta);
  for (const frame of await frames(delta, [])) receiver.receive(frame);
  expect(observer.read).toHaveBeenLastCalledWith('complete', delta.transferId, 'delta');
  const invalid = { ...metadata(4, 1), mode: 'delta' as const };
  receiver.expectRead(invalid);
  const goal = { kind: 'goal', goal: { id: randomUUID(), objective: 'Outside', repositoryDirectory: '/other', status: 'created', executionStatus: 'active' } };
  const values = await frames(invalid, [goal]);
  expect(() => values.forEach((frame) => receiver.receive(frame))).toThrow('Display repository outside assignment');
});
it('requires a completed initial read before delta and rejects a mode mismatch', async () => {
  const { receiver, metadata, state, frames } = fixture();
  const delta = { ...metadata(4, 1), mode: 'delta' as const };
  expect(() => receiver.expectRead(delta)).not.toThrow();
  const values = await frames(delta, []);
  expect(() => receiver.receive(values[0])).toThrow('Delta before initial snapshot');
  const initial = metadata(4, 1); receiver.expectRead(initial);
  const initialFrames = await frames(initial, [{ kind: 'state', state }]);
  receiver.receive(initialFrames[0]);
  expect(() => receiver.expectRead({ ...initial, mode: 'delta' })).toThrow('Read metadata mismatch');
});

it('accepts a repeated deletion on a later delta so a retried read remains idempotent', async () => {
  const { receiver, observer, metadata, state, frames } = fixture();
  const event = { kind: 'display_event', event: { id: 'removed', message: 'Visible' } } as const;
  for (const frame of await frames(metadata(4, 1), [{ kind: 'state', state }, event])) receiver.receive(frame);
  for (let attempt = 0; attempt < 2; attempt++) {
    const delta = { ...metadata(4, 1), mode: 'delta' as const };
    receiver.expectRead(delta);
    for (const frame of await frames(delta, [{ kind: 'remove', key: snapshotItemKey(event) }])) receiver.receive(frame);
    expect(observer.read).toHaveBeenLastCalledWith('complete', delta.transferId, 'delta');
  }
  expect(observer.remove.mock.calls.map(([key]) => key)).toEqual([snapshotItemKey(event), snapshotItemKey(event)]);
});

it.each(['value', 'remove'] as const)('rejects a duplicate delta key from a second %s before publishing it', async (duplicate) => {
  const { receiver, observer, metadata, state, frames } = fixture();
  for (const frame of await frames(metadata(4, 1), [{ kind: 'state', state }])) receiver.receive(frame);
  const delta = { ...metadata(4, 1), mode: 'delta' as const };
  const event = { kind: 'display_event', event: { id: 'same', message: 'Visible' } } as const;
  const repeated = duplicate === 'value' ? event : { kind: 'remove', key: snapshotItemKey(event) };
  receiver.expectRead(delta);
  const values = await frames(delta, [event, repeated]);

  expect(() => values.forEach((frame) => receiver.receive(frame))).toThrow();
  expect(observer.item).toHaveBeenCalledExactlyOnceWith(event, delta.transferId);
  expect(observer.remove).not.toHaveBeenCalled();
  expect(observer.read).toHaveBeenLastCalledWith('incomplete', delta.transferId, 'delta');
});
