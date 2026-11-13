import { createHash } from 'node:crypto';
import { conversationId } from '../../infra/conversations/identity.js';
import { DaemonEpicFiles } from '../../infra/daemon/epicFiles.js';
import type { DaemonIngress } from '../../core/daemon/ports.js';
import type { DaemonConversations } from './conversationState.js';
import { publishEpicEvents } from './epicEvents.js';
import { startWatchLoop, WATCH_INTERVALS } from './watchers/loop.js';

export function startEpicWatcher(conversations: DaemonConversations, ingress: Pick<DaemonIngress, 'accept'>, onError: (error: unknown) => void) {
  const versions = new Map<string, string>();
  const files = new DaemonEpicFiles(conversations.routing.directory);
  return startWatchLoop(WATCH_INTERVALS.files, async (signal) => {
    for (const assignment of await conversations.routing.assignments()) {
      if (assignment.kind !== 'workspace') continue;
      try {
        // 後方の破損を検出するまでイベントを公開しない。
        const validation = files.list(assignment.workspaceId);
        while (!(await validation.next()).done) signal.throwIfAborted();
        signal.throwIfAborted();
        await conversations.ensure(assignment);
        const hash = createHash('sha256').update('[');
        let separator = '';
        for await (const epic of files.list(assignment.workspaceId)) {
          signal.throwIfAborted();
          await publishEpicEvents(epic, ingress);
          hash.update(separator).update(JSON.stringify(epic));
          separator = ',';
        }
        const id = conversationId(assignment);
        const notifications: string[] = [];
        for await (const notice of conversations.notifications.iterate()) if (notice.conversationId === id) notifications.push(notice.id);
        const version = hash.update(']').update(JSON.stringify(notifications.sort())).digest('hex');
        if (versions.get(id) !== version) {
          const read = await conversations.snapshot(id);
          conversations.send(id, { kind: 'snapshot', read: { ...read, operationId: null } },
            { revision: read.revision, stateSequence: read.stateSequence, operationId: null });
          versions.set(id, version);
        }
      } catch (error) { onError(error); }
    }
  }, onError);
}
