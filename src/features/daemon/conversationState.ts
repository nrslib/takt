import { randomUUID } from 'node:crypto';
import { DaemonEpicFiles } from '../../infra/daemon/epicFiles.js';
import { epicEventId, epicEvents } from './epicEvents.js';
import { join } from 'node:path';
import { eventGoalReference } from '../../core/daemon/events.js';
import { DaemonPersistedFiles } from '../../infra/daemon/persistedFiles.js';
import { globalDaemonConfiguration, readDaemonConfiguration } from './configuration.js';
import type { ConversationTurns, ConversationOwner } from '../../core/daemon/ports.js';
import type { ConversationSnapshot, TurnIdentity, TurnOutcome, TurnResult, TurnStart } from '../../core/daemon/messages.js';
import { ConversationStateStore } from '../../infra/daemon/conversationStateStore.js';
import { DaemonDisplayFiles } from '../../infra/daemon/displayFiles.js';
import { DaemonNotifications } from '../../infra/daemon/notifications.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { ConversationState, OperationResult, OutputVersion, PortOutput, SnapshotItem } from '../manager/conversationPort.js';
import { conversationProjection } from './conversationProjection.js';
import { CLEAR_COMMAND } from '../manager/conversationCommands.js';
import { DaemonRouting } from './routing.js';
import type { ConversationProgress } from '../../shared/types/conversation-activity.js';
import { ToolTurn } from './toolTurn.js';
import type { ToolActivityEntry, ToolActivityTurnState } from '../../shared/tool-activity/types.js';

/** 配送する結果と読取で戻す結果を同じ形にし、再表示がライブ表示と食い違わないようにする。 */
function operationResultOf(outcome: Exclude<TurnOutcome, { kind: 'deferred' }>): OperationResult {
  return outcome.kind === 'completed' ? outcome.result : { kind: 'error', code: outcome.kind, message: outcome.message ?? 'Turn interrupted' };
}

interface RunningTurn {
  readonly state: NonNullable<ConversationState['running']> & { generation: number };
  tools?: ToolTurn;
}

export class DaemonConversations implements ConversationOwner {
  private readonly displayFiles = new DaemonDisplayFiles();
  private readonly sequences = new Map<string, number>();
  private readonly deliveries = new Set<Promise<void>>();
  private readonly interrupted = new Set<string>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly pendingToolWrites = new Map<string, Array<{ turn: TurnIdentity; entry: ToolActivityEntry }>>();

  constructor(readonly store: ConversationStateStore, readonly routing: DaemonRouting,
    readonly notifications: DaemonNotifications,
    private readonly deliver: (id: string, output: PortOutput, version: OutputVersion, signal?: AbortSignal) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly turns: ConversationTurns) {}

  async ensure(assignment: ConversationAssignment): Promise<void> {
    const id = conversationId(assignment);
    if (await this.store.read(id) !== undefined) return;
    await this.store.create({ schemaVersion: 1, id, agent: assignment.kind === 'daemon' ? 'director' : 'manager', assignment,
      counterpart: { namespace: 'local', id: 'operator' }, lastSpeaker: null, provider: 'claude-sdk', model: null, sessionId: null,
      bindings: [], revision: 0, pending: null, approval: null, running: null });
  }

  private version(id: string, revision: number, operationId: string | null): OutputVersion {
    const stateSequence = (this.sequences.get(id) ?? 0) + 1;
    this.sequences.set(id, stateSequence);
    return { revision, stateSequence, operationId };
  }

  private ordered<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const result = previous.then(action);
    // 失敗は呼出側へ返す。後続の読取・保存は失敗した操作の終了後にも実行できる。
    const completed = result.then(() => {}, () => {});
    this.operations.set(id, completed);
    void completed.then(() => {
      if (this.operations.get(id) === completed) this.operations.delete(id);
    });
    return result;
  }

  send(id: string, output: PortOutput, version: OutputVersion): void {
    const pending = this.deliver(id, output, version);
    this.deliveries.add(pending);
    void pending.then(() => { this.deliveries.delete(pending); }, (error: unknown) => {
      this.deliveries.delete(pending); this.onError(error);
    });
  }

  /** 送る read は配送の合図で、port は使わない。受け手ごとの読取は port が dispatcher を通して行う（main と同じ）。 */
  refresh(id: string): Promise<void> {
    return this.ordered(id, async () => {
      const read = await this.captureSnapshot(id, false);
      this.send(id, { kind: 'snapshot', read }, read);
    });
  }

  notification(id: string, notice: Parameters<DaemonNotifications['save']>[0], signal: AbortSignal): Promise<boolean> {
    return this.ordered(id, async () => {
      const saved = await this.notifications.save(notice, signal);
      if (saved) {
        const current = await this.store.read(id);
        // director の通知は、会話が初めて開かれるより先に保存されることもある。
        this.send(id, { kind: 'notice', id: notice.id, message: notice.message }, this.version(id, current?.state.revision ?? 0, notice.turnOperationId ?? null));
      }
      return saved;
    });
  }

  begin(turn: TurnIdentity): Promise<void> {
    return this.ordered(turn.conversationId, async () => {
      this.running.set(turn.conversationId, { state: { operationId: turn.operationId, generation: turn.generation,
        kind: 'turn', startedAt: Date.now() } });
    });
  }

  async started(input: TurnStart): Promise<void> {
    await this.ordered(input.turn.conversationId, async () => {
      const { event, turn, state } = input;
      const running = { operationId: turn.operationId, kind: 'turn', generation: turn.generation, startedAt: Date.now() };
      this.running.set(turn.conversationId, { state: running });
      this.interrupted.delete(turn.conversationId);
      if (event.event.kind === 'human_command' && event.event.command.kind === 'message' && event.event.command.display !== false) {
        this.send(turn.conversationId, { kind: 'user_message', operationId: turn.operationId, message: event.event.command.text },
          this.version(turn.conversationId, state.revision, turn.operationId));
      }
      this.send(turn.conversationId, { kind: 'running', state: { conversationId: turn.conversationId, assignment: state.assignment,
        revision: state.revision, pending: state.pending, approval: state.approval, interrupted: false, running } },
        this.version(turn.conversationId, state.revision, turn.operationId));
    });
  }

  async apply(result: TurnResult): Promise<void> {
    const { current } = await this.ordered(result.conversationId, async () => {
      await this.store.apply(result);
      this.running.delete(result.conversationId);
      const current = await this.store.read(result.conversationId);
      if (current === undefined) throw new Error('Missing result conversation');
      const event = result.event.event;
      if (event.kind === 'epic_verification_result' || event.kind === 'epic_completed') {
        if (current.state.assignment.kind !== 'workspace' || current.state.assignment.workspaceId !== event.workspaceId
          || !await this.routing.permits(current.state.assignment, result.conversationId)) throw new Error('Epic event outside assignment');
        const epic = await new DaemonEpicFiles(this.routing.directory).get(event.workspaceId, event.epicId);
        const id = epicEventId(event);
        if (result.outcome.kind === 'completed' && epicEvents(epic).some((candidate) => candidate.eventId === id)) {
          const run = epic.verificationRuns.find((entry) => entry.id === event.runId)!;
          await this.notifications.save({ id, conversationId: result.conversationId,
            message: `Epic ${epic.id} revision ${event.revision}: ${event.kind === 'epic_completed' ? 'completed' : `verification ${run.result!.outcome}`} (${event.runId})` }, new AbortController().signal);
        }
      }
      if (result.outcome.kind === 'interrupted') this.interrupted.add(result.conversationId);
      else this.interrupted.delete(result.conversationId);
      const outcome = result.outcome;
      this.send(result.conversationId, { kind: 'pending', state: { conversationId: result.conversationId, assignment: current.state.assignment,
        revision: current.state.revision, pending: current.state.pending, approval: current.state.approval, running: null,
        interrupted: outcome.kind === 'interrupted' } }, this.version(result.conversationId, current.state.revision, result.operationId));
      if (outcome.kind !== 'deferred') this.send(result.conversationId, { kind: 'result', operationId: result.operationId,
        result: operationResultOf(outcome) }, this.version(result.conversationId, current.state.revision, result.operationId));
      return { current };
    });
    if (result.outcome.kind === 'failed' && current.state.assignment.kind !== 'daemon') {
      try {
        const reference = eventGoalReference(result.event.event);
        if (reference?.goalId !== undefined && reference.goalId !== null) {
          const assignment = await this.routing.display(current.state.assignment);
          if (!assignment.repositoryDirectories.includes(reference.repositoryDirectory)) throw new Error('Failed turn goal is outside assignment');
          const global = await globalDaemonConfiguration(this.routing.directory);
          const project = await readDaemonConfiguration(join(reference.repositoryDirectory, '.takt', 'config.yaml'));
          if (project.manager?.notifications?.blocked ?? global.manager?.notifications?.blocked ?? true) {
            await new DaemonPersistedFiles(this.routing.directory).saveTurnFailure(reference.repositoryDirectory, reference.goalId,
              result.operationId, result.outcome.message, project.language ?? global.language ?? 'en');
          }
        }
      } catch (error) { this.onError(error); }
    }
    if (result.outcome.kind !== 'deferred' && result.event.event.kind === 'director_message') await this.notifyResult(result);
  }

  async notifyResult(result: TurnResult): Promise<void> {
    const outcome = result.outcome;
    const message = outcome.kind === 'completed' && 'message' in outcome.result ? outcome.result.message
      : outcome.kind === 'failed' ? outcome.message : outcome.kind === 'interrupted' ? 'Manager turn interrupted' : 'Manager operation completed';
    const id = `result-${result.operationId}`;
    await this.notification(conversationId({ kind: 'daemon' }), { id,
      message: `${result.conversationId} (${result.operationId}): ${message}` }, new AbortController().signal);
  }

  async progress(turn: TurnIdentity, message: ConversationProgress, signal: AbortSignal): Promise<void> {
    const { delivery } = await this.ordered(turn.conversationId, async () => {
      const running = this.running.get(turn.conversationId);
      if (signal.aborted || running?.state.operationId !== turn.operationId || running.state.generation !== turn.generation) return { delivery: Promise.resolve() };
      let outputs: PortOutput[];
      if (typeof message !== 'string' && message.kind === 'tool_event') {
        running.tools ??= new ToolTurn(turn);
        outputs = running.tools.apply(message);
        for (const output of outputs) {
          if (output.kind === 'tool_completed') {
            await this.appendCompletedTool(turn, output.entry);
          }
        }
      } else if (typeof message !== 'string' && message.kind === 'turn_text') {
        outputs = [{ ...message, operationId: turn.operationId, generation: turn.generation }];
      } else {
        running.tools ??= new ToolTurn(turn);
        outputs = [typeof message === 'string' ? { kind: 'progress', operationId: turn.operationId, message }
          : { kind: 'activity', operationId: turn.operationId, generation: turn.generation, activity: running.tools.maskActivity(message) }];
      }
      const current = await this.store.read(turn.conversationId);
      if (current === undefined) throw new Error('Missing progress conversation');
      // FIFO への投入は同じ区間内で呼ぶ。TUI の配送応答はソケット書込を待たない。
      const delivery = Promise.all(outputs.map((output) => this.deliver(turn.conversationId, output,
        this.version(turn.conversationId, current.state.revision, turn.operationId), signal))).then(() => {});
      return { delivery };
    });
    await delivery;
  }

  async inquiry(notice: import('../../core/daemon/messages.js').InquiryNotice): Promise<void> {
    await this.ordered(notice.conversationId, async () => {
      const current = await this.store.read(notice.conversationId);
      if (current === undefined) throw new Error('Missing inquiry conversation');
      if (notice.question.status !== 'pending' || notice.question.recipient !== 'human') {
        const read = await this.captureSnapshot(notice.conversationId, false);
        this.send(notice.conversationId, { kind: 'snapshot', read }, read);
      } else this.send(notice.conversationId, { kind: 'inquiry', target: notice.target, question: notice.question },
        this.version(notice.conversationId, current.state.revision, null));
    });
  }

  snapshot(id: string, request: { toolHistory: boolean; capture?: (snapshot: ConversationSnapshot) => void }): Promise<ConversationSnapshot> {
    return this.ordered(id, async () => {
      const snapshot = await this.captureSnapshot(id, request.toolHistory);
      request.capture?.(snapshot);
      return snapshot;
    });
  }

  private async appendCompletedTool(turn: TurnIdentity, entry: ToolActivityEntry): Promise<void> {
    let pending = this.pendingToolWrites.get(turn.conversationId);
    if (pending === undefined) { pending = []; this.pendingToolWrites.set(turn.conversationId, pending); }
    pending.push({ turn: { conversationId: turn.conversationId, operationId: turn.operationId, generation: turn.generation }, entry });
    await this.flushPendingToolWrites(turn.conversationId);
  }

  private async flushPendingToolWrites(id: string): Promise<void> {
    const pending = this.pendingToolWrites.get(id);
    if (pending === undefined) return;
    while (pending.length > 0) {
      const record = pending[0]!;
      try { await this.store.appendCompletedTool(record.turn, record.entry); }
      catch (error) { this.onError(error); return; }
      pending.shift();
    }
    this.pendingToolWrites.delete(id);
  }

  private async captureSnapshot(id: string, withTools: boolean): Promise<ConversationSnapshot> {
    const current = await this.store.read(id);
    if (current === undefined) throw new Error('Unknown conversation');
    const turn = this.running.get(id);
    const running = turn === undefined ? null : { ...turn.state };
    const state: ConversationState = { conversationId: id, assignment: current.state.assignment, revision: current.state.revision,
      pending: current.state.pending, approval: current.state.approval, running, interrupted: this.interrupted.has(id) };
    let items: Array<SnapshotItem & { recordedAt?: string }> = [{ kind: 'state', state }];
    if (withTools) {
      const histories = await this.store.readToolHistories(id).catch((error: unknown) => {
        this.onError(error);
        return [];
      });
      const merged = new Map<string, { turn: Omit<ToolActivityTurnState, 'history'>; entries: Map<string, ToolActivityEntry> }>();
      const include = (history: ToolActivityTurnState): void => {
        const key = JSON.stringify([history.operationId, history.generation]);
        const known = merged.get(key) ?? { turn: history, entries: new Map<string, ToolActivityEntry>() };
        known.turn = history;
        for (const entry of history.history.entries) known.entries.set(entry.key, entry);
        merged.set(key, known);
      };
      for (const history of histories) include(history);
      for (const record of this.pendingToolWrites.get(id) ?? []) {
        include({ operationId: record.turn.operationId, generation: record.turn.generation, finished: true, history: { entries: [record.entry] } });
      }
      const currentHistory = turn?.tools?.snapshot();
      if (currentHistory !== undefined) include(currentHistory);
      for (const { turn, entries } of merged.values()) {
        if (entries.size > 0) items.push({ kind: 'tool_history', history: { ...turn, history: { entries: [...entries.values()] } } });
      }
    }
    let projectionError: unknown;
    try {
      if (current.state.assignment.kind !== 'daemon') {
        for await (const item of conversationProjection(this.routing, this.displayFiles, current.state.assignment)) items.push(item);
      } else items.push({ kind: 'assignment', assignment: await this.routing.display(current.state.assignment) });
    } catch (error) { projectionError = error; }
    for await (const notice of this.notifications.iterate()) {
      if ((notice.conversationId ?? conversationId({ kind: 'daemon' })) === id) {
        items.push({ kind: 'display_event', event: { id: notice.id, message: notice.message } });
      }
    }
    if (withTools) {
      const turns = await this.turns.readTurns(id);
      const cleared = turns.filter(({ message, outcome }) => message?.trim() === CLEAR_COMMAND
        && outcome?.kind === 'completed' && outcome.result.kind === 'notice').at(-1);
      for (const { outcome, ...saved } of turns) {
        for (const item of items) {
          if (item.kind === 'tool_history' && item.history.operationId === saved.operationId) item.acceptedSequence = saved.acceptedSequence;
        }
        if (cleared !== undefined && saved.acceptedSequence < cleared.acceptedSequence) continue;
        if (saved.message !== undefined) items.push({ kind: 'user_message', ...saved, message: saved.message });
        if (outcome !== undefined && outcome.kind !== 'deferred') {
          items.push({ kind: 'turn_result', operationId: saved.operationId, acceptedSequence: saved.acceptedSequence, result: operationResultOf(outcome) });
        }
      }
      if (cleared !== undefined) {
        items = items.filter((item) => item.kind !== 'tool_history' || item.acceptedSequence === undefined
          || item.acceptedSequence >= cleared.acceptedSequence);
      }
    }
    const frozen = structuredClone(items);
    const version = this.version(id, current.state.revision, running?.operationId ?? null);
    return { ...version, transferId: randomUUID(), conversationId: id, mode: 'initial', turnState: structuredClone(current.state),
      generation: running?.generation ?? null,
      items: { async *[Symbol.asyncIterator]() { yield* frozen; if (projectionError !== undefined) throw projectionError; } },
      complete() {}, cancel() {} };
  }

  async close(): Promise<void> {
    await Promise.all([...this.operations.values()]);
    for (const id of [...this.pendingToolWrites.keys()]) await this.ordered(id, () => this.flushPendingToolWrites(id));
    await Promise.all([...this.deliveries]);
  }
}
