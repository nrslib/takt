import { join } from 'node:path';
import type { SnapshotItem } from '../manager/conversationPort.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { GoalQuestionSchema } from '../../infra/goals/schema.js';
import { DaemonDisplayFiles, readDisplayFile } from '../../infra/daemon/displayFiles.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitive-text.js';
import { listWatchEntries } from './watchers/files.js';
import { DaemonRouting, projectKey } from './routing.js';
import { projectManagerDisplayEvents } from '../manager/savedEvents.js';
import { globalDaemonConfiguration, readDaemonConfiguration } from './configuration.js';

/** 読取を consumer の要求に従わせ、全プロジェクトの本文を一度に保持しない。 */
export async function* conversationProjection(routing: DaemonRouting, files: DaemonDisplayFiles, identity: Exclude<ConversationAssignment, { kind: 'daemon' }>,
  cancelled: () => boolean): AsyncGenerator<SnapshotItem & { recordedAt?: string }> {
  let reading = routing.directory;
  try {
    const assignment = await routing.display(identity);
    const global = await globalDaemonConfiguration(routing.directory);
    yield { kind: 'assignment', assignment };
    for (const directory of assignment.repositoryDirectories) {
      const configuration = await readDaemonConfiguration(join(directory, '.takt', 'config.yaml'));
      const policy = Object.fromEntries((['question', 'awaiting_merge', 'completed', 'progress', 'blocked', 'custom'] as const)
        .map((kind) => [kind, configuration.manager?.notifications?.[kind] ?? global.manager?.notifications?.[kind] ?? true])) as Record<'question' | 'awaiting_merge' | 'completed' | 'progress' | 'blocked' | 'custom', boolean>;
      const root = join(directory, '.takt', 'goals');
      reading = root;
      for (const entry of await listWatchEntries(root)) {
        if (!entry.isDirectory()) continue;
        if (cancelled()) return;
        reading = join(root, entry.name, 'goal.json');
        const goal = await files.goal(reading);
        if (goal.id !== entry.name) throw new Error('Display goal identity mismatch');
        yield { kind: 'goal', goal: { id: goal.id, objective: goal.objective, status: goal.status, executionStatus: goal.executionStatus, repositoryDirectory: directory } };
        for (const question of goal.questions ?? []) {
          if (cancelled()) return;
          if (question.status === 'pending') yield { kind: 'inquiry', inquiry: { target: { goalId: goal.id, repositoryDirectory: directory }, question, objective: goal.objective } };
        }
        const dates = new Map([...goal.workLog.map((record) => [JSON.stringify([directory, goal.id, 'work-log', record.id]), record.recordedAt] as const),
          ...(goal.notifications ?? []).map((notice) => [JSON.stringify([directory, goal.id, 'notification', notice.id]), notice.recordedAt] as const)]);
        for (const event of projectManagerDisplayEvents(goal, directory, configuration.language ?? global.language ?? 'en', undefined, -Infinity, policy)) {
          if (cancelled()) return;
          yield { kind: 'display_event', event, recordedAt: dates.get(event.id) };
        }
      }
    }
    const root = identity.kind === 'workspace' ? join(routing.directory, 'workspaces', identity.workspaceId, 'inquiries')
      : join(routing.directory, 'projects', projectKey(identity.repositoryDirectory), 'inquiries');
    reading = root;
    for (const entry of await listWatchEntries(root)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (cancelled()) return;
      reading = join(root, entry.name);
      const question = GoalQuestionSchema.parse(await readDisplayFile(reading));
      if (`${question.id}.json` !== entry.name) throw new Error('Display inquiry identity mismatch');
      if (question.status === 'pending') yield { kind: 'inquiry', inquiry: { target: { goalId: null, owner: identity }, question } };
    }
  } catch (error) {
    if (cancelled()) return;
    yield { kind: 'display_event', event: { id: JSON.stringify(['diagnostic', reading]),
      message: `${reading}: ${sanitizeSensitiveText(getErrorMessage(error))}` } };
    throw error;
  }
}
