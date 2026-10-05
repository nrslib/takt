import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export const goalId = '550e8400-e29b-41d4-a716-446655440000';

export function goalInput() {
  return {
    objective: 'ローカルのゴールを管理する',
    outOfScope: ['GitHub連携'],
    acceptanceCriteria: ['MCPから登録したゴールを読み取れる'],
    creationOrigin: 'human' as 'human' | 'director',
  };
}

export function goalRecord() {
  return {
    id: goalId,
    ...goalInput(),
    mode: 'local' as const,
    status: 'created' as const,
    branch: 'takt/20261004T1443-goal-550e8400',
    startBranch: 'main',
    integrationBranch: 'main',
    confirmation: {
      confirmedAt: '2026-10-04T14:43:00.000Z',
      confirmedBy: 'reviewer',
    },
  };
}

export function confirmationKeys() {
  const keys = generateKeyPairSync('ed25519');
  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function confirmationPayload(cwd: string) {
  return {
    id: goalId,
    projectRoot: cwd,
    ...goalInput(),
    ...goalRecord().confirmation,
  };
}

export function signedConfirmation(payload: object, privateKey: KeyObject) {
  const serialized = JSON.stringify(payload);
  return {
    payload: serialized,
    signature: sign(null, Buffer.from(serialized, 'utf-8'), privateKey).toString('base64'),
  };
}
