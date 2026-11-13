import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { validateWorkerUrl, WorkerRequestSchema, executionIdentity, sameExecution } from '../core/worker-pool/remoteProtocol.js';

describe('remote worker protocol', () => {
  it.each([false, true])('requires explicit execution capability canExecute=%s at connection', (canExecute) => {
    const connect = { kind: 'connect', protocolVersion: 1, requestId: 'connect', workerId: 'w1',
      registrationGeneration: randomUUID(), version: '1.0', active: [], canExecute };
    expect(WorkerRequestSchema.parse(connect)).toEqual(connect);
    for (const value of [undefined, null, 'true']) {
      expect(WorkerRequestSchema.safeParse({ ...connect, canExecute: value }).success).toBe(false);
    }
  });
  it.each(['http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234', 'https://daemon.example.test'])
    ('accepts an allowed daemon URL %s', (value) => { expect(validateWorkerUrl(value).href).toBe(new URL(value).href); });
  it.each(['http://0.0.0.0:1234', 'http://localhost.example.test', 'http://192.0.2.1', 'ftp://localhost'])
    ('rejects an unprotected daemon URL %s', (value) => { expect(() => validateWorkerUrl(value)).toThrow(/HTTPS/); });
  it('rejects embedded credentials without exposing them in the error', () => {
    expect(() => validateWorkerUrl('https://name:secret@example.test')).toThrow('Daemon URL must not contain credentials, query or fragment');
  });
  it('validates pull identities and rejects unknown protocol versions', () => {
    const pull = { kind: 'pull', protocolVersion: 1, requestId: 'r1', workerId: 'w1', registrationGeneration: randomUUID() };
    expect(WorkerRequestSchema.parse(pull)).toEqual(pull);
    expect(WorkerRequestSchema.safeParse({ ...pull, protocolVersion: 2 }).success).toBe(false);
    expect(WorkerRequestSchema.safeParse({ ...pull, requestId: '' }).success).toBe(false);
  });
  it('compares every ownership field without treating the lease as an execution identifier', () => {
    const current = { projectId: 'p', taskName: 't', workerId: 'w1', registrationGeneration: randomUUID(),
      executionId: randomUUID(), assignmentGeneration: 2, leaseExpiresAt: 100 };
    const renewed = { ...current, leaseExpiresAt: 200 };
    expect(sameExecution(executionIdentity(current), renewed)).toBe(true);
    for (const changed of [{ projectId: 'other' }, { taskName: 'other' }, { workerId: 'w2' },
      { registrationGeneration: randomUUID() }, { executionId: randomUUID() }, { assignmentGeneration: 1 }]) {
      expect(sameExecution(current, { ...current, ...changed })).toBe(false);
    }
  });
});
