import { createHash } from 'node:crypto';
import type { EventInput } from '../../core/daemon/events.js';
import type { EpicEvent } from '../../core/daemon/epicEvent.js';
import type { Epic } from '../../infra/epics/schema.js';
import { epicView } from '../../infra/epics/state.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { DaemonIngress } from '../../core/daemon/ports.js';

export function epicEventId(event: EpicEvent): string {
  return `epic-${createHash('sha256').update(JSON.stringify([event.kind, event.workspaceId, event.epicId, event.revision, event.runId])).digest('hex')}`;
}

export function epicEvents(epic: Epic): EventInput[] {
  const events: EventInput[] = [];
  const append = (event: EpicEvent, occurredAt: string): void => {
    const id = epicEventId(event);
    events.push({ eventId: id, requestId: id, conversationId: conversationId({ kind: 'workspace', workspaceId: epic.workspaceId }),
      source: 'daemon', occurredAt, event });
  };
  for (const run of epic.verificationRuns) {
    if (run.result === undefined || run.invalidationReason !== undefined || run.status === 'stale') continue;
    append({ kind: 'epic_verification_result', workspaceId: epic.workspaceId, epicId: epic.id, revision: run.revision, runId: run.id }, run.result.completedAt);
  }
  const evidence = epicView(epic).currentEvidence;
  if (epic.status === 'completed' && evidence?.result !== undefined) append({ kind: 'epic_completed',
    workspaceId: epic.workspaceId, epicId: epic.id, revision: epic.revision, runId: evidence.id }, evidence.result.completedAt);
  return events;
}

export async function publishEpicEvents(epic: Epic, ingress: Pick<DaemonIngress, 'accept'>, reason?: string): Promise<void> {
  for (const event of epicEvents(epic)) {
    if (reason !== undefined) event.event = { ...event.event, operation: { reason } } as EpicEvent;
    const admission = await ingress.accept(event);
    if (admission.kind !== 'accepted') throw new Error(`Epic event admission rejected: ${admission.reason}`);
  }
}
