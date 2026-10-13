import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { userInfo } from 'node:os';
import { GoalConfirmationPayloadSchema, GoalCreateInputSchema } from '../../infra/goals/schema.js';
import type { GoalCreateInput } from '../../infra/goals/schema.js';

export type ManagerGoalSummary = Omit<GoalCreateInput, 'cwd' | 'confirmation' | 'creationOrigin'>;
export interface GoalConfirmationAuthority {
  readonly publicKey: string;
  sign(summary: ManagerGoalSummary): GoalCreateInput;
}

export function createGoalConfirmation(cwd: string): GoalConfirmationAuthority {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign(summary) {
      const approved = GoalCreateInputSchema.omit({ cwd: true, confirmation: true })
        .parse({ ...summary, creationOrigin: 'human' });
      const payload = JSON.stringify(GoalConfirmationPayloadSchema.parse({
        ...approved, id: randomUUID(), projectRoot: cwd,
        confirmedAt: new Date().toISOString(), confirmedBy: userInfo().username,
      }));
      return GoalCreateInputSchema.parse({
        ...approved, cwd,
        confirmation: { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') },
      });
    },
  };
}
