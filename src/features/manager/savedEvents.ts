import { basename } from 'node:path';
import type { Language } from '../../core/models/types.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { GoalStore } from '../../infra/goals/store.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { formatGoalNotification } from '../../infra/goals/notifications.js';
import type { Goal } from '../../infra/goals/schema.js';
import { listPendingInquiries } from '../../infra/goals/pending-inquiries.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import type { ManagerAssignment } from './startupResolution.js';
import type { PendingQuestion } from './inquiryAnswer.js';
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

interface ManagerDisplayEvent {
  id: string;
  message: string;
  suppressInitialDisplay?: true;
}

async function readRepositoryDisplayEvents(cwd: string, language: Language,
  workLogStartedAt: number | undefined, notificationStartedAt: number | undefined): Promise<{
  events: ManagerDisplayEvent[]; diagnostics: ManagerDisplayEvent[];
  goals: ManagerDisplayGoal[]; notices: ManagerDisplayNotice[];
}> {
  const events: ManagerDisplayEvent[] = [];
  const diagnostics: ManagerDisplayEvent[] = [];
  const displayGoals: ManagerDisplayGoal[] = [];
  const notices: ManagerDisplayNotice[] = [];
  const project = basename(cwd);
  const { notifications: policy } = resolveManagerConfig(cwd);
  try {
    const { goals, errors } = await new GoalStore(cwd).list();
    displayGoals.push(...goals.map(({ id, objective, status, executionStatus }) => ({ id, objective, status, executionStatus })));
    for (const goal of goals) {
      events.push(...goal.workLog.map((record) => ({
        id: JSON.stringify([goal.id, 'work-log', record.id]),
        message: `${goal.id}: ${record.kind === 'patrol' ? formatPatrolSummary(record.summary) : record.summary}`,
        ...(workLogStartedAt !== undefined && Date.parse(record.recordedAt) < workLogStartedAt
          ? { suppressInitialDisplay: true as const } : {}),
      })));
      for (const notification of goal.notifications ?? []) {
        if (notification.kind === 'question' || !policy[notification.kind]) continue;
        events.push({
          id: JSON.stringify([goal.id, 'notification', notification.id]),
          message: formatGoalNotification(goal, notification, language, project, 'tui'),
          ...(notificationStartedAt !== undefined && Date.parse(notification.recordedAt) < notificationStartedAt
            ? { suppressInitialDisplay: true as const } : {}),
        });
        notices.push({
          id: notification.id, repositoryDirectory: cwd, project, goalId: goal.id,
          objective: goal.objective, kind: notification.kind, recordedAt: notification.recordedAt,
          message: formatGoalNotification(goal, notification, language, project, 'tui', 'full'),
        });
      }
    }
    diagnostics.push(...errors.map(({ goalId, error }) => ({
      id: JSON.stringify(['diagnostic', 'goal', goalId, getErrorMessage(error)]),
      message: `${goalId}: ${getErrorMessage(error)}`,
    })));
  } catch (error) {
    const message = getErrorMessage(error);
    diagnostics.push({ id: JSON.stringify(['diagnostic', 'goals', message]), message });
  }
  return { events, diagnostics, goals: displayGoals, notices };
}

export async function readManagerDisplayEvents(cwd: string, language: Language = resolveConfigValue(cwd, 'language'),
  assignment: ManagerAssignment = { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] },
  startupBoundaries?: ReadonlyMap<string, number>, notificationStartedAt?: number): Promise<{
    events: ManagerDisplayEvent[]; diagnostics: ManagerDisplayEvent[];
    questions: PendingQuestion[]; goals: ManagerDisplayGoal[]; notices: ManagerDisplayNotice[];
  }> {
  const snapshots = await Promise.all(assignment.repositoryDirectories.map((directory) => readRepositoryDisplayEvents(
    directory, language, startupBoundaries?.get(directory), notificationStartedAt ?? startupBoundaries?.get(directory),
  )));
  const diagnostics = snapshots.flatMap((snapshot) => snapshot.diagnostics);
  const questions: PendingQuestion[] = [];
  try {
    const pending = await listPendingInquiries(getGlobalConfigDir(), assignment);
    for (const inquiry of pending.inquiries) {
      if (inquiry.question.recipient !== 'human') continue;
      questions.push(inquiry.goalId === null
        ? { goalId: null, owner: assignment.kind === 'workspace'
          ? { kind: 'workspace', workspaceId: assignment.workspaceId }
          : { kind: 'repository', repositoryDirectory: assignment.repositoryDirectory }, question: inquiry.question }
        : { goalId: inquiry.goalId, repositoryDirectory: inquiry.repositoryDirectory, objective: inquiry.objective, question: inquiry.question });
    }
    diagnostics.push(...pending.errors.map(({ repositoryDirectory, goalId, error }) => ({
      id: JSON.stringify(['diagnostic', repositoryDirectory, goalId, getErrorMessage(error)]),
      message: `${goalId}: ${getErrorMessage(error)}`,
    })));
  } catch (error) {
    const message = getErrorMessage(error);
    diagnostics.push({ id: JSON.stringify(['diagnostic', 'inquiries', message]), message });
  }
  return { events: snapshots.flatMap((snapshot) => snapshot.events), diagnostics, questions,
    goals: snapshots.flatMap((snapshot) => snapshot.goals),
    notices: snapshots.flatMap((snapshot) => snapshot.notices)
      .sort((first, second) => Date.parse(second.recordedAt) - Date.parse(first.recordedAt)) };
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
