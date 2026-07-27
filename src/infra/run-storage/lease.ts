import type { RunWriteContext } from './context.js';

export interface LeaseOwner {
  readonly runId: string;
  readonly generation: number;
  readonly claimToken: string;
}

export interface ClaimLeaseInput {
  readonly runId: string;
  readonly ownerId: string;
  readonly claimToken: string;
  readonly leaseDurationMs: number;
}

interface LeaseRow {
  readonly generation: number;
  readonly expiresAt: number;
  readonly releasedAt: number | null;
  readonly terminalizedAt: number | null;
}

export class StaleLeaseOwnerError extends Error {
  constructor(runId: string) {
    super(`Run lease owner is stale for "${runId}"`);
    this.name = 'StaleLeaseOwnerError';
  }
}

function leaseExpiry(now: number, leaseDurationMs: number): number {
  assertLeaseTime(now);
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error('Lease duration must be a positive safe integer');
  }
  const expiresAt = now + leaseDurationMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('Lease expiry exceeds the safe integer range');
  }
  return expiresAt;
}

function assertLeaseTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Lease time must be a non-negative safe integer');
  }
}

export class RunLeaseManager {
  claim(
    context: RunWriteContext,
    input: ClaimLeaseInput,
    now: number,
  ): LeaseOwner {
    const expiresAt = leaseExpiry(now, input.leaseDurationMs);
    const existing = context.get<LeaseRow>(`
        SELECT
          generation,
          expires_at AS expiresAt,
          released_at AS releasedAt,
          terminalized_at AS terminalizedAt
        FROM run_leases
        WHERE
          run_id = ?
          AND EXISTS (
            SELECT 1 FROM runs
            WHERE runs.run_id = run_leases.run_id AND runs.status = 'running'
          )
      `, input.runId);
    const generation = existing === undefined ? 1 : existing.generation + 1;
    if (existing !== undefined && existing.terminalizedAt !== null) {
      throw new Error(`Run "${input.runId}" is terminalized`);
    }
    if (
      existing !== undefined
      && existing.releasedAt === null
      && existing.expiresAt > now
    ) {
      throw new Error(`Run "${input.runId}" already has an active lease`);
    }

    if (existing === undefined) {
      context.run(`
          INSERT INTO run_leases (
            run_id,
            generation,
            owner_id,
            claim_token,
            claimed_at,
            expires_at,
            heartbeat_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      input.runId,
      generation,
      input.ownerId,
      input.claimToken,
      now,
      expiresAt,
      now);
    } else {
      const result = context.run(`
          UPDATE run_leases
          SET
            generation = ?,
            owner_id = ?,
            claim_token = ?,
            claimed_at = ?,
            expires_at = ?,
            heartbeat_at = ?,
            released_at = NULL,
            validation_count = 0
          WHERE
            run_id = ?
            AND generation = ?
            AND terminalized_at IS NULL
            AND (released_at IS NOT NULL OR expires_at <= ?)
            AND EXISTS (
              SELECT 1 FROM runs
              WHERE runs.run_id = run_leases.run_id AND runs.status = 'running'
            )
        `,
      generation,
      input.ownerId,
      input.claimToken,
      now,
      expiresAt,
      now,
      input.runId,
      existing.generation,
      now);
      if (result.changes !== 1) {
        throw new StaleLeaseOwnerError(input.runId);
      }
    }
    return { runId: input.runId, generation, claimToken: input.claimToken };
  }

  assertForWrite(context: RunWriteContext, owner: LeaseOwner, now: number): void {
    assertLeaseTime(now);
    context.assertLeaseOwner(owner);
    const result = context.run(`
      UPDATE run_leases
      SET validation_count = validation_count + 1
      WHERE
        run_id = ?
        AND generation = ?
        AND claim_token = ?
        AND expires_at > ?
        AND released_at IS NULL
        AND terminalized_at IS NULL
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.run_id = run_leases.run_id AND runs.status = 'running'
        )
    `, owner.runId, owner.generation, owner.claimToken, now);
    if (result.changes !== 1) {
      throw new StaleLeaseOwnerError(owner.runId);
    }
  }

  heartbeat(
    context: RunWriteContext,
    owner: LeaseOwner,
    now: number,
    leaseDurationMs: number,
  ): void {
    const expiresAt = leaseExpiry(now, leaseDurationMs);
    const result = context.run(`
      UPDATE run_leases
      SET heartbeat_at = ?, expires_at = ?
      WHERE
        run_id = ?
        AND generation = ?
        AND claim_token = ?
        AND expires_at > ?
        AND released_at IS NULL
        AND terminalized_at IS NULL
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.run_id = run_leases.run_id AND runs.status = 'running'
        )
    `, now, expiresAt, owner.runId, owner.generation, owner.claimToken, now);
    if (result.changes !== 1) {
      throw new StaleLeaseOwnerError(owner.runId);
    }
  }

  release(context: RunWriteContext, owner: LeaseOwner, now: number): void {
    assertLeaseTime(now);
    const result = context.run(`
      UPDATE run_leases
      SET released_at = ?
      WHERE
        run_id = ?
        AND generation = ?
        AND claim_token = ?
        AND expires_at > ?
        AND released_at IS NULL
        AND terminalized_at IS NULL
    `, now, owner.runId, owner.generation, owner.claimToken, now);
    if (result.changes !== 1) {
      throw new StaleLeaseOwnerError(owner.runId);
    }
  }

  terminalize(
    context: RunWriteContext,
    owner: LeaseOwner,
    status: 'completed' | 'failed' | 'cancelled',
    now: number,
  ): void {
    assertLeaseTime(now);
    const result = context.run(`
        UPDATE run_leases
        SET terminalized_at = ?, terminal_status = ?
        WHERE
          run_id = ?
          AND generation = ?
          AND claim_token = ?
          AND expires_at > ?
          AND released_at IS NULL
          AND terminalized_at IS NULL
          AND EXISTS (
            SELECT 1 FROM runs
            WHERE runs.run_id = run_leases.run_id AND runs.status = 'running'
          )
      `, now, status, owner.runId, owner.generation, owner.claimToken, now);
    if (result.changes !== 1) {
      throw new StaleLeaseOwnerError(owner.runId);
    }
  }
}
