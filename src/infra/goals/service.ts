import { createGoalBranch, prepareGoalBranch, removeGoalBranch } from './git.js';
import { GoalCreateInputSchema, GoalSchema, type Goal, type GoalCreateInput } from './schema.js';
import { GoalStore } from './store.js';
import { saveManagerEvent } from './events.js';
import { getGlobalConfigDir } from '../config/paths.js';
import { registerProject } from '../config/global/projectRegistry.js';

export async function createGoal(input: GoalCreateInput): Promise<Goal> {
  input = GoalCreateInputSchema.parse(input);
  const store = new GoalStore(input.cwd);
  store.assertAbsent(input.id);
  await registerProject({ globalConfigDirectory: getGlobalConfigDir(), projectDirectory: input.cwd, command: 'manager', managerUsed: true });
  const { commit, ...branches } = prepareGoalBranch(input.cwd, input.id, input.startBranch, input.integrationBranch);
  const goal = GoalSchema.parse({
    id: input.id, objective: input.objective, outOfScope: input.outOfScope,
    acceptanceCriteria: input.acceptanceCriteria, constraints: input.constraints,
    workLog: [], mode: 'local', status: 'created', executionStatus: 'active',
    acceptanceCriteriaVersion: 1, ...branches,
  });
  createGoalBranch(input.cwd, goal.branch, commit);
  try { await store.create(goal); }
  catch (error) {
    removeGoalBranch(input.cwd, goal.branch, commit);
    throw error;
  }
  saveManagerEvent(input.cwd, { kind: 'registered', goalId: goal.id });
  return goal;
}
