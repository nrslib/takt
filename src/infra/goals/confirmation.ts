import { createPublicKey, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GoalConfirmationPayloadSchema, GoalCreateInputSchema } from './schema.js';

export function verifyGoalConfirmation(input: unknown, publicKey: string | undefined) {
  if (publicKey === undefined) {
    throw new Error('A trusted goal confirmation public key is required');
  }
  const { cwd, confirmation, ...requestedSummary } = GoalCreateInputSchema.parse(input);
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Goal confirmation requires an Ed25519 public key');
  }
  if (!verify(null, Buffer.from(confirmation.payload, 'utf8'), key,
    Buffer.from(confirmation.signature, 'base64'))) {
    throw new Error('Invalid goal confirmation signature');
  }
  const raw: unknown = JSON.parse(confirmation.payload);
  const payload = GoalConfirmationPayloadSchema.parse(raw);
  const { id, projectRoot, confirmedAt, confirmedBy, ...confirmedSummary } = payload;
  if (projectRoot !== cwd || !isDeepStrictEqual(confirmedSummary, requestedSummary)) {
    throw new Error('Goal input does not match the confirmed summary');
  }
  return { id, confirmedAt, confirmedBy };
}
