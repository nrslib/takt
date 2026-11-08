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

export function buildManagerEventPrompt(event: TurnEvent & { unreadableGoalIds?: readonly string[] }): string {
  return JSON.stringify({ event, instruction: event.kind === 'patrol'
    ? [
      'To support progress toward completion, read the runs\' decisions and evidence for the listed goals together. When the approach is sound, leave the work with the run and record the inspection. To uphold the agreement with the person, assess review findings during an intervention by distinguishing the requested outcomes, underlying assumptions, and proposed methods. Preserve the outcomes and checks needed under the actual conditions while adjusting additional work based on the evidence. When statements in the agreement appear to conflict, continue work following the judgment of the reviewers and the run, record the discrepancy in the work log, and inform the person. Apply changes to the agreement based on the person\'s decision.',
      'Intervene when evidence from code, configuration, or documentation shows that effort is going into preparations for assumptions that cannot hold, a threat model that does not fit the actual entry points, trust boundaries, or execution paths, or mechanisms that do not contribute to the objective. Give the run the evidence and the adjustment needed to focus effort on the required results and checks.',
      'Report goals in unreadableGoalIds as unverified and continue inspecting those you could retrieve.',
    ].join('\n\n')
    : 'To advance the assigned goals, compare the change conveyed by this event with the current state. Decide the next work to arrange and whether to accept results based on the runs\' decisions and evidence and the saved results.' });
}
