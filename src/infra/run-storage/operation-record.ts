import type { LeaseOwner } from './lease.js';
import { sha256 } from './canonical-json.js';
import type { OperationState } from './operation-state-contract.js';
import { assertCodecContent } from './codec-contract.js';

export type { OperationState } from './operation-state-contract.js';

export interface EncodedValueInput {
  readonly codecName: string;
  readonly encoded: string;
}

export interface EncodedValue extends EncodedValueInput {
  readonly digest: string;
}

export interface OperationRecord {
  readonly operationId: string;
  readonly runId: string;
  readonly scopeId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly state: OperationState;
  readonly preparedAt: number;
  readonly dispatchingAt: number | null;
  readonly responseRecordedAt: number | null;
  readonly terminalAt: number | null;
  readonly request: EncodedValue;
  readonly response?: EncodedValue;
  readonly error?: EncodedValue;
  readonly owner: LeaseOwner;
}

export interface OperationRow {
  readonly operationId: string;
  readonly runId: string;
  readonly scopeId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly state: OperationState;
  readonly requestCodecName: string;
  readonly requestContent: string;
  readonly requestDigest: string;
  readonly responseCodecName: string | null;
  readonly responseContent: string | null;
  readonly responseDigest: string | null;
  readonly errorCodecName: string | null;
  readonly errorContent: string | null;
  readonly errorDigest: string | null;
  readonly ownerGeneration: number;
  readonly ownerClaimToken: string;
  readonly preparedAt: number;
  readonly dispatchingAt: number | null;
  readonly responseRecordedAt: number | null;
  readonly terminalAt: number | null;
}

export function encodeOperationValue(value: EncodedValueInput): EncodedValue {
  if (value.codecName.length === 0) {
    throw new Error('Operation codec name is required');
  }
  assertCodecContent(value.codecName, value.encoded);
  return { ...value, digest: sha256(value.encoded) };
}

function optionalEncodedValue(
  codecName: string | null,
  encoded: string | null,
  digest: string | null,
): EncodedValue | undefined {
  if (codecName === null && encoded === null && digest === null) {
    return undefined;
  }
  if (codecName === null || encoded === null || digest === null) {
    throw new Error('Stored operation encoded value is inconsistent');
  }
  if (sha256(encoded) !== digest) {
    throw new Error('Stored operation payload digest mismatch');
  }
  assertCodecContent(codecName, encoded);
  return { codecName, encoded, digest };
}

export function operationRecordFromRow(row: OperationRow): OperationRecord {
  if (sha256(row.requestContent) !== row.requestDigest) {
    throw new Error('Stored operation request digest mismatch');
  }
  assertCodecContent(row.requestCodecName, row.requestContent);
  const response = optionalEncodedValue(
    row.responseCodecName,
    row.responseContent,
    row.responseDigest,
  );
  const error = optionalEncodedValue(row.errorCodecName, row.errorContent, row.errorDigest);
  return {
    operationId: row.operationId,
    runId: row.runId,
    scopeId: row.scopeId,
    idempotencyKey: row.idempotencyKey,
    kind: row.kind,
    state: row.state,
    preparedAt: row.preparedAt,
    dispatchingAt: row.dispatchingAt,
    responseRecordedAt: row.responseRecordedAt,
    terminalAt: row.terminalAt,
    request: {
      codecName: row.requestCodecName,
      encoded: row.requestContent,
      digest: row.requestDigest,
    },
    ...(response === undefined ? {} : { response }),
    ...(error === undefined ? {} : { error }),
    owner: {
      runId: row.runId,
      generation: row.ownerGeneration,
      claimToken: row.ownerClaimToken,
    },
  };
}
