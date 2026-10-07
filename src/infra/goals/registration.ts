import { createPublicKey } from 'node:crypto';
import { realpathSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import { hostProjectStateDirectory } from '../config/host-state.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { ensurePrivateDirectory, readPrivateFileState, writeNewPrivateFileWithMode } from '../../shared/utils/private-file.js';
import { verifyGoalConfirmation } from './confirmation.js';
import { GoalCreateInputSchema, GoalIdSchema, GoalSchema, type Goal, type GoalCreateInput } from './schema.js';
import { GoalStore } from './store.js';

const RegistrationSchema = z.object({
  id: GoalIdSchema,
  projectRoot: z.string(),
  input: GoalCreateInputSchema,
  publicKey: z.string().min(1),
  branches: GoalSchema.pick({ branch: true, startBranch: true, integrationBranch: true }),
}).strict();

function registrationPath(cwd: string, id: string): string {
  return join(hostProjectStateDirectory(cwd, 'goal-registrations'), `${GoalIdSchema.parse(id)}.json`);
}

export function saveGoalRegistration(input: GoalCreateInput, publicKey: string, goal: Goal): () => void {
  const filePath = registrationPath(input.cwd, goal.id);
  const record = RegistrationSchema.parse({
    id: goal.id, projectRoot: realpathSync(input.cwd), input,
    publicKey: createPublicKey(publicKey).export({ type: 'spki', format: 'pem' }).toString(),
    branches: { branch: goal.branch, startBranch: goal.startBranch, integrationBranch: goal.integrationBranch },
  });
  const content = `${JSON.stringify(record, null, 2)}\n`;
  ensurePrivateDirectory(dirname(filePath));
  if ('content' in readPrivateFileState(filePath)) throw new Error(`Goal registration already exists: ${goal.id}`);
  const remove = () => {
    const saved = readPrivateFileState(filePath);
    if (!('content' in saved) || saved.content.toString('utf8') !== content) {
      throw new Error('Goal registration changed before compensation');
    }
    unlinkSync(filePath);
  };
  try {
    writeNewPrivateFileWithMode(filePath, content, 0o600);
  } catch (error) {
    try {
      if ('content' in readPrivateFileState(filePath)) remove();
    } catch (compensationError) {
      throw new AggregateError([error, compensationError], 'Goal registration publication and compensation failed');
    }
    throw error;
  }
  return remove;
}

function verifyRegistration(cwd: string, goal: Goal): void {
  const filePath = registrationPath(cwd, goal.id);
  assertSafePath(filePath, false);
  if (lstatOrUndefined(dirname(filePath)) === undefined) throw new Error(`Goal registration is missing: ${goal.id}`);
  const saved = readPrivateFileState(filePath);
  if (!('content' in saved)) throw new Error(`Goal registration is missing: ${goal.id}`);
  const record = RegistrationSchema.parse(JSON.parse(saved.content.toString('utf8')) as unknown);
  const confirmed = verifyGoalConfirmation(record.input, record.publicKey);
  if (record.id !== goal.id || confirmed.id !== goal.id
    || record.projectRoot !== realpathSync(cwd) || realpathSync(record.input.cwd) !== record.projectRoot) {
    throw new Error(`Goal registration belongs to a different project or goal: ${goal.id}`);
  }
  const { objective, outOfScope, acceptanceCriteria, creationOrigin } = record.input;
  if (!isDeepStrictEqual({ objective, outOfScope, acceptanceCriteria, creationOrigin }, {
    objective: goal.objective, outOfScope: goal.outOfScope,
    acceptanceCriteria: goal.acceptanceCriteria, creationOrigin: goal.creationOrigin,
  }) || !isDeepStrictEqual(goal.confirmation, { confirmedAt: confirmed.confirmedAt, confirmedBy: confirmed.confirmedBy })
    || !isDeepStrictEqual(record.branches, { branch: goal.branch, startBranch: goal.startBranch, integrationBranch: goal.integrationBranch })) {
    throw new Error(`Saved goal differs from its confirmed registration: ${goal.id}`);
  }
}

export async function getRegisteredGoal(cwd: string, id: string): Promise<Goal> {
  const goal = await new GoalStore(cwd).get(id);
  verifyRegistration(cwd, goal);
  return goal;
}

export async function listRegisteredGoals(cwd: string) {
  const listed = await new GoalStore(cwd).list();
  const goals: Goal[] = [];
  const errors = [...listed.errors];
  for (const goal of listed.goals) {
    try {
      verifyRegistration(cwd, goal);
      goals.push(goal);
    } catch (error) {
      errors.push({ goalId: goal.id, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return { goals, errors };
}
