import { randomUUID } from 'node:crypto';
import { DaemonEpicFiles } from '../../infra/daemon/epicFiles.js';
import { epicEventId, epicEvents } from './epicEvents.js';
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
import type { ConversationProgress } from '../../shared/types/conversation-activity.js';

export class DaemonConversations implements ConversationOwner {
  private readonly displayFiles = new DaemonDisplayFiles();
  private readonly sequences = new Map<string, number>();
  private readonly deliveries = new Set<Promise<void>>();
  private readonly interrupted = new Set<string>();
  private readonly running = new Map<string, NonNullable<ConversationState['running']>>();
  private readonly historyOperations = new Map<string, Promise<void>>();

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
    this.running.set(turn.conversationId, { ...running });
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
      const history = await this.store.updateToolHistory({
        conversationId: result.conversationId, operationId: result.operationId, generation: result.generation,
      }, null, new AbortController().signal);
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

  async progress(turn: TurnIdentity, message: ConversationProgress, signal: AbortSignal): Promise<void> {
    if (typeof message !== 'string' && message.kind === 'tool_event') {
      const saved = await this.orderedHistory(turn.conversationId, async () => {
        const running = this.running.get(turn.conversationId);
        if (signal.aborted || running?.operationId !== turn.operationId || running.generation !== turn.generation) return;
        try {
          const history = await this.store.updateToolHistory(turn, message, signal);
          const current = await this.store.read(turn.conversationId);
          if (current === undefined) throw new Error('Missing progress conversation');
          return history === undefined ? undefined : { history, version: this.version(turn.conversationId, current.state.revision, turn.operationId) };
        } catch (error) {
          if (!signal.aborted || error !== signal.reason) throw new ToolHistoryPersistenceError(error);
          return undefined;
        }
      });
      if (saved !== undefined && !signal.aborted) {
        await this.deliver(turn.conversationId, { kind: 'tool_history', history: saved.history }, saved.version, signal);
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
      const savedHistory = await this.store.readToolHistory(id);
      const running = this.running.get(id);
      return { current, savedHistory, running: running === undefined ? undefined : { ...running },
        interrupted: this.interrupted.has(id), version: this.version(id, current.state.revision, null) };
    });
    const history = savedHistory === undefined || running !== undefined
      && (running.operationId !== savedHistory.operationId || running.generation !== savedHistory.generation) ? undefined
      : { ...savedHistory, finished: savedHistory.finished || running === undefined,
        history: { ...savedHistory.history, entries: savedHistory.history.entries.filter((entry) =>
          entry.status !== 'running' || running !== undefined && !savedHistory.finished) } };
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
        }
        for await (const notice of notifications.iterate()) {
          if (cancelled) return;
          if ((notice.conversationId ?? conversationId({ kind: 'daemon' })) !== id) continue;
          yield { kind: 'display_event', event: { id: notice.id, message: notice.message } };
        }
      })(), complete() { cancelled = true; }, cancel() { cancelled = true; } };
  }

  async close(): Promise<void> { await Promise.all([...this.deliveries]); }
}
