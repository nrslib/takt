import { describe, expect, it } from 'vitest';
import { verifyGoalConfirmation } from '../infra/goals/confirmation.js';
import {
  confirmationKeys, confirmationPayload, goalId, goalInput, signedConfirmation,
} from './helpers/goal-fixtures.js';

describe('Goal human confirmation', () => {
  const cwd = '/project';

  it('accepts trusted signed UTF-8 content and returns the confirmed identity and reviewer', () => {
    const keys = confirmationKeys();
    const payload = confirmationPayload(cwd);
    const input = { cwd, ...goalInput(), confirmation: signedConfirmation(payload, keys.privateKey) };
    expect(verifyGoalConfirmation(input, keys.publicKey)).toMatchObject({
      id: goalId,
      confirmedAt: payload.confirmedAt,
      confirmedBy: payload.confirmedBy,
    });
  });

  it.each([undefined, { confirmedAt: '2026-10-04T14:43:00.000Z', confirmedBy: 'reviewer' }])(
    'rejects missing or self-reported confirmation %#', (confirmation) => {
      const keys = confirmationKeys();
      expect(() => verifyGoalConfirmation({ cwd, ...goalInput(), confirmation }, keys.publicKey)).toThrow();
    },
  );

  it('rejects a signature made with an untrusted key', () => {
    const trusted = confirmationKeys();
    const untrusted = confirmationKeys();
    const input = {
      cwd, ...goalInput(),
      confirmation: signedConfirmation(confirmationPayload(cwd), untrusted.privateKey),
    };
    expect(() => verifyGoalConfirmation(input, trusted.publicKey)).toThrow();
  });

  it('rejects payload bytes modified after signing', () => {
    const keys = confirmationKeys();
    const confirmation = signedConfirmation(confirmationPayload(cwd), keys.privateKey);
    expect(() => verifyGoalConfirmation({
      cwd, ...goalInput(),
      confirmation: { ...confirmation, payload: confirmation.payload.replace('reviewer', 'attacker') },
    }, keys.publicKey)).toThrow();
  });

  it.each([
    { cwd: '/other-project' },
    { objective: '別の目的' },
    { outOfScope: ['別の範囲外'] },
    { acceptanceCriteria: ['別の条件'] },
    { creationOrigin: 'director' },
    { startBranch: 'release' },
    { integrationBranch: 'develop' },
  ])('rejects a request different from the signed summary %#', (changed) => {
    const keys = confirmationKeys();
    expect(() => verifyGoalConfirmation({
      cwd, ...goalInput(), ...changed,
      confirmation: signedConfirmation(confirmationPayload(cwd), keys.privateKey),
    }, keys.publicKey)).toThrow();
  });

  it('rejects creation when no trusted public key is configured', () => {
    const keys = confirmationKeys();
    expect(() => verifyGoalConfirmation({
      cwd, ...goalInput(), confirmation: signedConfirmation(confirmationPayload(cwd), keys.privateKey),
    }, undefined)).toThrow();
  });
});
