import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { validateWorkerUrl, WorkerRequestSchema, executionIdentity, sameExecution } from '../core/worker-pool/remoteProtocol.js';
import { RemoteControlSchema, RemoteInputManifestSchema, RemoteRecordSchema, isRemoteRunArtifactPath } from '../core/worker-pool/remoteExecutionProtocol.js';

describe('remote worker protocol', () => {
  it('preserves attachments in child contexts while excluding daemon intervention state and transient files', () => {
    for (const path of ['context/task/attachments/data.lock',
      'context/subworkflows/child/task/attachments/data.lock',
      'context/task/attachments/meta.json.123.12345678-1234-1234-1234-123456789abc.tmp',
      'reports/requested.tmp',
      'reports/.takt-report-internal/executions/versions/result.md']) {
      expect(isRemoteRunArtifactPath(path)).toBe(true);
    }
    for (const path of ['interventions.jsonl', 'reports/.takt-report-internal/locks/report.lock', '.meta.json.write.tmp',
      'meta.json.123.12345678-1234-1234-1234-123456789abc.tmp',
      'context/subworkflows/child/workflow-results.json.456.12345678-1234-1234-1234-123456789abc.tmp']) {
      expect(isRemoteRunArtifactPath(path)).toBe(false);
    }
  });
  it('rejects unsupported, oversized or ambiguous input manifests', () => {
    const file = { path: 'order.md', size: 1, sha256: 'a'.repeat(64) };
    const valid = { version: 1, runSlug: 'remote-run', directories: [], files: [file] };
    expect(RemoteInputManifestSchema.parse(valid)).toEqual(valid);
    for (const invalid of [{ ...valid, version: 2 }, { ...valid, files: [file, file] },
      { ...valid, files: [{ ...file, path: '../order.md' }] }, { ...valid, files: [{ ...file, size: 65 * 1024 * 1024 }] },
      { ...valid, files: [{ ...file, sha256: 'wrong' }] }]) expect(RemoteInputManifestSchema.safeParse(invalid).success).toBe(false);
  });
  it('requires canonical relative paths and bounded binary record chunks', () => {
    const valid = { sequence: 1, runSlug: 'remote-run', path: 'logs/session.jsonl', offset: 0,
      mode: 'append', final: true, data: 'AA==', sha256: 'a'.repeat(64) };
    expect(RemoteRecordSchema.parse(valid)).toEqual(valid);
    for (const path of ['/absolute', '../outside', 'a/../b', 'a\\b', 'a//b', 'a\0b', 'x'.repeat(4097)]) {
      expect(RemoteRecordSchema.safeParse({ ...valid, path }).success).toBe(false);
    }
    expect(RemoteRecordSchema.safeParse({ ...valid, data: '!not-base64!' }).success).toBe(false);
    expect(RemoteRecordSchema.safeParse({ ...valid, sequence: 0 }).success).toBe(false);
  });
  it('keeps record and control sequences within the safe integer range', () => {
    const cases = [
      { schema: RemoteRecordSchema, value: { sequence: 1, runSlug: 'remote-run', path: 'logs/session.jsonl', offset: 0,
        mode: 'append', final: true, data: 'AA==', sha256: 'a'.repeat(64) } },
      { schema: RemoteControlSchema, value: { sequence: 1, kind: 'stop', issuedAt: '2026-11-13T00:00:00Z' } },
    ];
    for (const { schema, value } of cases) {
      expect(schema.safeParse({ ...value, sequence: Number.MAX_SAFE_INTEGER }).success).toBe(true);
      expect(schema.safeParse({ ...value, sequence: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    }
  });
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
  it('rejects a successful completion without artifact identity and final run sequence', () => {
    const identity = { workerId: 'w1', registrationGeneration: randomUUID() };
    expect(WorkerRequestSchema.safeParse({ ...identity, protocolVersion: 1, requestId: 'complete', kind: 'complete',
      assignment: { ...identity, projectId: '/project', taskName: 'task', executionId: randomUUID(), assignmentGeneration: 1 },
      success: true }).success).toBe(false);
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
