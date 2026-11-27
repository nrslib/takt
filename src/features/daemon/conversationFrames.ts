import type { Socket } from 'node:net';
import type { OutputVersion, SnapshotMode, SnapshotRead } from '../manager/conversationPort.js';

export const MAX_CONVERSATION_FRAME_BYTES = 1_048_576;
const RAW_FRAGMENT_BYTES = 256 * 1024;

export class ConversationFrameDecoder {
  private parts: Buffer[] = [];
  private length = 0;

  *decode(chunk: Buffer): Generator<unknown> {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      this.length += part.length;
      if (this.length > MAX_CONVERSATION_FRAME_BYTES) throw new Error('IPC frame exceeds byte limit');
      this.parts.push(part);
      if (newline >= 0) {
        const bytes = Buffer.concat(this.parts, this.length);
        this.parts = [];
        this.length = 0;
        yield JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
      }
      offset = end;
    }
  }
}

export function encodeConversationFrame(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.length > MAX_CONVERSATION_FRAME_BYTES) throw new Error('IPC envelope exceeds byte limit');
  return bytes;
}

export async function writeConversationFrame(socket: Socket, value: unknown): Promise<void> {
  const bytes = encodeConversationFrame(value);
  if (socket.destroyed || socket.writableLength + bytes.length > MAX_CONVERSATION_FRAME_BYTES) throw new Error('IPC receiver is unavailable');
  await new Promise<void>((resolve, reject) => {
    let callbackDone = false;
    let needsDrain: boolean | undefined;
    let drained = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('drain', onDrain); socket.off('error', fail); socket.off('close', onClose);
    };
    const fail = (error: Error): void => { cleanup(); reject(error); };
    const finish = (): void => {
      if (callbackDone && needsDrain !== undefined && (!needsDrain || drained)) { cleanup(); resolve(); }
    };
    const onDrain = (): void => { drained = true; finish(); };
    const onClose = (): void => fail(new Error('IPC receiver disconnected'));
    const timer = setTimeout(() => fail(new Error('IPC receiver stalled')), 5_000);
    socket.on('drain', onDrain); socket.once('error', fail); socket.once('close', onClose);
    try {
      needsDrain = !socket.write(bytes, (error) => {
        if (error !== undefined && error !== null) { fail(error); return; }
        callbackDone = true; finish();
      });
      finish();
    } catch (error) { fail(error instanceof Error ? error : new Error('IPC write failed')); }
  });
}

export interface ConversationTransfer {
  frame: unknown;
  boundary: boolean;
  terminal: boolean;
}

export async function* conversationTransferFrames(
  conversationId: string, metadata: OutputVersion & { transferId: string; mode?: SnapshotMode }, purpose: 'snapshot' | 'output',
  items: AsyncIterable<unknown>,
): AsyncGenerator<ConversationTransfer> {
  const envelope = (output: unknown) => ({ protocolVersion: 1, type: 'event', conversationId, output });
  yield { frame: envelope({ kind: 'transfer_start', purpose, transferId: metadata.transferId,
    revision: metadata.revision, stateSequence: metadata.stateSequence, operationId: metadata.operationId,
    ...(metadata.mode === undefined ? {} : { mode: metadata.mode }) }), boundary: false, terminal: false };
  let itemIndex = 0;
  for await (const item of items) {
    const bytes = Buffer.from(JSON.stringify(item), 'utf8');
    let fragmentIndex = 0;
    for (let offset = 0; offset < bytes.length;) {
      let count = Math.min(RAW_FRAGMENT_BYTES, bytes.length - offset);
      let frame;
      while (true) {
        frame = envelope({ kind: 'transfer_data', transferId: metadata.transferId, itemIndex, fragmentIndex,
          finalFragment: offset + count === bytes.length, data: bytes.subarray(offset, offset + count).toString('base64') });
        if (Buffer.byteLength(`${JSON.stringify(frame)}\n`) <= MAX_CONVERSATION_FRAME_BYTES) break;
        count = Math.floor(count / 2);
        if (count === 0) throw new Error('IPC transfer metadata exceeds byte limit');
      }
      offset += count;
      fragmentIndex++;
      yield { frame, boundary: offset === bytes.length, terminal: false };
    }
    itemIndex++;
  }
  yield { frame: envelope({ kind: 'transfer_end', transferId: metadata.transferId, itemCount: itemIndex }), boundary: true, terminal: true };
}

export function snapshotMetadata(read: SnapshotRead) {
  return { transferId: read.transferId, conversationId: read.conversationId, revision: read.revision,
    stateSequence: read.stateSequence, operationId: read.operationId, mode: read.mode };
}
