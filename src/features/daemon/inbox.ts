import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { EventInput, TurnEvent } from '../../core/daemon/events.js';
import type { DaemonIngress, EventStore } from '../../core/daemon/ports.js';
import { DaemonPersistedFiles } from '../../infra/daemon/persistedFiles.js';
import { DaemonConversations } from './conversationState.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { WatchFileChange } from './watchers/directories.js';
import { hasCode } from '../../infra/daemon/privateFile.js';
import { listWatchEntries, readSmallJson } from './watchers/files.js';
import { z } from 'zod/v4';

/** 以前の登録がなくても、残った巡回は起動時にモデルを使わず退役させる。 */
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
    let event: TurnEvent;
    switch (saved.kind) {
      case 'completion': event = { kind: saved.result.success ? 'task_completed' : 'task_failed',
        task: { repositoryDirectory: directory, goalId: saved.goalId, taskName: saved.taskName, runSlug: saved.runSlug }, result: saved.result }; break;
      case 'answer': event = { kind: 'inquiry_answered', repositoryDirectory: directory, goalId: saved.goalId, questionId: saved.questionId, answer: saved.answer }; break;
      case 'registered': case 'resumed': event = { kind: saved.kind === 'registered' ? 'goal_registered' : 'goal_resumed', repositoryDirectory: directory, goalId: saved.goalId }; break;
    }
    const id = `inbox-${createHash('sha256').update(change.path).digest('hex')}`;
    const input: EventInput = { eventId: id, requestId: id, conversationId: conversationId(assignment), source: 'run', occurredAt: saved.createdAt, event };
    const admission = await ingress.accept(input);
    if (admission.kind !== 'accepted') throw new Error(`Inbox event was not accepted: ${admission.reason}`);
  }
  await unlink(change.path).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
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
    if (record.running !== null) await conversations.store.retireLegacy(record.id, null);
  }
}
