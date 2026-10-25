import { basename } from 'node:path';
import type { Language } from '../../core/models/types.js';
import { GoalStore } from '../../infra/goals/store.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { formatGoalNotification } from '../../infra/goals/notifications.js';
import type { Goal } from '../../infra/goals/schema.js';
import type { ManagerAssignment } from './startupResolution.js';
import { formatPatrolSummary } from './goalDisplay.js';

type ManagerNotificationPolicy = Readonly<ReturnType<typeof resolveManagerConfig>['notifications']>;

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

export function* projectManagerDisplayEvents(goal: Goal, directory: string, language: Language,
  startupBoundary: number | undefined, notificationStartedAt: number, policy: ManagerNotificationPolicy): Generator<ManagerDisplayEvent> {
  const project = basename(directory);
  for (const record of goal.workLog) {
    yield { id: JSON.stringify([goal.id, 'work-log', record.id]),
      message: `${goal.id}: ${record.kind === 'patrol' ? formatPatrolSummary(record.summary) : record.summary}`,
      ...(startupBoundary !== undefined && Date.parse(record.recordedAt) < startupBoundary ? { suppressInitialDisplay: true as const } : {}) };
  }
  for (const notification of goal.notifications ?? []) {
    if (notification.kind === 'question' || !policy[notification.kind]) continue;
    yield { id: JSON.stringify([goal.id, 'notification', notification.id]),
      message: formatGoalNotification(goal, notification, language, project, 'tui'),
      ...(Date.parse(notification.recordedAt) < notificationStartedAt ? { suppressInitialDisplay: true as const } : {}) };
  }
}

export function* projectManagerNotices(goal: Goal, directory: string, language: Language,
  policy: ManagerNotificationPolicy): Generator<ManagerDisplayNotice> {
  const project = basename(directory);
  for (const notification of goal.notifications ?? []) {
    if (notification.kind === 'question' || !policy[notification.kind]) continue;
    yield { id: notification.id, repositoryDirectory: directory, project, goalId: goal.id,
      objective: goal.objective, kind: notification.kind, recordedAt: notification.recordedAt,
      message: formatGoalNotification(goal, notification, language, project, 'tui', 'full') };
  }
}

export function compareManagerNotices(left: ManagerDisplayNotice, right: ManagerDisplayNotice): number {
  // Stable sorting retains repository, goal ID and source-index order for equal timestamps.
  return Date.parse(right.recordedAt) - Date.parse(left.recordedAt);
}

export async function* iterateManagerDisplayEvents(assignment: ManagerAssignment, language: Language,
  startupBoundaries: ReadonlyMap<string, number>, notificationStartedAt: number): AsyncGenerator<ManagerDisplayEvent> {
  for (const directory of assignment.repositoryDirectories) {
    const { notifications: policy } = resolveManagerConfig(directory);
    for await (const goal of new GoalStore(directory).iterate()) {
      yield* projectManagerDisplayEvents(goal, directory, language, startupBoundaries.get(directory), notificationStartedAt, policy);
    }
  }
}

export async function* iterateManagerNotices(assignment: ManagerAssignment, language: Language): AsyncGenerator<ManagerDisplayNotice> {
  const notices: ManagerDisplayNotice[] = [];
  for (const directory of assignment.repositoryDirectories) {
    const { notifications: policy } = resolveManagerConfig(directory);
    for await (const goal of new GoalStore(directory).iterate()) {
      for (const notice of projectManagerNotices(goal, directory, language, policy)) notices.push(notice);
    }
  }
  yield* notices.sort(compareManagerNotices);
}
