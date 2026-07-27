import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sha256 } from './canonical-json.js';
import type { RunStorageClock } from './clock.js';
import type { RunReadContext, RunWriteContext } from './context.js';
import type { RunDatabaseFile } from './database-file.js';
import type { LeaseOwner } from './lease.js';
import { RunLeaseManager } from './lease.js';
import {
  readCompleteResumeSnapshot,
  type CompleteResumeSnapshot,
} from './resume-snapshot.js';
import type { PublishedRunDatabase } from './run-database-publication.js';
import type {
  RunStorageExecutor,
  RuntimeBinding,
  RuntimeHandleAuthority,
} from './runtime-binding.js';
import {
  createBoundRunStorageRuntime,
  type RunStorageRuntime,
} from './runtime-composition.js';
import type {
  ExecutionHandle,
  LeaseHandle,
  OperationHandle,
  PersonaSessionHandle,
  PhaseExecutionHandle,
  RecoveryHandle,
  RunSessionHandle,
  ScopeHandle,
} from './runtime-handles.js';
import {
  RunUnitOfWork,
  type BusyRetryPolicy,
} from './unit-of-work.js';
import { readTrustedFindingResumeSource } from './finding-resume-source.js';

interface BoundHandle {
  readonly scopeId: string;
  readonly authorityId?: string;
}

const TRUSTED_RESUME_SNAPSHOT_READERS = new WeakMap<
  object,
  () => CompleteResumeSnapshot
>();

class RunStorageRootImpl {
  readonly #database: DatabaseSync;
  readonly #databaseFile: RunDatabaseFile;
  readonly #runId: string;
  readonly #leases = new RunLeaseManager();
  readonly #handles = new RuntimeHandleVault();
  readonly #rootScope: ScopeHandle;
  readonly #unitOfWork: RunUnitOfWork;
  readonly #executor: RunStorageExecutor;
  #closed = false;

  constructor(
    published: PublishedRunDatabase,
    busyRetry: BusyRetryPolicy,
    clock: RunStorageClock,
  ) {
    this.#database = published.database;
    this.#databaseFile = published.file;
    this.#runId = published.runId;
    this.#unitOfWork = new RunUnitOfWork(
      this.#database,
      this.#leases,
      busyRetry,
      clock,
    );
    this.#executor = Object.freeze({
      read: <Result>(command: (context: RunReadContext) => Result): Result => {
        this.assertOpen();
        return this.#unitOfWork.read(command);
      },
      write: <Result>(
        owner: LeaseOwner,
        command: (context: RunWriteContext, now: number) => Result,
      ): Result => {
        this.assertOpen();
        return this.#unitOfWork.write(owner, command);
      },
      operation: <Result>(
        owner: LeaseOwner,
        command: (context: RunWriteContext, now: number) => Result,
      ): Result => {
        this.assertOpen();
        return this.#unitOfWork.operation(owner, command);
      },
    });
    this.#rootScope = this.#handles.issueScope('root');
    TRUSTED_RESUME_SNAPSHOT_READERS.set(this, () => {
      this.assertOpen();
      return this.#unitOfWork.read(readCompleteResumeSnapshot);
    });
  }

  get rootScope(): ScopeHandle {
    return this.#rootScope;
  }

  runtime(input: {
    readonly lease: LeaseHandle;
    readonly scope?: ScopeHandle;
  }): RunStorageRuntime {
    assertExactKeys(input, ['lease', 'scope']);
    const owner = this.#handles.resolveLease(input.lease);
    const scope = this.#handles.resolveScope(input.scope ?? this.#rootScope);
    const trustedFindingResumeSource = this.#executor.read((context) => (
      readTrustedFindingResumeSource(context, this.#runId)
    ));
    const binding: RuntimeBinding = {
      executor: this.#executor,
      handles: this.#handles,
      owner,
      runId: this.#runId,
      scopeId: scope.scopeId,
      ...(trustedFindingResumeSource === undefined
        ? {}
        : { trustedFindingResumeSource }),
    };
    return createBoundRunStorageRuntime(binding);
  }

  readResumeSnapshot(): CompleteResumeSnapshot {
    this.assertOpen();
    return this.#unitOfWork.read(readCompleteResumeSnapshot);
  }

  claimLease(input: {
    readonly ownerKey: string;
    readonly leaseDurationMs: number;
  }): LeaseHandle {
    assertExactKeys(input, ['ownerKey', 'leaseDurationMs']);
    this.assertOpen();
    const owner = this.#unitOfWork.claim((context, now) => (
      this.#leases.claim(context, {
        runId: this.#runId,
        ownerId: sha256([this.#runId, input.ownerKey].join('\0')),
        claimToken: randomUUID(),
        leaseDurationMs: input.leaseDurationMs,
      }, now)
    ));
    return this.#handles.issueLease(owner);
  }

  heartbeatLease(handle: LeaseHandle, leaseDurationMs: number): void {
    this.assertOpen();
    const owner = this.#handles.resolveLease(handle);
    this.#unitOfWork.maintainLease(owner, true, (context, now) => {
      this.#leases.heartbeat(context, owner, now, leaseDurationMs);
    });
  }

  releaseLease(handle: LeaseHandle): void {
    this.assertOpen();
    const owner = this.#handles.resolveLease(handle);
    this.#unitOfWork.maintainLease(owner, false, (context, now) => {
      this.#leases.release(context, owner, now);
    });
  }

  terminalizeRun(
    handle: LeaseHandle,
    status: 'completed' | 'failed' | 'cancelled',
  ): void {
    this.assertOpen();
    const owner = this.#handles.resolveLease(handle);
    this.#unitOfWork.maintainLease(owner, false, (context, now) => {
      const runtime = context.get<{
        readonly status: string;
        readonly revision: number;
      }>(`
        SELECT status, revision
        FROM scope_runtime
        WHERE run_id = ? AND scope_id = 'root'
      `, owner.runId);
      if (runtime === undefined) {
        throw new Error(
          `Root scope runtime for "${owner.runId}" does not exist`,
        );
      }
      if (isTerminal(runtime.status)) {
        throw new Error(
          `Root scope runtime for "${owner.runId}" is already terminal`,
        );
      }
      context.run(`
        UPDATE scope_runtime
        SET status = ?, revision = revision + 1, updated_at = ?
        WHERE run_id = ? AND scope_id = 'root' AND revision = ? AND status = ?
      `, status, now, owner.runId, runtime.revision, runtime.status);
      this.#leases.terminalize(context, owner, status, now);
    });
  }

  close(): void {
    if (this.#closed) {
      throw new Error('Run storage is closed');
    }
    this.#unitOfWork.assertIdle();
    this.#closed = true;
    this.#databaseFile.close(this.#database);
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new Error('Run storage is closed');
    }
  }
}

class RuntimeHandleVault implements RuntimeHandleAuthority {
  readonly #leases = new WeakMap<object, LeaseOwner>();
  readonly #scopes = new WeakMap<object, BoundHandle>();
  readonly #executions = new WeakMap<object, BoundHandle>();
  readonly #phases = new WeakMap<object, BoundHandle>();
  readonly #operations = new WeakMap<object, BoundHandle>();
  readonly #sessions = new WeakMap<object, BoundHandle>();
  readonly #personaSessions = new WeakMap<object, BoundHandle>();
  readonly #recoveries = new WeakMap<object, BoundHandle>();

  issueLease(owner: LeaseOwner): LeaseHandle {
    const handle = Object.freeze({});
    this.#leases.set(handle, owner);
    return handle as LeaseHandle;
  }

  resolveLease(handle: LeaseHandle): LeaseOwner {
    const owner = this.#leases.get(handle as object);
    if (owner === undefined) {
      throw new Error('Lease handle is forged or belongs to another run');
    }
    return owner;
  }

  issueScope(scopeId: string): ScopeHandle {
    return this.issue<ScopeHandle>(this.#scopes, { scopeId });
  }

  resolveScope(handle: ScopeHandle): { readonly scopeId: string } {
    const record = this.#scopes.get(handle as object);
    if (record === undefined) {
      throw new Error('Scope handle is forged or belongs to another run');
    }
    return { scopeId: record.scopeId };
  }

  issueExecution(scopeId: string, executionId: string): ExecutionHandle {
    return this.issueAuthority(
      this.#executions,
      scopeId,
      executionId,
    ) as ExecutionHandle;
  }

  resolveExecution(handle: ExecutionHandle) {
    const record = this.resolve(this.#executions, handle, 'Execution');
    return { scopeId: record.scopeId, executionId: record.authorityId };
  }

  issuePhase(scopeId: string, phaseExecutionId: string): PhaseExecutionHandle {
    return this.issueAuthority(
      this.#phases,
      scopeId,
      phaseExecutionId,
    ) as PhaseExecutionHandle;
  }

  resolvePhase(handle: PhaseExecutionHandle) {
    const record = this.resolve(this.#phases, handle, 'Phase execution');
    return { scopeId: record.scopeId, phaseExecutionId: record.authorityId };
  }

  issueOperation(scopeId: string, operationId: string): OperationHandle {
    return this.issueAuthority(
      this.#operations,
      scopeId,
      operationId,
    ) as OperationHandle;
  }

  resolveOperation(handle: OperationHandle) {
    const record = this.resolve(this.#operations, handle, 'Operation');
    return { scopeId: record.scopeId, operationId: record.authorityId };
  }

  issueSession(scopeId: string, sessionId: string): RunSessionHandle {
    return this.issueAuthority(
      this.#sessions,
      scopeId,
      sessionId,
    ) as RunSessionHandle;
  }

  resolveSession(handle: RunSessionHandle) {
    const record = this.resolve(this.#sessions, handle, 'Session');
    return { scopeId: record.scopeId, sessionId: record.authorityId };
  }

  issuePersonaSession(
    scopeId: string,
    sessionId: string,
  ): PersonaSessionHandle {
    return this.issueAuthority(
      this.#personaSessions,
      scopeId,
      sessionId,
    ) as PersonaSessionHandle;
  }

  resolvePersonaSession(handle: PersonaSessionHandle) {
    const record = this.resolve(
      this.#personaSessions,
      handle,
      'Persona session',
    );
    return { scopeId: record.scopeId, sessionId: record.authorityId };
  }

  issueRecovery(scopeId: string, recoveryId: string): RecoveryHandle {
    return this.issueAuthority(
      this.#recoveries,
      scopeId,
      recoveryId,
    ) as RecoveryHandle;
  }

  resolveRecovery(handle: RecoveryHandle) {
    const record = this.resolve(this.#recoveries, handle, 'Recovery');
    return { scopeId: record.scopeId, recoveryId: record.authorityId };
  }

  private issueAuthority(
    registry: WeakMap<object, BoundHandle>,
    scopeId: string,
    authorityId: string,
  ): object {
    return this.issue(registry, { scopeId, authorityId });
  }

  private issue<Handle>(
    registry: WeakMap<object, BoundHandle>,
    record: BoundHandle,
  ): Handle {
    const handle = Object.freeze({});
    registry.set(handle, record);
    return handle as Handle;
  }

  private resolve(
    registry: WeakMap<object, BoundHandle>,
    handle: object,
    label: string,
  ): { readonly scopeId: string; readonly authorityId: string } {
    const record = registry.get(handle);
    if (record?.authorityId === undefined) {
      throw new Error(`${label} handle is forged or belongs to another run`);
    }
    return { scopeId: record.scopeId, authorityId: record.authorityId };
  }
}

export function createRunStorageRoot(
  published: PublishedRunDatabase,
  busyRetry: BusyRetryPolicy,
  clock: RunStorageClock,
): RunStorageRoot {
  return new RunStorageRootImpl(published, busyRetry, clock);
}

export type RunStorageRoot = RunStorageRootImpl;

export function readTrustedRunStorageResumeSnapshot(
  root: RunStorageRoot,
): CompleteResumeSnapshot {
  const read = TRUSTED_RESUME_SNAPSHOT_READERS.get(root);
  if (read === undefined) {
    throw new Error('Run storage resume source is forged');
  }
  return read();
}

function isTerminal(status: string): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'cancelled';
}

function assertExactKeys(input: object, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) {
      throw new Error(`Unknown run storage input field "${key}"`);
    }
  }
}
