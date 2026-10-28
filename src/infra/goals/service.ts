import { createGoalBranch, prepareGoalBranch, removeGoalBranch } from './git.js';
import { GoalCreateInputSchema, GoalSchema, type Goal, type GoalCreateInput } from './schema.js';
import { GoalStore } from './store.js';
import { readManagerEvents, saveManagerEvent } from './events.js';
import { runGoalGit } from './git-command.js';
import { TaskRunner } from '../task/runner.js';
import { getGlobalConfigDir } from '../config/paths.js';
import { registerProject } from '../config/global/projectRegistry.js';

export async function createGoal(input: GoalCreateInput, signal?: AbortSignal): Promise<Goal> {
  signal?.throwIfAborted();
  input = GoalCreateInputSchema.parse(input);
  const store = new GoalStore(input.cwd);
  store.assertAbsent(input.id);
  await registerProject({ globalConfigDirectory: getGlobalConfigDir(), projectDirectory: input.cwd, command: 'manager', managerUsed: true });
  signal?.throwIfAborted();
  const { commit, ...branches } = await prepareGoalBranch(input.cwd, input.id, input.startBranch, input.integrationBranch, signal);
  signal?.throwIfAborted();
  const goal = GoalSchema.parse({
    id: input.id, createdAt: new Date().toISOString(), objective: input.objective, outOfScope: input.outOfScope,
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

export class GoalRegistrationRecoveryError extends Error {
  readonly code = 'registration_recovery';
}

export async function registerReservedGoal(input: GoalCreateInput, signal?: AbortSignal): Promise<Goal> {
  signal?.throwIfAborted();
  input = GoalCreateInputSchema.parse(input);
  const existing = new GoalStore(input.cwd).find(input.id);
  if (existing !== undefined) {
    if (existing.objective !== input.objective
      || JSON.stringify(existing.outOfScope) !== JSON.stringify(input.outOfScope)
      || JSON.stringify(existing.acceptanceCriteria) !== JSON.stringify(input.acceptanceCriteria)
      || JSON.stringify(existing.constraints) !== JSON.stringify(input.constraints)
      || (input.startBranch !== undefined && existing.startBranch !== input.startBranch)
      || (input.integrationBranch !== undefined && existing.integrationBranch !== input.integrationBranch)) {
      throw new GoalRegistrationRecoveryError('Reserved goal conflicts with the approved proposal');
    }
    if (!readManagerEvents(input.cwd).some(({ event }) => event.goalId === input.id && event.kind === 'registered')
      && existing.workLog.length === 0 && existing.status === 'created'
      && !new TaskRunner(input.cwd).listTaskStateItems().some((task) => task.goalId === input.id)) {
      throw new GoalRegistrationRecoveryError('Goal exists, but registration event delivery cannot be confirmed');
    }
    return existing;
  }
  const refs = await runGoalGit(input.cwd, ['for-each-ref', '--format=%(refname)', `refs/heads/takt/*-goal-${input.id.slice(0, 8)}`], 1024, signal);
  signal?.throwIfAborted();
  if (refs.truncated || refs.output.length > 0) {
    throw new GoalRegistrationRecoveryError('A branch for this reservation requires explicit reconciliation');
  }
  return createGoal(input, signal);
}
