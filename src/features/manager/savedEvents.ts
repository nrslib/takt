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

export type ManagerDisplayGoal = Pick<Goal, 'id' | 'objective' | 'status' | 'executionStatus'>;

async function readRepositoryDisplayEvents(cwd: string, language: Language): Promise<{
  events: { id: string; message: string }[]; diagnostics: { id: string; message: string }[];
  goals: ManagerDisplayGoal[];
}> {
  const events: { id: string; message: string }[] = [];
  const diagnostics: { id: string; message: string }[] = [];
  const displayGoals: ManagerDisplayGoal[] = [];
  const project = basename(cwd);
  const { notifications: policy } = resolveManagerConfig(cwd);
  try {
    const { goals, errors } = await new GoalStore(cwd).list();
    displayGoals.push(...goals.map(({ id, objective, status, executionStatus }) => ({ id, objective, status, executionStatus })));
    for (const goal of goals) {
      events.push(...goal.workLog.map((record) => ({
        id: JSON.stringify([goal.id, 'work-log', record.id]),
        message: `${goal.id}: ${record.summary}`,
      })));
      events.push(...(goal.notifications ?? []).filter((notification) => policy[notification.kind]).map((notification) => ({
        id: JSON.stringify([goal.id, 'notification', notification.id]), message: formatGoalNotification(goal, notification, language, project, 'tui'),
      })));
    }
    diagnostics.push(...errors.map(({ goalId, error }) => ({
      id: JSON.stringify(['diagnostic', 'goal', goalId, getErrorMessage(error)]),
      message: `${goalId}: ${getErrorMessage(error)}`,
    })));
  } catch (error) {
    const message = getErrorMessage(error);
    diagnostics.push({ id: JSON.stringify(['diagnostic', 'goals', message]), message });
  }
  return { events, diagnostics, goals: displayGoals };
}

export async function readManagerDisplayEvents(cwd: string, language: Language = resolveConfigValue(cwd, 'language'),
  assignment: ManagerAssignment = { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] }): Promise<{
    events: { id: string; message: string }[]; diagnostics: { id: string; message: string }[];
    questions: PendingQuestion[]; goals: ManagerDisplayGoal[];
  }> {
  const snapshots = await Promise.all(assignment.repositoryDirectories.map((directory) => readRepositoryDisplayEvents(directory, language)));
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
    goals: snapshots.flatMap((snapshot) => snapshot.goals) };
}
