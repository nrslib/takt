import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eventGoalReference } from '../../core/daemon/events.js';
import { ToolHistoryPersistenceError } from '../../core/daemon/toolHistoryPersistenceError.js';
import { DaemonPersistedFiles } from '../../infra/daemon/persistedFiles.js';
import { globalDaemonConfiguration, readDaemonConfiguration } from './configuration.js';
import type { ConversationOwner } from '../../core/daemon/ports.js';
import type { ConversationSnapshot, TurnIdentity, TurnResult, TurnStart } from '../../core/daemon/messages.js';
import { ConversationStateStore } from '../../infra/daemon/conversationStateStore.js';
import { DaemonDisplayFiles } from '../../infra/daemon/displayFiles.js';
import { DaemonNotifications } from '../../infra/daemon/notifications.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { ConversationState, OutputVersion, PortOutput, SnapshotItem } from '../manager/conversationPort.js';
import { conversationProjection } from './conversationProjection.js';
import { DaemonRouting } from './routing.js';
import type { ConversationProgress, ConversationToolEvent } from '../../shared/types/conversation-activity.js';
import { ToolActivityHistory } from '../../shared/tool-activity/history.js';
import type { ToolActivityEntry, ToolActivityTurnState, ToolActivityTurnUpdate } from '../../shared/tool-activity/types.js';
import { createBoundedSensitiveValues, createSensitiveTextStreamRedactor, sanitizeSensitiveTextWithKnownValues, writeSensitiveTextInChunks,
  type BoundedSensitiveValues, type SensitiveTextStreamRedactor } from '../../shared/utils/sensitiveText.js';

/** 実行中の entry の途中出力。配信済みのマスク済みテキストと、チャンクの境目をまたぐ秘密値を保留する redactor を持つ。 */
interface ToolOutputStream {
  readonly redactor: SensitiveTextStreamRedactor;
  text: string;
}

/** 実行中ターンのツール履歴。daemon が保持し、イベントごとにファイルから読み直さない。 */
interface ToolTurn {
  readonly history: ToolActivityHistory;
  /** 適用済みのイベント。同じイベントが再送されても二重に適用しない。 */
  readonly eventIds: Set<string>;
  /** 配信した entry を history と同じ順に持つ。完了した entry はマスク済みなので、snapshot ごとにマスクし直さない。 */
  readonly entries: Map<string, ToolActivityEntry>;
  readonly outputs: Map<string, ToolOutputStream>;
  sensitiveValues?: BoundedSensitiveValues;
  /** 追記に失敗すると、ファイルの途中に書きかけの行が残りうる。次の区切りでファイル全体を書き直す。 */
  rewrite: boolean;
}

interface RunningTurn {
  readonly state: NonNullable<ConversationState['running']> & { generation: number };
  readonly revision: number;
  tools?: ToolTurn;
}

/**
 * result を持つ完了 entry は output を持たない。表示は result を使う。
 * 途中出力を落としたツールの output は秘密値の途中で切れていることがあり、値全体の一致でしか伏せられないため。
 */
function redactToolEntry(entry: ToolActivityEntry, sensitiveValues: BoundedSensitiveValues | undefined): ToolActivityEntry {
  const source = sensitiveValues ?? entry.input;
  const output = entry.result === undefined || entry.result === '' ? sanitizeSensitiveTextWithKnownValues(entry.output, source) : '';
  return { ...entry, output,
    ...(entry.result === undefined ? {} : { result: sanitizeSensitiveTextWithKnownValues(entry.result, source) }) };
}

function toolTurnState(turn: TurnIdentity, tools: ToolTurn, finished: boolean): ToolActivityTurnState {
  // 実行中の entry は配信済みの途中出力を返し、差分配信と同じ状態にする。
  const entries = [...tools.entries.values()].flatMap((entry) => entry.status !== 'running' ? [entry]
    : finished ? [] : [{ ...entry, output: tools.outputs.get(entry.key)?.text ?? '' }]);
  return { operationId: turn.operationId, generation: turn.generation, finished, history: { sequence: tools.history.currentSequence, entries } };
}

/** 途中出力のチャンクだけを redactor に通し、確定した部分を追記分として返す。保留分は次のチャンクか完了時の entry で送る。 */
function appendToolOutput(tools: ToolTurn, changed: readonly ToolActivityEntry[], chunk: string): Pick<ToolActivityTurnUpdate, 'entries' | 'output'> {
  const [entry] = changed;
  if (entry === undefined) return { entries: [] };
  const existing = tools.outputs.get(entry.key);
  const stream = existing ?? { redactor: createSensitiveTextStreamRedactor(), text: '' };
  if (existing === undefined) tools.outputs.set(entry.key, stream);
  const text = writeSensitiveTextInChunks(stream.redactor, chunk, tools.sensitiveValues ?? entry.input);
  stream.text += text;
  if (existing !== undefined) return { entries: [], output: { key: entry.key, text } };
  // 最初の途中出力では、出力のない entry を先に送る。途中出力だけで作られた entry もこれで受け手に届く。
  const started = { ...entry, output: '' };
  tools.entries.set(entry.key, started);
  return { entries: [started], output: { key: entry.key, text } };
}

export class DaemonConversations implements ConversationOwner {
  private readonly displayFiles = new DaemonDisplayFiles();
  private readonly sequences = new Map<string, number>();
  private readonly deliveries = new Set<Promise<void>>();
  private readonly interrupted = new Set<string>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly historyOperations = new Map<string, Promise<void>>();
  /**
   * 実行中でない会話のツール履歴。ファイルは daemon の起動後に一度だけ読み、確定時は確定した履歴を覚える。
   * 値が undefined の会話は、履歴がないことを確認済み。
   */
  private readonly savedToolHistories = new Map<string, ToolActivityTurnState | undefined>();

  constructor(readonly store: ConversationStateStore, readonly routing: DaemonRouting,
    readonly notifications: DaemonNotifications,
    private readonly deliver: (id: string, output: PortOutput, version: OutputVersion, signal?: AbortSignal) => Promise<void>,
    private readonly onError: (error: unknown) => void) {}

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

  private orderedHistory<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.historyOperations.get(id) ?? Promise.resolve();
    const result = previous.then(action);
    // 失敗は呼出側へ返す。後続の読取・保存は失敗した操作の終了後にも実行できる。
    const completed = result.then(() => {}, () => {});
    this.historyOperations.set(id, completed);
    void completed.then(() => {
      if (this.historyOperations.get(id) === completed) this.historyOperations.delete(id);
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

  started(input: TurnStart): void {
    const { event, turn, state } = input;
    const running = { operationId: turn.operationId, kind: 'turn', generation: turn.generation, startedAt: Date.now() };
    this.running.set(turn.conversationId, { state: { ...running }, revision: state.revision });
    this.interrupted.delete(turn.conversationId);
    const version = this.version(turn.conversationId, state.revision, turn.operationId);
    if (event.event.kind === 'human_command' && event.event.command.kind === 'message' && event.event.command.display !== false) {
      this.send(turn.conversationId, { kind: 'user_message', operationId: turn.operationId, message: event.event.command.text }, version);
    }
    this.send(turn.conversationId, { kind: 'running', state: { conversationId: turn.conversationId, assignment: state.assignment,
      revision: state.revision, pending: state.pending, approval: state.approval, interrupted: false,
      running } }, version);
  }

  async apply(result: TurnResult): Promise<void> {
    const { history, current, version } = await this.orderedHistory(result.conversationId, async () => {
      await this.store.apply(result);
      const running = this.running.get(result.conversationId);
      this.running.delete(result.conversationId);
      // 結果は保存済みなので、履歴の確定に失敗しても実行中の状態は解除して配信する。
      const history = await this.finishToolHistory(result, running?.state.operationId === result.operationId
        && running.state.generation === result.generation ? running.tools : undefined).catch((error: unknown) => {
        this.onError(error);
        return undefined;
      });
      const current = await this.store.read(result.conversationId);
      if (current === undefined) throw new Error('Missing result conversation');
      if (result.outcome.kind === 'interrupted') this.interrupted.add(result.conversationId);
      else this.interrupted.delete(result.conversationId);
      return { history, current, version: this.version(result.conversationId, current.state.revision, result.operationId) };
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
    if (history !== undefined) {
      this.send(result.conversationId, { kind: 'tool_history', history }, version);
    }
    const outcome = result.outcome;
    this.send(result.conversationId, { kind: 'pending', state: { conversationId: result.conversationId, assignment: current.state.assignment,
      revision: current.state.revision, pending: current.state.pending, approval: current.state.approval, running: null,
      interrupted: outcome.kind === 'interrupted' } }, version);
    if (outcome.kind === 'deferred') return;
    this.send(result.conversationId, { kind: 'result', operationId: result.operationId, result: outcome.kind === 'completed' ? outcome.result
      : { kind: 'error', code: outcome.kind, message: outcome.message ?? 'Turn interrupted' } }, version);
    if (result.event.event.kind === 'director_message') await this.notifyResult(result);
  }

  async notifyResult(result: TurnResult): Promise<void> {
    const outcome = result.outcome;
    const message = outcome.kind === 'completed' && 'message' in outcome.result ? outcome.result.message
      : outcome.kind === 'failed' ? outcome.message : outcome.kind === 'interrupted' ? 'Manager turn interrupted' : 'Manager operation completed';
    const id = `result-${result.operationId}`;
    if (await this.notifications.save({ id, message: `${result.conversationId} (${result.operationId}): ${message}` }, new AbortController().signal)) {
      const directorId = conversationId({ kind: 'daemon' });
      this.send(directorId, { kind: 'notice', id, message: `${result.conversationId} (${result.operationId}): ${message}` }, this.version(directorId, 0, null));
    }
  }

  private async savedToolHistory(id: string): Promise<ToolActivityTurnState | undefined> {
    if (this.savedToolHistories.has(id)) return this.savedToolHistories.get(id);
    const saved = await this.store.readToolHistory(id).catch(async (error: unknown) => {
      // 読めない履歴は表示に使えないので、報告して消す。
      this.onError(error);
      await this.store.removeToolHistory(id);
      return undefined;
    });
    this.savedToolHistories.set(id, saved);
    return saved;
  }

  private async finishToolHistory(turn: TurnIdentity, tools: ToolTurn | undefined): Promise<ToolActivityTurnState | undefined> {
    const id = turn.conversationId;
    if (tools !== undefined) {
      const history = toolTurnState(turn, tools, true);
      this.savedToolHistories.set(id, history);
      await this.store.writeToolHistory(id, history);
      return history;
    }
    // ツールを使わなかったターンでは、前のターンの履歴を残さない。daemon 再起動前に始まった同じターンの履歴は確定する。
    const saved = await this.savedToolHistory(id);
    if (saved === undefined) return undefined;
    if (saved.operationId !== turn.operationId || saved.generation !== turn.generation) {
      this.savedToolHistories.set(id, undefined);
      await this.store.removeToolHistory(id);
      return undefined;
    }
    if (saved.finished) return undefined;
    const history: ToolActivityTurnState = { ...saved, finished: true, history: { ...saved.history,
      entries: saved.history.entries.filter((entry) => entry.status !== 'running').map((entry) => redactToolEntry(entry, undefined)) } };
    this.savedToolHistories.set(id, history);
    await this.store.writeToolHistory(id, history);
    return history;
  }

  /** 1 件のイベントを現在ターンの履歴へ適用し、変わった entry（途中出力では追記分）だけを保存・配信用に返す。 */
  private async recordToolEvent(turn: TurnIdentity, running: RunningTurn, message: ConversationToolEvent): Promise<ToolActivityTurnUpdate | undefined> {
    const context = message.event.toolActivity;
    if (context?.operationId !== turn.operationId || context.generation !== turn.generation) throw new Error('Tool event turn mismatch');
    if (running.tools?.eventIds.has(message.eventId)) return undefined;
    if (running.tools === undefined) {
      // ファイルを新しいターンの履歴で置き換えるので、覚えていた前のターンの履歴は使わない。
      this.savedToolHistories.delete(turn.conversationId);
      await this.store.startToolHistory(turn);
      running.tools = { history: new ToolActivityHistory(), eventIds: new Set(), entries: new Map(), outputs: new Map(), rewrite: false };
    }
    const tools = running.tools;
    if (message.event.type === 'tool_use') {
      tools.sensitiveValues ??= createBoundedSensitiveValues();
      tools.sensitiveValues.collect(message.event.data.input);
    }
    const previousSequence = tools.history.currentSequence;
    const changed = tools.history.apply(message.event);
    tools.eventIds.add(message.eventId);
    const update = { operationId: turn.operationId, generation: turn.generation, previousSequence, sequence: tools.history.currentSequence };
    // 途中出力は保存しない。完了時の entry が出力全体を持つ。
    if (message.event.type === 'tool_output') return { ...update, ...appendToolOutput(tools, changed, message.event.data.output) };
    for (const entry of changed) {
      if (entry.status !== 'running') tools.outputs.delete(entry.key);
    }
    const entries = changed.map((entry) => redactToolEntry(entry, tools.sensitiveValues));
    for (const entry of entries) tools.entries.set(entry.key, entry);
    await this.saveToolChange(turn, tools, { sequence: update.sequence, entries });
    return { ...update, entries };
  }

  private async saveToolChange(turn: TurnIdentity, tools: ToolTurn, change: { sequence: number; entries: ToolActivityEntry[] }): Promise<void> {
    if (tools.rewrite) {
      await this.store.writeToolHistory(turn.conversationId, toolTurnState(turn, tools, false));
      tools.rewrite = false;
      return;
    }
    try {
      await this.store.appendToolHistory(turn.conversationId, change);
    } catch (error) {
      tools.rewrite = true;
      throw error;
    }
  }

  async progress(turn: TurnIdentity, message: ConversationProgress, signal: AbortSignal): Promise<void> {
    if (typeof message !== 'string' && message.kind === 'tool_event') {
      const recorded = await this.orderedHistory(turn.conversationId, async () => {
        const running = this.running.get(turn.conversationId);
        if (signal.aborted || running?.state.operationId !== turn.operationId || running.state.generation !== turn.generation) return undefined;
        const update = await this.recordToolEvent(turn, running, message).catch((error: unknown) => {
          throw new ToolHistoryPersistenceError(error);
        });
        return update === undefined ? undefined : { update, version: this.version(turn.conversationId, running.revision, turn.operationId) };
      });
      if (recorded !== undefined && !signal.aborted) {
        await this.deliver(turn.conversationId, { kind: 'tool_history_update', update: recorded.update }, recorded.version, signal);
      }
      return;
    }
    const version = this.version(turn.conversationId, 0, turn.operationId);
    const current = await this.store.read(turn.conversationId);
    if (signal.aborted) return;
    if (current === undefined) throw new Error('Missing progress conversation');
    version.revision = current.state.revision;
    if (typeof message !== 'string' && message.kind === 'turn_text') {
      await this.deliver(turn.conversationId, { ...message, operationId: turn.operationId, generation: turn.generation }, version, signal);
      return;
    }
    const output: PortOutput = typeof message === 'string' ? { kind: 'progress', operationId: turn.operationId, message }
      : { kind: 'activity', operationId: turn.operationId, generation: turn.generation, activity: message };
    this.send(turn.conversationId, output, version);
  }

  async inquiry(notice: import('../../core/daemon/messages.js').InquiryNotice): Promise<void> {
    const current = await this.store.read(notice.conversationId);
    if (current === undefined) throw new Error('Missing inquiry conversation');
    if (notice.question.status !== 'pending' || notice.question.recipient !== 'human') {
      const read = await this.snapshot(notice.conversationId);
      this.send(notice.conversationId, { kind: 'snapshot', read: { ...read, operationId: null } }, this.version(notice.conversationId, current.state.revision, null));
      return;
    }
    this.send(notice.conversationId, { kind: 'inquiry', target: notice.target, question: notice.question },
      this.version(notice.conversationId, current.state.revision, null));
  }

  async snapshot(id: string): Promise<Omit<ConversationSnapshot, 'operationId' | 'generation'>> {
    const { current, running, savedHistory, version, interrupted } = await this.orderedHistory(id, async () => {
      const current = await this.store.read(id);
      if (current === undefined) throw new Error('Unknown conversation');
      const turn = this.running.get(id);
      const running = turn === undefined ? undefined : { ...turn.state };
      // 実行中ターンの履歴はメモリから全量を返す。それ以外は覚えている履歴を返し、ファイルは daemon 起動後の最初だけ読む。
      // 履歴を読めなくても会話は開けるようにする。
      const savedHistory = turn?.tools === undefined ? await this.savedToolHistory(id).catch((error: unknown) => {
        this.onError(error);
        return undefined;
      }) : toolTurnState({ conversationId: id, operationId: turn.state.operationId, generation: turn.state.generation }, turn.tools, false);
      return { current, savedHistory, running, interrupted: this.interrupted.has(id), version: this.version(id, current.state.revision, null) };
    });
    // daemon 再起動前に実行中だった履歴は、実行中でなくなったら確定した履歴として見せる。
    const history = savedHistory === undefined || running !== undefined
      && (running.operationId !== savedHistory.operationId || running.generation !== savedHistory.generation) ? undefined
      : savedHistory.finished || running !== undefined ? savedHistory
      : { ...savedHistory, finished: true, history: { ...savedHistory.history,
        entries: savedHistory.history.entries.filter((entry) => entry.status !== 'running') } };
    const state: ConversationState = { conversationId: id, assignment: current.state.assignment, revision: current.state.revision,
      pending: current.state.pending, approval: current.state.approval, running: running === undefined ? null : running, interrupted };
    const { routing, notifications, displayFiles } = this;
    let cancelled = false;
    return { ...version, transferId: randomUUID(), conversationId: id, mode: 'initial', turnState: current.state,
      items: (async function* (): AsyncGenerator<SnapshotItem & { recordedAt?: string }> {
        if (cancelled) return;
        yield { kind: 'state', state };
        if (history !== undefined && history.history.entries.length > 0) yield { kind: 'tool_history', history };
        if (current.state.assignment.kind !== 'daemon') {
          yield* conversationProjection(routing, displayFiles, current.state.assignment, () => cancelled);
        } else {
          yield { kind: 'assignment', assignment: await routing.display(current.state.assignment) };
          for await (const notice of notifications.iterate()) {
            if (cancelled) return;
            yield { kind: 'display_event', event: { id: notice.id, message: notice.message } };
          }
        }
      })(), complete() { cancelled = true; }, cancel() { cancelled = true; } };
  }

  async close(): Promise<void> { await Promise.all([...this.deliveries]); }
}
