import { join } from 'node:path';
import type { Goal } from '../../infra/goals/schema.js';
import type { ManagerEvent } from '../../infra/goals/events.js';
import type { TaskState } from '../../infra/task/types.js';
import { goalSummary } from '../mcp/goalResponse.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';

const GOAL_MEMORY_MAX_BYTES = 64 * 1024;
const goalRetrieval = 'Read details from the referenced goal file or use takt_get_goal with path, recordId and offset/limit or textOffset/maxBytes. Use takt_list_goals with offset/limit for omitted goals. Read only the needed ranges.';

export function buildManagerGoalSummary(cwd: string, goal: Goal, tasks: readonly TaskState[]) {
  const summary = goalSummary(goal);
  const goalTasks = tasks.filter((task) => task.goalId === goal.id);
  const taskStates: Partial<Record<TaskState['status'], number>> = {};
  for (const task of goalTasks) taskStates[task.status] = (taskStates[task.status] ?? 0) + 1;
  return {
    id: goal.id, objective: summary.objective, status: goal.status, executionStatus: goal.executionStatus,
    branch: truncateUtf8(goal.branch, 256).value, integrationBranch: truncateUtf8(goal.integrationBranch, 256).value,
    taskCount: goalTasks.length, taskStates,
    workUnitCount: new Set(goalTasks.flatMap((task) => task.goalWorkKey === undefined ? [] : [task.goalWorkKey])).size,
    pendingQuestionCount: summary.pendingQuestionCount, questions: summary.questions,
    workLogCount: summary.workLogCount, workLog: summary.workLog,
    references: { goal: join(cwd, '.takt', 'goals', goal.id, 'goal.json') },
    truncated: true, retrieval: goalRetrieval,
  };
}

export function buildGoalMemory(repositories: readonly {
  repositoryDirectory: string;
  goals: ReturnType<typeof buildManagerGoalSummary>[] | undefined;
  diagnostics: { goalId?: string; message: string }[];
}[]): string {
  const memory: typeof repositories[number][] = [];
  let truncated = false;
  const serialize = () => JSON.stringify({ repositories: memory, repositoryCount: repositories.length, truncated, retrieval: goalRetrieval });
  for (const repository of repositories) {
    const goals: ReturnType<typeof buildManagerGoalSummary>[] | undefined = repository.goals === undefined ? undefined : [];
    const entry = { ...repository, goals,
      diagnostics: repository.diagnostics.slice(0, 3).map((diagnostic) => ({
        ...diagnostic, message: truncateUtf8(diagnostic.message, 256).value,
      })),
      goalCount: repository.goals?.length, diagnosticCount: repository.diagnostics.length,
    };
    memory.push(entry);
    if (Buffer.byteLength(serialize()) > GOAL_MEMORY_MAX_BYTES) {
      memory.pop();
      truncated = true;
      break;
    }
    for (const goal of repository.goals ?? []) {
      entry.goals!.push(goal);
      if (Buffer.byteLength(serialize()) > GOAL_MEMORY_MAX_BYTES) {
        entry.goals!.pop();
        truncated = true;
        break;
      }
    }
    if (repository.diagnostics.length > entry.diagnostics.length) truncated = true;
  }
  return serialize();
}

export function buildGoalTurnContext(cwd: string, goal: Goal, event: ManagerEvent, tasks: readonly TaskState[]): string {
  const observedAt = new Date().toISOString();
  const lastProgressAt = goal.workLog.filter((record) => record.kind !== 'patrol').at(-1)?.recordedAt ?? goal.createdAt;
  return JSON.stringify({
    repositoryDirectory: cwd,
    event,
    goal: buildManagerGoalSummary(cwd, goal, tasks),
    tasks: tasks.filter((task) => task.goalId === goal.id),
    ...(event.kind === 'patrol' ? {
      patrol: {
        observedAt,
        lastProgressAt,
      },
    } : {}),
    references: { goal: join(cwd, '.takt', 'goals', goal.id, 'goal.json'), tasks: join(cwd, '.takt', 'tasks.yaml') },
  });
}
