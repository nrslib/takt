import type { RunWriteContext } from './context.js';
import type { LeaseOwner } from './lease.js';
import type { OperationState } from './operation-state-contract.js';

export function requireOperationState(
  changes: number | bigint,
  operationId: string,
  expectedState: OperationState,
): void {
  if (changes !== 1 && changes !== 1n) {
    throw new Error(`Operation "${operationId}" must be ${expectedState}`);
  }
}

export function applyTerminalOperationTransition(
  context: RunWriteContext,
  input: {
    readonly operationId: string;
    readonly owner: LeaseOwner;
    readonly now: number;
    readonly from: OperationState;
    readonly to: OperationState;
  },
): void {
  const result = context.run(`
    UPDATE operations
    SET state = ?, terminal_at = ?
    WHERE
      operation_id = ?
      AND state = ?
      AND owner_generation = ?
      AND owner_claim_token = ?
  `,
  input.to,
  input.now,
  input.operationId,
  input.from,
  input.owner.generation,
  input.owner.claimToken);
  requireOperationState(result.changes, input.operationId, input.from);
}
