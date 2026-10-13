import { join } from 'node:path';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';
import { createGoalBranch, prepareGoalBranch, removeGoalBranch } from './git.js';
import { GoalCreateInputSchema, GoalSchema, type Goal, type GoalCreateInput } from './schema.js';
import { GoalStore } from './store.js';

export async function createGoal(input: GoalCreateInput): Promise<Goal> {
  input = GoalCreateInputSchema.parse(input);
  const store = new GoalStore(input.cwd);
  return runPrivateFileExclusiveAsync(
    join(input.cwd, '.takt', 'goals', input.id, 'registration.lock'),
    async () => {
      store.assertAbsent(input.id);
      const prepared = prepareGoalBranch(input.cwd, input.id, input.startBranch, input.integrationBranch);
      const { commit, ...branches } = prepared;
      const goal = GoalSchema.parse({
        id: input.id,
        objective: input.objective,
        outOfScope: input.outOfScope,
        acceptanceCriteria: input.acceptanceCriteria,
        constraints: input.constraints,
        workLog: [],
        mode: 'local',
        status: 'created',
        executionStatus: 'active',
        acceptanceCriteriaVersion: 1,
        ...branches,
      });
      createGoalBranch(input.cwd, goal.branch, commit);
      try {
        return await store.create(goal);
      } catch (error) {
        try {
          // A failure after publication (including lock release) must not
          // remove the branch referenced by an already saved record.
          store.assertAbsent(input.id);
          removeGoalBranch(input.cwd, goal.branch, commit);
        } catch (compensationError) {
          throw new AggregateError([error, compensationError],
            `Goal publication and branch compensation failed: ${goal.branch}`);
        }
        throw error;
      }
    },
  );
}
