import { join } from 'node:path';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';
import { verifyGoalConfirmation } from './confirmation.js';
import { createGoalBranch, prepareGoalBranch, removeGoalBranch } from './git.js';
import { GoalCreateInputSchema, GoalSchema, type Goal, type GoalCreateInput } from './schema.js';
import { GoalStore } from './store.js';
import { saveGoalRegistration } from './registration.js';

export async function createGoal(input: GoalCreateInput, publicKey: string | undefined): Promise<Goal> {
  input = GoalCreateInputSchema.parse(input);
  const confirmed = verifyGoalConfirmation(input, publicKey);
  const store = new GoalStore(input.cwd);
  return runPrivateFileExclusiveAsync(
    join(input.cwd, '.takt', 'goals', confirmed.id, 'registration.lock'),
    async () => {
      store.assertAbsent(confirmed.id);
      const prepared = prepareGoalBranch(input.cwd, confirmed.id, input.startBranch, input.integrationBranch);
      const { commit, ...branches } = prepared;
      const goal = GoalSchema.parse({
        id: confirmed.id,
        objective: input.objective,
        outOfScope: input.outOfScope,
        acceptanceCriteria: input.acceptanceCriteria,
        creationOrigin: input.creationOrigin,
        mode: 'local',
        status: 'created',
        ...branches,
        confirmation: { confirmedAt: confirmed.confirmedAt, confirmedBy: confirmed.confirmedBy },
      });
      createGoalBranch(input.cwd, goal.branch, commit);
      let removeRegistration: (() => void) | undefined;
      try {
        removeRegistration = saveGoalRegistration(input, publicKey!, goal);
        return await store.create(goal);
      } catch (error) {
        try {
          // A failure after publication (including lock release) must not
          // remove the branch referenced by an already saved record.
          store.assertAbsent(confirmed.id);
          removeRegistration?.();
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
