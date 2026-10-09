import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';
import { GoalStore } from './store.js';
import { GoalIdSchema, type Goal, type GoalOperation } from './schema.js';

export const GOAL_EVENT_CONTEXT_ENV = 'TAKT_MANAGER_GOAL_EVENT_CONTEXT';
export interface GoalEventContext { goalId: string; eventId: string }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function withGoalWrites<T>(cwd: string, goalId: string, action: () => Promise<T>): Promise<T> {
  return runPrivateFileExclusiveAsync(join(cwd, '.takt', 'goals', GoalIdSchema.parse(goalId), 'operations.lock'), action);
}

export function prepareGoalOperation(
  goal: Goal, context: GoalEventContext, operationName: string | undefined,
  tool: GoalOperation['tool'], input: Record<string, unknown>,
): GoalOperation {
  if (operationName === undefined || operationName.trim().length === 0) throw new Error('Event operations require an operationName');
  if (!goal.events?.some((event) => event.id === context.eventId)) throw new Error('Goal event does not exist');
  const id = createHash('sha256').update(JSON.stringify([context.eventId, operationName])).digest('hex');
  const args = canonical(input) as Record<string, unknown>;
  const previous = goal.operations?.find((operation) => operation.id === id);
  if (previous !== undefined) {
    if (previous.tool !== tool || JSON.stringify(canonical(previous.arguments)) !== JSON.stringify(args)) {
      throw new Error('Operation name already has different arguments or tool');
    }
    return previous;
  }
  const operation: GoalOperation = { id, eventId: context.eventId, operationName, tool,
    arguments: args, status: 'pending', recordedAt: new Date().toISOString() };
  return operation;
}

export async function beginGoalOperation(store: GoalStore, goalId: string, operation: GoalOperation): Promise<void> {
  await store.update(goalId, (current) => current.operations?.some((saved) => saved.id === operation.id)
    ? current : { ...current, operations: [...(current.operations ?? []), operation] });
}

function operationsIncluding(goal: Goal, operation: GoalOperation): GoalOperation[] {
  return goal.operations?.some((saved) => saved.id === operation.id)
    ? goal.operations : [...(goal.operations ?? []), operation];
}

export function finishGoalOperation(goal: Goal, operation: GoalOperation | undefined, result: Record<string, unknown>): Goal {
  if (operation === undefined) return goal;
  const operations = operationsIncluding(goal, operation);
  return { ...goal, operations: operations.map((saved) => saved.id === operation.id
    ? { ...saved, status: 'completed', result } : saved) };
}

export async function saveGoalOperationRecovery(
  store: GoalStore, goalId: string, operation: GoalOperation, recovery: Record<string, unknown>,
): Promise<void> {
  await store.update(goalId, (goal) => {
    const operations = operationsIncluding(goal, operation);
    return { ...goal, operations: operations.map((saved) => saved.id === operation.id
      ? { ...saved, recovery } : saved) };
  });
}
