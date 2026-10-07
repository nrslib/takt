import { beforeEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), alive: vi.fn(), identity: vi.fn() }));
vi.mock('../shared/utils/private-file.js', () => ({ ensurePrivateDirectory: vi.fn(), readPrivateFileState: doubles.read, writePrivateFile: doubles.write }));
vi.mock('../shared/utils/private-file-lock.js', () => ({ runPrivateFileExclusive: (_path: string, action: () => unknown) => action() }));
vi.mock('../infra/task/process.js', async (original) => ({ ...await original<typeof import('../infra/task/process.js')>(), isProcessAlive: doubles.alive, getProcessIdentity: doubles.identity }));
vi.mock('../infra/config/host-state.js', () => ({ hostProjectStateDirectory: () => '/host/project' }));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: vi.fn(), lstatOrUndefined: () => ({}) }));
import {
  MANAGER_RUN_TOKEN_ENV, adoptManagerReservation, assertManagerReservationAllowsExecution,
  processRecord, readManagerRunState, recoverManagerReservation, requestManagerRun,
  withProjectRunCoordination, writeManagerRunState, type ManagerRunState,
} from '../infra/task/manager-run-state.js';
const token = '550e8400-e29b-41d4-a716-446655440000';
let state: ManagerRunState;
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  state = { requested: false, failures: [] };
  doubles.read.mockImplementation((path: string) => ({ content: Buffer.from(JSON.stringify(path.startsWith('/host/')
    ? { requested: state.requested, reservation: state.reservation } : { failures: state.failures })) }));
  doubles.write.mockImplementation((path: string, content: string) => {
    const saved = JSON.parse(content) as ManagerRunState;
    state = path.startsWith('/host/') ? { ...saved, failures: state.failures } : { ...state, failures: saved.failures };
  });
  doubles.alive.mockReturnValue(false);
});
describe('manager startup reservation', () => {
  it('consumes a queued launch request when a manual run takes execution ownership', () => {
    state.requested = true;
    adoptManagerReservation('/project', 'manual-owner');
    expect(state).toEqual({ requested: false, failures: [] });
  });
  it('publishes enqueue requests inside project coordination and preserves diagnostics', () => {
    state.failures = [{ id: token, message: 'spawn failed', at: '2026-10-06T00:00:00Z' }];
    withProjectRunCoordination('/project', () => requestManagerRun('/project'));
    expect(readManagerRunState('/project')).toEqual({ ...state, requested: true });
    expect(processRecord(10, { startTime: 'start' })).toEqual({ pid: 10, startTime: 'start' });
  });
  it('reads absence as an unreserved state and rejects malformed saved state', () => {
    doubles.read.mockReturnValueOnce({ state: { exists: false } });
    expect(readManagerRunState('/project')).toEqual({ requested: false, failures: [] });
    expect(() => writeManagerRunState('/project', { ...state, requested: 'yes' } as unknown as ManagerRunState)).toThrow();
  });
  it.each(['launcher', 'child'] as const)('keeps a live %s even when its identity is unknown', (owner) => {
    state.reservation = { token, launcher: { pid: 10, startTime: 'old' }, child: { pid: 20 } };
    doubles.alive.mockImplementation((pid: number) => pid === (owner === 'launcher' ? 10 : 20));
    expect(recoverManagerReservation('/project').reservation).toEqual(state.reservation);
    expect(doubles.write).not.toHaveBeenCalled();
  });
  it('recovers dead owners and PID reuse without discarding work requests or diagnostics', () => {
    state.requested = true;
    state.reservation = { token, launcher: { pid: 10, startTime: 'darwin-start-v1:1791244800:100000' } };
    doubles.alive.mockReturnValue(true);
    doubles.identity.mockReturnValue({ startTime: 'darwin-start-v1:1791244800:200000' });
    expect(recoverManagerReservation('/project')).toEqual({ requested: true, failures: [] });
  });
  it.each(['launcher', 'child'] as const)('compares the real %s identity before keeping or recovering a reservation', (owner) => {
    const recorded = 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440001';
    state.reservation = { token, launcher: { pid: 10, startTime: recorded }, ...(owner === 'child' ? { child: { pid: 20, startTime: recorded } } : {}) };
    const original = structuredClone(state.reservation);
    doubles.alive.mockImplementation((pid: number) => pid === (owner === 'launcher' ? 10 : 20));
    doubles.identity.mockReturnValue({ startTime: recorded });
    expect(recoverManagerReservation('/project').reservation).toEqual(original);
    doubles.identity.mockReturnValue(undefined);
    expect(recoverManagerReservation('/project').reservation).toEqual(original);
    doubles.identity.mockReturnValue({ startTime: 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440002' });
    expect(recoverManagerReservation('/project')).toEqual({ requested: true, failures: [] });
  });
  it('refuses other run entrants and records the adopting owner atomically', () => {
    state.reservation = { token, launcher: { pid: 10, startTime: 'start' } };
    state.requested = true;
    doubles.alive.mockReturnValue(true);
    expect(() => assertManagerReservationAllowsExecution('/project')).toThrow('reserved');
    vi.stubEnv(MANAGER_RUN_TOKEN_ENV, token);
    expect(() => assertManagerReservationAllowsExecution('/project')).not.toThrow();
    adoptManagerReservation('/project', 'execution-owner');
    expect(state).toMatchObject({ requested: false, reservation: { token, adoptedOwnerId: 'execution-owner' } });
    vi.unstubAllEnvs();
    expect(() => assertManagerReservationAllowsExecution('/project')).not.toThrow();
  });
  it('recovers a stopped unadopted reservation as a request but does not recreate an adopted request', () => {
    state.reservation = { token, launcher: { pid: 10 }, child: { pid: 20 } };
    expect(recoverManagerReservation('/project')).toEqual({ requested: true, failures: [] });
    state = { requested: false, failures: [], reservation: { token, launcher: { pid: 10 }, adoptedOwnerId: 'old-owner' } };
    expect(recoverManagerReservation('/project')).toEqual(state);
    expect(state.requested).toBe(false);
  });
});
