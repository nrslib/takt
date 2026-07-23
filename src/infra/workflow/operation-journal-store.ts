import {
  existsSync,
  lstatSync,
  type Stats,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  readRegularFileNoFollow,
  writePrivateFileWithMode,
} from '../../shared/utils/private-file.js';
import {
  assertAncestorIdentities,
  hasMatchingIdentity,
  inspectPrivateArtifactPath,
  lstatOrUndefined,
  type DirectoryIdentity,
} from '../../shared/utils/private-path-identity.js';
import {
  OperationJournalConflictError,
} from '../../core/workflow/operations/operation-recovery-error.js';
import {
  parseOperationJournalDocument,
} from '../../core/workflow/operations/operation-journal-schemas.js';
import {
  OPERATION_JOURNAL_STAGE_ORDER,
  type AppendOperationAttemptInput,
  type ClaimOperationParentInput,
  type CompareAndSetOperationChildInput,
  type CompareAndSetOperationParentInput,
  type CreateOperationChildInput,
  type CreateOperationParentInput,
  type OperationJournalChild,
  type OperationJournalDocument,
  type OperationJournalParent,
  type OperationJournalStage,
  type OperationJournalStore,
  type OperationOwner,
} from '../../core/workflow/operations/operation-journal-types.js';

const PRIVATE_FILE_MODE = 0o600;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const MALFORMED_LOCK_GRACE_MS = 250;
const RECOVERY_ELECTION_RECORD_LIMIT = 256;
const RECOVERY_ELECTION_LOG_BYTE_LIMIT = 256 * 1024;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const LOCK_PUBLICATION_SCRIPT = String.raw`
const fs = require('node:fs');
const request = JSON.parse(process.argv[1]);
const noFollow = fs.constants.O_NOFOLLOW ?? 0;

function matches(stat, identity) {
  return stat.isFile()
    && String(stat.dev) === identity.dev
    && String(stat.ino) === identity.ino;
}

let stagingDescriptor;
let targetDescriptor;
let stagingIdentity;
let published = false;
let phase = 'staging';
try {
  const parent = fs.statSync('.');
  if (
    !parent.isDirectory()
    || String(parent.dev) !== request.parent.dev
    || String(parent.ino) !== request.parent.ino
  ) {
    throw new Error('Operation journal lock parent identity changed before publication');
  }
  stagingDescriptor = fs.openSync(
    request.stagingName,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    request.mode,
  );
  const stagingStat = fs.fstatSync(stagingDescriptor);
  stagingIdentity = { dev: String(stagingStat.dev), ino: String(stagingStat.ino) };
  fs.fchmodSync(stagingDescriptor, request.mode);
  fs.writeFileSync(stagingDescriptor, request.content, { encoding: 'utf-8' });
  fs.fsyncSync(stagingDescriptor);
  phase = 'publish';
  fs.linkSync(request.stagingName, request.targetName);
  published = true;
  targetDescriptor = fs.openSync(request.targetName, fs.constants.O_RDONLY | noFollow);
  if (!matches(fs.fstatSync(targetDescriptor), stagingIdentity)) {
    throw new Error('Operation journal lock target identity changed during publication');
  }
  fs.unlinkSync(request.stagingName);
} catch (error) {
  let cleanupError;
  if (published) {
    try {
      const target = fs.lstatSync(request.targetName);
      if (stagingIdentity !== undefined && matches(target, stagingIdentity)) {
        fs.unlinkSync(request.targetName);
      }
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError;
    }
  }
  if (stagingIdentity !== undefined) {
    try {
      const staging = fs.lstatSync(request.stagingName);
      if (matches(staging, stagingIdentity)) fs.unlinkSync(request.stagingName);
    } catch (caughtCleanupError) {
      cleanupError ??= caughtCleanupError;
    }
  }
  process.stderr.write(JSON.stringify({
    code: phase === 'publish'
      && error && typeof error === 'object' && 'code' in error
      ? error.code
      : null,
    message: [
      error instanceof Error ? error.message : String(error),
      cleanupError instanceof Error ? cleanupError.message : undefined,
    ].filter(Boolean).join('; '),
  }));
  process.exitCode = 1;
} finally {
  if (targetDescriptor !== undefined) fs.closeSync(targetDescriptor);
  if (stagingDescriptor !== undefined) fs.closeSync(stagingDescriptor);
}
`;

interface LockHolder {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
}

interface LockSnapshot {
  readonly stat: Stats;
  readonly ancestorIdentities: readonly DirectoryIdentity[];
  readonly content: string;
}

interface LockPublicationFailure {
  readonly code: string | null;
  readonly message: string;
}

interface RecoveryElectionRecord {
  readonly version: 1;
  readonly kind: 'claim' | 'release';
  readonly lockKey: string;
  readonly pid: number;
  readonly token: string;
}

class OperationJournalLockContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationJournalLockContentionError';
  }
}

function createEmptyDocument(): OperationJournalDocument {
  return { version: 1, parents: [] };
}

function cloneParent(parent: OperationJournalParent): OperationJournalParent {
  return structuredClone(parent);
}

function cloneChild(child: OperationJournalChild): OperationJournalChild {
  return structuredClone(child);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function parseLockPublicationFailure(stderr: string): LockPublicationFailure {
  const value: unknown = JSON.parse(stderr);
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    throw new Error('Operation journal lock publisher returned an invalid failure');
  }
  const record = value as Record<string, unknown>;
  if (
    (record.code !== null && typeof record.code !== 'string')
    || typeof record.message !== 'string'
  ) {
    throw new Error('Operation journal lock publisher returned an invalid failure');
  }
  return {
    code: record.code,
    message: record.message,
  };
}

function parseRecoveryElectionRecord(line: string): RecoveryElectionRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'kind,lockKey,pid,token,version'
    || record.version !== 1
    || (record.kind !== 'claim' && record.kind !== 'release')
    || typeof record.lockKey !== 'string'
    || record.lockKey.length === 0
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.token !== 'string'
    || record.token.length === 0
  ) {
    return undefined;
  }
  return {
    version: 1,
    kind: record.kind,
    lockKey: record.lockKey,
    pid: record.pid as number,
    token: record.token,
  };
}

function parseRecoveryElectionLog(content: string): readonly RecoveryElectionRecord[] {
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const record = parseRecoveryElectionRecord(line);
      return record === undefined ? [] : [record];
    });
}

function compactRecoveryElectionRecords(
  records: readonly RecoveryElectionRecord[],
): readonly RecoveryElectionRecord[] {
  const releasedClaims = new Set(
    records
      .filter((record) => record.kind === 'release')
      .map((record) => `${record.lockKey}\0${record.token}`),
  );
  const retainedClaims = new Map<string, RecoveryElectionRecord>();
  for (const record of records) {
    if (record.kind !== 'claim') continue;
    const claimKey = `${record.lockKey}\0${record.token}`;
    if (!releasedClaims.has(claimKey) && isProcessAlive(record.pid)) {
      retainedClaims.set(claimKey, record);
    }
  }
  return [...retainedClaims.values()];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, 'ESRCH');
  }
}

function publishOperationLock(
  parentPath: string,
  targetPath: string,
  stagingPath: string,
  parentStat: Stats,
  content: string,
): void {
  const result = spawnSync(
    process.execPath,
    ['-e', LOCK_PUBLICATION_SCRIPT, JSON.stringify({
      parent: { dev: String(parentStat.dev), ino: String(parentStat.ino) },
      content,
      mode: PRIVATE_FILE_MODE,
      targetName: basename(targetPath),
      stagingName: basename(stagingPath),
    })],
    {
      cwd: parentPath,
      encoding: 'utf-8',
      env: {},
      timeout: LOCK_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status === 0) {
    return;
  }
  const failure = parseLockPublicationFailure(result.stderr);
  if (failure.code === 'EEXIST') {
    throw new OperationJournalLockContentionError(failure.message);
  }
  throw new Error(`Operation journal lock publication failed: ${failure.message}`);
}

function waitForLockRetry(): void {
  Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_DELAY_MS);
}

function serializeLockHolder(holder: LockHolder): string {
  return `${JSON.stringify(holder)}\n`;
}

function parseLockHolder(content: string): LockHolder | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'pid,token,version'
    || record.version !== 1
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.token !== 'string'
    || record.token.length === 0
  ) {
    return undefined;
  }
  return {
    version: 1,
    pid: record.pid as number,
    token: record.token,
  };
}

function isTerminalStage(stage: OperationJournalStage): boolean {
  return stage === 'completed' || stage === 'terminated';
}

function assertParentAllowsChildMutation(
  parent: OperationJournalParent,
  nextStage: OperationJournalStage,
  operation: 'compare_and_set' | 'append_attempt',
): void {
  assertParentIsMutable(parent);
  if (
    parent.stage === 'terminating'
    && (operation !== 'compare_and_set' || nextStage !== 'applied')
  ) {
    throw new OperationJournalConflictError(
      `Operation parent "${parent.id}" only permits raw/applied child publication while terminating`,
    );
  }
}

function assertStageTransition(
  current: OperationJournalStage,
  next: OperationJournalStage,
  operationId: string,
): void {
  const currentOrder = OPERATION_JOURNAL_STAGE_ORDER[current];
  const nextOrder = OPERATION_JOURNAL_STAGE_ORDER[next];
  if (nextOrder < currentOrder || (nextOrder === currentOrder && next !== current)) {
    throw new OperationJournalConflictError(
      `Operation "${operationId}" cannot move from stage "${current}" to "${next}"`,
    );
  }
}

function assertParentIsMutable(parent: OperationJournalParent): void {
  if (isTerminalStage(parent.stage)) {
    throw new OperationJournalConflictError(
      `Operation parent "${parent.id}" is sealed at terminal stage "${parent.stage}"`,
    );
  }
}

function assertOwner(parent: OperationJournalParent, expected: OperationOwner): void {
  if (
    parent.owner.generation !== expected.generation
    || parent.owner.claimToken !== expected.claimToken
  ) {
    throw new OperationJournalConflictError(
      `Operation parent "${parent.id}" owner changed: expected generation ${expected.generation}`,
    );
  }
}

function requireParent(
  document: OperationJournalDocument,
  parentId: string,
): { readonly parent: OperationJournalParent; readonly index: number } {
  const index = document.parents.findIndex((parent) => parent.id === parentId);
  const parent = document.parents[index];
  if (parent === undefined) {
    throw new OperationJournalConflictError(`Operation parent "${parentId}" does not exist`);
  }
  return { parent, index };
}

function requireChild(
  parent: OperationJournalParent,
  childId: string,
): { readonly child: OperationJournalChild; readonly index: number } {
  const index = parent.children.findIndex((child) => child.id === childId);
  const child = parent.children[index];
  if (child === undefined) {
    throw new OperationJournalConflictError(
      `Operation child "${childId}" does not exist under parent "${parent.id}"`,
    );
  }
  return { child, index };
}

function replaceParent(
  document: OperationJournalDocument,
  parentIndex: number,
  parent: OperationJournalParent,
): OperationJournalDocument {
  return {
    ...document,
    parents: document.parents.map((current, index) => index === parentIndex ? parent : current),
  };
}

function replaceChild(
  parent: OperationJournalParent,
  childIndex: number,
  child: OperationJournalChild,
): OperationJournalParent {
  return {
    ...parent,
    children: parent.children.map((current, index) => index === childIndex ? child : current),
  };
}

class FileOperationJournalStore implements OperationJournalStore {
  private readonly journalPath: string;
  private readonly lockPath: string;
  private readonly recoveryElectionPath: string;
  private readonly recoveryElectionMutexPath: string;
  private locked = false;

  constructor(journalPath: string) {
    this.journalPath = resolve(journalPath);
    this.lockPath = `${this.journalPath}.lock`;
    this.recoveryElectionPath = `${this.lockPath}.recovery`;
    this.recoveryElectionMutexPath = `${this.recoveryElectionPath}.mutex`;
  }

  createParent(input: CreateOperationParentInput): OperationJournalParent {
    return this.mutate((document) => {
      if (document.parents.some((parent) => parent.id === input.id)) {
        throw new OperationJournalConflictError(`Operation parent "${input.id}" already exists`);
      }
      const parent: OperationJournalParent = {
        id: input.id,
        kind: input.kind,
        revision: 0,
        stage: input.stage,
        payload: input.payload,
        owner: {
          generation: 0,
          claimToken: input.claimToken,
        },
        children: [],
      };
      return {
        document: { ...document, parents: [...document.parents, parent] },
        result: parent,
      };
    });
  }

  getParent(parentId: string): OperationJournalParent {
    return this.withLock(() => cloneParent(requireParent(this.readDocument(), parentId).parent));
  }

  listParents(): readonly OperationJournalParent[] {
    return this.withLock(() => this.readDocument().parents.map(cloneParent));
  }

  claimParent(input: ClaimOperationParentInput): OperationJournalParent {
    return this.mutate((document) => {
      const { parent, index } = requireParent(document, input.parentId);
      assertOwner(parent, input.expectedOwner);
      this.assertRevisionAndStage(
        parent.id,
        parent.revision,
        parent.stage,
        input.expectedRevision,
        input.expectedStage,
      );
      assertParentIsMutable(parent);
      if (input.nextClaimToken === parent.owner.claimToken) {
        throw new OperationJournalConflictError(
          `Operation parent "${parent.id}" claim token must change on ownership transfer`,
        );
      }
      const generation = parent.owner.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new OperationJournalConflictError(
          `Operation parent "${parent.id}" owner generation is exhausted`,
        );
      }
      const claimed: OperationJournalParent = {
        ...parent,
        revision: parent.revision + 1,
        owner: {
          generation,
          claimToken: input.nextClaimToken,
        },
      };
      return {
        document: replaceParent(document, index, claimed),
        result: claimed,
      };
    });
  }

  compareAndSetParent(input: CompareAndSetOperationParentInput): OperationJournalParent {
    return this.mutate((document) => {
      const { parent, index } = requireParent(document, input.parentId);
      assertOwner(parent, input.owner);
      this.assertRevisionAndStage(
        parent.id,
        parent.revision,
        parent.stage,
        input.expectedRevision,
        input.expectedStage,
      );
      assertParentIsMutable(parent);
      assertStageTransition(parent.stage, input.nextStage, parent.id);
      const updated: OperationJournalParent = {
        ...parent,
        revision: parent.revision + 1,
        stage: input.nextStage,
        payload: input.payload,
      };
      return {
        document: replaceParent(document, index, updated),
        result: updated,
      };
    });
  }

  createChild(input: CreateOperationChildInput): OperationJournalChild {
    return this.mutate((document) => {
      const { parent, index } = requireParent(document, input.parentId);
      assertOwner(parent, input.owner);
      this.assertRevisionAndStage(
        parent.id,
        parent.revision,
        parent.stage,
        input.expectedParentRevision,
        input.expectedParentStage,
      );
      assertParentIsMutable(parent);
      if (parent.stage === 'terminating') {
        throw new OperationJournalConflictError(
          `Operation parent "${parent.id}" cannot create children while terminating`,
        );
      }
      if (parent.children.some((child) => child.id === input.id)) {
        throw new OperationJournalConflictError(
          `Operation child "${input.id}" already exists under parent "${parent.id}"`,
        );
      }
      const child: OperationJournalChild = {
        id: input.id,
        kind: input.kind,
        revision: 0,
        stage: input.stage,
        payload: input.payload,
        attempts: [],
      };
      const updatedParent: OperationJournalParent = {
        ...parent,
        revision: parent.revision + 1,
        children: [...parent.children, child],
      };
      return {
        document: replaceParent(document, index, updatedParent),
        result: child,
      };
    });
  }

  getChild(parentId: string, childId: string): OperationJournalChild {
    return this.withLock(() => {
      const { parent } = requireParent(this.readDocument(), parentId);
      return cloneChild(requireChild(parent, childId).child);
    });
  }

  listChildren(parentId: string): readonly OperationJournalChild[] {
    return this.withLock(() => {
      const { parent } = requireParent(this.readDocument(), parentId);
      return parent.children.map(cloneChild);
    });
  }

  compareAndSetChild(input: CompareAndSetOperationChildInput): OperationJournalChild {
    return this.updateChild(input, 'compare_and_set', (child) => ({
      ...child,
      revision: child.revision + 1,
      stage: input.nextStage,
      payload: input.payload,
    }));
  }

  appendAttempt(input: AppendOperationAttemptInput): OperationJournalChild {
    return this.updateChild(input, 'append_attempt', (child) => {
      if (child.attempts.some((attempt) => attempt.id === input.attempt.id)) {
        throw new OperationJournalConflictError(
          `Operation attempt "${input.attempt.id}" already exists under child "${child.id}"`,
        );
      }
      const sequence = child.attempts.length + 1;
      return {
        ...child,
        revision: child.revision + 1,
        stage: input.nextStage,
        payload: input.payload,
        attempts: [...child.attempts, { ...input.attempt, sequence }],
      };
    });
  }

  private updateChild(
    input: CompareAndSetOperationChildInput,
    operation: 'compare_and_set' | 'append_attempt',
    update: (child: OperationJournalChild) => OperationJournalChild,
  ): OperationJournalChild {
    return this.mutate((document) => {
      const { parent, index: parentIndex } = requireParent(document, input.parentId);
      assertOwner(parent, input.owner);
      this.assertRevisionAndStage(
        parent.id,
        parent.revision,
        parent.stage,
        input.expectedParentRevision,
        input.expectedParentStage,
      );
      assertParentAllowsChildMutation(parent, input.nextStage, operation);
      const { child, index: childIndex } = requireChild(parent, input.childId);
      this.assertRevisionAndStage(
        child.id,
        child.revision,
        child.stage,
        input.expectedRevision,
        input.expectedStage,
      );
      assertStageTransition(child.stage, input.nextStage, child.id);
      const updatedChild = update(child);
      const updatedParent = {
        ...replaceChild(parent, childIndex, updatedChild),
        revision: parent.revision + 1,
      };
      return {
        document: replaceParent(document, parentIndex, updatedParent),
        result: updatedChild,
      };
    });
  }

  private assertRevisionAndStage(
    operationId: string,
    currentRevision: number,
    currentStage: OperationJournalStage,
    expectedRevision: number,
    expectedStage: OperationJournalStage,
  ): void {
    if (currentRevision !== expectedRevision || currentStage !== expectedStage) {
      throw new OperationJournalConflictError(
        `Operation "${operationId}" changed: expected revision ${expectedRevision} at stage "${expectedStage}", `
        + `received revision ${currentRevision} at stage "${currentStage}"`,
      );
    }
  }

  private mutate<Result>(
    mutation: (document: OperationJournalDocument) => {
      readonly document: OperationJournalDocument;
      readonly result: Result;
    },
  ): Result {
    return this.withLock(() => {
      const mutationResult = mutation(this.readDocument());
      const parsed = parseOperationJournalDocument(mutationResult.document);
      this.writeDocument(parsed);
      return structuredClone(mutationResult.result);
    });
  }

  private readDocument(): OperationJournalDocument {
    if (!existsSync(this.journalPath)) {
      return createEmptyDocument();
    }
    const expectedStat = lstatSync(this.journalPath);
    if (expectedStat.isSymbolicLink() || !expectedStat.isFile()) {
      throw new Error(`Operation journal path is not a regular file: ${this.journalPath}`);
    }
    const content = readRegularFileNoFollow(this.journalPath, expectedStat).toString('utf-8');
    return parseOperationJournalDocument(JSON.parse(content) as unknown);
  }

  private writeDocument(document: OperationJournalDocument): void {
    writePrivateFileWithMode(
      this.journalPath,
      JSON.stringify(document, null, 2),
      PRIVATE_FILE_MODE,
    );
  }

  private withLock<Result>(action: () => Result): Result {
    if (this.locked) {
      throw new Error(`Operation journal store reentrant lock detected: ${this.journalPath}`);
    }
    this.locked = true;
    let lockSnapshot: LockSnapshot;
    try {
      ensurePrivateDirectory(dirname(this.journalPath));
      lockSnapshot = this.acquireFileLock();
    } catch (error) {
      this.locked = false;
      throw error;
    }
    let result!: Result;
    let actionFailed = false;
    let actionError: unknown;
    try {
      result = action();
    } catch (error) {
      actionFailed = true;
      actionError = error;
    }
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      this.releaseFileLock(lockSnapshot);
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    this.locked = false;
    if (actionFailed) {
      if (releaseFailed) {
        throw new AggregateError(
          [actionError, releaseError],
          `Operation journal action and lock release both failed: ${this.journalPath}`,
        );
      }
      throw actionError;
    }
    if (releaseFailed) {
      throw releaseError;
    }
    return result;
  }

  private acquireFileLock(): LockSnapshot {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      const acquired = this.tryAcquireLock(this.lockPath);
      if (acquired !== undefined) {
        return acquired;
      }
      const existing = this.readLockSnapshot(this.lockPath);
      if (existing !== undefined && this.isLockRecoverable(existing)) {
        this.recoverFileLock(existing, deadline);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Operation journal timed out waiting for lock: ${this.lockPath}`);
      }
      waitForLockRetry();
    }
  }

  private acquireIndependentFileLock(lockPath: string): LockSnapshot {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      const acquired = this.tryAcquireLock(lockPath);
      if (acquired !== undefined) {
        return acquired;
      }
      const existing = this.readLockSnapshot(lockPath);
      if (existing !== undefined && this.isLockRecoverable(existing)) {
        this.removeLockFileIfUnchanged(lockPath, existing);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Operation journal timed out waiting for lock: ${lockPath}`);
      }
      waitForLockRetry();
    }
  }

  private tryAcquireLock(lockPath: string): LockSnapshot | undefined {
    if (this.readLockSnapshot(lockPath) !== undefined) {
      return undefined;
    }
    const holder: LockHolder = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
    };
    const content = serializeLockHolder(holder);
    try {
      this.publishNewLock(lockPath, content);
    } catch (error) {
      if (error instanceof OperationJournalLockContentionError) {
        return undefined;
      }
      throw error;
    }
    const acquired = this.readLockSnapshot(lockPath);
    if (acquired === undefined || acquired.content !== content) {
      throw new OperationJournalConflictError(
        `Operation journal lock identity changed after acquisition: ${lockPath}`,
      );
    }
    return acquired;
  }

  private publishNewLock(lockPath: string, content: string): void {
    const inspection = inspectPrivateArtifactPath(lockPath, 'file');
    if (inspection.expectedStat !== undefined) {
      throw new OperationJournalLockContentionError(
        `Operation journal lock already exists: ${lockPath}`,
      );
    }
    const parentIdentity = inspection.ancestorIdentities.at(-1);
    if (parentIdentity === undefined) {
      throw new Error(`Operation journal lock parent identity is missing: ${lockPath}`);
    }
    assertAncestorIdentities(inspection.ancestorIdentities);
    const stagingPath = `${lockPath}.${process.pid}.${randomUUID()}.pending`;
    publishOperationLock(
      dirname(lockPath),
      lockPath,
      stagingPath,
      parentIdentity.stat,
      content,
    );
  }

  private readLockSnapshot(lockPath: string): LockSnapshot | undefined {
    const inspection = inspectPrivateArtifactPath(lockPath, 'file');
    if (inspection.expectedStat === undefined) {
      return undefined;
    }
    const content = readRegularFileNoFollow(
      lockPath,
      inspection.expectedStat,
    ).toString('utf-8');
    assertAncestorIdentities(inspection.ancestorIdentities);
    const currentStat = lstatOrUndefined(lockPath);
    if (
      currentStat === undefined
      || !currentStat.isFile()
      || !hasMatchingIdentity(inspection.expectedStat, currentStat)
    ) {
      throw new OperationJournalConflictError(
        `Operation journal lock identity changed while reading: ${lockPath}`,
      );
    }
    return {
      stat: inspection.expectedStat,
      ancestorIdentities: inspection.ancestorIdentities,
      content,
    };
  }

  private recoverFileLock(expected: LockSnapshot, deadline: number): void {
    const claim: RecoveryElectionRecord = {
      version: 1,
      kind: 'claim',
      lockKey: this.createRecoveryLockKey(expected),
      pid: process.pid,
      token: randomUUID(),
    };
    this.appendRecoveryElectionRecord(claim);
    let recoveryFailed = false;
    let recoveryError: unknown;
    try {
      while (true) {
        const current = this.readLockSnapshot(this.lockPath);
        if (
          current === undefined
          || current.content !== expected.content
          || !hasMatchingIdentity(expected.stat, current.stat)
          || !this.isLockRecoverable(current)
        ) {
          break;
        }
        if (this.isRecoveryLeader(claim)) {
          this.removeLockFileIfUnchanged(this.lockPath, current);
          break;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Operation journal timed out waiting for lock recovery: ${this.lockPath}`,
          );
        }
        waitForLockRetry();
      }
    } catch (error) {
      recoveryFailed = true;
      recoveryError = error;
    }
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      this.appendRecoveryElectionRecord({ ...claim, kind: 'release' });
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (recoveryFailed && releaseFailed) {
      throw new AggregateError(
        [recoveryError, releaseError],
        `Operation journal lock recovery and election release both failed: ${this.lockPath}`,
      );
    }
    if (recoveryFailed) {
      throw recoveryError;
    }
    if (releaseFailed) {
      throw releaseError;
    }
  }

  private createRecoveryLockKey(snapshot: LockSnapshot): string {
    const contentHash = createHash('sha256').update(snapshot.content).digest('hex');
    return `${snapshot.stat.dev}:${snapshot.stat.ino}:${contentHash}`;
  }

  private appendRecoveryElectionRecord(record: RecoveryElectionRecord): void {
    const mutex = this.acquireIndependentFileLock(this.recoveryElectionMutexPath);
    let appendFailed = false;
    let appendError: unknown;
    try {
      appendPrivateFile(this.recoveryElectionPath, `${JSON.stringify(record)}\n`);
      this.compactRecoveryElectionLog();
    } catch (error) {
      appendFailed = true;
      appendError = error;
    }
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      this.releaseFileLock(mutex, this.recoveryElectionMutexPath);
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (appendFailed && releaseFailed) {
      throw new AggregateError(
        [appendError, releaseError],
        `Operation journal recovery election update and lock release both failed: ${this.recoveryElectionPath}`,
      );
    }
    if (appendFailed) throw appendError;
    if (releaseFailed) throw releaseError;
  }

  private compactRecoveryElectionLog(): void {
    const snapshot = this.readLockSnapshot(this.recoveryElectionPath);
    if (
      snapshot === undefined
      || (
        snapshot.content.length <= RECOVERY_ELECTION_LOG_BYTE_LIMIT
        && snapshot.content.split('\n').length - 1 <= RECOVERY_ELECTION_RECORD_LIMIT
      )
    ) {
      return;
    }
    const retained = compactRecoveryElectionRecords(
      parseRecoveryElectionLog(snapshot.content),
    );
    const content = retained.map((record) => JSON.stringify(record)).join('\n');
    writePrivateFileWithMode(
      this.recoveryElectionPath,
      content.length === 0 ? '' : `${content}\n`,
      PRIVATE_FILE_MODE,
    );
  }

  private isRecoveryLeader(claim: RecoveryElectionRecord): boolean {
    const snapshot = this.readLockSnapshot(this.recoveryElectionPath);
    if (snapshot === undefined) {
      throw new Error(
        `Operation journal recovery election log disappeared: ${this.recoveryElectionPath}`,
      );
    }
    const records = parseRecoveryElectionLog(snapshot.content)
      .filter((record) => record.lockKey === claim.lockKey);
    const releasedTokens = new Set(
      records
        .filter((record) => record.kind === 'release')
        .map((record) => record.token),
    );
    const leader = records.find((record) =>
      record.kind === 'claim'
      && !releasedTokens.has(record.token)
      && isProcessAlive(record.pid)
    );
    return leader?.token === claim.token;
  }

  private isLockRecoverable(snapshot: LockSnapshot): boolean {
    const holder = parseLockHolder(snapshot.content);
    if (holder === undefined) {
      return Date.now() - snapshot.stat.mtimeMs >= MALFORMED_LOCK_GRACE_MS;
    }
    return !isProcessAlive(holder.pid);
  }

  private removeLockFileIfUnchanged(lockPath: string, expected: LockSnapshot): boolean {
    const current = this.readLockSnapshot(lockPath);
    if (
      current === undefined
      || current.content !== expected.content
      || !hasMatchingIdentity(expected.stat, current.stat)
    ) {
      return false;
    }
    assertAncestorIdentities(expected.ancestorIdentities);
    const confirmed = this.readLockSnapshot(lockPath);
    if (
      confirmed === undefined
      || confirmed.content !== expected.content
      || !hasMatchingIdentity(expected.stat, confirmed.stat)
    ) {
      return false;
    }
    const finalStat = lstatOrUndefined(lockPath);
    if (
      finalStat === undefined
      || !finalStat.isFile()
      || !hasMatchingIdentity(expected.stat, finalStat)
    ) {
      return false;
    }
    try {
      unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) {
        return false;
      }
      throw error;
    }
  }

  private releaseFileLock(
    expected: LockSnapshot,
    lockPath = this.lockPath,
  ): void {
    const holder = parseLockHolder(expected.content);
    if (
      holder === undefined
      || holder.pid !== process.pid
      || !this.removeLockFileIfUnchanged(lockPath, expected)
    ) {
      throw new OperationJournalConflictError(
        `Operation journal lock ownership changed before release: ${lockPath}`,
      );
    }
  }
}

export function createOperationJournalStore(journalPath: string): OperationJournalStore {
  return new FileOperationJournalStore(journalPath);
}
