import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import type { EventInput } from '../../core/daemon/events.js';
import type { DaemonIngress, EventStore } from '../../core/daemon/ports.js';
import { DaemonPersistedFiles } from '../../infra/daemon/persistedFiles.js';
import { DaemonConversations } from './conversationState.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { WatchFileChange } from './watchers/directories.js';
import { hasCode } from '../../infra/daemon/privateFile.js';
import { listWatchEntries, readSmallJson } from './watchers/files.js';
import { z } from 'zod/v4';
import { ConversationIdSchema } from '../../infra/conversations/schema.js';
import type { TurnOutcome } from '../../core/daemon/messages.js';
import { managerInboxTurnEvent } from './inboxEvent.js';

/** 旧形式のゴール単位の patrol は、新しい見回りとして再生しない。 */
export async function retireLegacyPatrols(directory: string): Promise<void> {
  const root = join(directory, 'manager-inbox');
  for (const entry of await listWatchEntries(root)) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    for (const file of await listWatchEntries(join(root, entry.name))) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const path = join(root, entry.name, file.name);
      const value = await readSmallJson(path);
      if (value === null || typeof value !== 'object' || !('kind' in value) || value.kind !== 'patrol') continue;
      z.object({ kind: z.literal('patrol'), goalId: z.uuid(), createdAt: z.iso.datetime() }).strict().parse(value);
      await unlink(path).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
    }
  }
}

export async function receiveInboxChange(change: WatchFileChange, files: DaemonPersistedFiles,
  conversations: DaemonConversations, ingress: Pick<DaemonIngress, 'accept'>): Promise<void> {
  if (change.removed || change.target.kind !== 'inbox') return;
  const directory = change.target.targetId;
  const saved = await files.readInboxEvent(directory, basename(change.path));
  if (saved === undefined) return;
  if (saved.kind !== 'patrol') {
    const assignment = await conversations.routing.resolve({ kind: 'repository', repositoryDirectory: directory });
    await conversations.ensure(assignment);
    const event = managerInboxTurnEvent(directory, saved);
    const id = `inbox-${createHash('sha256').update(change.path).digest('hex')}`;
    const input: EventInput = { eventId: id, requestId: id, conversationId: conversationId(assignment), source: 'run', occurredAt: saved.createdAt, event };
    const admission = await ingress.accept(input);
    if (admission.kind !== 'accepted') throw new Error(`Inbox event was not accepted: ${admission.reason}`);
  }
  await unlink(change.path).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
}

const legacyResultSchema = z.object({
  operationId: z.uuid(), conversationId: ConversationIdSchema, directorConversationId: ConversationIdSchema,
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('reply'), message: z.string() }).strict(),
    z.object({ kind: z.literal('error'), code: z.string().min(1), message: z.string() }).strict(),
  ]),
}).strict();

async function legacyOutcome(directory: string, id: string, operationId: string, directorId: string | undefined): Promise<TurnOutcome> {
  const content = await readFile(join(directory, 'director-message-results', `${z.uuid().parse(operationId)}.json`), 'utf8')
    .catch((error: unknown) => { if (hasCode(error, 'ENOENT')) return undefined; throw error; });
  if (content === undefined) return { kind: 'interrupted' };
  const saved = legacyResultSchema.parse(JSON.parse(content) as unknown);
  if (saved.operationId !== operationId || saved.conversationId !== id || saved.directorConversationId !== directorId) {
    throw new Error('Legacy director result identity mismatch');
  }
  return { kind: 'completed', result: saved.result };
}

export async function restoreLegacyConversations(conversations: DaemonConversations, store: EventStore): Promise<void> {
  let sequence = (await store.restore()).lastAcceptedSequence;
  for await (const record of conversations.store.iterate()) {
    for (const message of record.directorMessages ?? []) {
      const id = `legacy-${message.operationId}`;
      await store.accept({ eventId: id, requestId: id, conversationId: record.id,
        operationId: message.operationId, acceptedSequence: ++sequence, lane: message.directorConversationId === undefined ? 'human' : 'other',
        source: message.directorConversationId === undefined ? 'daemon' : 'director', occurredAt: new Date().toISOString(),
        event: message.directorConversationId === undefined ? { kind: 'human_command', command: { kind: 'message', text: message.text },
          speaker: message.speaker, ...(message.agentOverrides === undefined ? {} : { agentOverrides: message.agentOverrides }) }
          : { kind: 'director_message', directorConversationId: message.directorConversationId, text: message.text } });
      await conversations.store.retireLegacy(record.id, message.operationId);
    }
    if (record.running !== null) {
      const running = record.running;
      const id = `legacy-running-${running.operationId}`;
      const event: import('../../core/daemon/events.js').AcceptedEvent = { eventId: id, requestId: id, conversationId: record.id,
        operationId: running.operationId, acceptedSequence: ++sequence, lane: running.directorConversationId === undefined ? 'human' : 'other',
        source: running.directorConversationId === undefined ? 'daemon' : 'director', occurredAt: new Date().toISOString(),
        event: running.directorConversationId === undefined ? { kind: 'human_command', command: { kind: 'message', text: 'Legacy turn interrupted during daemon restart', display: false },
          speaker: record.lastSpeaker ?? record.counterpart }
          : { kind: 'director_message', directorConversationId: running.directorConversationId, text: 'Legacy turn interrupted during daemon restart' } };
      // 再起動が移行中に止まっても、保存済みのイベント・結果を使い直す。
      const admission = await store.accept(event);
      const canonical = admission.kind === 'stored' ? event : admission.event;
      const outcome = await legacyOutcome(conversations.routing.directory, record.id, running.operationId, running.directorConversationId);
      const result = { conversationId: record.id, operationId: running.operationId, generation: 1, event: canonical, outcome };
      await store.markStarted(id, result);
      await store.saveResult(id, result);
      await conversations.apply(result);
      await conversations.notifyResult(result);
      await store.markSettled(id, result);
      await conversations.store.retireLegacy(record.id, null);
    }
  }
}
