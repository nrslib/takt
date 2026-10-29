import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { conversationIpcEndpoint, DaemonIpcStateSchema, ipcStateMatchesOwner, readDaemonIpcState,
  resolveDaemonConfigDirectory } from '../../infra/daemon/ipcEndpoint.js';
import { isDaemonOwnerRunning, readDaemonOwner } from '../../infra/daemon/owner.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { ConversationFrameDecoder, encodeConversationFrame, MAX_CONVERSATION_FRAME_BYTES } from '../daemon/conversationFrames.js';
import { ensureDaemon } from '../daemon/lifecycle.js';
import { createTuiConversationPort } from './tuiConversationPort.js';
import type { ConversationCommand, ConversationOpen, ConversationPort, ConversationState, PortOutput, Submission } from './conversationPort.js';
import { snapshotItemKey, orderSnapshotItems, type SnapshotDisplayItem } from './snapshotChanges.js';
import { ConversationReadMetadataSchema, ConversationTransferReceiver } from './conversationTransferReceiver.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';

const responseSchema = z.object({ protocolVersion: z.literal(1), type: z.literal('response'), requestId: z.string(),
  result: z.unknown().optional(), error: z.object({ kind: z.literal('error'), code: z.string(), message: z.string() }).strict().optional() }).strict()
  .refine((response) => Object.hasOwn(response, 'result') !== (response.error !== undefined));
const submissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), operationId: z.uuid() }).strict(),
  z.object({ kind: z.literal('busy'), operationId: z.uuid() }).strict(),
  z.object({ kind: z.literal('error'), code: z.string(), message: z.string() }).strict(),
]);
export interface ConversationClientSnapshot {
  connection: 'connecting' | 'connected' | 'disconnected';
  readStatus: 'reading' | 'complete' | 'incomplete';
  state: ConversationState | null;
  items: readonly SnapshotDisplayItem[];
  error: string | null;
}
type Output = Exclude<PortOutput, { kind: 'snapshot' }>;
type Request = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type ActiveRead = { transferId?: string; response?: Promise<void> };

export class ConversationIpcClient {
  private socket: Socket | undefined;
  private requests = new Map<string, Request>();
  private listeners = new Set<() => void>();
  private outputs = new Set<(output: Output) => void>();
  private receiver: ConversationTransferReceiver | undefined;
  private resolved: ConversationOpen | undefined;
  private attachmentId: string | undefined;
  private closed = false;
  private connecting: Promise<void> | undefined;
  private read: ActiveRead | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private committedItems = new Map<string, SnapshotDisplayItem>();
  private items = new Map<string, SnapshotDisplayItem>();
  private readItems = new Map<string, SnapshotDisplayItem>();
  private removed = new Set<string>();
  private view: ConversationClientSnapshot = { connection: 'connecting', readStatus: 'reading', state: null, items: [], error: null };
  private configDirectory = resolveDaemonConfigDirectory();

  constructor(private readonly assignment: ConversationAssignment, private readonly agentOverrides?: AssistantCliOverrides,
    private readonly options?: { port: ConversationPort<ConversationAssignment>; reconnect: boolean }) {}

  getSnapshot = (): ConversationClientSnapshot => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onOutput(listener: (output: Output) => void): () => void { this.outputs.add(listener); return () => { this.outputs.delete(listener); }; }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Conversation client is closed'));
    if (this.view.connection === 'connected') return Promise.resolve();
    if (this.connecting !== undefined) return this.connecting;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connecting = this.open().catch((error: unknown) => {
      this.socket?.destroy();
      const failure = error instanceof Error ? error : new Error('Conversation connection failed');
      this.disconnect(failure);
      throw failure;
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async submit(command: ConversationCommand, onAccepted?: (operationId: string) => void): Promise<Submission> {
    if (this.view.connection !== 'connected' || this.attachmentId === undefined || this.resolved === undefined) {
      return { kind: 'error', code: 'unavailable_attachment', message: 'Conversation is disconnected' };
    }
    const result = await this.request('submit', { attachmentId: this.attachmentId, speaker: this.resolved.speaker, command }, (value) => {
      const submission = submissionSchema.parse(value);
      // 後続の result が同じ socket chunk に入っていても、先に要求と対応付ける。
      if (submission.kind === 'accepted') onAccepted?.(submission.operationId);
      return submission;
    });
    if (result.kind === 'error' && result.code === 'stale_summary') {
      this.update({ readStatus: 'reading' });
      void this.refresh().catch((error: Error) => this.update({ error: error.message }));
    }
    if (result.kind === 'error' && result.code === 'invalid_assignment') await this.reopen();
    return result;
  }

  refresh(): Promise<void> {
    if (this.read !== undefined) return this.read.response ?? Promise.resolve();
    if (this.attachmentId === undefined || this.view.connection !== 'connected') return Promise.reject(new Error('Conversation is disconnected'));
    return this.requestRead('snapshot', { attachmentId: this.attachmentId }, (value) => {
      const result = z.object({ read: ConversationReadMetadataSchema }).strict().parse(value);
      this.receiver!.expectRead(result.read);
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.disconnect(new Error('Conversation client closed'));
  }

  private async reopen(): Promise<void> {
    this.socket?.destroy();
    this.disconnect(new Error('Conversation assignment changed'));
    await this.connect();
  }

  private update(change: Partial<ConversationClientSnapshot>): void {
    this.view = { ...this.view, ...change };
    for (const listener of this.listeners) listener();
  }

  private async open(): Promise<void> {
    this.update({ connection: 'connecting', readStatus: 'reading' });
    await ensureDaemon();
    if (this.closed) return;
    const owner = readDaemonOwner(this.configDirectory);
    const state = readDaemonIpcState(this.configDirectory);
    if (owner === undefined || state === undefined || !isDaemonOwnerRunning(owner) || !ipcStateMatchesOwner(state, owner)
      || state.endpoint !== conversationIpcEndpoint(this.configDirectory, process.platform, process.getuid?.() ?? 0)) throw new Error('Daemon IPC identity mismatch');
    const port = this.options?.port ?? createTuiConversationPort(this.configDirectory, { deliver: async () => ({ kind: 'unavailable', reason: 'IPC delivery only' }) });
    const resolved = await port.resolve(this.assignment);
    if (this.closed) return;
    if (this.resolved?.conversationId !== resolved.conversationId) {
      this.committedItems.clear();
      this.items.clear();
      this.update({ state: null, items: [] });
      this.receiver = new ConversationTransferReceiver(resolved.conversationId, {
        state: (next) => this.update({ state: next }),
        item: (item) => {
          const key = snapshotItemKey(item);
          this.readItems.set(key, item);
          this.items.set(key, item);
        },
        remove: (key) => { this.removed.add(key); },
        output: (output) => { for (const listener of this.outputs) listener(output); },
        read: (readStatus, transferId, mode) => {
          if (readStatus === 'reading') {
            this.readItems.clear();
            this.removed.clear();
            this.items = new Map(this.committedItems);
            this.read ??= {};
            this.read.transferId = transferId;
          } else if (this.read?.transferId === transferId) {
            if (readStatus === 'complete') {
              const next = mode === 'initial' ? new Map<string, SnapshotDisplayItem>() : new Map(this.committedItems);
              for (const [key, item] of this.readItems) next.set(key, item);
              for (const key of this.removed) next.delete(key);
              this.committedItems = next;
              this.items = new Map(next);
            }
            this.read.transferId = undefined;
            if (this.read.response === undefined) this.read = undefined;
          }
          if (readStatus === 'reading' && this.view.readStatus === 'complete') return;
          this.update({
            readStatus,
            ...(readStatus === 'reading' ? {} : { items: orderSnapshotItems(this.items) }),
          });
        },
      });
    }
    this.resolved = resolved;
    const socket = createConnection(state.endpoint);
    this.socket = socket;
    const decoder = new ConversationFrameDecoder();
    let authenticated = false;
    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket || socket.destroyed) return;
      try {
        for (const value of decoder.decode(chunk)) {
          const response = responseSchema.safeParse(value);
          if (response.success) {
            const pending = this.requests.get(response.data.requestId);
            if (pending === undefined) throw new Error('Unknown IPC response');
            this.requests.delete(response.data.requestId);
            clearTimeout(pending.timer);
            if (response.data.error !== undefined) pending.reject(new Error(response.data.error.message, { cause: response.data.error.code }));
            else {
              try { pending.resolve(response.data.result); }
              catch (error) { pending.reject(error instanceof Error ? error : new Error('Invalid IPC response')); throw error; }
            }
          } else {
            if (!authenticated) throw new Error('IPC event before authentication');
            this.receiver!.receive(value);
          }
        }
      } catch (error) { this.disconnect(error instanceof Error ? error : new Error('Invalid IPC response')); socket.destroy(); }
    });
    socket.on('error', (error) => { if (this.socket === socket) this.disconnect(error); });
    socket.once('close', () => { if (this.socket === socket) this.disconnect(new Error('Daemon disconnected')); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC connection timed out')); }, 5_000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    await this.request('hello', { capability: state.capability }, (value) => {
      const hello = z.object({ owner: DaemonIpcStateSchema.shape.owner }).strict().parse(value);
      if (!ipcStateMatchesOwner({ ...state, owner: hello.owner }, owner)) throw new Error('Daemon hello identity mismatch');
      this.receiver!.authenticated();
      authenticated = true;
    });
    await this.requestRead('open', { ...resolved, ...(this.agentOverrides === undefined ? {} : { agentOverrides: this.agentOverrides }) }, (value) => {
      const result = z.object({ attachmentId: z.uuid(), read: ConversationReadMetadataSchema }).strict().parse(value);
      this.attachmentId = result.attachmentId;
      this.receiver!.expectRead(result.read);
    });
    this.update({ connection: 'connected', error: null });
  }

  private requestRead(method: 'open' | 'snapshot', params: unknown, parse: (value: unknown) => void): Promise<void> {
    const read: ActiveRead = {};
    this.read = read;
    if (this.view.readStatus !== 'complete') this.update({ readStatus: 'reading' });
    read.response = this.request(method, params, parse).catch(async (error: unknown) => {
      if (this.read !== read) throw error;
      this.read = undefined;
      if (method === 'snapshot') {
        if (error instanceof Error && error.cause === 'invalid_assignment') {
          await this.reopen();
          return;
        }
        this.update({ readStatus: 'incomplete', error: error instanceof Error ? error.message : 'Read failed' });
      }
      throw error;
    }).finally(() => {
      read.response = undefined;
      if (this.read === read && read.transferId === undefined) this.read = undefined;
    });
    return read.response;
  }

  private request<T>(method: string, params: unknown, parse: (value: unknown) => T): Promise<T> {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) return Promise.reject(new Error('Conversation is disconnected'));
    const requestId = randomUUID();
    const bytes = encodeConversationFrame({ protocolVersion: 1, type: 'request', requestId, method, params });
    if (socket.writableLength + bytes.length > MAX_CONVERSATION_FRAME_BYTES) return Promise.reject(new Error('IPC output capacity exceeded'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.disconnect(new Error('IPC request timed out')); socket.destroy(); }, 5_000);
      this.requests.set(requestId, { resolve: (value) => resolve(parse(value)), reject, timer });
      socket.write(bytes, (error) => { if (error) { this.disconnect(error); socket.destroy(); } });
    });
  }

  private disconnect(error: Error): void {
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.requests.clear();
    this.attachmentId = undefined;
    this.read = undefined;
    this.receiver?.disconnect();
    this.update({ connection: 'disconnected', readStatus: 'incomplete', error: error.message });
    if (!this.closed && this.options?.reconnect !== false && this.reconnectTimer === undefined) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.connect().catch((next: Error) => this.disconnect(next));
      }, 500);
    }
  }
}
