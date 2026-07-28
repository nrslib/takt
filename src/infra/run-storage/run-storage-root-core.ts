import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sha256 } from './canonical-json.js';
import type { RunStorageClock } from './clock.js';
import { assertCodecContent } from './codec-contract.js';
import type { RunReadContext, RunWriteContext } from './context.js';
import type { RunDatabaseFile } from './database-file.js';
import type { LeaseOwner } from './lease.js';
import { RunLeaseManager } from './lease.js';
import { ExecutionRepository } from './execution.js';
import { RuntimeSequenceRepository } from './runtime-sequences.js';
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
import { ScopeRepository } from './scopes.js';
import {
  bootstrapRecoverySeedSha256,
  parseBootstrapRecoverySeed,
  type BootstrapRecoverySeed,
} from '../../core/workflow/run/bootstrap-recovery-seed.js';

interface BoundHandle {
  readonly scopeId: string;
  readonly authorityId?: string;
}

interface RunTerminalizationInput {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly failureReason?: string;
  readonly publication: {
    readonly status: 'completed' | 'aborted' | 'failed';
    readonly iteration: number;
    readonly reason?: string;
    readonly payload: string;
  };
}

export interface TerminalPublication {
  readonly eventId: string;
  readonly status: 'completed' | 'aborted' | 'failed';
  readonly iteration: number;
  readonly reason?: string;
  readonly terminalAt: number;
  readonly payload: string;
  readonly payloadDigest: string;
  readonly stages: readonly TerminalPublicationStage[];
  readonly publishedAt?: number;
}

export interface TerminalPublicationCommitReceipt {
  readonly runId: string;
  readonly eventId: string;
  readonly runStatus: 'completed' | 'failed' | 'cancelled';
  readonly iteration: number;
  readonly payloadDigest: string;
  readonly terminalAt: number;
}

export const TERMINAL_PUBLICATION_STAGES = [
  'meta',
  'session',
  'trace',
] as const;

export type TerminalPublicationStage =
  typeof TERMINAL_PUBLICATION_STAGES[number];

export interface TerminalPublicationStageClaim {
  readonly stage: TerminalPublicationStage;
  readonly generation: number;
  readonly token: string;
  readonly expiresAt: number;
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
  readonly #scopes = new ScopeRepository();
  readonly #executions = new ExecutionRepository();
  readonly #sequences = new RuntimeSequenceRepository();
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
    const binding: RuntimeBinding = {
      executor: this.#executor,
      handles: this.#handles,
      owner,
      runId: this.#runId,
      scopeId: scope.scopeId,
    };
    return createBoundRunStorageRuntime(binding);
  }

  readResumeSnapshot(): CompleteResumeSnapshot {
    this.assertOpen();
    return this.#unitOfWork.read(readCompleteResumeSnapshot);
  }

  readBootstrapSeed(): BootstrapRecoverySeed {
    this.assertOpen();
    return this.#unitOfWork.read((context) => {
      const row = context.get<{
        readonly codecName: string;
        readonly seed: string;
        readonly digest: string;
      }>(`
        SELECT
          bootstrap_seed_codec_name AS codecName,
          bootstrap_seed AS seed,
          bootstrap_seed_sha256 AS digest
        FROM runs
        WHERE run_id = ?
      `, this.#runId);
      if (row === undefined || row.codecName !== 'json-v1') {
        throw new Error(
          `Bootstrap recovery seed is missing for "${this.#runId}"`,
        );
      }
      const seed = parseBootstrapRecoverySeed(
        JSON.parse(row.seed) as unknown,
      );
      if (
        seed.backend !== 'sqlite'
        || bootstrapRecoverySeedSha256(seed) !== row.digest
      ) {
        throw new Error(
          `Bootstrap recovery seed failed integrity validation for "${this.#runId}"`,
        );
      }
      return seed;
    });
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

  finishRun(
    handle: LeaseHandle,
    input: RunTerminalizationInput,
  ): TerminalPublicationCommitReceipt {
    assertExactKeys(input, ['status', 'failureReason', 'publication']);
    assertExactKeys(input.publication, [
      'status',
      'iteration',
      'reason',
      'payload',
    ]);
    assertTerminalPublicationMatchesRunStatus(input);
    assertCodecContent('json-v1', input.publication.payload);
    this.assertOpen();
    const owner = this.#handles.resolveLease(handle);
    try {
      this.#unitOfWork.terminalize(owner, (context, now) => {
        this.terminalizeRun(context, owner, input, now);
      });
    } catch (error) {
      const recovered = this.restoreTerminalCommitReceipt(input);
      if (recovered === undefined) {
        throw error;
      }
      return recovered;
    }
    const receipt = this.restoreTerminalCommitReceipt(input);
    if (receipt === undefined) {
      throw new Error(
        `Terminal commit receipt is missing for "${this.#runId}"`,
      );
    }
    return receipt;
  }

  forceFailRun(input: {
    readonly expectedRunId: string;
    readonly ownerKey: string;
    readonly leaseDurationMs: number;
    readonly reason: string;
    readonly iteration: number;
    readonly publicationPayload: string;
  }): TerminalPublicationCommitReceipt {
    assertExactKeys(input, [
      'expectedRunId',
      'ownerKey',
      'leaseDurationMs',
      'reason',
      'iteration',
      'publicationPayload',
    ]);
    const terminalization: RunTerminalizationInput = {
      status: 'failed',
      failureReason: input.reason,
      publication: {
        status: 'failed',
        iteration: input.iteration,
        reason: input.reason,
        payload: input.publicationPayload,
      },
    };
    assertTerminalPublicationMatchesRunStatus(terminalization);
    assertCodecContent('json-v1', input.publicationPayload);
    this.assertOpen();
    try {
      this.#unitOfWork.forceFail((context, now) => {
        const run = context.get<{
          readonly status: string;
        }>(`
          SELECT status
          FROM runs
          WHERE run_id = ?
        `, this.#runId);
        if (run === undefined || this.#runId !== input.expectedRunId) {
          throw new Error(
            `Run database identity does not match force-fail run "${input.expectedRunId}"`,
          );
        }
        if (run.status !== 'running') {
          this.assertIdempotentForceFailure(context, input.reason, run.status);
          return;
        }
        const owner = this.#leases.claim(context, {
          runId: this.#runId,
          ownerId: sha256([this.#runId, input.ownerKey].join('\0')),
          claimToken: randomUUID(),
          leaseDurationMs: input.leaseDurationMs,
        }, now);
        this.terminalizeRun(context, owner, terminalization, now);
      });
    } catch (error) {
      const recovered = this.restoreForceFailCommitReceipt(input.reason);
      if (recovered === undefined) {
        throw error;
      }
      return recovered;
    }
    const receipt = this.restoreForceFailCommitReceipt(input.reason);
    if (receipt === undefined) {
      throw new Error(
        `Force-fail terminal commit receipt is missing for "${this.#runId}"`,
      );
    }
    return receipt;
  }

  readTerminalPublication(): TerminalPublication | undefined {
    this.assertOpen();
    return this.#unitOfWork.read((context) => {
      const row = context.get<{
        readonly eventId: string;
        readonly status: TerminalPublication['status'];
        readonly iteration: number;
        readonly reason: string | null;
        readonly terminalAt: number;
        readonly payload: string;
        readonly payloadDigest: string;
        readonly publishedAt: number | null;
      }>(`
        SELECT
          event_id AS eventId,
          status,
          iteration,
          reason,
          terminal_at AS terminalAt,
          payload,
          payload_digest AS payloadDigest,
          published_at AS publishedAt
        FROM terminal_publications
        WHERE run_id = ?
      `, this.#runId);
      if (row === undefined) {
        return undefined;
      }
      assertCodecContent('json-v1', row.payload);
      if (sha256(row.payload) !== row.payloadDigest) {
        throw new Error(
          `Terminal publication payload for "${this.#runId}" failed integrity validation`,
        );
      }
      const stages = context.all<{
        readonly stage: TerminalPublicationStage;
        readonly acknowledgedAt: number | null;
      }>(`
        SELECT stage, acknowledged_at AS acknowledgedAt
        FROM terminal_publication_stages
        WHERE run_id = ?
        ORDER BY CASE stage
          WHEN 'meta' THEN 1
          WHEN 'session' THEN 2
          WHEN 'trace' THEN 3
        END
      `, this.#runId);
      if (
        stages.length !== TERMINAL_PUBLICATION_STAGES.length
        || stages.some(({ stage }) => (
          !TERMINAL_PUBLICATION_STAGES.includes(stage)
        ))
      ) {
        throw new Error(
          `Terminal publication stages for "${this.#runId}" are incomplete`,
        );
      }
      return {
        eventId: row.eventId,
        status: row.status,
        iteration: row.iteration,
        ...(row.reason === null ? {} : { reason: row.reason }),
        terminalAt: row.terminalAt,
        payload: row.payload,
        payloadDigest: row.payloadDigest,
        stages: stages
          .filter(({ acknowledgedAt }) => acknowledgedAt === null)
          .map(({ stage }) => stage),
        ...(row.publishedAt === null ? {} : { publishedAt: row.publishedAt }),
      };
    });
  }

  private restoreTerminalCommitReceipt(
    input: RunTerminalizationInput,
  ): TerminalPublicationCommitReceipt | undefined {
    const publication = this.readTerminalPublication();
    if (
      publication === undefined
      || publication.status !== input.publication.status
      || publication.iteration !== input.publication.iteration
      || publication.reason !== input.publication.reason
      || publication.payloadDigest !== sha256(input.publication.payload)
    ) {
      return undefined;
    }
    return Object.freeze({
      runId: this.#runId,
      eventId: publication.eventId,
      runStatus: input.status,
      iteration: publication.iteration,
      payloadDigest: publication.payloadDigest,
      terminalAt: publication.terminalAt,
    });
  }

  private restoreForceFailCommitReceipt(
    reason: string,
  ): TerminalPublicationCommitReceipt | undefined {
    const publication = this.readTerminalPublication();
    if (
      publication === undefined
      || publication.status !== 'failed'
      || publication.reason !== reason
    ) {
      return undefined;
    }
    return Object.freeze({
      runId: this.#runId,
      eventId: publication.eventId,
      runStatus: 'failed',
      iteration: publication.iteration,
      payloadDigest: publication.payloadDigest,
      terminalAt: publication.terminalAt,
    });
  }

  claimTerminalPublicationStage(input: {
    readonly claimDurationMs: number;
  }): TerminalPublicationStageClaim | undefined {
    assertExactKeys(input, ['claimDurationMs']);
    if (
      !Number.isSafeInteger(input.claimDurationMs)
      || input.claimDurationMs <= 0
    ) {
      throw new Error(
        'Terminal publication stage claim duration must be positive',
      );
    }
    this.assertOpen();
    return this.#unitOfWork.terminalPublication((context, now) => {
      const stage = context.get<{
        readonly stage: TerminalPublicationStage;
        readonly generation: number;
        readonly token: string | null;
        readonly expiresAt: number | null;
      }>(`
        SELECT
          stage,
          claim_generation AS generation,
          claim_token AS token,
          claim_expires_at AS expiresAt
        FROM terminal_publication_stages
        WHERE run_id = ? AND acknowledged_at IS NULL
        ORDER BY CASE stage
          WHEN 'meta' THEN 1
          WHEN 'session' THEN 2
          WHEN 'trace' THEN 3
        END
        LIMIT 1
      `, this.#runId);
      if (stage === undefined) {
        return undefined;
      }
      if (stage.expiresAt !== null && stage.expiresAt > now) {
        return undefined;
      }
      const expiresAt = now + input.claimDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error(
          'Terminal publication stage claim expiry exceeds safe integer range',
        );
      }
      const generation = stage.generation + 1;
      const token = randomUUID();
      const result = context.run(`
        UPDATE terminal_publication_stages
        SET
          claim_generation = ?,
          claim_token = ?,
          claim_expires_at = ?
        WHERE
          run_id = ?
          AND stage = ?
          AND claim_generation = ?
          AND acknowledged_at IS NULL
          AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
      `,
      generation,
      token,
      expiresAt,
      this.#runId,
      stage.stage,
      stage.generation,
      now);
      if (Number(result.changes) !== 1) {
        return undefined;
      }
      return Object.freeze({
        stage: stage.stage,
        generation,
        token,
        expiresAt,
      });
    });
  }

  acknowledgeTerminalPublicationStage(
    claim: TerminalPublicationStageClaim,
  ): void {
    assertExactKeys(claim, ['stage', 'generation', 'token', 'expiresAt']);
    if (!TERMINAL_PUBLICATION_STAGES.includes(claim.stage)) {
      throw new Error(
        `Unknown terminal publication stage "${claim.stage}"`,
      );
    }
    this.assertOpen();
    this.#unitOfWork.terminalPublication((context, now) => {
      const stageResult = context.run(`
        UPDATE terminal_publication_stages
        SET acknowledged_at = ?
        WHERE
          run_id = ?
          AND stage = ?
          AND claim_generation = ?
          AND claim_token = ?
          AND claim_expires_at = ?
          AND claim_expires_at > ?
          AND acknowledged_at IS NULL
      `,
      now,
      this.#runId,
      claim.stage,
      claim.generation,
      claim.token,
      claim.expiresAt,
      now);
      if (Number(stageResult.changes) === 0) {
        throw new Error(
          `Terminal publication stage claim "${claim.stage}" for `
          + `"${this.#runId}" is stale`,
        );
      }
      context.run(`
        UPDATE terminal_publications
        SET published_at = ?
        WHERE
          run_id = ?
          AND published_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM terminal_publication_stages
            WHERE
              terminal_publication_stages.run_id = terminal_publications.run_id
              AND acknowledged_at IS NULL
          )
      `, now, this.#runId);
      const publication = context.get<{ readonly found: number }>(`
        SELECT 1 AS found
        FROM terminal_publications
        WHERE run_id = ?
      `, this.#runId);
      if (publication === undefined) {
        throw new Error(
          `Terminal publication for "${this.#runId}" is missing`,
        );
      }
    });
  }

  expireTerminalPublicationStageClaim(
    claim: TerminalPublicationStageClaim,
  ): void {
    assertExactKeys(claim, ['stage', 'generation', 'token', 'expiresAt']);
    this.assertOpen();
    this.#unitOfWork.terminalPublication((context, now) => {
      const result = context.run(`
        UPDATE terminal_publication_stages
        SET claim_expires_at = ?
        WHERE
          run_id = ?
          AND stage = ?
          AND claim_generation = ?
          AND claim_token = ?
          AND claim_expires_at = ?
          AND claim_expires_at > ?
          AND acknowledged_at IS NULL
      `,
      now,
      this.#runId,
      claim.stage,
      claim.generation,
      claim.token,
      claim.expiresAt,
      now);
      if (Number(result.changes) !== 1) {
        throw new Error(
          `Terminal publication stage claim "${claim.stage}" for `
          + `"${this.#runId}" is stale`,
        );
      }
    });
  }

  private assertIdempotentForceFailure(
    context: RunWriteContext,
    reason: string,
    runStatus: string,
  ): void {
    const publication = context.get<{
      readonly status: string;
      readonly reason: string | null;
    }>(`
      SELECT status, reason
      FROM terminal_publications
      WHERE run_id = ?
    `, this.#runId);
    if (
      runStatus === 'failed'
      && publication?.status === 'failed'
      && publication.reason === reason
    ) {
      return;
    }
    throw new Error(
      `Force-fail conflicts with the existing terminal run state for "${this.#runId}"`,
    );
  }

  private terminalizeRun(
    context: RunWriteContext,
    owner: LeaseOwner,
    input: RunTerminalizationInput,
    now: number,
  ): void {
    this.recordTerminalFailure(context, owner, input.failureReason, now);
    this.#executions.terminalizeActive(context, {
      runId: owner.runId,
      status: input.status,
      terminalAt: now,
    });
    this.#scopes.terminalizeActiveDescendants(context, {
      runId: owner.runId,
      status: input.status,
      terminalAt: now,
    });
    this.createTerminalPublication(context, owner.runId, input, now);
    this.terminalizeRootRuntime(context, owner.runId, input.status, now);
    this.#leases.terminalize(context, owner, input.status, now);
  }

  private recordTerminalFailure(
    context: RunWriteContext,
    owner: LeaseOwner,
    failureReason: string | undefined,
    now: number,
  ): void {
    if (failureReason === undefined) {
      return;
    }
    const currentSequence = this.#sequences.listEvents(
      context,
      owner.runId,
      'root',
    ).length;
    this.#sequences.appendEvent(context, {
      runId: owner.runId,
      scopeId: 'root',
      expectedSequence: currentSequence,
      eventType: 'workflow_failed',
      codecName: 'json-v1',
      payload: JSON.stringify({ reason: failureReason }),
      occurredAt: now,
    });
  }

  private createTerminalPublication(
    context: RunWriteContext,
    runId: string,
    input: RunTerminalizationInput,
    now: number,
  ): void {
    const payloadDigest = sha256(input.publication.payload);
    const eventId = sha256([
      runId,
      input.publication.status,
      String(input.publication.iteration),
      input.publication.reason ?? '',
      String(now),
      payloadDigest,
    ].join('\0'));
    context.run(`
      INSERT INTO terminal_publications (
        run_id, event_id, status, iteration, reason, terminal_at,
        payload_codec_name, payload, payload_digest
      ) VALUES (?, ?, ?, ?, ?, ?, 'json-v1', ?, ?)
    `,
    runId,
    eventId,
    input.publication.status,
    input.publication.iteration,
    input.publication.reason ?? null,
    now,
    input.publication.payload,
    payloadDigest);
    for (const stage of TERMINAL_PUBLICATION_STAGES) {
      context.run(`
        INSERT INTO terminal_publication_stages (
          run_id, stage, stage_id
        ) VALUES (?, ?, ?)
      `, runId, stage, sha256([eventId, stage].join('\0')));
    }
  }

  private terminalizeRootRuntime(
    context: RunWriteContext,
    runId: string,
    status: RunTerminalizationInput['status'],
    now: number,
  ): void {
    const runtime = context.get<{
      readonly status: string;
      readonly revision: number;
    }>(`
      SELECT status, revision
      FROM scope_runtime
      WHERE run_id = ? AND scope_id = 'root'
    `, runId);
    if (runtime === undefined) {
      throw new Error(
        `Root scope runtime for "${runId}" does not exist`,
      );
    }
    if (isTerminal(runtime.status)) {
      throw new Error(
        `Root scope runtime for "${runId}" is already terminal`,
      );
    }
    const result = context.run(`
      UPDATE scope_runtime
      SET status = ?, revision = revision + 1, updated_at = ?
      WHERE run_id = ? AND scope_id = 'root' AND revision = ? AND status = ?
    `, status, now, runId, runtime.revision, runtime.status);
    if (Number(result.changes) !== 1) {
      throw new Error(
        `Root scope runtime CAS mismatch for "${runId}"`,
      );
    }
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

function assertTerminalPublicationMatchesRunStatus(input: {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly publication: {
    readonly status: 'completed' | 'aborted' | 'failed';
    readonly iteration: number;
    readonly reason?: string;
    readonly payload: string;
  };
}): void {
  const expected = input.status === 'cancelled' ? 'aborted' : input.status;
  if (input.publication.status !== expected) {
    throw new Error('Terminal publication status does not match run status');
  }
  if (
    !Number.isInteger(input.publication.iteration)
    || input.publication.iteration < 0
  ) {
    throw new Error('Terminal publication iteration is invalid');
  }
  if (
    (input.publication.status === 'completed'
      && input.publication.reason !== undefined)
    || (input.publication.status !== 'completed'
      && (input.publication.reason?.length ?? 0) === 0)
  ) {
    throw new Error('Terminal publication reason does not match its status');
  }
}
