import { projectManagerDisplayEvents } from '../../features/manager/savedEvents.js';
import { GoalStore } from '../../infra/goals/store.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import type { ManagerAssignment } from '../../features/manager/startupResolution.js';
import type { PendingQuestion } from '../../features/manager/inquiryAnswer.js';
import { iteratePendingInquiries } from '../../infra/goals/pending-inquiries.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';

export async function collectItems<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

export async function* iterateTestDisplayEvents(assignment: ManagerAssignment, language: 'ja' | 'en',
  notificationStartedAt: number) {
  for (const directory of assignment.repositoryDirectories) {
    const { notifications: policy } = resolveManagerConfig(directory);
    for await (const goal of new GoalStore(directory).iterate()) {
      yield* projectManagerDisplayEvents(goal, directory, language, notificationStartedAt, policy);
    }
  }
}

/** Collect display projections for assertions without an Ink mount. */
export async function readManagerTestDisplay(cwd: string, language: 'ja' | 'en' = resolveConfigValue(cwd, 'language'),
  assignment: ManagerAssignment = { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] },
  notificationStartedAt = -Infinity) {
  const events = await collectItems(iterateTestDisplayEvents(assignment, language, notificationStartedAt));
  const inquiries = await collectItems(iteratePendingInquiries(getGlobalConfigDir(), assignment));
  const questions: PendingQuestion[] = inquiries.filter(({ question }) => question.recipient === 'human').map((inquiry) =>
    inquiry.goalId === null ? { goalId: null, owner: assignment.kind === 'workspace'
      ? { kind: 'workspace', workspaceId: assignment.workspaceId }
      : { kind: 'repository', repositoryDirectory: assignment.repositoryDirectory }, question: inquiry.question }
      : { goalId: inquiry.goalId, repositoryDirectory: inquiry.repositoryDirectory, objective: inquiry.objective, question: inquiry.question });
  return { events, questions };
}
