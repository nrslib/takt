import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { conversationIpcEndpoint } from '../infra/daemon/ipcEndpoint.js';
import { ConversationFrameDecoder, conversationTransferFrames, encodeConversationFrame,
  MAX_CONVERSATION_FRAME_BYTES, writeConversationFrame } from '../features/daemon/conversationFrames.js';
import { ConversationRequestSchema } from '../features/daemon/conversationRequests.js';

it('keeps the Unix endpoint short and uses the Windows named pipe namespace', () => {
  const directory = `/config/${'long-directory/'.repeat(100)}`;
  const unix = conversationIpcEndpoint(directory, 'darwin', 123);
  expect(unix).toMatch(/^\/tmp\/takt-123-[a-f0-9]{24}\/manager.sock$/);
  expect(Buffer.byteLength(unix)).toBeLessThanOrEqual(103);
  expect(conversationIpcEndpoint(directory, 'win32', 0)).toMatch(/^\\\\\.\\pipe\\takt-manager-[a-f0-9]{24}$/);
  expect(conversationIpcEndpoint(`${directory}other`, 'darwin', 123)).not.toBe(unix);
});

it('parses coalesced frames and UTF-8 split across input chunks', () => {
  const bytes = Buffer.concat([encodeConversationFrame({ text: '日本語' }), encodeConversationFrame({ text: 'second' })]);
  const decoder = new ConversationFrameDecoder();
  const output: unknown[] = [];
  for (const byte of bytes) output.push(...decoder.decode(Buffer.from([byte])));
  expect(output).toEqual([{ text: '日本語' }, { text: 'second' }]);
  expect([...new ConversationFrameDecoder().decode(bytes)]).toEqual(output);
});

it('enforces the physical byte bound including the newline', () => {
  const size = MAX_CONVERSATION_FRAME_BYTES - Buffer.byteLength('{"text":""}\n');
  const value = { text: 'a'.repeat(size) };
  const frame = encodeConversationFrame(value);
  expect(frame).toHaveLength(MAX_CONVERSATION_FRAME_BYTES);
  expect([...new ConversationFrameDecoder().decode(frame)]).toEqual([value]);
  expect(() => encodeConversationFrame({ text: `${value.text}a` })).toThrow();
  const decoder = new ConversationFrameDecoder();
  expect([...decoder.decode(frame.subarray(0, -1))]).toEqual([]);
  expect(() => [...decoder.decode(Buffer.from('a\n'))]).toThrow();
});

it.each([Buffer.from('{bad}\n'), Buffer.from([34, 0xc3, 0x28, 34, 10])])('rejects malformed JSON or UTF-8', (bytes) => {
  expect(() => [...new ConversationFrameDecoder().decode(bytes)]).toThrow();
});

it('rejects protocol versions, missing open identities and invalid submit parameters', () => {
  const hello = { protocolVersion: 1, type: 'request', requestId: 'one', method: 'hello', params: { capability: 'a'.repeat(64) } };
  expect(ConversationRequestSchema.safeParse(hello).success).toBe(true);
  expect(ConversationRequestSchema.safeParse({ ...hello, protocolVersion: 2 }).success).toBe(false);
  expect(ConversationRequestSchema.safeParse({ ...hello, method: 'open', params: {} }).success).toBe(false);
  const submit = { ...hello, method: 'submit', params: { attachmentId: '11111111-1111-4111-8111-111111111111',
    speaker: { namespace: 'local', id: 'operator' }, command: { kind: 'message', text: 'hello' } } };
  expect(ConversationRequestSchema.safeParse(submit).success).toBe(true);
  expect(ConversationRequestSchema.safeParse({ ...submit, params: { ...submit.params, requestId: 'two' } }).success).toBe(false);
  expect(ConversationRequestSchema.safeParse({ ...submit, params: { ...submit.params, command: {
    kind: 'answer_question', questionId: '22222222-2222-4222-8222-222222222222',
    target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: '/repository' } }, answer: { decision: 'allow', scope: 'global' },
    permission: { scope: { kind: 'global' }, sentence: 'Allow it', filePath: '/arbitrary-file', append: {} },
  } } }).success).toBe(false);
});

it.each([7, 9])('fragments one complete item containing %i large ASCII strings without truncation', async (count) => {
  const item = { kind: 'pending', constraints: Array.from({ length: count }, (_, index) => `${index}:`.padEnd(128 * 1024, 'a')) };
  const read = { transferId: 'transfer', revision: 4, stateSequence: 12, operationId: null };
  const fragments: Buffer[] = [];
  let expectedFragment = 0;
  let completed = false;
  for await (const { frame } of conversationTransferFrames('conversation', read, 'output', (async function* () { yield item; })())) {
    expect(encodeConversationFrame(frame).length).toBeLessThanOrEqual(MAX_CONVERSATION_FRAME_BYTES);
    const envelope = frame as { output: { kind: string; itemIndex: number; fragmentIndex: number; data: string; itemCount: number } };
    if (envelope.output.kind === 'transfer_data') {
      expect(envelope.output.itemIndex).toBe(0);
      expect(envelope.output.fragmentIndex).toBe(expectedFragment++);
      fragments.push(Buffer.from(envelope.output.data, 'base64'));
    }
    if (envelope.output.kind === 'transfer_end') { completed = true; expect(envelope.output.itemCount).toBe(1); }
  }
  expect(completed).toBe(true);
  expect(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(fragments)))).toEqual(item);
});

it('does not pull the next item before demand and closes a cancelled read', async () => {
  const readItem = vi.fn();
  const close = vi.fn();
  const items = async function* () {
    try { readItem(0); yield { id: 'first' }; readItem(1); yield { id: 'second' }; }
    finally { close(); }
  };
  const frames = conversationTransferFrames('conversation', { transferId: 'transfer', revision: 4, stateSequence: 1, operationId: null }, 'snapshot', items());
  await frames.next();
  expect(readItem).not.toHaveBeenCalled();
  await frames.next();
  expect(readItem).toHaveBeenCalledExactlyOnceWith(0);
  await frames.return(undefined);
  expect(close).toHaveBeenCalledOnce();
  expect(readItem).toHaveBeenCalledOnce();
});

it.each(['callback', 'drain'] as const)('waits for both the write callback and drain when %s arrives first', async (first) => {
  const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
    write: vi.fn((_bytes: Buffer, callback: (error?: Error) => void) => { finish = callback; return false; }) });
  let finish!: (error?: Error) => void;
  let complete = false;
  const writing = writeConversationFrame(socket as unknown as Socket, { value: 'test' }).then(() => { complete = true; });
  if (first === 'callback') finish(); else socket.emit('drain');
  await Promise.resolve();
  expect(complete).toBe(false);
  if (first === 'callback') socket.emit('drain'); else finish();
  await writing;
  expect(complete).toBe(true);
  expect(socket.listenerCount('drain')).toBe(0);
});
