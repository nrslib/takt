import type { TurnEvent } from '../../core/daemon/events.js';
import type { ManagerEvent } from '../../infra/goals/events.js';
import { inquiryAnswerEvent } from './inquiryAnswerEvent.js';

export function managerInboxTurnEvent(directory: string, saved: ManagerEvent): TurnEvent {
  switch (saved.kind) {
    case 'patrol': throw new Error('Legacy goal patrols are retired without delivery');
    case 'completion': return {
      kind: saved.result.success ? 'task_completed' : 'task_failed',
      task: { repositoryDirectory: directory, goalId: saved.goalId, taskName: saved.taskName,
        ...(saved.runSlug === undefined ? {} : { runSlug: saved.runSlug }) },
      result: saved.result,
    };
    case 'pr_failed': return { kind: 'goal_pr_failed', repositoryDirectory: directory,
      goalId: saved.goalId, expectedSha: saved.expectedSha, reason: saved.reason };
    case 'answer': return saved.goalId === null
      ? inquiryAnswerEvent(saved.questionId, saved.answer, saved.questionBody)
      : { kind: 'inquiry_answered', repositoryDirectory: directory,
        goalId: saved.goalId, questionId: saved.questionId, answer: saved.answer };
    case 'registered': return { kind: 'goal_registered', repositoryDirectory: directory, goalId: saved.goalId };
    case 'resumed': return { kind: 'goal_resumed', repositoryDirectory: directory, goalId: saved.goalId,
      ...(saved.origin === undefined ? {} : { origin: saved.origin }) };
  }
}

export function buildManagerEventPrompt(event: TurnEvent & { unreadableGoalIds?: readonly string[] }): string {
  return JSON.stringify({ event: event.kind === 'goal_resumed' ? { ...event, origin: event.origin ?? 'unknown' } : event, instruction: event.kind === 'patrol'
    ? [
      'Inspect the listed goals together using their current state, saved agreements, and the runs\' latest decisions and evidence. Determine the next actions for each goal and record the inspection.',
      'Report goals in unreadableGoalIds as unverified and continue inspecting those you could retrieve.',
    ].join('\n\n')
    : 'To advance the assigned goals, compare the change conveyed by this event with the current state. Decide the next work to arrange and whether to accept results based on the runs\' decisions and evidence and the saved results.' });
}
