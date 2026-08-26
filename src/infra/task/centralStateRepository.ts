import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { resolveStatePaths, UUID_PATTERN, type ExecutionLocations, type StatePaths } from '../../core/execution/locations.js';
import { getProcessIdentity, getSelfProcessIdentity, isProcessAlive, sameProcessIdentity, type ProcessIdentity } from './process.js';
import {
  projectIdForCanonicalDirectory,
  resolveRegisteredProject,
  type DirectoryFingerprint,
} from '../config/global/projectRegistry.js';

const STATE_VERSION = 1;
const TASKS_VERSION = 1;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
// A starting reservation has no adopted worker authority. This is the only
// time-based recovery exception; running tasks are recovered only by PID and
// process identity, never by elapsed time.
const STARTING_RESERVATION_TIMEOUT_MS = 10_000;

export type CentralTaskStatus = 'pending' | 'starting' | 'running' | 'completed' | 'failed';
export type CentralTaskOrigin = 'web';
export type CentralWorktreeRequest = false | true | string;

export interface CentralStateRecord {
  readonly version: typeof STATE_VERSION;
  readonly stateId: string;
  readonly locationId: string;
  readonly canonicalDirectory: string;
  readonly fingerprint?: DirectoryFingerprint;
  /** The central runs directory is an inode-pinned trust boundary. */
  readonly runsRootFingerprint: DirectoryFingerprint;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CentralActiveExecution {
  readonly executionId: string;
  readonly runId: string;
  readonly ownerTokenHash: string;
  readonly pid: number;
  readonly processIdentity?: ProcessIdentity;
  readonly startTime: string;
  readonly startedAt: string;
}

export interface CentralTaskFailure {
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export interface CentralTaskRecord {
  readonly taskId: string;
  readonly generation: number;
  readonly status: CentralTaskStatus;
  readonly origin: CentralTaskOrigin;
  readonly attempt: number;
  readonly task: string;
  readonly workflow: string;
  readonly worktree: CentralWorktreeRequest;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly autoPr?: boolean;
  readonly draftPr?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeExecution?: CentralActiveExecution;
  readonly failure?: CentralTaskFailure;
  /** Latest run pointer retained so workers started before run history support can finish safely. */
  readonly runId?: string;
  readonly runIds: readonly string[];
  readonly prUrl?: string;
}

interface StoredTasks {
  readonly version: typeof TASKS_VERSION;
  readonly tasks: readonly CentralTaskRecord[];
}

interface StoredCentralTaskRecord extends Omit<CentralTaskRecord, 'runIds'> {
  readonly runIds?: unknown;
  readonly runId?: string;
}

export interface CentralTaskHandle {
  readonly task: CentralTaskRecord;
  /** Raw owner token is kept in memory and may only be handed to the worker through env/private IPC. */
  readonly ownerToken: string;
  readonly executionId: string;
  readonly runId: string;
}

export interface CentralTaskLaunchDecision {
  readonly kind: 'started' | 'reused';
  readonly task: CentralTaskRecord;
  readonly ownerToken?: string;
  readonly executionId?: string;
  readonly runId?: string;
  readonly active?: CentralActiveExecution;
}

export class CentralTaskBusyError extends Error {
  readonly code = 'CENTRAL_TASK_BUSY';

  constructor() {
    super('A Web UI task is already starting or running for this state');
  }
}

export class CentralTaskRequeueError extends Error {
  readonly code = 'CENTRAL_TASK_REQUEUE_INVALID';
}

export class CentralTaskCasError extends Error {
  readonly code = 'CENTRAL_TASK_CAS_FAILED';

  constructor(message = 'Central task ownership compare-and-swap failed') {
    super(message);
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sameFingerprint(
  first: DirectoryFingerprint | undefined,
  second: DirectoryFingerprint | undefined,
): boolean {
  return first?.dev === second?.dev && first?.ino === second?.ino;
}

function sameCentralStateIdentity(first: CentralStateRecord, second: CentralStateRecord): boolean {
  return first.stateId === second.stateId
    && first.locationId === second.locationId
    && first.canonicalDirectory === second.canonicalDirectory
    && sameFingerprint(first.fingerprint, second.fingerprint)
    && sameFingerprint(first.runsRootFingerprint, second.runsRootFingerprint);
}

function makeOwnerToken(): string {
  return randomBytes(32).toString('base64url');
}

function makeRunId(now: string): string {
  return `${now.replace(/[-:.TZ]/gu, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function startPendingTask(task: CentralTaskRecord, now: string): CentralTaskHandle {
  const ownerToken = makeOwnerToken();
  const executionId = randomUUID();
  const runId = makeRunId(now);
  const started: CentralTaskRecord = {
    ...task,
    generation: task.generation + 1,
    status: 'starting',
    attempt: task.attempt + 1,
    updatedAt: now,
    runId,
    runIds: [...task.runIds, runId],
    activeExecution: {
      executionId,
      runId,
      ownerTokenHash: hashToken(ownerToken),
      pid: 0,
      startTime: now,
      startedAt: now,
    },
  };
  return { task: started, ownerToken, executionId, runId };
}

function resetFailedTaskToPending(task: CentralTaskRecord, now: string): CentralTaskRecord {
  return {
    taskId: task.taskId,
    generation: task.generation + 1,
    status: 'pending',
    origin: task.origin,
    attempt: task.attempt,
    task: task.task,
    workflow: task.workflow,
    worktree: task.worktree,
    ...(task.branch === undefined ? {} : { branch: task.branch }),
    ...(task.baseBranch === undefined ? {} : { baseBranch: task.baseBranch }),
    ...(task.autoPr === undefined ? {} : { autoPr: task.autoPr }),
    ...(task.draftPr === undefined ? {} : { draftPr: task.draftPr }),
    createdAt: task.createdAt,
    updatedAt: now,
    runIds: task.runIds,
  };
}

function assertStateId(stateId: string): void {
  if (!UUID_PATTERN.test(stateId)) throw new Error('stateId is invalid');
}

function assertTaskId(taskId: string): void {
  if (!UUID_PATTERN.test(taskId)) throw new Error('taskId is invalid');
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Central state directory is not a regular directory: ${directory}`);
  await chmod(directory, 0o700);
  await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
}

async function ensureCentralTree(paths: StatePaths): Promise<void> {
  const globalState = dirname(dirname(paths.stateDirectory));
  const globalConfig = dirname(globalState);
  await ensurePrivateDirectory(globalConfig);
  await ensurePrivateDirectory(globalState);
  await ensurePrivateDirectory(dirname(paths.stateDirectory));
  await ensurePrivateDirectory(paths.stateDirectory);
  await Promise.all([
    paths.tasksDirectory,
    paths.runsDirectory,
    paths.sessionsDirectory,
    paths.worktreeMetadataDirectory,
    paths.eventsDirectory,
    paths.locksDirectory,
  ].map(ensurePrivateDirectory));
}

async function verifyRunsRoot(
  paths: StatePaths,
  expectedFingerprint?: DirectoryFingerprint,
): Promise<DirectoryFingerprint> {
  const expectedStateDirectory = resolve(paths.stateDirectory);
  const expectedRunsDirectory = resolve(expectedStateDirectory, 'runs');
  if (resolve(paths.runsDirectory) !== expectedRunsDirectory) {
    throw new CentralTaskCasError('Central runs directory is not the state runs root');
  }
  const [stateStats, runsStats] = await Promise.all([
    lstat(expectedStateDirectory),
    lstat(expectedRunsDirectory),
  ]);
  if (
    !stateStats.isDirectory()
    || stateStats.isSymbolicLink()
    || !runsStats.isDirectory()
    || runsStats.isSymbolicLink()
  ) {
    throw new CentralTaskCasError('Central runs root must be a regular directory');
  }
  const [stateRealpath, runsRealpath] = await Promise.all([
    realpath(expectedStateDirectory),
    realpath(expectedRunsDirectory),
  ]);
  if (
    stateRealpath !== expectedStateDirectory
    || runsRealpath !== expectedRunsDirectory
    || relative(stateRealpath, runsRealpath) !== 'runs'
  ) {
    throw new CentralTaskCasError('Central runs root identity changed');
  }
  const fingerprint = { dev: runsStats.dev, ino: runsStats.ino };
  if (expectedFingerprint !== undefined && !sameFingerprint(fingerprint, expectedFingerprint)) {
    throw new CentralTaskCasError('Central runs root fingerprint changed');
  }
  return fingerprint;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${path.split('/').pop() ?? 'state'}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

interface StateLockOwner {
  readonly version: 1;
  readonly ownerToken: string;
  readonly pid: number;
  readonly processIdentity?: ProcessIdentity;
  readonly inode: number;
  readonly startedAt: string;
}

interface StateLockClaim {
  readonly version: 1;
  readonly claimToken: string;
  readonly ownerToken: string;
  readonly pid: number;
  readonly processIdentity?: ProcessIdentity;
  readonly dev: number;
  readonly ino: number;
}

interface StateLockHandle {
  readonly handle: import('node:fs/promises').FileHandle;
  readonly owner: StateLockOwner;
  readonly stat: { readonly dev: number; readonly ino: number };
}

function lockClaimPath(lockPath: string, ownerToken: string): string {
  return `${lockPath}.${createHash('sha256').update(ownerToken).digest('hex')}.claim`;
}

function lockInodeClaimPath(lockPath: string, ownerToken: string): string {
  return `${lockClaimPath(lockPath, ownerToken)}.inode`;
}

function parseStateLockOwner(value: unknown): StateLockOwner | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Readonly<Record<string, unknown>>;
  if (
    raw.version !== 1
    || typeof raw.ownerToken !== 'string'
    || raw.ownerToken.length < 16
    || !Number.isSafeInteger(raw.pid)
    || (raw.pid as number) <= 0
    || !Number.isSafeInteger(raw.inode)
    || (raw.inode as number) < 0
    || typeof raw.startedAt !== 'string'
  ) return undefined;
  if (raw.processIdentity !== undefined && (
    typeof raw.processIdentity !== 'object'
    || typeof (raw.processIdentity as Readonly<Record<string, unknown>>).startTime !== 'string'
  )) return undefined;
  return raw as unknown as StateLockOwner;
}

function parseStateLockClaim(value: unknown): StateLockClaim | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Readonly<Record<string, unknown>>;
  if (
    raw.version !== 1
    || typeof raw.claimToken !== 'string'
    || raw.claimToken.length < 16
    || typeof raw.ownerToken !== 'string'
    || !Number.isSafeInteger(raw.pid)
    || (raw.pid as number) <= 0
    || !Number.isSafeInteger(raw.dev)
    || !Number.isSafeInteger(raw.ino)
  ) return undefined;
  if (raw.processIdentity !== undefined && (
    typeof raw.processIdentity !== 'object'
    || typeof (raw.processIdentity as Readonly<Record<string, unknown>>).startTime !== 'string'
  )) return undefined;
  return raw as unknown as StateLockClaim;
}

async function readStateLockOwner(lockPath: string): Promise<StateLockOwner | undefined> {
  try {
    return parseStateLockOwner(JSON.parse(await readFile(lockPath, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

async function readStateLockClaim(claimPath: string): Promise<StateLockClaim | undefined> {
  try {
    return parseStateLockClaim(JSON.parse(await readFile(claimPath, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

function sameLockOwner(first: StateLockOwner, second: StateLockOwner): boolean {
  const identityMatches = first.processIdentity === undefined && second.processIdentity === undefined
    || sameProcessIdentity(first.processIdentity, second.processIdentity);
  return first.ownerToken === second.ownerToken
    && first.pid === second.pid
    && first.inode === second.inode
    && identityMatches;
}

function lockOwnerIsStale(owner: StateLockOwner): boolean {
  let alive: boolean;
  try {
    alive = isProcessAlive(owner.pid);
  } catch {
    return false;
  }
  if (!alive) return true;
  const currentIdentity = getProcessIdentity(owner.pid);
  return owner.processIdentity !== undefined
    && currentIdentity !== undefined
    && !sameProcessIdentity(owner.processIdentity, currentIdentity);
}

function lockClaimOwnerIsStale(claim: StateLockClaim): boolean {
  let alive: boolean;
  try {
    alive = isProcessAlive(claim.pid);
  } catch {
    return false;
  }
  if (!alive) return true;
  const currentIdentity = getProcessIdentity(claim.pid);
  return claim.processIdentity !== undefined
    && currentIdentity !== undefined
    && !sameProcessIdentity(claim.processIdentity, currentIdentity);
}

async function compareDeleteClaim(
  claimPath: string,
  expected: StateLockClaim,
  expectedStat: { readonly dev: number; readonly ino: number },
): Promise<boolean> {
  try {
    const currentStat = await lstat(claimPath);
    if (currentStat.dev !== expectedStat.dev || currentStat.ino !== expectedStat.ino) return false;
    const current = await readStateLockClaim(claimPath);
    if (current === undefined || current.claimToken !== expected.claimToken) return false;
    const beforeDelete = await lstat(claimPath);
    if (beforeDelete.dev !== expectedStat.dev || beforeDelete.ino !== expectedStat.ino) return false;
    await unlink(claimPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function publishStateLockClaim(
  lockPath: string,
  owner: StateLockOwner,
  expectedStat: { readonly dev: number; readonly ino: number },
  attempt = 0,
): Promise<{ readonly claim: StateLockClaim; readonly claimStat: { readonly dev: number; readonly ino: number } } | undefined> {
  const claimPath = lockClaimPath(lockPath, owner.ownerToken);
  const temporary = `${claimPath}.${process.pid}.${randomUUID()}.tmp`;
  const processIdentity = getSelfProcessIdentity();
  const claim: StateLockClaim = {
    version: 1,
    claimToken: makeOwnerToken(),
    ownerToken: owner.ownerToken,
    pid: process.pid,
    ...(processIdentity === undefined ? {} : { processIdentity }),
    dev: expectedStat.dev,
    ino: expectedStat.ino,
  };
  try {
    await writeFile(temporary, `${JSON.stringify(claim)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, claimPath);
    } catch (error) {
      if (!isExists(error)) throw new CentralTaskCasError('Central state lock claim cannot be published atomically');
      const existingStat = await lstat(claimPath).catch(() => undefined);
      const existing = await readStateLockClaim(claimPath);
      if (
        existingStat !== undefined
        && existing !== undefined
        && existing.ownerToken === owner.ownerToken
        && existing.dev === expectedStat.dev
        && existing.ino === expectedStat.ino
        && lockClaimOwnerIsStale(existing)
      ) {
        const inodeClaimPath = lockInodeClaimPath(lockPath, owner.ownerToken);
        const inodeStat = await lstat(inodeClaimPath).catch(() => undefined);
        if (inodeStat !== undefined && inodeStat.dev === expectedStat.dev && inodeStat.ino === expectedStat.ino) {
          await unlink(inodeClaimPath).catch((unlinkError: unknown) => {
            if (!isMissing(unlinkError)) throw unlinkError;
          });
        }
        if (attempt > 0 || !(await compareDeleteClaim(claimPath, existing, existingStat))) return undefined;
        return publishStateLockClaim(lockPath, owner, expectedStat, attempt + 1);
      }
      return undefined;
    }
    const claimStat = await lstat(claimPath);
    return { claim, claimStat: { dev: claimStat.dev, ino: claimStat.ino } };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Remove exactly the inode observed by this cleaner. Every remover uses the
 * deterministic hard-link claim, so a replacement canonical lock can never
 * be removed by a cleaner that observed the old owner.
 */
async function compareDeleteStateLock(
  lockPath: string,
  owner: StateLockOwner,
  expectedStat: { readonly dev: number; readonly ino: number },
): Promise<boolean> {
  const claimPath = lockClaimPath(lockPath, owner.ownerToken);
  const claim = await publishStateLockClaim(lockPath, owner, expectedStat);
  if (claim === undefined) return false;
  const inodeClaimPath = lockInodeClaimPath(lockPath, owner.ownerToken);
  try {
    try {
      await link(lockPath, inodeClaimPath);
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    const [canonicalStat, inodeStat, currentOwner, currentClaim] = await Promise.all([
      lstat(lockPath),
      lstat(inodeClaimPath),
      readStateLockOwner(lockPath),
      readStateLockClaim(claimPath),
    ]);
    if (
      canonicalStat.dev !== expectedStat.dev
      || canonicalStat.ino !== expectedStat.ino
      || inodeStat.dev !== expectedStat.dev
      || inodeStat.ino !== expectedStat.ino
      || currentOwner === undefined
      || !sameLockOwner(currentOwner, owner)
      || currentClaim === undefined
      || currentClaim.claimToken !== claim.claim.claimToken
    ) return false;
    const beforeDelete = await lstat(lockPath);
    if (beforeDelete.dev !== expectedStat.dev || beforeDelete.ino !== expectedStat.ino) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  } finally {
    const inodeStat = await lstat(inodeClaimPath).catch(() => undefined);
    if (inodeStat?.dev === expectedStat.dev && inodeStat.ino === expectedStat.ino) {
      await unlink(inodeClaimPath).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
    await compareDeleteClaim(claimPath, claim.claim, claim.claimStat);
  }
}

async function waitForLock(lockPath: string): Promise<StateLockHandle> {
  const publish = async (): Promise<StateLockHandle | undefined> => {
    const temporary = join(
      dirname(lockPath),
      `.${lockPath.split('/').pop() ?? 'state.lock'}.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryHandle: import('node:fs/promises').FileHandle | undefined;
    let publishedOwner: { readonly owner: StateLockOwner; readonly stat: { readonly dev: number; readonly ino: number } } | undefined;
    try {
      temporaryHandle = await open(temporary, 'wx', 0o600);
      const fileStat = await temporaryHandle.stat();
      const processIdentity = getSelfProcessIdentity();
      const owner: StateLockOwner = {
        version: 1,
        ownerToken: makeOwnerToken(),
        pid: process.pid,
        ...(processIdentity === undefined ? {} : { processIdentity }),
        inode: fileStat.ino,
        startedAt: new Date().toISOString(),
      };
      await temporaryHandle.writeFile(JSON.stringify(owner), 'utf8');
      await temporaryHandle.chmod(0o600);
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;

      try {
        // Hard-link publication never overwrites an existing owner and makes
        // the canonical path visible only after the complete JSON is synced.
        await link(temporary, lockPath);
      } catch (error) {
        if (isExists(error)) return undefined;
        throw new CentralTaskCasError('Central state lock cannot be published atomically on this platform');
      }
      publishedOwner = { owner, stat: { dev: fileStat.dev, ino: fileStat.ino } };
      await unlink(temporary);
      const handle = await open(lockPath, 'r+');
      const publishedStat = await handle.stat();
      const publishedDocument = await readStateLockOwner(lockPath);
      if (
        publishedStat.dev !== fileStat.dev
        || publishedStat.ino !== fileStat.ino
        || publishedDocument === undefined
        || !sameLockOwner(publishedDocument, owner)
      ) {
        await handle.close();
        throw new CentralTaskCasError('Central state lock publication identity changed');
      }
      return { handle, owner, stat: { dev: fileStat.dev, ino: fileStat.ino } };
    } catch (error) {
      if (publishedOwner !== undefined) {
        await compareDeleteStateLock(
          lockPath,
          publishedOwner.owner,
          publishedOwner.stat,
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      if (temporaryHandle !== undefined) await temporaryHandle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  };

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    const published = await publish();
    if (published !== undefined) return published;
    const owner = await readStateLockOwner(lockPath);
    if (owner !== undefined) {
      const lockStat = await lstat(lockPath).catch(() => undefined);
      if (lockStat !== undefined && lockOwnerIsStale(owner)) {
        const removed = await compareDeleteStateLock(lockPath, owner, { dev: lockStat.dev, ino: lockStat.ino });
        if (removed) continue;
      }
    }
    // An incomplete legacy lock has no safe owner identity. Leave it in
    // place and fail closed at the deadline instead of guessing its age.
    if (Date.now() >= deadline) throw new CentralTaskCasError('Central state lock is busy');
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, LOCK_WAIT_MS));
  }
}

async function withLock<T>(paths: StatePaths, action: () => Promise<T>): Promise<T> {
  const lockPath = join(paths.locksDirectory, 'state.lock');
  const lock = await waitForLock(lockPath);
  try {
    return await action();
  } finally {
    await lock.handle.close();
    await compareDeleteStateLock(lockPath, lock.owner, lock.stat).catch((error: unknown) => {
      if (!(error instanceof CentralTaskCasError) && !isMissing(error)) throw error;
    });
  }
}

function normalizeTaskRunHistory(task: StoredCentralTaskRecord): CentralTaskRecord {
  if (task.runIds !== undefined && !Array.isArray(task.runIds)) {
    return task as CentralTaskRecord;
  }
  const persistedRunIds = task.runIds as readonly string[] | undefined;
  const runIds = task.runId === undefined
    ? persistedRunIds ?? []
    : persistedRunIds?.at(-1) === task.runId
      ? persistedRunIds
      : [...persistedRunIds ?? [], task.runId];
  return {
    ...task,
    ...(persistedRunIds === undefined ? { attempt: runIds.length } : {}),
    runIds,
  };
}

function parseTasks(value: unknown): StoredTasks {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CentralTaskCasError('Central tasks file is malformed');
  const raw = value as Readonly<Record<string, unknown>>;
  if (raw.version !== TASKS_VERSION || !Array.isArray(raw.tasks)) throw new CentralTaskCasError('Central tasks file version is unsupported');
  return {
    version: TASKS_VERSION,
    tasks: (raw.tasks as StoredCentralTaskRecord[]).map(normalizeTaskRunHistory),
  };
}

function assertIsoTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new CentralTaskCasError(`Central ${label} timestamp is invalid`);
  }
}

function validateTask(task: CentralTaskRecord): void {
  assertTaskId(task.taskId);
  if (!Number.isSafeInteger(task.generation) || task.generation < 0) throw new CentralTaskCasError('Central task generation is invalid');
  if (!Number.isSafeInteger(task.attempt) || task.attempt < 0) throw new CentralTaskCasError('Central task attempt is invalid');
  if (!['pending', 'starting', 'running', 'completed', 'failed'].includes(task.status)) throw new CentralTaskCasError('Central task status is invalid');
  if (task.origin !== 'web') throw new CentralTaskCasError('Central task origin is invalid');
  if (typeof task.task !== 'string' || task.task.length === 0 || typeof task.workflow !== 'string' || task.workflow.length === 0) {
    throw new CentralTaskCasError('Central task content is invalid');
  }
  if (task.worktree !== false && task.worktree !== true && typeof task.worktree !== 'string') {
    throw new CentralTaskCasError('Central task worktree policy is invalid');
  }
  if (task.branch !== undefined && (typeof task.branch !== 'string' || task.branch.length === 0)) {
    throw new CentralTaskCasError('Central task branch is invalid');
  }
  if (task.baseBranch !== undefined && (typeof task.baseBranch !== 'string' || task.baseBranch.length === 0)) {
    throw new CentralTaskCasError('Central task base branch is invalid');
  }
  if (task.autoPr !== undefined && typeof task.autoPr !== 'boolean') {
    throw new CentralTaskCasError('Central task auto PR setting is invalid');
  }
  if (task.draftPr !== undefined && typeof task.draftPr !== 'boolean') {
    throw new CentralTaskCasError('Central task draft PR setting is invalid');
  }
  if (task.draftPr === true && task.autoPr !== true) {
    throw new CentralTaskCasError('Central task draft PR requires auto PR');
  }
  if (task.prUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(task.prUrl);
    } catch {
      throw new CentralTaskCasError('Central task PR URL is invalid');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new CentralTaskCasError('Central task PR URL is invalid');
    }
  }
  if (task.autoPr === true && task.worktree === false) {
    throw new CentralTaskCasError('Central task auto PR requires a worktree');
  }
  if (
    !Array.isArray(task.runIds)
    || task.runIds.some((runId) => typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId))
    || new Set(task.runIds).size !== task.runIds.length
    || task.runIds.length !== task.attempt
  ) {
    throw new CentralTaskCasError('Central task run history is invalid');
  }
  if (task.runId !== undefined && task.runId !== task.runIds.at(-1)) {
    throw new CentralTaskCasError('Central task latest run does not match its run history');
  }
  assertIsoTimestamp(task.createdAt, 'task.createdAt');
  assertIsoTimestamp(task.updatedAt, 'task.updatedAt');
  if (task.activeExecution !== undefined) {
    const active = task.activeExecution;
    if (
      !UUID_PATTERN.test(active.executionId)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(active.runId)
      || !/^[a-f0-9]{64}$/u.test(active.ownerTokenHash)
      || !Number.isSafeInteger(active.pid)
      || active.pid < 0
    ) {
      throw new CentralTaskCasError('Central active execution is malformed');
    }
    assertIsoTimestamp(active.startTime, 'active execution startTime');
    assertIsoTimestamp(active.startedAt, 'active execution startedAt');
    if (active.processIdentity !== undefined && (
      typeof active.processIdentity !== 'object'
      || typeof active.processIdentity.startTime !== 'string'
      || active.processIdentity.startTime.length === 0
    )) {
      throw new CentralTaskCasError('Central active process identity is malformed');
    }
  }
  if ((task.status === 'starting' || task.status === 'running') !== (task.activeExecution !== undefined)) {
    throw new CentralTaskCasError('Central task active execution does not match its status');
  }
  if (
    task.activeExecution !== undefined
    && task.runIds.at(-1) !== task.activeExecution.runId
  ) {
    throw new CentralTaskCasError('Central task active execution does not match its run history');
  }
  if (task.failure !== undefined) {
    if (
      typeof task.failure.code !== 'string'
      || task.failure.code.length === 0
      || typeof task.failure.message !== 'string'
      || typeof task.failure.at !== 'string'
    ) {
      throw new CentralTaskCasError('Central task failure is malformed');
    }
    assertIsoTimestamp(task.failure.at, 'task failure');
  }
}

/** Parse the ledger without creating or repairing any central-state files. */
export function parseCentralTasks(value: unknown): readonly CentralTaskRecord[] {
  const parsed = parseTasks(value);
  parsed.tasks.forEach(validateTask);
  return parsed.tasks;
}

function parseState(value: unknown): CentralStateRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CentralTaskCasError('Central state file is malformed');
  const raw = value as Readonly<Record<string, unknown>>;
  if (
    raw.version !== STATE_VERSION
    || typeof raw.stateId !== 'string'
    || typeof raw.locationId !== 'string'
    || !/^[a-f0-9]{64}$/u.test(raw.locationId)
    || typeof raw.canonicalDirectory !== 'string'
    || raw.canonicalDirectory.length === 0
    || typeof raw.displayName !== 'string'
    || raw.displayName.length === 0
  ) {
    throw new CentralTaskCasError('Central state version is unsupported or malformed');
  }
  assertStateId(raw.stateId);
  assertIsoTimestamp(raw.createdAt, 'state.createdAt');
  assertIsoTimestamp(raw.updatedAt, 'state.updatedAt');
  const validateFingerprint = (value: unknown, label: string): DirectoryFingerprint => {
    const fingerprint = value;
    if (
      fingerprint === null
      || typeof fingerprint !== 'object'
      || Array.isArray(fingerprint)
      || !Number.isSafeInteger((fingerprint as Readonly<Record<string, unknown>>).dev)
      || !Number.isSafeInteger((fingerprint as Readonly<Record<string, unknown>>).ino)
    ) {
      throw new CentralTaskCasError(`Central state ${label} is malformed`);
    }
    return fingerprint as DirectoryFingerprint;
  };
  if (raw.fingerprint !== undefined) validateFingerprint(raw.fingerprint, 'fingerprint');
  const runsRootFingerprint = validateFingerprint(raw.runsRootFingerprint, 'runs root fingerprint');
  return { ...raw, runsRootFingerprint } as unknown as CentralStateRecord;
}

/** Revalidate the registered location at every worker/repository attach. */
async function verifyStateLocationIdentity(
  state: Pick<CentralStateRecord, 'canonicalDirectory' | 'locationId' | 'fingerprint'>,
): Promise<void> {
  let currentDirectory: string;
  try {
    currentDirectory = await realpath(state.canonicalDirectory);
  } catch {
    throw new CentralTaskCasError('Central project directory is unavailable');
  }
  if (currentDirectory !== state.canonicalDirectory) {
    throw new CentralTaskCasError('Central project directory canonical path changed');
  }
  const stats = await lstat(currentDirectory).catch(() => undefined);
  if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CentralTaskCasError('Central project directory is not a regular directory');
  }
  if (projectIdForCanonicalDirectory(currentDirectory) !== state.locationId) {
    throw new CentralTaskCasError('Central project location identity changed');
  }
  if (
    state.fingerprint !== undefined
    && (state.fingerprint.dev !== stats.dev || state.fingerprint.ino !== stats.ino)
  ) {
    throw new CentralTaskCasError('Central project directory fingerprint changed; explicit relink is required');
  }
}

async function verifyStateRegistryIdentity(
  globalConfigDirectory: string,
  state: CentralStateRecord,
): Promise<void> {
  let registered: Awaited<ReturnType<typeof resolveRegisteredProject>>;
  try {
    registered = await resolveRegisteredProject(globalConfigDirectory, state.locationId);
  } catch {
    throw new CentralTaskCasError('Central project registry identity is unavailable');
  }
  if (
    registered.stateId !== state.stateId
    || registered.canonicalDirectory !== state.canonicalDirectory
    || registered.fingerprint.dev !== state.fingerprint?.dev
    || registered.fingerprint.ino !== state.fingerprint?.ino
  ) {
    throw new CentralTaskCasError('Central state identity does not match the project registry');
  }
}

export class CentralTaskRepository {
  readonly paths: StatePaths;
  readonly locations: ExecutionLocations;
  readonly state: CentralStateRecord;
  readonly globalConfigDirectory: string;

  private constructor(
    locations: ExecutionLocations,
    paths: StatePaths,
    state: CentralStateRecord,
    globalConfigDirectory: string,
  ) {
    this.locations = Object.freeze({ ...locations });
    this.paths = paths;
    this.state = state;
    this.globalConfigDirectory = globalConfigDirectory;
  }

  private async verifyProjectIdentityUnlocked(): Promise<void> {
    await verifyStateRegistryIdentity(this.globalConfigDirectory, this.state);
    await verifyStateLocationIdentity(this.state);
    await verifyRunsRoot(this.paths, this.state.runsRootFingerprint);
  }

  /**
   * Read the persisted state while the ownership lock is held. The repository
   * snapshot is only an attach-time observation; task CAS must never proceed
   * if state.json was atomically replaced since that observation.
   */
  private async readAndVerifyPersistedIdentityUnlocked(): Promise<CentralStateRecord> {
    const persisted = parseState(JSON.parse(await readFile(this.paths.stateFile, 'utf8')) as unknown);
    if (!sameCentralStateIdentity(persisted, this.state)) {
      throw new CentralTaskCasError('Central persisted state identity changed');
    }
    await verifyStateRegistryIdentity(this.globalConfigDirectory, persisted);
    await verifyStateLocationIdentity(persisted);
    await verifyRunsRoot(this.paths, persisted.runsRootFingerprint);
    return persisted;
  }

  /** Verify the fixed location before starting any central execution work. */
  async verifyProjectIdentity(): Promise<void> {
    await this.verifyProjectIdentityUnlocked();
  }

  static async open(options: {
    readonly globalConfigDirectory: string;
    readonly stateId: string;
    readonly locationId: string;
    readonly canonicalDirectory: string;
    readonly displayName: string;
    readonly fingerprint?: DirectoryFingerprint;
    readonly executionDirectory?: string;
  }): Promise<CentralTaskRepository> {
    assertStateId(options.stateId);
    await verifyStateLocationIdentity({
      locationId: options.locationId,
      canonicalDirectory: options.canonicalDirectory,
      ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
    });
    const paths = resolveStatePaths(options.globalConfigDirectory, options.stateId);
    await ensureCentralTree(paths);
    let state!: CentralStateRecord;
    await withLock(paths, async () => {
      let serializedState: string | undefined;
      try {
        serializedState = await readFile(paths.stateFile, 'utf8');
      } catch (error) {
        if (!isMissing(error)) throw error;
        let tasksExist = false;
        try {
          await readFile(paths.tasksFile, 'utf8');
          tasksExist = true;
        } catch (tasksError) {
          if (isMissing(tasksError)) {
            tasksExist = false;
          } else {
            throw tasksError;
          }
        }
        if (tasksExist) {
          throw new CentralTaskCasError('Central state is incomplete; state and task ledger must be recovered together');
        }
        const now = new Date().toISOString();
        const runsRootFingerprint = await verifyRunsRoot(paths);
        state = {
          version: STATE_VERSION,
          stateId: options.stateId,
          locationId: options.locationId,
          canonicalDirectory: options.canonicalDirectory,
          ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
          runsRootFingerprint,
          displayName: options.displayName,
          createdAt: now,
          updatedAt: now,
        };
        await verifyStateRegistryIdentity(options.globalConfigDirectory, state);
        await verifyStateLocationIdentity(state);
        await atomicWrite(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
        await atomicWrite(paths.tasksFile, `${JSON.stringify({ version: TASKS_VERSION, tasks: [] }, null, 2)}\n`);
        return;
      }
      if (serializedState === undefined) {
        throw new CentralTaskCasError('Central state initialization did not produce a state file');
      }
      state = parseState(JSON.parse(serializedState) as unknown);
      if (
        state.stateId !== options.stateId
        || state.locationId !== options.locationId
        || state.canonicalDirectory !== options.canonicalDirectory
        || !sameFingerprint(state.fingerprint, options.fingerprint)
      ) {
        throw new CentralTaskCasError('Central state identity does not match the registry');
      }
      // This verification is deliberately inside the same state lock as all
      // later ownership mutations. It removes the verify -> await -> adopt
      // race in which the project directory could be swapped in between.
      await verifyStateRegistryIdentity(options.globalConfigDirectory, state);
      await verifyStateLocationIdentity(state);
      await verifyRunsRoot(paths, state.runsRootFingerprint);
      // A state without its task ledger is an incomplete ownership state,
      // not an empty queue. Never repair it implicitly.
      try {
        parseCentralTasks(JSON.parse(await readFile(paths.tasksFile, 'utf8')) as unknown);
      } catch (error) {
        if (isMissing(error)) {
          throw new CentralTaskCasError('Central state is incomplete; state and task ledger must be recovered together');
        }
        throw error;
      }
    });
    return new CentralTaskRepository(
      {
        projectDirectory: options.canonicalDirectory,
        executionDirectory: options.executionDirectory ?? options.canonicalDirectory,
        stateDirectory: paths.stateDirectory,
      },
      { ...paths, runsRootFingerprint: state.runsRootFingerprint },
      state,
      options.globalConfigDirectory,
    );
  }

  static async openByState(options: {
    readonly globalConfigDirectory: string;
    readonly stateId: string;
    readonly executionDirectory?: string;
  }): Promise<CentralTaskRepository> {
    assertStateId(options.stateId);
    const paths = resolveStatePaths(options.globalConfigDirectory, options.stateId);
    const state = parseState(JSON.parse(await readFile(paths.stateFile, 'utf8')) as unknown);
    return CentralTaskRepository.open({
      globalConfigDirectory: options.globalConfigDirectory,
      stateId: state.stateId,
      locationId: state.locationId,
      canonicalDirectory: state.canonicalDirectory,
      displayName: state.displayName,
      ...(state.fingerprint === undefined ? {} : { fingerprint: state.fingerprint }),
      ...(options.executionDirectory === undefined ? {} : { executionDirectory: options.executionDirectory }),
    });
  }

  async readTasks(): Promise<readonly CentralTaskRecord[]> {
    // A repository handle is attached to an already initialized state.  A
    // missing ledger therefore means that the ownership state was damaged or
    // replaced after attach; treating it as an empty queue would permit a
    // stale handle to recreate and mutate a different state.  Only `open`
    // creates the initial empty ledger.
    try {
      return parseCentralTasks(JSON.parse(await readFile(this.paths.tasksFile, 'utf8')) as unknown);
    } catch (error) {
      if (isMissing(error)) {
        throw new CentralTaskCasError('Central task ledger is missing from an attached state');
      }
      throw error;
    }
  }

  async readTask(taskId: string): Promise<CentralTaskRecord | undefined> {
    assertTaskId(taskId);
    return (await this.readTasks()).find((task) => task.taskId === taskId);
  }

  private async writeTasks(tasks: readonly CentralTaskRecord[]): Promise<void> {
    tasks.forEach(validateTask);
    await atomicWrite(this.paths.tasksFile, `${JSON.stringify({ version: TASKS_VERSION, tasks }, null, 2)}\n`);
  }

  /** Enqueue and claim in one state-lock transaction. */
  async enqueueAndClaim(input: {
    readonly task: string;
    readonly workflow: string;
    readonly worktree: CentralWorktreeRequest;
    readonly branch?: string;
    readonly baseBranch?: string;
    readonly autoPr?: boolean;
    readonly draftPr?: boolean;
    readonly origin?: CentralTaskOrigin;
  }): Promise<CentralTaskHandle> {
    if (!input.task.trim() || !input.workflow.trim()) throw new Error('task and workflow are required');
    return withLock(this.paths, async () => {
      const tasks = [...await this.readTasks()];
      if (tasks.some((task) => task.status === 'starting' || task.status === 'running')) throw new CentralTaskBusyError();
      const now = new Date().toISOString();
      const taskId = randomUUID();
      const executionId = randomUUID();
      const runId = makeRunId(now);
      const ownerToken = makeOwnerToken();
      const record: CentralTaskRecord = {
        taskId,
        generation: 0,
        status: 'starting',
        origin: input.origin ?? 'web',
        attempt: 1,
        task: input.task,
        workflow: input.workflow,
        worktree: input.worktree,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
        ...(input.autoPr === undefined ? {} : { autoPr: input.autoPr }),
        ...(input.draftPr === undefined ? {} : { draftPr: input.draftPr }),
        createdAt: now,
        updatedAt: now,
        runId,
        runIds: [runId],
        activeExecution: {
          executionId,
          runId,
          ownerTokenHash: hashToken(ownerToken),
          pid: 0,
          startTime: now,
          startedAt: now,
        },
      };
      await this.writeTasks([...tasks, record]);
      return { task: record, ownerToken, executionId, runId };
    });
  }

  /**
   * Queue a UI task or reuse the currently active UI worker.  The decision and
   * task append share the state lock, so two HTTP requests cannot both spawn.
   */
  async enqueueOrReuse(input: {
    readonly task: string;
    readonly workflow: string;
    readonly worktree: CentralWorktreeRequest;
    readonly branch?: string;
    readonly baseBranch?: string;
    readonly autoPr?: boolean;
    readonly draftPr?: boolean;
  }): Promise<CentralTaskLaunchDecision> {
    return withLock(this.paths, async () => {
      const tasks = [...await this.readTasks()];
      const active = tasks.find((task) => task.status === 'starting' || task.status === 'running');
      if (active?.activeExecution !== undefined) {
        const now = new Date().toISOString();
        const pending: CentralTaskRecord = {
          taskId: randomUUID(),
          generation: 0,
          status: 'pending',
          origin: 'web',
          attempt: 0,
          task: input.task,
          workflow: input.workflow,
          worktree: input.worktree,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
          ...(input.autoPr === undefined ? {} : { autoPr: input.autoPr }),
          ...(input.draftPr === undefined ? {} : { draftPr: input.draftPr }),
          createdAt: now,
          updatedAt: now,
          runIds: [],
        };
        await this.writeTasks([...tasks, pending]);
        return { kind: 'reused', task: pending, active: active.activeExecution };
      }
      const pendingIndex = tasks.findIndex((task) => task.status === 'pending');
      if (pendingIndex >= 0) {
        const claimed = startPendingTask(tasks[pendingIndex]!, new Date().toISOString());
        const now = new Date().toISOString();
        const incoming: CentralTaskRecord = {
          taskId: randomUUID(),
          generation: 0,
          status: 'pending',
          origin: 'web',
          attempt: 0,
          task: input.task,
          workflow: input.workflow,
          worktree: input.worktree,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
          ...(input.autoPr === undefined ? {} : { autoPr: input.autoPr }),
          ...(input.draftPr === undefined ? {} : { draftPr: input.draftPr }),
          createdAt: now,
          updatedAt: now,
          runIds: [],
        };
        tasks[pendingIndex] = claimed.task;
        tasks.push(incoming);
        await this.writeTasks(tasks);
        return {
          kind: 'started',
          task: claimed.task,
          ownerToken: claimed.ownerToken,
          executionId: claimed.executionId,
          runId: claimed.runId,
        };
      }
      const now = new Date().toISOString();
      const taskId = randomUUID();
      const executionId = randomUUID();
      const runId = makeRunId(now);
      const ownerToken = makeOwnerToken();
      const record: CentralTaskRecord = {
        taskId,
        generation: 0,
        status: 'starting',
        origin: 'web',
        attempt: 1,
        task: input.task,
        workflow: input.workflow,
        worktree: input.worktree,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
        ...(input.autoPr === undefined ? {} : { autoPr: input.autoPr }),
        ...(input.draftPr === undefined ? {} : { draftPr: input.draftPr }),
        createdAt: now,
        updatedAt: now,
        runId,
        runIds: [runId],
        activeExecution: {
          executionId,
          runId,
          ownerTokenHash: hashToken(ownerToken),
          pid: 0,
          startTime: now,
          startedAt: now,
        },
      };
      await this.writeTasks([...tasks, record]);
      return { kind: 'started', task: record, ownerToken, executionId, runId };
    });
  }

  /** Start another run for one failed task while preserving its execution settings. */
  async requeueFailedTask(taskId: string): Promise<CentralTaskLaunchDecision> {
    assertTaskId(taskId);
    return withLock(this.paths, async () => {
      const tasks = [...await this.readTasks()];
      const failedIndex = tasks.findIndex((task) => task.taskId === taskId);
      const failed = failedIndex < 0 ? undefined : tasks[failedIndex];
      if (failed === undefined) {
        throw new CentralTaskRequeueError('Task was not found');
      }
      if (failed.status !== 'failed') {
        throw new CentralTaskRequeueError('Only failed tasks can be requeued');
      }
      const now = new Date().toISOString();
      tasks[failedIndex] = resetFailedTaskToPending(failed, now);
      const active = tasks.find((task) => task.status === 'starting' || task.status === 'running');
      if (active?.activeExecution !== undefined) {
        await this.writeTasks(tasks);
        return { kind: 'reused', task: tasks[failedIndex]!, active: active.activeExecution };
      }
      const pendingIndex = tasks.findIndex((task) => task.status === 'pending');
      if (pendingIndex < 0) throw new CentralTaskCasError('Requeued task was not persisted as pending');
      const claimed = startPendingTask(tasks[pendingIndex]!, now);
      tasks[pendingIndex] = claimed.task;
      await this.writeTasks(tasks);
      return {
        kind: 'started',
        task: claimed.task,
        ownerToken: claimed.ownerToken,
        executionId: claimed.executionId,
        runId: claimed.runId,
      };
    });
  }

  /** Claim exactly one oldest pending task while no active worker exists. */
  async claimNextPending(): Promise<CentralTaskHandle | undefined> {
    return withLock(this.paths, async () => {
      const tasks = [...await this.readTasks()];
      if (tasks.some((task) => task.status === 'starting' || task.status === 'running')) return undefined;
      const pendingIndex = tasks.findIndex((task) => task.status === 'pending');
      if (pendingIndex < 0) return undefined;
      const claimed = startPendingTask(tasks[pendingIndex]!, new Date().toISOString());
      tasks[pendingIndex] = claimed.task;
      await this.writeTasks(tasks);
      return claimed;
    });
  }

  async setStartingPid(input: {
    readonly taskId: string;
    readonly generation: number;
    readonly executionId: string;
    readonly ownerToken: string;
    readonly pid: number;
    readonly runId?: string;
  }): Promise<CentralTaskRecord> {
    return withLock(this.paths, async () => {
      const tasks = [...await this.readTasks()];
      const index = tasks.findIndex((task) => task.taskId === input.taskId);
      const task = index < 0 ? undefined : tasks[index];
      if (task === undefined) {
        throw new CentralTaskCasError('Central task startup PID compare-and-swap failed');
      }
      // The child may adopt before the parent records the PID. Its adoption
      // owns the process identity, so the parent observes that committed
      // state instead of racing it back to `starting`.
      if (
        task.status === 'running'
        && task.generation === input.generation + 1
        && task.activeExecution?.executionId === input.executionId
        && task.activeExecution.ownerTokenHash === hashToken(input.ownerToken)
      ) {
        return task;
      }
      // An immediately finishing child can terminalize before the parent
      // reaches this point. The task id/run id still binds the observation to
      // this reservation; never mutate the terminal record.
      if (
        (task.status === 'completed' || task.status === 'failed')
        && task.runIds.at(-1) === input.runId
        && task.generation >= input.generation + 2
      ) {
        return task;
      }
      if (
        task.status !== 'starting'
        || task.generation !== input.generation
        || task.activeExecution?.executionId !== input.executionId
        || task.activeExecution.ownerTokenHash !== hashToken(input.ownerToken)
      ) {
        throw new CentralTaskCasError('Central task startup PID compare-and-swap failed');
      }
      const processIdentity = getProcessIdentity(input.pid);
      const updated: CentralTaskRecord = {
        ...task,
        activeExecution: {
          ...task.activeExecution,
          pid: input.pid,
          ...(processIdentity === undefined ? { processIdentity: undefined } : { processIdentity }),
        },
        updatedAt: new Date().toISOString(),
      };
      tasks[index] = updated;
      await this.writeTasks(tasks);
      return updated;
    });
  }

  async failStarting(input: {
    readonly taskId: string;
    readonly generation: number;
    readonly executionId: string;
    readonly ownerToken: string;
    readonly message: string;
  }): Promise<CentralTaskRecord> {
    return withLock(this.paths, async () => {
      const tasks = [...await this.readTasks()];
      const index = tasks.findIndex((task) => task.taskId === input.taskId);
      const task = index < 0 ? undefined : tasks[index];
      if (task === undefined || task.status !== 'starting' || task.generation !== input.generation || task.activeExecution?.executionId !== input.executionId || task.activeExecution.ownerTokenHash !== hashToken(input.ownerToken)) {
        throw new CentralTaskCasError('Central task startup failure compare-and-swap failed');
      }
      const now = new Date().toISOString();
      const failed: CentralTaskRecord = {
        ...task,
        generation: task.generation + 1,
        status: 'failed',
        updatedAt: now,
        failure: { code: 'spawn_failed', message: input.message, at: now },
      };
      delete (failed as { activeExecution?: CentralActiveExecution }).activeExecution;
      tasks[index] = failed;
      await this.writeTasks(tasks);
      return failed;
    });
  }

  /**
   * Adopt only after the current project identity has been checked while the
   * state lock is held. An optional precondition hook is kept for callers that
   * already have an external identity observation; the repository check still
   * runs afterwards and is authoritative.
   */
  async adoptVerified(
    input: {
      readonly taskId: string;
      readonly generation: number;
      readonly executionId: string;
      readonly ownerToken: string;
      readonly pid?: number;
    },
    precondition?: () => Promise<void>,
  ): Promise<CentralTaskRecord> {
    assertTaskId(input.taskId);
    return withLock(this.paths, async () => {
      if (precondition !== undefined) await precondition();
      await this.readAndVerifyPersistedIdentityUnlocked();
      const tasks = [...await this.readTasks()];
      const index = tasks.findIndex((task) => task.taskId === input.taskId);
      const task = index < 0 ? undefined : tasks[index];
      if (task === undefined || task.status !== 'starting' || task.generation !== input.generation || task.activeExecution?.executionId !== input.executionId || task.activeExecution.ownerTokenHash !== hashToken(input.ownerToken)) {
        throw new CentralTaskCasError('Central task adopt compare-and-swap failed');
      }
      const pid = input.pid ?? process.pid;
      const identity = getProcessIdentity(pid);
      const now = new Date().toISOString();
      const adopted: CentralTaskRecord = {
        ...task,
        generation: task.generation + 1,
        status: 'running',
        updatedAt: now,
        activeExecution: {
          ...task.activeExecution,
          pid,
          ...(identity === undefined ? { processIdentity: undefined } : { processIdentity: identity }),
          startedAt: now,
        },
      };
      tasks[index] = adopted;
      await this.writeTasks(tasks);
      return adopted;
    });
  }

  async adopt(input: {
    readonly taskId: string;
    readonly generation: number;
    readonly executionId: string;
    readonly ownerToken: string;
    readonly pid?: number;
  }): Promise<CentralTaskRecord> {
    return this.adoptVerified(input);
  }

  async terminal(input: {
    readonly taskId: string;
    readonly generation: number;
    readonly executionId: string;
    readonly ownerToken: string;
    readonly status: 'completed' | 'failed';
    readonly failure?: { readonly code: string; readonly message: string };
    readonly prUrl?: string;
  }): Promise<CentralTaskRecord> {
    return withLock(this.paths, async () => {
      const tasks = [...await this.readTasks()];
      const index = tasks.findIndex((task) => task.taskId === input.taskId);
      const task = index < 0 ? undefined : tasks[index];
      if (task === undefined || task.generation !== input.generation || !task.activeExecution || task.activeExecution.executionId !== input.executionId || task.activeExecution.ownerTokenHash !== hashToken(input.ownerToken) || task.status !== 'running') {
        throw new CentralTaskCasError('Central task terminal compare-and-swap failed');
      }
      const now = new Date().toISOString();
      const terminal: CentralTaskRecord = {
        ...task,
        generation: task.generation + 1,
        status: input.status,
        updatedAt: now,
        ...(input.failure === undefined ? {} : { failure: { ...input.failure, at: now } }),
        ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
      };
      delete (terminal as { activeExecution?: CentralActiveExecution }).activeExecution;
      tasks[index] = terminal;
      await this.writeTasks(tasks);
      return terminal;
    });
  }

  /** Mark dead/reused processes failed; unknown identity is fail-closed and kept live. */
  async reconcile(): Promise<readonly CentralTaskRecord[]> {
    return withLock(this.paths, async () => {
      const tasks = [...await this.readTasks()];
      let changed = false;
      const reconciled = tasks.map((task) => {
        const active = task.activeExecution;
        if (active === undefined || task.status === 'completed' || task.status === 'failed') return task;
        const currentIdentity = active.pid > 0 ? getProcessIdentity(active.pid) : undefined;
        const startingExpired = task.status === 'starting'
          && Date.parse(active.startedAt) + STARTING_RESERVATION_TIMEOUT_MS <= Date.now();
        let processStale = false;
        try {
          processStale = active.pid > 0 && !isProcessAlive(active.pid)
            || active.pid > 0
              && active.processIdentity !== undefined
              && currentIdentity !== undefined
              && !sameProcessIdentity(active.processIdentity, currentIdentity);
        } catch {
          processStale = false;
        }
        const stale = startingExpired || processStale;
        if (!stale) return task;
        changed = true;
        const now = new Date().toISOString();
        const failed: CentralTaskRecord = {
          ...task,
          generation: task.generation + 1,
          status: 'failed',
          updatedAt: now,
          failure: {
            code: startingExpired ? 'startup_timeout' : 'worker_crashed',
            message: startingExpired
              ? 'Central worker did not adopt the startup reservation before its deadline'
              : 'Central worker process is no longer the recorded process',
            at: now,
          },
        };
        delete (failed as { activeExecution?: CentralActiveExecution }).activeExecution;
        return failed;
      });
      if (changed) await this.writeTasks(reconciled);
      return reconciled;
    });
  }
}

export async function openCentralTaskRepository(options: Parameters<typeof CentralTaskRepository.open>[0]): Promise<CentralTaskRepository> {
  return CentralTaskRepository.open(options);
}
