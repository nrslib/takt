import { basename } from 'node:path';
import type { Language } from '../../core/models/types.js';
import { GoalStore } from '../../infra/goals/store.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { formatGoalNotification } from '../../infra/goals/notifications.js';
import type { Goal } from '../../infra/goals/schema.js';
import type { ManagerAssignment } from './startupResolution.js';
import { formatPatrolSummary } from './goalDisplay.js';

export type ManagerDisplayGoal = Pick<Goal, 'id' | 'objective' | 'status' | 'executionStatus'>;
export interface ManagerDisplayNotice {
  id: string;
  repositoryDirectory: string;
  project: string;
  goalId: string;
  objective: string;
  kind: Exclude<NonNullable<Goal['notifications']>[number]['kind'], 'question'>;
  recordedAt: string;
  message: string;
}

export interface ManagerDisplayEvent {
  id: string;
  message: string;
  suppressInitialDisplay?: true;
}

export async function* iterateManagerDisplayEvents(assignment: ManagerAssignment, language: Language,
  startupBoundaries: ReadonlyMap<string, number>, notificationStartedAt: number): AsyncGenerator<ManagerDisplayEvent> {
  for (const directory of assignment.repositoryDirectories) {
    const project = basename(directory);
    const { notifications: policy } = resolveManagerConfig(directory);
    const boundary = startupBoundaries.get(directory);
    for await (const goal of new GoalStore(directory).iterate()) {
      for (const record of goal.workLog) {
        yield { id: JSON.stringify([goal.id, 'work-log', record.id]),
          message: `${goal.id}: ${record.kind === 'patrol' ? formatPatrolSummary(record.summary) : record.summary}`,
          ...(boundary !== undefined && Date.parse(record.recordedAt) < boundary ? { suppressInitialDisplay: true as const } : {}) };
      }
      for (const notification of goal.notifications ?? []) {
        if (notification.kind === 'question' || !policy[notification.kind]) continue;
        yield { id: JSON.stringify([goal.id, 'notification', notification.id]),
          message: formatGoalNotification(goal, notification, language, project, 'tui'),
          ...(Date.parse(notification.recordedAt) < notificationStartedAt ? { suppressInitialDisplay: true as const } : {}) };
      }
    }
  }
}

export async function* iterateManagerNotices(assignment: ManagerAssignment, language: Language): AsyncGenerator<ManagerDisplayNotice> {
  interface Position { time: number; repository: number; goalId: string; index: number }
  const compare = (left: Position, right: Position): number => right.time - left.time
    || left.repository - right.repository || left.goalId.localeCompare(right.goalId) || left.index - right.index;
  let cursor: Position | undefined;
  while (true) {
    let candidate: { position: Position; notice: ManagerDisplayNotice } | undefined;
    for (const [repository, directory] of assignment.repositoryDirectories.entries()) {
      const project = basename(directory);
      const { notifications: policy } = resolveManagerConfig(directory);
      for await (const goal of new GoalStore(directory).iterate()) {
        for (const [index, notification] of (goal.notifications ?? []).entries()) {
          if (notification.kind === 'question' || !policy[notification.kind]) continue;
          const position = { time: Date.parse(notification.recordedAt), repository, goalId: goal.id, index };
          if ((cursor === undefined || compare(position, cursor) > 0)
            && (candidate === undefined || compare(position, candidate.position) < 0)) {
            candidate = { position, notice: {
              id: notification.id, repositoryDirectory: directory, project, goalId: goal.id,
              objective: goal.objective, kind: notification.kind, recordedAt: notification.recordedAt,
              message: formatGoalNotification(goal, notification, language, project, 'tui', 'full'),
            } };
          }
        }
      }
    }
    if (candidate === undefined) return;
    cursor = candidate.position;
    yield candidate.notice;
  }
}
