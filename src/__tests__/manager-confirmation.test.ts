import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { verifyGoalConfirmation } from '../infra/goals/confirmation.js';
import { GoalIdSchema } from '../infra/goals/schema.js';

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, sign: vi.fn(original.sign), generateKeyPairSync: vi.fn(original.generateKeyPairSync) };
});
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, writeFileSync: vi.fn(), appendFileSync: vi.fn() };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, writeFile: vi.fn(), appendFile: vi.fn() };
});

const cwd = '/test/manager-repository';
const summary = {
  objective: 'JSONを出力する',
  outOfScope: ['CSV出力'],
  acceptanceCriteria: ['JSON形式でダウンロードできる'],
  startBranch: 'release',
  integrationBranch: 'main',
};

beforeEach(() => { vi.clearAllMocks(); });

describe('manager host confirmation', () => {
  it('does not sign when the host confirmation authority is created', () => {
    createGoalConfirmation(cwd);

    expect(crypto.sign).not.toHaveBeenCalled();
  });

  it('signs the displayed summary with host-owned identity and an Ed25519 key', () => {
    const authority = createGoalConfirmation(cwd);

    const request = authority.sign(summary);
    const confirmed = verifyGoalConfirmation(request, authority.publicKey);

    expect(request).toMatchObject({ cwd, ...summary, creationOrigin: 'human' });
    expect(GoalIdSchema.safeParse(confirmed.id).success).toBe(true);
    expect(Number.isNaN(Date.parse(confirmed.confirmedAt))).toBe(false);
    expect(confirmed.confirmedBy.trim().length).toBeGreaterThan(0);
    expect(crypto.createPublicKey(authority.publicKey).asymmetricKeyType).toBe('ed25519');
    expect(crypto.sign).toHaveBeenCalledTimes(1);
  });

  it('keeps the private key out of persisted data and the goal creation request', () => {
    const authority = createGoalConfirmation(cwd);
    const request = authority.sign(summary);
    const generated = vi.mocked(crypto.generateKeyPairSync).mock.results;
    const privateKeys = generated.map(({ value }) => (value as { privateKey: crypto.KeyObject }).privateKey);
    const writes = [fs.writeFileSync, fs.appendFileSync, fsPromises.writeFile, fsPromises.appendFile]
      .flatMap((write) => vi.mocked(write).mock.calls.map((args) => Buffer.isBuffer(args[1]) ? args[1] : Buffer.from(String(args[1]))));
    const transferred = [Buffer.from(JSON.stringify(request)), ...writes];

    expect(privateKeys.length).toBeGreaterThan(0);
    for (const key of privateKeys) {
      const pem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
      const der = key.export({ type: 'pkcs8', format: 'der' });
      expect(transferred.some((value) => value.includes(pem) || value.includes(der) || value.includes(der.toString('base64')))).toBe(false);
    }
    expect(transferred.some((value) => /PRIVATE KEY/u.test(value.toString()))).toBe(false);
  });
});
