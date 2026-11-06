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
    ? 'Inspect all listed active goals together in this patrol turn. Read the latest reports, review findings and intended fixes from running runs, and compare them against the task instructions and acceptance criteria to check for deviations from the requested work. If a run has strayed, use takt_tell_run to explain the deviation and its evidence, and ask it to drop only findings confirmed to be outside the requested work. Do not judge by execution time or step counts, or stop or terminate a run because review and fix cycles have continued for a long time or repeated many times. If unreadableGoalIds are listed, report those goals as unreadable and do not claim that they have no anomalies; continue inspecting the readable goals. Do not propose a new registration. If nothing is wrong, take no action and send no notification; return a short message with the goal count and no anomalies. Record inspection details for each goal using takt_record_goal_work_log with kind: "patrol". If a problem needs attention, use the existing notification or inquiry tools without repeating an earlier notice for the same state and reason.'
    : 'Handle this event for the existing goals. Do not propose a new registration.' });
}
