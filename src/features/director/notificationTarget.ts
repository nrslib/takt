import { z } from 'zod/v4';
import { isAbsolute } from 'node:path';
import { GoalStore } from '../../infra/goals/store.js';
import { StandaloneInquiryStore } from '../../infra/goals/standalone-inquiries.js';
import type { DirectorNotificationSubject } from '../../infra/conversations/directorNotifications.js';
import { resolveDirectorManager } from './managers.js';

const managerId = z.string().regex(/^manager-[a-f0-9]{64}$/);
export const directorNotificationTargetSchema = z.union([
  z.object({ managerId, cwd: z.string().refine(isAbsolute), goalId: z.uuid(), inquiryId: z.uuid().optional() }).strict(),
  z.object({ managerId, inquiryId: z.uuid() }).strict(),
]);

export async function resolveDirectorNotificationSubject(
  configDirectory: string,
  target: z.infer<typeof directorNotificationTargetSchema>,
): Promise<DirectorNotificationSubject> {
  const assignment = await resolveDirectorManager(configDirectory, target.managerId);
  const key = JSON.stringify([
    target.managerId, 'cwd' in target ? target.cwd : null,
    'goalId' in target ? target.goalId : null, target.inquiryId ?? null,
  ]);
  if (!('goalId' in target)) {
    const question = await new StandaloneInquiryStore(configDirectory, assignment).get(target.inquiryId);
    if (question.status !== 'pending') {
      throw new Error('Inquiry is not pending for a human');
    }
    return { key, state: JSON.stringify(question) };
  }
  if (!assignment.repositoryDirectories.includes(target.cwd)) throw new Error('Repository is outside manager assignment');
  const goal = await new GoalStore(target.cwd).get(target.goalId);
  if (target.inquiryId !== undefined) {
    const question = goal.questions?.find((candidate) => candidate.id === target.inquiryId);
    if (question === undefined || question.status !== 'pending') {
      throw new Error('Inquiry is not pending for a human');
    }
    return { key, state: JSON.stringify(question) };
  }
  const progress = goal.workLog.filter((entry) => entry.kind !== 'patrol')
    .map((entry) => entry.recordedAt).sort().at(-1) ?? goal.createdAt;
  return {
    key,
    state: JSON.stringify({
      status: goal.status,
      executionStatus: goal.executionStatus,
      pullRequest: goal.pullRequest,
      blocked: (goal.notifications ?? []).filter((entry) => entry.kind === 'blocked').map(({ id, body }) => ({ id, body })),
      ...(goal.status === 'created' && goal.executionStatus === 'active' ? { lastProgressAt: progress } : {}),
    }),
  };
}
