import { createGoal } from '../../infra/goals/service.js';
import type { GoalCreateInput } from '../../infra/goals/schema.js';
import { goalId, goalInput } from './goal-fixtures.js';

export async function registerFixtureGoal(cwd: string, overrides: Partial<Omit<GoalCreateInput, 'cwd'>> = {}) {
  return createGoal({ cwd, id: goalId, ...goalInput(), ...overrides });
}
