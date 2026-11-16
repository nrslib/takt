import { type Socket } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { DaemonOwner } from '../../infra/daemon/owner.js';
import type { ConversationDelivery, ConversationInput, SnapshotRead } from '../manager/conversationPort.js';
import { conversationErrorResult, ConversationError } from '../manager/conversationErrors.js';
import { createTuiConversationPort } from '../manager/tuiConversationPort.js';
import { ConversationRequestSchema } from './conversationRequests.js';
import { ConversationFrameDecoder, conversationTransferFrames, snapshotMetadata, writeConversationFrame } from './conversationFrames.js';

const INPUT_BATCH_BYTES = 16 * 1024;
// Keep a short burst of notifications without retaining an unbounded backlog for a slow TUI.
const OUTPUT_QUEUE_CAPACITY = 16;

export function attachConversationConnection(socket: Socket, service: ConversationInput, configDirectory: string, capability: string, owner: DaemonOwner,
  onInitializingChange: (difference: number) => void) {
  const decoder = new ConversationFrameDecoder();
  const owned = new Set<string>();
  let authenticated = false;
  let awaitingOpen = false;
  const finishInitializing = (): void => {
    if (!awaitingOpen) return;
    awaitingOpen = false;
    onInitializingChange(-1);
  };
  let pumping = false;
  let pendingRequests = 0;
  let pendingRequestBytes = 0;
  type QueuedSend = { write(): Promise<void>; fail?(): void; read?: SnapshotRead; replaceable?: boolean };
  const queue: QueuedSend[] = [];
  let current: QueuedSend | undefined;
  const fail = (): void => {
    finishInitializing();
    current?.fail?.();
    for (const pending of queue.splice(0)) pending.fail?.();
    for (const id of owned) service.detach(id);
    owned.clear();
    socket.destroy();
  };
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (!socket.destroyed && queue.length > 0) {
        current = queue.shift()!;
        await current.write();
        current = undefined;
      }
    } catch { fail(); }
    finally { pumping = false; }
  };
  const enqueue = (pending: QueuedSend): void => {
    if (socket.destroyed || queue.length >= OUTPUT_QUEUE_CAPACITY) {
      pending.fail?.();
      fail();
      return;
    }
    queue.push(pending);
    void pump();
  };
  const cancelRead = (): void => {
    current?.read?.cancel();
    for (const pending of queue) pending.read?.cancel();
  };
  const respond = (value: unknown): void => { enqueue({ write: () => writeConversationFrame(socket, value) }); };
  const beginRead = (read: SnapshotRead, replaceable: boolean): void => {
    // 応答で transferId を知らせた read は、クライアントが待つので捨てない。
    // deliver で積まれ、まだ送り始めていない read だけを捨てる。差分は送り始めた時点で計算するので、順に送れば基準はずれない。
    if (replaceable) {
      for (let index = queue.length - 1; index >= 0; index--) {
        const stale = queue[index]!;
        if (stale.replaceable !== true) continue;
        queue.splice(index, 1);
        stale.read!.cancel();
      }
    }
    enqueue({ read, replaceable, fail() { read.cancel(); }, async write() {
      try {
        for await (const fragment of conversationTransferFrames(read.conversationId, read, 'snapshot', read.items)) {
          await writeConversationFrame(socket, fragment.frame);
        }
        read.complete();
      } catch {
        read.cancel();
        await writeConversationFrame(socket, { protocolVersion: 1, type: 'event', conversationId: read.conversationId,
          output: { kind: 'transfer_error', transferId: read.transferId, code: 'read_failed' } });
      }
    } });
  };
  const delivery: ConversationDelivery = {
    deliver(conversationId, value, version, signal) {
      if (signal?.aborted) return Promise.resolve({ kind: 'unavailable', reason: 'interrupted' });
      if (socket.destroyed) return Promise.resolve({ kind: 'unavailable', reason: 'disconnected' });
      if (value.kind === 'snapshot') { beginRead(value.read, true); return Promise.resolve({ kind: 'delivered' }); }
      const transferId = randomUUID();
      enqueue({ async write() {
        let started = false;
        for await (const fragment of conversationTransferFrames(conversationId, { ...version, transferId },
          'output', (async function* () { yield value; })())) {
          if (signal?.aborted) {
            if (started) await writeConversationFrame(socket, { protocolVersion: 1, type: 'event', conversationId,
              output: { kind: 'transfer_error', transferId, code: 'interrupted' } });
            return;
          }
          await writeConversationFrame(socket, fragment.frame);
          started = true;
        }
      } });
      // 配送完了ではなく FIFO への受入で返す。遅い接続は既存の容量で切断する。
      return Promise.resolve(socket.destroyed ? { kind: 'unavailable', reason: 'disconnected' } : { kind: 'delivered' });
    },
  };
  const port = createTuiConversationPort(configDirectory, delivery);
  const dispatch = async (raw: unknown): Promise<void> => {
    const request = ConversationRequestSchema.parse(raw);
    const response = (result: unknown): void => { respond({ protocolVersion: 1, type: 'response', requestId: request.requestId, result }); };
    if (request.method === 'hello') {
      if (authenticated || !timingSafeEqual(Buffer.from(capability, 'hex'), Buffer.from(request.params.capability, 'hex'))) { fail(); return; }
      authenticated = true;
      // readiness と最初の attachment を、同じ接続の寿命で連続させる。
      awaitingOpen = true;
      onInitializingChange(1);
      response({ owner });
      return;
    }
    if (!authenticated) { fail(); return; }
    try {
      if (request.method === 'open') {
        onInitializingChange(1);
        try {
          if (request.params.binding.port !== 'tui') throw new ConversationError('invalid_input');
          const resolved = await port.resolve(request.params.assignment);
          if (JSON.stringify(request.params.binding) !== JSON.stringify(resolved.binding)
            || JSON.stringify(request.params.speaker) !== JSON.stringify(resolved.speaker)) throw new ConversationError('invalid_input');
          // 応答は、それが知らせる read より先に届ける。
          const opened = await service.open(request.params, port.delivery, (read, attachmentId) => {
            owned.add(attachmentId);
            finishInitializing();
            response({ attachmentId, read: snapshotMetadata(read) });
            beginRead(read, false);
          });
          if (socket.destroyed) { service.detach(opened.attachmentId); opened.read.cancel(); }
        } finally { onInitializingChange(-1); }
      } else {
        if (!owned.has(request.params.attachmentId)) throw new ConversationError('unavailable_attachment');
        switch (request.method) {
          case 'submit': {
            const result = await service.submit({ ...request.params, requestId: request.requestId });
            response(result);
            break;
          }
          case 'snapshot': {
            await service.snapshot(request.params.attachmentId, { enqueueSnapshot: (read) => {
              response({ read: snapshotMetadata(read) });
              beginRead(read, false);
            } });
            break;
          }
          case 'detach':
            service.detach(request.params.attachmentId); owned.delete(request.params.attachmentId); cancelRead();
            response({ detached: true });
        }
      }
    } catch (error) {
      respond({ protocolVersion: 1, type: 'response', requestId: request.requestId, error: conversationErrorResult(error, 'en') });
    }
  };
  let reading = false;
  const receive = async (): Promise<void> => {
    if (reading) return;
    reading = true;
    try {
      while (!socket.destroyed && socket.readableLength > 0
        && (pendingRequestBytes < INPUT_BATCH_BYTES || pendingRequests === 1)) {
        const chunk = socket.read(Math.min(INPUT_BATCH_BYTES, socket.readableLength)) as Buffer | null;
        if (chunk === null) break;
        // Admit the whole bounded batch so competing mutations are never queued
        // for reevaluation. One large pending frame still leaves room for a
        // second request. Frame limits and the byte budget bound further input.
        for (const value of decoder.decode(chunk)) {
          const requestBytes = Buffer.byteLength(JSON.stringify(value)!) + 1;
          pendingRequests++;
          pendingRequestBytes += requestBytes;
          void dispatch(value).catch(fail).finally(() => {
            pendingRequests--;
            pendingRequestBytes -= requestBytes;
            void pump();
            void receive();
          });
        }
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
    } catch { fail(); }
    finally { reading = false; }
  };
  socket.on('readable', () => { void receive(); });
  socket.once('close', fail);
  socket.on('error', fail);
  return fail;
}
