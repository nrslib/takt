import { dirname, join } from 'node:path';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { hostProjectStateDirectory } from '../config/host-state.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { runPrivateFileExclusive } from '../../shared/utils/private-file-lock.js';
import { ensurePrivateDirectory, readPrivateFileState, writePrivateFile } from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { getProcessIdentity, hasProcessIdentityMismatch, isProcessAlive, type ProcessIdentity } from './process.js';

export const MANAGER_RUN_TOKEN_ENV = 'TAKT_MANAGER_RUN_TOKEN';
const identity = z.object({ pid: z.number().int().positive(), startTime: z.string().min(1).optional() }).strict();
const StateSchema = z.object({
  requested: z.boolean(),
  reservation: z.object({
    token: z.uuid(), launcher: identity, child: identity.optional(),
    adoptedOwnerId: z.string().optional(),
  }).strict().optional(),
  failures: z.array(z.object({ id: z.uuid(), message: z.string(), at: z.string() }).strict()),
}).strict();
export type ManagerRunState = z.infer<typeof StateSchema>;
const AuthoritySchema = StateSchema.omit({ failures: true });
const DiagnosticSchema = StateSchema.pick({ failures: true }).strip();
const STATE_FILE = 'manager-run.json';
const log = createLogger('manager-run-state');

export function readManagerRunFailures(cwd: string): ManagerRunState['failures'] {
  const path = join(cwd, '.takt', STATE_FILE);
  assertSafePath(path, false);
  if (lstatOrUndefined(dirname(path)) === undefined) return [];
  const saved = readPrivateFileState(path);
  return 'content' in saved ? DiagnosticSchema.parse(JSON.parse(saved.content.toString('utf8')) as unknown).failures : [];
}

export function recordManagerRunFailure(cwd: string, error: unknown): void {
  const failure = { id: randomUUID(), message: sanitizeSensitiveText(getErrorMessage(error)), at: new Date().toISOString() };
  log.error('Manager automatic processing stopped', { error: failure.message });
  try {
    ensurePrivateDirectory(join(cwd, '.takt'));
    writePrivateFile(join(cwd, '.takt', STATE_FILE), JSON.stringify({ failures: [...readManagerRunFailures(cwd), failure] }));
  } catch (diagnosticError) {
    log.error('Cannot save manager diagnostic', { error: sanitizeSensitiveText(getErrorMessage(diagnosticError)) });
  }
}

export function withProjectRunCoordination<T>(cwd: string, action: () => T): T {
  return runPrivateFileExclusive(join(cwd, '.takt', 'run-coordination.lock'), action);
}

export function readManagerRunState(cwd: string): ManagerRunState {
  const path = join(hostProjectStateDirectory(cwd, 'manager-runs'), STATE_FILE);
  assertSafePath(path, false);
  const saved = lstatOrUndefined(dirname(path)) === undefined ? undefined : readPrivateFileState(path);
  const authority = saved !== undefined && 'content' in saved
    ? AuthoritySchema.parse(JSON.parse(saved.content.toString('utf8')) as unknown)
    : { requested: false };
  return { ...authority, failures: readManagerRunFailures(cwd) };
}

export function writeManagerRunState(cwd: string, state: ManagerRunState): void {
  const checked = StateSchema.parse(state);
  const { failures, ...authority } = checked;
  const directory = hostProjectStateDirectory(cwd, 'manager-runs');
  ensurePrivateDirectory(directory);
  writePrivateFile(join(directory, STATE_FILE), JSON.stringify(authority));
  ensurePrivateDirectory(join(cwd, '.takt'));
  writePrivateFile(join(cwd, '.takt', STATE_FILE), JSON.stringify({ failures }));
}

function alive(record: { pid: number; startTime?: string }): boolean {
  return isProcessAlive(record.pid)
    && (record.startTime === undefined
      || !hasProcessIdentityMismatch({ startTime: record.startTime }, getProcessIdentity(record.pid)));
}

export function recoverManagerReservation(cwd: string): ManagerRunState {
  const state = readManagerRunState(cwd);
  const reservation = state.reservation;
  if (reservation === undefined || reservation.adoptedOwnerId !== undefined) return state;
  if (alive(reservation.launcher) || (reservation.child !== undefined && alive(reservation.child))) return state;
  const recovered = { ...state, requested: true, reservation: undefined };
  writeManagerRunState(cwd, recovered);
  return recovered;
}

export function assertManagerReservationAllowsExecution(cwd: string): void {
  const reservation = manualRunState(cwd)?.reservation;
  if (reservation !== undefined && reservation.adoptedOwnerId === undefined
    && reservation.token !== process.env[MANAGER_RUN_TOKEN_ENV]) {
    throw new Error('TAKT run startup is already reserved for this project');
  }
}

export function adoptManagerReservation(cwd: string, ownerId: string): void {
  const state = manualRunState(cwd);
  if (state === undefined) return;
  const reservation = state.reservation !== undefined && state.reservation.token === process.env[MANAGER_RUN_TOKEN_ENV]
    ? { ...state.reservation, adoptedOwnerId: ownerId } : state.reservation;
  if (state.requested || reservation !== state.reservation) {
    writeManagerRunState(cwd, { ...state, requested: false, reservation });
  }
}

function manualRunState(cwd: string): ManagerRunState | undefined {
  try { return recoverManagerReservation(cwd); }
  catch (error) {
    // A detached child must authenticate its reservation; a manual run needs only the execution lock.
    if (process.env[MANAGER_RUN_TOKEN_ENV] !== undefined) throw error;
    recordManagerRunFailure(cwd, error);
    return undefined;
  }
}

export function processRecord(pid: number, identity: ProcessIdentity): { pid: number; startTime: string } {
  return { pid, startTime: identity.startTime };
}

export function requestManagerRun(cwd: string): void {
  const state = readManagerRunState(cwd);
  writeManagerRunState(cwd, { ...state, requested: true });
}
