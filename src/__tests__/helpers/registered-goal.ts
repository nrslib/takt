import { createGoal } from '../../infra/goals/service.js';
import type { GoalCreateInput } from '../../infra/goals/schema.js';
import { confirmationKeys, confirmationPayload, goalId, goalInput, signedConfirmation } from './goal-fixtures.js';

export async function registerFixtureGoal(cwd: string, overrides: Partial<Omit<GoalCreateInput, 'cwd' | 'confirmation'>> & { id?: string } = {}) {
  const { id = goalId, ...summaryOverrides } = overrides;
  const summary = { ...goalInput(), ...summaryOverrides };
  const keys = confirmationKeys();
  return createGoal({
    cwd, ...summary,
    confirmation: signedConfirmation({ ...confirmationPayload(cwd), ...summary, id }, keys.privateKey),
  }, keys.publicKey);
}
