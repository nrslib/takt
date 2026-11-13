import { randomUUID } from 'node:crypto';
import type { AcceptedEvent, Admission, ControlEvent, ControlReceipt, EventInput } from '../../core/daemon/events.js';
import type { ConversationSnapshot, RuntimeMessage, TurnIdentity, TurnOutcome, TurnResult } from '../../core/daemon/messages.js';
import type {
  ConversationOwner, DaemonBus, DaemonIngress, DaemonResources, DispatchFailure,
  DaemonStateOwner, EventStore, StoredEvent, TurnRunner,
} from '../../core/daemon/ports.js';
import type { DaemonStateRequest, DaemonStateReply } from '../../core/daemon/processProtocol.js';
import { MAX_PROCESS_PENDING_PROGRESS } from '../../core/daemon/processProtocol.js';
import { effect, reply, type DispatcherEffect, type DispatcherNotice, type Reply } from './dispatcherMailbox.js';
import { createTurnQueues } from './turnQueues.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { isToolHistoryProgress, type ConversationProgress } from '../../shared/types/conversation-activity.js';
import { ToolHistoryPersistenceError } from '../../core/daemon/toolHistoryPersistenceError.js';
import { DroppedToolOutputs } from '../../shared/tool-activity/droppedOutputs.js';

export interface DispatcherDependencies {
  store: EventStore;
  conversations: ConversationOwner;
  runner: TurnRunner;
  stateRequests: DaemonStateOwner;
  resources: DaemonResources;
  limits: { maxPendingEvents: number; maxPendingBytes: number };
  onFailure(failure: DispatchFailure): void;
}

interface PendingAdmission {
  event: AcceptedEvent;
  reply: Reply<Admission>;
  phase: 'saving' | 'accepted';
}

interface ActiveTurn {
  event: AcceptedEvent;
  turn: TurnIdentity;
  abort: AbortController;
  requestAbort: AbortController;
  interruption: 'requested' | 'shutdown' | 'restart' | undefined;
  launchPending: boolean;
  requests: Map<number, Reply<DaemonStateReply>>;
  progress: Map<number, { reply: Reply<void>; message: ConversationProgress; ordered: boolean }>;
  droppedOutputs: DroppedToolOutputs;
  phase: 'starting' | 'reading' | 'running' | 'settling';
  result?: TurnResult;
  save: 'waiting' | 'saving' | 'failed';
  saveAttempt: number;
  finishReply?: Reply<void>;
  historyFailure?: ToolHistoryPersistenceError;
}

interface Shutdown {
  reply: Reply<ControlReceipt>;
  phase: 'runner' | 'draining' | 'replies' | 'resources' | 'closed';
  errors: unknown[];
}

/** 実 adapter の生成・結線は runDaemon 側で行う。 */
export async function createDaemonDispatcher(dependencies: DispatcherDependencies): Promise<DaemonDispatcher> {
  const dispatcher = new DaemonDispatcher(dependencies);
  const restored = await dependencies.store.restore();
  await dispatcher.restore(restored.lastAcceptedSequence, restored.pending);
  return dispatcher;
}

export class DaemonDispatcher implements DaemonIngress, DaemonBus {
  get activeTurnCount(): number { return this.active.size; }
  get hasPendingEvents(): boolean { return this.eventAdmissions.size > 0; }
  hasPendingPatrol(conversationId: string): boolean {
    return this.queues.pending(conversationId).some(({ event }) => event.kind === 'patrol');
  }
  private readonly queues = createTurnQueues();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly admissions = new Map<string, PendingAdmission>();
  private readonly eventAdmissions = new Map<string, PendingAdmission>();
  private readonly idleReplies: Reply<void>[] = [];
  private readonly deferredRetries: Reply<void>[] = [];
  private readonly ancillaryEffects = new Set<number>();
  private readonly effectErrors: unknown[] = [];
  private sequence = 0;
  private generation = 0;
  private nextId = 0;
  private restoring = true;
  private shutdown?: Shutdown;
  private readonly mailbox: DispatcherNotice[] = [];
  private processing = false;

  constructor(private readonly dependencies: DispatcherDependencies) {
    const { maxPendingEvents, maxPendingBytes } = dependencies.limits;
    if (!Number.isSafeInteger(maxPendingEvents) || maxPendingEvents <= 0
      || !Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) throw new Error('Invalid dispatcher capacity');
  }

  async restore(lastSequence: number, pending: AsyncIterable<StoredEvent>): Promise<void> {
    this.send({ kind: 'restore_sequence', sequence: lastSequence });
    for await (const stored of pending) this.send({ kind: 'restore_event', stored });
    const response = reply<void>();
    this.send({ kind: 'restore_complete', reply: response });
    return response.promise;
  }

  accept(input: EventInput): Promise<Admission> {
    const response = { reply: reply<Admission>() };
    this.send({ kind: 'accept', input, operationId: randomUUID(), response });
    return response.reply.promise;
  }

  post(message: RuntimeMessage): Promise<void> {
    const response = reply<void>();
    this.send({ kind: 'runtime', message, reply: response });
    return response.promise;
  }

  request(turn: TurnIdentity, request: DaemonStateRequest, signal: AbortSignal): Promise<DaemonStateReply> {
    const response = reply<DaemonStateReply>();
    this.send({ kind: 'request', turn, request, signal, reply: response });
    return response.promise;
  }

  snapshot(conversationId: string): Promise<ConversationSnapshot> {
    const response = reply<ConversationSnapshot>();
    this.send({ kind: 'snapshot', conversationId, reply: response });
    return response.promise;
  }

  inquiry(notice: import('../../core/daemon/messages.js').InquiryNotice): Promise<void> {
    return this.dependencies.conversations.inquiry(notice);
  }

  control(event: ControlEvent): Promise<ControlReceipt> {
    const response = { reply: reply<ControlReceipt>() };
    this.send({ kind: 'control', event, response });
    return response.reply.promise;
  }

  /** 組立側が保存の回復を通知する。モデルの再試行には使わない。 */
  retryStorage(): Promise<void> {
    const response = reply<void>();
    this.send({ kind: 'retry_storage', reply: response });
    return response.promise;
  }

  /** 受付・状態読取・保存だけを待ち、実行中 provider の完了は待たない。 */
  drain(): Promise<void> {
    const response = reply<void>();
    this.send({ kind: 'drain', reply: response });
    return response.promise;
  }

  private send(notice: DispatcherNotice): void {
    this.mailbox.push(notice);
    if (this.processing) return;
    this.processing = true;
    const effects: DispatcherEffect[] = [];
    try {
      while (this.mailbox.length > 0) {
        const next = this.mailbox.shift()!;
        effects.push(...this.reduce(next));
      }
    } finally { this.processing = false; }
    // 外部呼出しによる再入は、同期の状態遷移が終わってから受け付ける。
    for (const run of effects) void run().then((completed) => this.send(completed));
  }

  /** この関数と、ここから同期的に呼ぶ関数だけが dispatcher の状態を変更する。 */
  private reduce(notice: DispatcherNotice): DispatcherEffect[] {
    const effects: DispatcherEffect[] = [];
    switch (notice.kind) {
      case 'restore_sequence': this.sequence = notice.sequence; break;
      case 'restore_event': this.restoreEvent(notice.stored, effects); break;
      case 'restore_complete': this.restoring = false; notice.reply.resolve(); break;
      case 'accept': this.admit(notice, effects); break;
      case 'admission_saved': this.admissionSaved(notice, effects); break;
      case 'start_saved':
      case 'turn_state_read':
      case 'process_started': this.startCompleted(notice, effects); break;
      case 'runtime': this.runtime(notice, effects); break;
      case 'progress_delivered': {
        const active = this.current(notice.turn);
        const response = active?.progress.get(notice.id);
        if (active === undefined || response === undefined) break;
        active.progress.delete(notice.id);
        if (!notice.result.ok) {
          if (notice.result.error instanceof ToolHistoryPersistenceError) active.historyFailure ??= notice.result.error;
          this.failure('progress', active.event, notice.result.error, effects);
        }
        response.reply.resolve();
        if (response.ordered) {
          const next = [...active.progress.entries()].find(([, pending]) => pending.ordered);
          if (next !== undefined) this.deliverProgress(active, effects, next[0]);
        }
        break;
      }
      case 'request': this.handleRequest(notice, effects); break;
      case 'request_completed': {
        const active = this.current(notice.turn);
        const response = active?.requests.get(notice.id);
        if (active === undefined || response === undefined) break;
        active.requests.delete(notice.id);
        if (notice.result.ok) response.resolve(notice.result.value);
        else response.reject(notice.result.error);
        break;
      }
      case 'result_saved':
      case 'result_applied':
      case 'result_settled':
      case 'result_committed': this.resultCompleted(notice, effects); break;
      case 'snapshot': {
        const { conversationId, reply: response } = notice;
        const id = ++this.nextId;
        this.ancillaryEffects.add(id);
        effects.push(effect(() => this.dependencies.conversations.snapshot(conversationId),
          (result) => ({ kind: 'snapshot_read', id, conversationId, reply: response, result })));
        break;
      }
      case 'snapshot_read': {
        this.ancillaryEffects.delete(notice.id);
        if (!notice.result.ok) notice.reply.reject(notice.result.error);
        else {
          const active = this.active.get(notice.conversationId);
          const running = active?.phase === 'settling' ? undefined : active;
          notice.reply.resolve({ ...notice.result.value, operationId: running?.turn.operationId ?? null, generation: running?.turn.generation ?? null,
            queuedMessageCount: this.queues.pending(notice.conversationId).filter((event) => event.lane === 'human' && event.operationId !== active?.turn.operationId).length });
        }
        break;
      }
      case 'control': this.handleControl(notice, effects); break;
      case 'runner_closed':
        if (this.shutdown?.phase === 'runner') {
          if (!notice.result.ok) this.shutdown.errors.push(notice.result.error);
          this.shutdown.phase = 'draining';
        }
        break;
      case 'shutdown_drained':
        if (this.shutdown?.phase === 'replies') {
          if (this.busy()) { this.shutdown.phase = 'draining'; break; }
          if (this.active.size > 0) this.shutdown.errors.push(new Error('Unsettled turns remain at shutdown'));
          this.shutdown.errors.push(...this.effectErrors.splice(0));
          this.shutdown.phase = 'resources';
          effects.push(effect(() => this.dependencies.resources.close(), (result) => ({ kind: 'resources_closed', result })));
        }
        break;
      case 'resources_closed':
        if (this.shutdown?.phase === 'resources') {
          const stop = this.shutdown;
          if (!notice.result.ok) stop.errors.push(notice.result.error);
          stop.phase = 'closed';
          if (stop.errors.length > 0) stop.reply.reject(new AggregateError(stop.errors, 'Daemon shutdown failed'));
          else stop.reply.resolve({ kind: 'stopped' });
          for (const response of this.deferredRetries.splice(0)) this.retry(response);
        }
        break;
      case 'retry_storage':
        if (this.shutdown?.phase === 'replies' || this.shutdown?.phase === 'resources') this.deferredRetries.push(notice.reply);
        else this.retry(notice.reply);
        break;
      case 'drain': this.idleReplies.push(notice.reply); break;
      case 'effect_completed':
        this.ancillaryEffects.delete(notice.id);
        if (!notice.result.ok) {
          if (this.shutdown !== undefined && this.shutdown.phase !== 'closed') this.shutdown.errors.push(notice.result.error);
          else this.effectErrors.push(notice.result.error);
        }
        break;
    }
    for (const active of this.active.values()) this.beginSettlement(active, effects);
    this.schedule(effects);
    this.advanceShutdown(effects);
    if (!this.busy() && this.idleReplies.length > 0) {
      const errors = this.effectErrors.splice(0);
      for (const response of this.idleReplies.splice(0)) {
        if (errors.length > 0) response.reject(new AggregateError(errors, 'Dispatcher effects failed'));
        else response.resolve();
      }
    }
    return effects;
  }

  private receipt(event: AcceptedEvent): Extract<Admission, { kind: 'accepted' }> {
    const active = this.active.get(event.conversationId);
    const count = this.queues.pending(event.conversationId).filter((pending) => pending.lane === 'human'
      && (active === undefined ? pending.acceptedSequence < event.acceptedSequence
        : pending.operationId !== active.turn.operationId && pending.acceptedSequence <= event.acceptedSequence)).length;
    return { kind: 'accepted', eventId: event.eventId, operationId: event.operationId, acceptedSequence: event.acceptedSequence,
      ...(count === 0 ? {} : { queuedMessageCount: count }) };
  }

  private requestKey(input: EventInput): string { return JSON.stringify([input.conversationId, input.requestId]); }

  private current(turn: TurnIdentity): ActiveTurn | undefined {
    const active = this.active.get(turn.conversationId);
    return active?.turn.operationId === turn.operationId && active.turn.generation === turn.generation ? active : undefined;
  }

  private indexAdmission(admission: PendingAdmission): void {
    this.admissions.set(this.requestKey(admission.event), admission);
    this.eventAdmissions.set(admission.event.eventId, admission);
  }

  private forgetAdmission(event: AcceptedEvent): void {
    this.admissions.delete(this.requestKey(event));
    this.eventAdmissions.delete(event.eventId);
  }

  private restoreEvent(stored: StoredEvent, effects: DispatcherEffect[]): void {
    const { event } = stored;
    this.queues.add(event);
    this.queues.confirm(event.eventId);
    const response = reply<Admission>();
    response.resolve(this.receipt(event));
    this.indexAdmission({ event, reply: response, phase: 'accepted' });
    if (stored.state === 'queued') return;
    const turn = stored.state === 'running' ? stored.turn : stored.result;
    this.generation = Math.max(this.generation, turn.generation);
    this.queues.markStarted(event.eventId);
    const active = this.newTurn(event, turn);
    active.interruption = 'restart';
    this.active.set(event.conversationId, active);
    this.finish(active, stored.state === 'settling' ? stored.result.outcome : { kind: 'interrupted' }, effects,
      stored.state === 'settling');
  }

  private admit(notice: Extract<DispatcherNotice, { kind: 'accept' }>, effects: DispatcherEffect[]): void {
    const { input, response } = notice;
    if (this.shutdown !== undefined) { response.reply.resolve({ kind: 'rejected', reason: 'stopping' }); return; }
    const duplicate = this.admissions.get(this.requestKey(input)) ?? this.eventAdmissions.get(input.eventId);
    if (duplicate !== undefined) { response.reply = duplicate.reply; return; }
    const event: AcceptedEvent = {
      ...input, operationId: notice.operationId, acceptedSequence: ++this.sequence,
      lane: input.event.kind === 'human_command' || input.event.kind === 'inquiry_answer' ? 'human' : 'other',
    };
    const pending = this.queues.pending(input.conversationId);
    if (pending.length >= this.dependencies.limits.maxPendingEvents
      || Buffer.byteLength(JSON.stringify([...pending, event])) > this.dependencies.limits.maxPendingBytes) {
      response.reply.resolve({ kind: 'rejected', reason: 'capacity' });
      return;
    }
    this.queues.add(event);
    const admission: PendingAdmission = { event, reply: response.reply, phase: 'saving' };
    this.indexAdmission(admission);
    effects.push(effect(() => this.dependencies.store.accept(event), (result) => ({ kind: 'admission_saved', event, result })));
  }

  private admissionSaved(notice: Extract<DispatcherNotice, { kind: 'admission_saved' }>, effects: DispatcherEffect[]): void {
    const admission = this.eventAdmissions.get(notice.event.eventId);
    if (admission === undefined || admission.event.operationId !== notice.event.operationId
      || admission.phase !== 'saving') return;
    if (!notice.result.ok) {
      this.queues.remove(admission.event.eventId);
      this.forgetAdmission(admission.event);
      admission.reply.resolve({ kind: 'rejected', reason: 'storage' });
      this.failure('accept', admission.event, notice.result.error, effects);
      if (this.shutdown !== undefined) this.shutdown.errors.push(notice.result.error);
      return;
    }
    const saved = notice.result.value;
    admission.phase = 'accepted';
    if (saved.kind === 'stored') this.queues.confirm(admission.event.eventId);
    else {
      this.queues.remove(admission.event.eventId);
      this.forgetAdmission(admission.event);
      this.sequence = Math.max(this.sequence, saved.event.acceptedSequence);
      const canonical = this.eventAdmissions.get(saved.event.eventId);
      if (canonical === undefined && saved.state === 'queued') {
        admission.event = saved.event;
        this.queues.add(saved.event);
        this.queues.confirm(saved.event.eventId);
        this.indexAdmission(admission);
      }
    }
    const accepted = saved.kind === 'stored' ? admission.event : saved.event;
    if (accepted.lane === 'human' && (saved.kind === 'stored' || saved.state === 'queued')) {
      const active = this.active.get(accepted.conversationId);
      if (active?.event.event.kind === 'patrol' && active.phase !== 'settling') this.interrupt(active, 'requested', effects);
    }
    const observed = accepted.event;
    if (observed.kind === 'watch_observation' && observed.observation.kind === 'director_state_changed' && observed.observation.goalId !== null) {
      this.queues.resumeGoal({ repositoryDirectory: observed.observation.repositoryDirectory, goalId: observed.observation.goalId });
    }
    admission.reply.resolve(this.receipt(accepted));
  }

  private newTurn(event: AcceptedEvent, turn: TurnIdentity): ActiveTurn {
    return { event, turn, abort: new AbortController(), requestAbort: new AbortController(), interruption: undefined, launchPending: false,
      requests: new Map(), progress: new Map(), droppedOutputs: new DroppedToolOutputs(), phase: 'starting', save: 'waiting', saveAttempt: 0 };
  }

  private schedule(effects: DispatcherEffect[]): void {
    if (this.shutdown !== undefined || this.restoring) return;
    while (true) {
      const event = this.queues.peekNext((id) => !this.active.has(id));
      if (event === undefined) return;
      const turn = { conversationId: event.conversationId, operationId: event.operationId, generation: ++this.generation };
      this.active.set(event.conversationId, this.newTurn(event, turn));
      this.queues.markStarted(event.eventId);
      effects.push(effect(() => this.dependencies.store.markStarted(event.eventId, turn), (result) => ({ kind: 'start_saved', turn, result })));
    }
  }

  private startCompleted(notice: Extract<DispatcherNotice, { kind: 'start_saved' | 'turn_state_read' | 'process_started' }>, effects: DispatcherEffect[]): void {
    const active = this.current(notice.turn);
    if (active !== undefined && notice.kind === 'process_started') active.launchPending = false;
    const phase = notice.kind === 'start_saved' ? 'starting' : notice.kind === 'turn_state_read' ? 'reading' : 'running';
    if (active === undefined || active.phase !== phase) return;
    const { event, turn, abort } = active;
    if (notice.kind === 'start_saved' && !notice.result.ok) {
      this.failure('start', event, notice.result.error, effects);
      this.finish(active, active.interruption !== undefined ? { kind: 'interrupted' }
        : { kind: 'failed', message: 'Turn start could not be saved' }, effects);
      return;
    }
    if (notice.kind !== 'process_started' && active.interruption !== undefined) { this.finish(active, { kind: 'interrupted' }, effects); return; }
    if (!notice.result.ok) {
      this.finish(active, active.interruption !== undefined ? { kind: 'interrupted' }
        : { kind: 'failed', message: notice.result.error instanceof Error ? notice.result.error.message : String(notice.result.error) }, effects);
      return;
    }
    if (notice.kind === 'start_saved') {
      active.phase = 'reading';
      effects.push(effect(async () => {
        const snapshot = await this.dependencies.conversations.snapshot(event.conversationId);
        try { return snapshot.turnState; } finally { snapshot.cancel(); }
      }, (result) => ({ kind: 'turn_state_read', turn, result })));
    } else if (notice.kind === 'turn_state_read') {
      active.phase = 'running';
      active.launchPending = true;
      const state = notice.result.value;
      effects.push(effect(() => this.dependencies.runner.start({ event, turn, state }, abort.signal), (result) => ({ kind: 'process_started', turn, result })));
    }
  }

  private runtime(notice: Extract<DispatcherNotice, { kind: 'runtime' }>, effects: DispatcherEffect[]): void {
    const { message, reply: response } = notice;
    const active = this.current(message.turn);
    if (active === undefined || active.phase !== 'running') { response.resolve(); return; }
    if (message.kind === 'turn_finished') {
      const outcome = active.interruption !== undefined && message.outcome.kind !== 'interrupted' ? { kind: 'interrupted' as const } : message.outcome;
      active.finishReply = response;
      this.finish(active, outcome, effects);
    } else if (active.interruption !== undefined || active.event.event.kind === 'patrol'
      && (typeof message.message === 'string' || message.message.kind === 'turn_text')) {
      // 見回りは完了結果だけを表示し、後から中断したターンの途中結果を残さない。
      response.resolve();
    } else {
      const id = ++this.nextId;
      const waiting = [...active.progress.values()].some((pending) => pending.ordered);
      const progress = message.message;
      const ordered = waiting || typeof progress !== 'string' && (progress.kind === 'turn_text' || progress.kind === 'tool_event');
      // 配送が詰まっている間は途中表示だけを間引き、ターンも子プロセスも止めない。ツールの開始・完了は常に受け付ける。
      const afterDropped = active.droppedOutputs.follows(progress);
      if (afterDropped || ordered && !isToolHistoryProgress(progress)
        && [...active.progress.values()].filter((pending) => !isToolHistoryProgress(pending.message)).length >= MAX_PROCESS_PENDING_PROGRESS) {
        active.droppedOutputs.record(progress);
        response.resolve();
        return;
      }
      active.progress.set(id, { reply: response, message: progress, ordered });
      if (!waiting) this.deliverProgress(active, effects, id);
    }
  }

  private deliverProgress(active: ActiveTurn, effects: DispatcherEffect[], id: number): void {
    const { message } = active.progress.get(id)!;
    const { turn, abort } = active;
    effects.push(effect(async () => {
      if (!abort.signal.aborted) await this.dependencies.conversations.progress(turn, message, abort.signal);
    }, (result) => ({ kind: 'progress_delivered', turn, id, result })));
  }

  private handleRequest(notice: Extract<DispatcherNotice, { kind: 'request' }>, effects: DispatcherEffect[]): void {
    const { turn, request, signal, reply: response } = notice;
    if (this.shutdown !== undefined) { response.resolve({ kind: 'error', code: 'stopping', message: 'Daemon is stopping' }); return; }
    const active = this.current(turn);
    if (active === undefined || active.phase !== 'running' || active.interruption !== undefined) {
      response.resolve({ kind: 'error', code: 'stale_turn', message: 'Turn is no longer active' });
      return;
    }
    if (signal.aborted) { response.reject(signal.reason); return; }
    const id = ++this.nextId;
    active.requests.set(id, response);
    const requestSignal = AbortSignal.any([signal, active.abort.signal, active.requestAbort.signal]);
    effects.push(effect(() => this.dependencies.stateRequests.handle(turn, request, requestSignal), (result) => ({ kind: 'request_completed', turn, id, result })));
  }

  private finish(active: ActiveTurn, outcome: TurnOutcome, effects: DispatcherEffect[], preserveOutcome = false): void {
    const event = active.event.event;
    if (!preserveOutcome && outcome.kind === 'interrupted' && active.event.lane === 'other'
      && (active.interruption === 'shutdown' || active.interruption === 'restart')) {
      outcome = { kind: 'deferred' };
    }
    if (!preserveOutcome && outcome.kind === 'interrupted' && outcome.change?.interruptedMessage === undefined
      && event.kind === 'human_command' && event.command.kind === 'message'
      && (event.command.text.trim() !== '/verify' || active.turn.conversationId === conversationId({ kind: 'daemon' }))) {
      outcome = { ...outcome, change: {
        // 子の変更結果がなくても、保存時に最新の版へ載せ直す本文だけの変更を確定する。
        operationId: active.turn.operationId, expectedVersion: 0, ...outcome.change,
        interruptedMessage: event.command.text,
      } };
    }
    active.phase = 'settling';
    active.result = { ...active.turn, event: active.event, outcome };
    const { requestAbort } = active;
    this.ancillary(() => requestAbort.abort(), effects);
  }

  private beginSettlement(active: ActiveTurn, effects: DispatcherEffect[]): void {
    if (active.phase !== 'settling' || active.save !== 'waiting' || active.requests.size > 0 || active.progress.size > 0) return;
    if (active.result === undefined) throw new Error('Missing turn result');
    if (active.result.outcome.kind === 'completed' && active.historyFailure !== undefined) {
      active.result = { ...active.result, outcome: { kind: 'failed', message: active.historyFailure.message,
        ...(active.result.outcome.change === undefined ? {} : { change: active.result.outcome.change }) } };
    }
    const result = active.result;
    active.save = 'saving';
    const attempt = ++active.saveAttempt;
    const { turn, event } = active;
    effects.push(effect(async () => {
      // 開始保存の応答が失われても、同じ世代を確定してから失敗結果を保存する。
      await this.dependencies.store.markStarted(event.eventId, turn);
      await this.dependencies.store.saveResult(event.eventId, result);
    }, (completion) => ({ kind: 'result_saved', turn, attempt, result: completion })));
  }

  private resultCompleted(notice: Extract<DispatcherNotice, { kind: 'result_saved' | 'result_applied' | 'result_settled' | 'result_committed' }>, effects: DispatcherEffect[]): void {
    const active = this.current(notice.turn);
    if (active === undefined || active.phase !== 'settling' || active.save !== 'saving' || active.saveAttempt !== notice.attempt) return;
    if (!notice.result.ok) {
      active.save = 'failed';
      active.finishReply?.resolve();
      active.finishReply = undefined;
      this.failure('settle', active.event, notice.result.error, effects);
      return;
    }
    const { turn, event } = active;
    const result = active.result!;
    const { attempt } = notice;
    switch (notice.kind) {
      case 'result_saved':
        effects.push(effect(() => this.dependencies.conversations.apply(result), (completion) => ({ kind: 'result_applied', turn, attempt, result: completion })));
        break;
      case 'result_applied':
        effects.push(effect(() => this.dependencies.store.markSettled(event.eventId, result), (completion) => ({ kind: 'result_settled', turn, attempt, result: completion })));
        break;
      case 'result_settled':
        effects.push(effect(() => this.dependencies.runner.resultCommitted(turn), (completion) => ({ kind: 'result_committed', turn, attempt, result: completion })));
        break;
      case 'result_committed':
        if (result.outcome.kind === 'deferred') {
          // 起動時は queued と同じ順序で戻し、停止中は次の起動まで実行しない。
          if (active.interruption === 'restart') this.queues.confirm(event.eventId);
          else this.queues.defer(event.eventId);
        }
        else {
          this.queues.remove(event.eventId);
          if (event.event.kind === 'goal_resumed') this.queues.resumeGoal(event.event);
          if (event.event.kind === 'human_command' && event.event.command.kind === 'abort_goal') {
            // 中止済みの結果も再読取し、通常の保存経路で終端化する。
            this.queues.resumeGoal({ conversationId: event.conversationId, goalId: event.event.command.goalId });
          }
          this.forgetAdmission(event);
        }
        this.active.delete(event.conversationId);
        active.finishReply?.resolve();
        break;
    }
  }

  private handleControl(notice: Extract<DispatcherNotice, { kind: 'control' }>, effects: DispatcherEffect[]): void {
    const { event, response } = notice;
    if (event.kind === 'stop') {
      if (this.shutdown !== undefined && (this.shutdown.phase !== 'closed' || this.shutdown.errors.length === 0)) {
        response.reply = this.shutdown.reply; return;
      }
      this.shutdown = { reply: response.reply, phase: 'runner', errors: [] };
      for (const active of this.active.values()) if (active.phase !== 'settling') this.interrupt(active, 'shutdown', effects);
      effects.push(effect(() => this.dependencies.runner.close(), (result) => ({ kind: 'runner_closed', result })));
      return;
    }
    const active = this.current(event);
    if (active === undefined || active.phase === 'settling' || active.interruption !== undefined) { response.reply.resolve({ kind: 'ignored' }); return; }
    this.interrupt(active, 'requested', effects);
    response.reply.resolve({ kind: 'interrupted' });
  }

  private interrupt(active: ActiveTurn, reason: 'requested' | 'shutdown', effects: DispatcherEffect[]): void {
    if (active.interruption !== undefined) return;
    active.interruption = reason;
    const { abort, turn, phase } = active;
    this.ancillary(() => {
      abort.abort();
      if (phase === 'running') this.dependencies.runner.interrupt(turn);
    }, effects);
  }

  private failure(phase: DispatchFailure['phase'], event: AcceptedEvent, error: unknown, effects: DispatcherEffect[]): void {
    this.ancillary(() => this.dependencies.onFailure({ phase, event, error }), effects);
  }

  private ancillary(action: () => void, effects: DispatcherEffect[]): void {
    const id = ++this.nextId;
    this.ancillaryEffects.add(id);
    effects.push(effect(action, (result) => ({ kind: 'effect_completed', id, result })));
  }

  private retry(response: Reply<void>): void {
    for (const active of this.active.values()) {
      if (active.phase === 'settling' && active.save === 'failed') active.save = 'waiting';
    }
    this.idleReplies.push(response);
  }

  private busy(): boolean {
    return this.ancillaryEffects.size > 0
      || [...this.eventAdmissions.values()].some((admission) => admission.phase === 'saving')
      || [...this.active.values()].some((active) => active.launchPending || active.phase === 'starting' || active.phase === 'reading'
        || active.phase === 'settling' && active.save !== 'failed' || active.progress.size > 0);
  }

  private advanceShutdown(effects: DispatcherEffect[]): void {
    const stop = this.shutdown;
    if (stop?.phase !== 'draining' || this.busy() || [...this.active.values()].some((active) => active.requests.size > 0)) return;
    stop.phase = 'replies';
    // 解決した accepted/終了の返答を呼出側が受け取ってから、通信を閉じる。
    effects.push(effect(() => undefined, () => ({ kind: 'shutdown_drained' })));
  }
}
