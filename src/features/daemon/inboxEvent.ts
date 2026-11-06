import type { TurnEvent } from '../../core/daemon/events.js';
import type { ManagerEvent } from '../../infra/goals/events.js';

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
    case 'answer': return { kind: 'inquiry_answered', repositoryDirectory: directory,
      goalId: saved.goalId, questionId: saved.questionId, answer: saved.answer };
    case 'registered': case 'resumed': return { kind: saved.kind === 'registered' ? 'goal_registered' : 'goal_resumed',
      repositoryDirectory: directory, goalId: saved.goalId };
  }
}
