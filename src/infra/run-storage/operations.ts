import type { RunReadContext, RunWriteContext } from './context.js';
import type { LeaseOwner } from './lease.js';
import {
  encodeOperationValue,
  operationRecordFromRow,
  type EncodedValueInput,
  type OperationRecord,
  type OperationRow,
} from './operation-record.js';
import {
  applyTerminalOperationTransition,
  requireOperationState,
} from './operation-transitions.js';
import { readClock, type RunStorageClock } from './clock.js';

export class OperationRepository {
  get(context: RunReadContext, operationId: string): OperationRecord {
    const row = context.get<OperationRow>(`
      SELECT
        operation_id AS operationId,
        run_id AS runId,
        scope_id AS scopeId,
        idempotency_key AS idempotencyKey,
        kind,
        state,
        request_codec_name AS requestCodecName,
        request_content AS requestContent,
        request_digest AS requestDigest,
        response_codec_name AS responseCodecName,
        response_content AS responseContent,
        response_digest AS responseDigest,
        error_codec_name AS errorCodecName,
        error_content AS errorContent,
        error_digest AS errorDigest,
        owner_generation AS ownerGeneration,
        owner_claim_token AS ownerClaimToken,
        prepared_at AS preparedAt,
        dispatching_at AS dispatchingAt,
        response_recorded_at AS responseRecordedAt,
        terminal_at AS terminalAt
      FROM operations
      WHERE operation_id = ?
    `, operationId);
    if (row === undefined) {
      throw new Error(`Operation "${operationId}" does not exist`);
    }
    return operationRecordFromRow(row);
  }
}

class OperationAuthorityRepository extends OperationRepository {
  prepareOrLoad(context: RunWriteContext, input: {
    readonly operationId: string;
    readonly runId: string;
    readonly scopeId: string;
    readonly idempotencyKey: string;
    readonly kind: string;
    readonly request: EncodedValueInput;
    readonly owner: LeaseOwner;
    readonly now: number;
  }): OperationRecord {
    context.assertLeaseOwner(input.owner);
    const request = encodeOperationValue(input.request);
    const inserted = context.run(`
      INSERT INTO operations (
        operation_id,
        run_id,
        scope_id,
        idempotency_key,
        kind,
        state,
        request_codec_name,
        request_content,
        request_digest,
        owner_generation,
        owner_claim_token,
        prepared_at
      ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, scope_id, idempotency_key) DO NOTHING
    `,
    input.operationId,
    input.runId,
    input.scopeId,
    input.idempotencyKey,
    input.kind,
    request.codecName,
    request.encoded,
    request.digest,
    input.owner.generation,
    input.owner.claimToken,
    input.now);
    if (inserted.changes === 1 || inserted.changes === 1n) {
      return this.get(context, input.operationId);
    }
    const existing = this.getByAuthorityKey(
      context,
      input.runId,
      input.scopeId,
      input.idempotencyKey,
    );
    if (
      existing.kind !== input.kind
      || existing.request.codecName !== request.codecName
      || existing.request.digest !== request.digest
    ) {
      throw new Error(
        `Operation authority collision for idempotency key "${input.idempotencyKey}"`,
      );
    }
    return existing;
  }

  claimPrepared(context: RunWriteContext, input: {
    readonly operationId: string;
    readonly owner: LeaseOwner;
    readonly now: number;
  }): void {
    context.assertLeaseOwner(input.owner);
    const result = context.run(`
      UPDATE operations
      SET
        state = 'dispatching',
        owner_generation = ?,
        owner_claim_token = ?,
        dispatching_at = ?
      WHERE operation_id = ? AND state = 'prepared'
    `, input.owner.generation, input.owner.claimToken, input.now, input.operationId);
    requireOperationState(result.changes, input.operationId, 'prepared');
  }

  recordResponse(context: RunWriteContext, input: {
    readonly operationId: string;
    readonly response: EncodedValueInput;
    readonly owner: LeaseOwner;
    readonly now: number;
  }): void {
    context.assertLeaseOwner(input.owner);
    const response = encodeOperationValue(input.response);
    const result = context.run(`
      UPDATE operations
      SET
        state = 'response_recorded',
        response_codec_name = ?,
        response_content = ?,
        response_digest = ?,
        response_recorded_at = ?
      WHERE
        operation_id = ?
        AND state = 'dispatching'
        AND owner_generation = ?
        AND owner_claim_token = ?
    `,
    response.codecName,
    response.encoded,
    response.digest,
    input.now,
    input.operationId,
    input.owner.generation,
    input.owner.claimToken);
    requireOperationState(result.changes, input.operationId, 'dispatching');
  }

  markApplied(context: RunWriteContext, input: {
    readonly operationId: string;
    readonly owner: LeaseOwner;
    readonly now: number;
  }): void {
    context.assertLeaseOwner(input.owner);
    applyTerminalOperationTransition(context, {
      ...input,
      from: 'response_recorded',
      to: 'applied',
    });
  }

  markFailed(context: RunWriteContext, input: {
    readonly operationId: string;
    readonly error: EncodedValueInput;
    readonly owner: LeaseOwner;
    readonly now: number;
  }): void {
    context.assertLeaseOwner(input.owner);
    const current = this.get(context, input.operationId);
    if (!['prepared', 'dispatching', 'response_recorded'].includes(current.state)) {
      throw new Error(`Operation "${input.operationId}" cannot fail from ${current.state}`);
    }
    const error = encodeOperationValue(input.error);
    const result = context.run(`
      UPDATE operations
      SET
        state = 'failed',
        error_codec_name = ?,
        error_content = ?,
        error_digest = ?,
        terminal_at = ?
      WHERE
        operation_id = ?
        AND state = ?
        AND owner_generation = ?
        AND owner_claim_token = ?
    `,
    error.codecName,
    error.encoded,
    error.digest,
    input.now,
    input.operationId,
    current.state,
    input.owner.generation,
    input.owner.claimToken);
    requireOperationState(result.changes, input.operationId, current.state);
  }

  cancelPrepared(context: RunWriteContext, input: {
    readonly operationId: string;
    readonly owner: LeaseOwner;
    readonly now: number;
  }): void {
    context.assertLeaseOwner(input.owner);
    applyTerminalOperationTransition(context, {
      ...input,
      from: 'prepared',
      to: 'cancelled',
    });
  }

  recoverAfterDispatchCrash(context: RunWriteContext, input: {
    readonly operationId: string;
    readonly owner: LeaseOwner;
    readonly now: number;
  }): void {
    context.assertLeaseOwner(input.owner);
    applyTerminalOperationTransition(context, {
      ...input,
      from: 'dispatching',
      to: 'unknown_after_dispatch',
    });
  }

  takeOverForRecovery(context: RunWriteContext, input: {
    readonly operationId: string;
    readonly owner: LeaseOwner;
    readonly now: number;
  }): OperationRecord {
    context.assertLeaseOwner(input.owner);
    const current = this.get(context, input.operationId);
    if (
      current.runId !== input.owner.runId
      || current.owner.generation >= input.owner.generation
    ) {
      throw new Error(`Operation "${input.operationId}" cannot be taken over by this owner`);
    }
    if (current.state === 'dispatching') {
      const result = context.run(`
        UPDATE operations
        SET
          state = 'unknown_after_dispatch',
          owner_generation = ?,
          owner_claim_token = ?,
          terminal_at = ?
        WHERE
          operation_id = ?
          AND state = 'dispatching'
          AND owner_generation = ?
          AND owner_claim_token = ?
          AND owner_generation < ?
      `,
      input.owner.generation,
      input.owner.claimToken,
      input.now,
      input.operationId,
      current.owner.generation,
      current.owner.claimToken,
      input.owner.generation);
      requireOperationState(result.changes, input.operationId, 'dispatching');
      return this.get(context, input.operationId);
    }
    if (current.state === 'response_recorded') {
      const result = context.run(`
        UPDATE operations
        SET owner_generation = ?, owner_claim_token = ?
        WHERE
          operation_id = ?
          AND state = 'response_recorded'
          AND owner_generation = ?
          AND owner_claim_token = ?
          AND owner_generation < ?
      `,
      input.owner.generation,
      input.owner.claimToken,
      input.operationId,
      current.owner.generation,
      current.owner.claimToken,
      input.owner.generation);
      requireOperationState(result.changes, input.operationId, 'response_recorded');
      return this.get(context, input.operationId);
    }
    throw new Error(
      `Operation "${input.operationId}" cannot recover from ${current.state}`,
    );
  }

  private getByAuthorityKey(
    context: RunReadContext,
    runId: string,
    scopeId: string,
    idempotencyKey: string,
  ): OperationRecord {
    const row = context.get<OperationRow>(`
      SELECT
        operation_id AS operationId,
        run_id AS runId,
        scope_id AS scopeId,
        idempotency_key AS idempotencyKey,
        kind,
        state,
        request_codec_name AS requestCodecName,
        request_content AS requestContent,
        request_digest AS requestDigest,
        response_codec_name AS responseCodecName,
        response_content AS responseContent,
        response_digest AS responseDigest,
        error_codec_name AS errorCodecName,
        error_content AS errorContent,
        error_digest AS errorDigest,
        owner_generation AS ownerGeneration,
        owner_claim_token AS ownerClaimToken,
        prepared_at AS preparedAt,
        dispatching_at AS dispatchingAt,
        response_recorded_at AS responseRecordedAt,
        terminal_at AS terminalAt
      FROM operations
      WHERE run_id = ? AND scope_id = ? AND idempotency_key = ?
    `, runId, scopeId, idempotencyKey);
    if (row === undefined) {
      throw new Error('Operation authority insert did not produce a row');
    }
    return operationRecordFromRow(row);
  }
}

type WriteOperationMethod =
  | 'prepareOrLoad'
  | 'claimPrepared'
  | 'recordResponse'
  | 'markApplied'
  | 'markFailed'
  | 'cancelPrepared'
  | 'recoverAfterDispatchCrash'
  | 'takeOverForRecovery';

type OperationInput<Method extends WriteOperationMethod> = Omit<
  Parameters<OperationAuthorityRepository[Method]>[1],
  'owner' | 'now'
>;

export interface RunOperationCommands {
  prepareOrLoad(input: OperationInput<'prepareOrLoad'>): OperationRecord;
  claimPrepared(input: OperationInput<'claimPrepared'>): void;
  recordResponse(input: OperationInput<'recordResponse'>): void;
  markApplied(input: OperationInput<'markApplied'>): void;
  markFailed(input: OperationInput<'markFailed'>): void;
  cancelPrepared(input: OperationInput<'cancelPrepared'>): void;
  recoverAfterDispatchCrash(input: OperationInput<'recoverAfterDispatchCrash'>): void;
  takeOverForRecovery(input: OperationInput<'takeOverForRecovery'>): OperationRecord;
  get(operationId: string): OperationRecord;
}

class RunOperationCommandsImpl implements RunOperationCommands {
  readonly #context: RunWriteContext;
  readonly #clock: RunStorageClock;
  readonly #owner: LeaseOwner;
  readonly #repository = new OperationAuthorityRepository();

  constructor(
    context: RunWriteContext,
    owner: LeaseOwner,
    clock: RunStorageClock,
  ) {
    this.#context = context;
    this.#owner = owner;
    this.#clock = clock;
  }

  prepareOrLoad(input: OperationInput<'prepareOrLoad'>): OperationRecord {
    return this.#repository.prepareOrLoad(
      this.#context,
      { ...input, owner: this.#owner, now: readClock(this.#clock) },
    );
  }

  claimPrepared(input: OperationInput<'claimPrepared'>): void {
    this.#repository.claimPrepared(this.#context, {
      ...input,
      owner: this.#owner,
      now: readClock(this.#clock),
    });
  }

  recordResponse(input: OperationInput<'recordResponse'>): void {
    this.#repository.recordResponse(this.#context, {
      ...input,
      owner: this.#owner,
      now: readClock(this.#clock),
    });
  }

  markApplied(input: OperationInput<'markApplied'>): void {
    this.#repository.markApplied(this.#context, {
      ...input,
      owner: this.#owner,
      now: readClock(this.#clock),
    });
  }

  markFailed(input: OperationInput<'markFailed'>): void {
    this.#repository.markFailed(this.#context, {
      ...input,
      owner: this.#owner,
      now: readClock(this.#clock),
    });
  }

  cancelPrepared(input: OperationInput<'cancelPrepared'>): void {
    this.#repository.cancelPrepared(this.#context, {
      ...input,
      owner: this.#owner,
      now: readClock(this.#clock),
    });
  }

  recoverAfterDispatchCrash(input: OperationInput<'recoverAfterDispatchCrash'>): void {
    this.#repository.recoverAfterDispatchCrash(
      this.#context,
      { ...input, owner: this.#owner, now: readClock(this.#clock) },
    );
  }

  takeOverForRecovery(
    input: OperationInput<'takeOverForRecovery'>,
  ): OperationRecord {
    return this.#repository.takeOverForRecovery(
      this.#context,
      { ...input, owner: this.#owner, now: readClock(this.#clock) },
    );
  }

  get(operationId: string): OperationRecord {
    return this.#repository.get(this.#context, operationId);
  }
}

export function createRunOperationCommands(
  context: RunWriteContext,
  owner: LeaseOwner,
  clock: RunStorageClock,
): RunOperationCommands {
  return new RunOperationCommandsImpl(context, owner, clock);
}
