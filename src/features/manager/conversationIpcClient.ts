import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { resolveCurrentManagerAssignment } from './assignment.js';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { resolveDaemonConfigDirectory } from '../../infra/daemon/ipcEndpoint.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { ConversationFrameDecoder, encodeConversationFrame, MAX_CONVERSATION_FRAME_BYTES } from '../daemon/conversationFrames.js';
import { ensureDaemon } from '../daemon/lifecycle.js';
import { createTuiConversationPort } from './tuiConversationPort.js';
import type { ConversationCommand, ConversationOpen, ConversationPort, ConversationState, OutputVersion, PortOutput, Submission } from './conversationPort.js';
import { snapshotItemKey, orderSnapshotItems, type SnapshotDisplayItem } from './snapshotChanges.js';
import { ConversationReadMetadataSchema, ConversationTransferReceiver } from './conversationTransferReceiver.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import type { ToolActivityTurnState } from '../../shared/tool-activity/types.js';

const responseSchema = z.object({ protocolVersion: z.literal(1), type: z.literal('response'), requestId: z.string(),
  result: z.unknown().optional(), error: z.object({ kind: z.literal('error'), code: z.string(), message: z.string() }).strict().optional() }).strict()
  .refine((response) => Object.hasOwn(response, 'result') !== (response.error !== undefined));
const submissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), operationId: z.uuid(), eventId: z.string().min(1).max(128).optional(), acceptedSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), queuedMessageCount: z.number().int().positive().optional() }).strict(),
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
type PendingToolHistory = { history: ToolActivityTurnState; version: OutputVersion };

export class ConversationIpcClient {
  private socket: Socket | undefined;
  private requests = new Map<string, Request>();
  private listeners = new Set<() => void>();
  private outputs = new Set<(output: Output) => void>();
  private activity: Extract<Output, { kind: 'activity' }> | undefined;
  private pendingActivity: Extract<Output, { kind: 'activity' }> | undefined;
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
  private toolHistorySequence = -1;
  private currentStateSequence = -1;
  private pendingToolHistories = new Map<string, PendingToolHistory>();
  private toolTurnBoundary: { operationId: string; generation: number | undefined; stateSequence: number } | undefined;
  private view: ConversationClientSnapshot = { connection: 'connecting', readStatus: 'reading', state: null, items: [], error: null };

  constructor(private readonly assignment: ConversationAssignment, private readonly agentOverrides?: AssistantCliOverrides,
    private readonly options?: { port: ConversationPort<ConversationAssignment>; reconnect: boolean }) {}

  getSnapshot = (): ConversationClientSnapshot => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onOutput(listener: (output: Output) => void): () => void {
    this.outputs.add(listener);
    if (this.view.connection === 'connected' && this.activity !== undefined) listener(this.activity);
    return () => { this.outputs.delete(listener); };
  }

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
    const previousConnection = this.view.connection;
    this.view = { ...this.view, ...change };
    const running = this.view.state?.running;
    const tools = this.committedItems.get('tool_history');
    if (running != null && tools?.kind === 'tool_history'
      && (tools.history.operationId !== running.operationId || tools.history.generation !== running.generation)) {
      this.committedItems.delete('tool_history');
      this.items.delete('tool_history');
      this.readItems.delete('tool_history');
      this.view = { ...this.view, items: orderSnapshotItems(this.items) };
    }
    if (this.view.connection === 'disconnected' || running?.operationId !== this.activity?.operationId
      || running?.generation !== this.activity?.generation) this.activity = undefined;
    let activityResumed = false;
    if (this.view.connection === 'disconnected' || change.state === null || change.state?.running === null) {
      this.pendingActivity = undefined;
    } else if (this.pendingActivity !== undefined && running?.operationId === this.pendingActivity.operationId
      && running.generation === this.pendingActivity.generation) {
      this.activity = this.pendingActivity;
      this.pendingActivity = undefined;
      activityResumed = true;
    }
    this.applyPendingToolHistories();
    for (const listener of this.listeners) listener();
    if ((previousConnection !== 'connected' || activityResumed) && this.view.connection === 'connected' && this.activity !== undefined) {
      for (const listener of this.outputs) listener(this.activity);
    }
  }

  private isPreviousToolTurn(history: ToolActivityTurnState, version: OutputVersion): boolean {
    const boundary = this.toolTurnBoundary;
    return boundary !== undefined && version.stateSequence < boundary.stateSequence
      && (history.operationId !== boundary.operationId || history.generation !== boundary.generation);
  }

  private acceptToolHistory(history: ToolActivityTurnState, version: OutputVersion, live: boolean): boolean {
    if (this.isPreviousToolTurn(history, version)) return false;
    const running = this.view.state?.running;
    const matchesRunning = running != null && history.operationId === running.operationId
      && history.generation === running.generation;
    if (live && version.stateSequence > this.currentStateSequence && !matchesRunning) {
      const key = JSON.stringify([history.operationId, history.generation]);
      const previous = this.pendingToolHistories.get(key);
      if (previous === undefined || history.history.sequence >= previous.history.history.sequence) {
        this.pendingToolHistories.set(key, { history, version });
      }
      return false;
    }
    if (running != null && (history.operationId !== running.operationId || history.generation !== running.generation)) return false;
    const previous = this.committedItems.get('tool_history');
    const current = previous?.kind === 'tool_history' ? previous.history : undefined;
    const sameTurn = current?.operationId === history.operationId && current.generation === history.generation;
    if (!sameTurn && version.stateSequence < this.toolHistorySequence) return false;
    if (current !== undefined) {
      if (current.operationId === history.operationId && history.generation < current.generation
        || sameTurn && (history.history.sequence < current.history.sequence || current.finished && !history.finished)) return false;
    }
    if (live) {
      this.toolHistorySequence = Math.max(this.toolHistorySequence, version.stateSequence);
      this.removed.delete('tool_history');
    }
    if (current !== undefined && JSON.stringify(history) === JSON.stringify(current)) return false;
    const item = { kind: 'tool_history' as const, history };
    if (live) {
      this.committedItems.set('tool_history', item);
      this.items.set('tool_history', item);
    }
    this.readItems.set('tool_history', item);
    return true;
  }

  private applyPendingToolHistories(): void {
    const running = this.view.state?.running;
    let changed = false;
    for (const [key, pending] of this.pendingToolHistories) {
      const matchesRunning = running != null && pending.history.operationId === running.operationId
        && pending.history.generation === running.generation;
      const finishedWithoutRunning = running == null && pending.history.finished;
      if ((matchesRunning || finishedWithoutRunning) && this.acceptToolHistory(pending.history, pending.version, true)) {
        changed = true;
        this.pendingToolHistories.delete(key);
        for (const listener of this.outputs) listener({ kind: 'tool_history', history: pending.history });
      } else if (this.isPreviousToolTurn(pending.history, pending.version)
        || pending.version.stateSequence <= this.currentStateSequence) {
        this.pendingToolHistories.delete(key);
      }
    }
    if (changed) this.view = { ...this.view, items: orderSnapshotItems(this.items) };
  }

  private async open(): Promise<void> {
    this.update({ connection: 'connecting', readStatus: 'reading' });
    const configDirectory = await resolveDaemonConfigDirectory(getGlobalConfigDir());
    const port = this.options?.port ?? createTuiConversationPort(configDirectory, { deliver: async () => ({ kind: 'unavailable', reason: 'IPC delivery only' }) });
    const selected = this.options?.port !== undefined || this.assignment.kind === 'daemon' ? this.assignment
      : await resolveCurrentManagerAssignment(this.assignment.kind === 'repository'
        ? { kind: 'repository', repositoryDirectory: await resolveGitRepositoryDirectory(this.assignment.repositoryDirectory) }
        : this.assignment, configDirectory);
    const resolved = await port.resolve(selected);
    if (this.closed) return;
    if (this.resolved?.conversationId !== resolved.conversationId) {
      this.committedItems.clear();
      this.items.clear();
      this.update({ state: null, items: [] });
      this.receiver = new ConversationTransferReceiver(resolved.conversationId, {
        state: (next, version) => {
          this.currentStateSequence = Math.max(this.currentStateSequence, version.stateSequence);
          const running = next.running;
          if (running !== null) {
            this.toolTurnBoundary = { operationId: running.operationId, generation: running.generation, stateSequence: version.stateSequence };
            const staged = this.readItems.get('tool_history');
            if (staged?.kind === 'tool_history'
              && (staged.history.operationId !== running.operationId || staged.history.generation !== running.generation)) this.readItems.delete('tool_history');
          }
          this.update({ state: next });
        },
        item: (item, _transferId, version) => {
          if (item.kind === 'tool_history') {
            if (!this.acceptToolHistory(item.history, version, false)) {
              const current = this.committedItems.get('tool_history');
              if (current !== undefined) this.readItems.set('tool_history', current);
            }
            return;
          }
          const key = snapshotItemKey(item);
          this.readItems.set(key, item);
          this.items.set(key, item);
        },
        remove: (key, _transferId, version) => {
          if (key !== 'tool_history' || this.toolHistorySequence <= version.stateSequence) this.removed.add(key);
        },
        output: (output, version) => {
          if (output.kind === 'tool_history') {
            if (!this.acceptToolHistory(output.history, version, true)) return;
            this.update({ items: orderSnapshotItems(this.committedItems) });
          }
          if (output.kind === 'activity') {
            const running = this.view.state?.running;
            if (running?.operationId !== output.operationId || running.generation !== output.generation) {
              this.pendingActivity = output;
              return;
            }
            this.activity = output;
            if (this.view.connection !== 'connected') return;
          } else if (output.kind === 'result') {
            if (output.operationId === this.activity?.operationId) this.activity = undefined;
            if (output.operationId === this.pendingActivity?.operationId) this.pendingActivity = undefined;
          }
          for (const listener of this.outputs) listener(output);
        },
        read: (readStatus, transferId, mode, version) => {
          if (readStatus === 'reading') {
            this.readItems.clear();
            this.removed.clear();
            this.items = new Map(this.committedItems);
            this.read ??= {};
            this.read.transferId = transferId;
          } else if (this.read?.transferId === transferId) {
            if (readStatus === 'complete') {
              const next = mode === 'initial' ? new Map<string, SnapshotDisplayItem>() : new Map(this.committedItems);
              for (const [key, item] of this.readItems) {
                if (item.kind === 'tool_history' && this.isPreviousToolTurn(item.history, version)) continue;
                next.set(key, item);
              }
              for (const key of this.removed) next.delete(key);
              const history = this.committedItems.get('tool_history');
              if (history !== undefined && this.toolHistorySequence > version.stateSequence) next.set('tool_history', history);
              this.toolHistorySequence = Math.max(this.toolHistorySequence, version.stateSequence);
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
    const socket = await ensureDaemon({ retainConnection: true });
    if (this.closed) { socket.destroy(); return; }
    this.socket = socket;
    if (socket.destroyed) throw new Error('Daemon disconnected before opening conversation');
    const decoder = new ConversationFrameDecoder();
    this.toolHistorySequence = -1;
    this.currentStateSequence = -1;
    this.pendingToolHistories.clear();
    this.toolTurnBoundary = undefined;
    this.receiver!.authenticated();
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
            this.receiver!.receive(value);
          }
        }
      } catch (error) { this.disconnect(error instanceof Error ? error : new Error('Invalid IPC response')); socket.destroy(); }
    });
    socket.on('error', (error) => { if (this.socket === socket) this.disconnect(error); });
    socket.once('close', () => { if (this.socket === socket) this.disconnect(new Error('Daemon disconnected')); });
    socket.resume();
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
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
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
