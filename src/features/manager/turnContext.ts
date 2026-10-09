import { join } from 'node:path';
import type { Goal, GoalEvent } from '../../infra/goals/schema.js';
import type { TaskState } from '../../infra/task/types.js';
import { boundedRecords, jsonBytes as bytes, selectRecordPage } from '../../shared/utils/bounded-records.js';

export const GOAL_TURN_MAX_BYTES = 64 * 1024;
const SECTION_BYTES = 3 * 1024;

function boundedText(text: string, budget: number): string {
  if (bytes(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(text.slice(0, middle) + '…') <= budget) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low) + '…';
}

export function buildGoalTurnContext(cwd: string, goal: Goal, event: GoalEvent, tasks: readonly TaskState[]): string {
  const source = join(cwd, '.takt', 'goals', goal.id, 'goal.json');
  const omissions: Record<string, unknown> = {};
  const section = <T>(name: string, records: readonly T[], tool: string, recordSource = source): T[] => {
    const page = boundedRecords(records, 0, 20, SECTION_BYTES);
    omissions[name] = { total: page.total, omitted: page.omitted, nextOffset: page.nextOffset,
      oversized: page.oversized, source: recordSource, tool };
    return page.records;
  };
  const decisions = goal.decisions ?? [];
  // Recent decisions are useful context; older records remain available by offset and file reference.
  const recentPage = selectRecordPage(decisions.length, 0, 20, SECTION_BYTES, (index) => bytes(decisions[decisions.length - 1 - index]));
  const recentDecisions = decisions.slice(decisions.length - recentPage.endOffset);
  omissions.decisions = { total: decisions.length, omitted: decisions.length - recentDecisions.length,
    source, tool: 'takt_list_goal_decisions' };
  const relatedTasks = tasks.filter((task) => task.goalId === goal.id);
  const eventText = (field: string, text: string): string => {
    const bounded = boundedText(text, SECTION_BYTES);
    if (bounded !== text) omissions[`event.${field}`] = { truncated: true, source, eventIndex: goal.events?.findIndex((saved) => saved.id === event.id) };
    return bounded;
  };
  const context = {
    goal: {
      id: goal.id, objective: boundedText(goal.objective, SECTION_BYTES),
      outOfScope: section('outOfScope', goal.outOfScope, 'takt_get_goal'),
      acceptanceCriteria: section('acceptanceCriteria', goal.acceptanceCriteria, 'takt_get_goal'),
      acceptanceCriteriaVersion: goal.acceptanceCriteriaVersion, status: goal.status, executionStatus: goal.executionStatus,
      branch: goal.branch, integrationBranch: goal.integrationBranch,
      completion: section('completion', goal.completion === undefined ? [] : [goal.completion], 'takt_get_goal'),
      workUnits: section('workUnits', goal.workUnits ?? [], 'takt_get_goal'),
      events: section('events', (goal.events ?? []).filter((saved) => !saved.processed), 'takt_get_goal'),
      decisions: recentDecisions,
      questions: section('questions', (goal.questions ?? []).filter((question) => question.status === 'pending'), 'takt_list_goal_questions'),
      operations: section('operations', (goal.operations ?? []).filter((operation) => operation.eventId === event.id), 'takt_list_goal_operations'),
    },
    event: event.kind === 'completion' ? { id: event.id, kind: event.kind,
      taskName: eventText('taskName', event.taskName), runSlug: eventText('runSlug', event.runSlug),
      result: Object.fromEntries(Object.entries(event.result).map(([key, value]) => [key, typeof value === 'string' ? eventText(`result.${key}`, value) : value])) }
      : event.kind === 'answer' ? { id: event.id, kind: event.kind, questionId: event.questionId,
        answer: { ...event.answer, text: eventText('answer.text', event.answer.text) } }
        : { id: event.id, kind: event.kind, requestId: eventText('requestId', event.requestId),
          result: section('delegationResult', [event.result], 'takt_get_goal'), evidenceRefs: section('evidenceRefs', event.evidenceRefs, 'takt_get_goal') },
    tasks: section('tasks', relatedTasks.map((task) => ({ name: task.name, status: task.status, branch: task.branch,
      sha: task.completion?.sha, completion: task.completion,
      references: { runSlug: task.runSlug, taskDirectory: task.taskDir, worktree: task.worktreePath, queue: task.filePath } })), 'takt_list_tasks', join(cwd, '.takt', 'tasks.yaml')),
    references: { goal: source, tasks: join(cwd, '.takt', 'tasks.yaml') }, omissions,
  };
  omissions.objective = { truncated: context.goal.objective !== goal.objective, source };
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized, 'utf8') > GOAL_TURN_MAX_BYTES) throw new Error('Goal turn references exceed the input budget');
  return serialized;
}
