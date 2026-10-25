import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ConversationTransferReceiver, type ConversationReadMetadata } from '../features/manager/conversationTransferReceiver.js';
import { ConversationFrameDecoder, conversationTransferFrames, encodeConversationFrame, MAX_CONVERSATION_FRAME_BYTES } from '../features/daemon/conversationFrames.js';
import type { ConversationState } from '../features/manager/conversationPort.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';

function fixture() {
  const record = conversationRecord('/repository');
  const state: ConversationState = { conversationId: record.id, assignment: record.assignment, revision: 4,
    pending: record.pending, approval: null, running: null, interrupted: false };
  const observer = { state: vi.fn(), item: vi.fn(), output: vi.fn(), read: vi.fn() };
  const receiver = new ConversationTransferReceiver(record.id, observer);
  const metadata = (revision: number, stateSequence: number, operationId: string | null = null): ConversationReadMetadata => ({
    conversationId: record.id, transferId: randomUUID(), revision, stateSequence, operationId,
  });
  const event = (output: unknown) => ({ protocolVersion: 1, type: 'event', conversationId: record.id, output });
  const frames = async (read: ConversationReadMetadata, items: unknown[], purpose: 'snapshot' | 'output' = 'snapshot') => {
    const values: unknown[] = [];
    for await (const { frame } of conversationTransferFrames(record.id, read, purpose, (async function* () { yield* items; })())) values.push(frame);
    return values;
  };
  return { receiver, observer, state, metadata, event, frames };
}

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
  expect(observer.read).toHaveBeenLastCalledWith('complete', read.transferId);
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
  expect(observer.read).toHaveBeenLastCalledWith('incomplete', read.transferId);
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
  expect(observer.read).toHaveBeenLastCalledWith('incomplete', read.transferId);
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
  expect(observer.read).toHaveBeenLastCalledWith('complete', replacement.transferId);
});

it('requires a goal objective in a snapshot inquiry before publishing it to the view', async () => {
  const { receiver, observer, state, metadata, frames } = fixture();
  const read = metadata(4, 1); receiver.expectRead(read);
  const values = await frames(read, [{ kind: 'state', state },
    { kind: 'assignment', assignment: { ...state.assignment, repositoryDirectories: ['/repository'] } },
    { kind: 'inquiry', inquiry: { target: { goalId: randomUUID(), repositoryDirectory: '/repository' },
      question: { id: randomUUID(), recipient: 'human', status: 'pending', body: 'Choose a format' } } }]);
  expect(() => values.forEach((value) => receiver.receive(value))).toThrow('Missing inquiry objective');
  expect(observer.item.mock.calls.some(([item]) => item.kind === 'inquiry')).toBe(false);
  expect(observer.read).toHaveBeenLastCalledWith('incomplete', read.transferId);
});
