import type { FindingLedger } from '../../core/workflow/findings/types.js';
import {
  FindingLedgerSchema,
  LegacyProvisionalConflictFindingLedgerSchema,
} from '../../core/models/finding-schemas.js';

export interface SourceAuthorityRaw {
  authorityKey: string;
  workflowName: string;
  revision: number;
  ledgerJson: string;
}

export type ParsedLegacyFindingLedger = Omit<
  FindingLedger,
  'provisionalConflictNormalizationSnapshots' | 'provisionalConflictNormalizations'
>;

export type InheritedSourceShape =
  | { kind: 'current'; raw: Record<string, unknown> }
  | { kind: 'legacy_provisional_conflict'; raw: Record<string, unknown> };

export interface LegacyPendingPreflightFailure {
  code: 'legacy_pending_manager_commit';
  authorityKey: string;
  sourceWorkflowName: string;
  sourceRevision: number;
  roundMarker: string | null;
  publicationId: string | null;
  retryCondition: 'source ledger_json has no top-level pendingManagerCommit property';
  recoveryActions: readonly [
    'resume the original source run with a binary that can read the legacy ledger',
    'complete or recover the pending report publication',
    'finalize the pending manager commit through the dedicated finalization API',
    'retry requeue only after the persisted pendingManagerCommit property is absent',
  ];
}

export class LegacyPendingManagerCommitError extends Error {
  readonly failure: LegacyPendingPreflightFailure;

  constructor(failure: LegacyPendingPreflightFailure) {
    super(
      `Legacy source authority "${failure.authorityKey}" has a pending manager commit; `
      + failure.retryCondition,
    );
    this.name = 'LegacyPendingManagerCommitError';
    this.failure = failure;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function classifyInheritedSourceShape(raw: unknown): InheritedSourceShape {
  if (!isRecord(raw)) {
    throw new Error('Inherited finding source must be a top-level JSON object');
  }
  const hasSnapshots = own(raw, 'provisionalConflictNormalizationSnapshots');
  const hasRecords = own(raw, 'provisionalConflictNormalizations');
  if (hasSnapshots !== hasRecords) {
    throw new Error(
      'Inherited finding source has a partial provisional conflict normalization registry',
    );
  }
  return hasSnapshots
    ? { kind: 'current', raw }
    : { kind: 'legacy_provisional_conflict', raw };
}

function nullableNestedString(
  record: Record<string, unknown>,
  path: readonly string[],
): string | null {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return typeof current === 'string' ? current : null;
}

function assertNoLegacyPendingManagerCommit(
  source: SourceAuthorityRaw,
  raw: Record<string, unknown>,
): void {
  if (!own(raw, 'pendingManagerCommit')) {
    return;
  }
  throw new LegacyPendingManagerCommitError({
    code: 'legacy_pending_manager_commit',
    authorityKey: source.authorityKey,
    sourceWorkflowName: source.workflowName,
    sourceRevision: source.revision,
    roundMarker: nullableNestedString(raw, ['pendingManagerCommit', 'roundMarker']),
    publicationId: nullableNestedString(
      raw,
      ['pendingManagerCommit', 'publication', 'publicationId'],
    ),
    retryCondition: 'source ledger_json has no top-level pendingManagerCommit property',
    recoveryActions: [
      'resume the original source run with a binary that can read the legacy ledger',
      'complete or recover the pending report publication',
      'finalize the pending manager commit through the dedicated finalization API',
      'retry requeue only after the persisted pendingManagerCommit property is absent',
    ],
  });
}

export type ParsedInheritedSource =
  | { kind: 'current'; ledger: FindingLedger }
  | { kind: 'legacy_provisional_conflict'; ledger: ParsedLegacyFindingLedger };

export function parseInheritedSourceAuthority(
  source: SourceAuthorityRaw,
): ParsedInheritedSource {
  if (
    source.authorityKey.length === 0
    || source.workflowName.length === 0
    || !Number.isSafeInteger(source.revision)
    || source.revision < 1
  ) {
    throw new Error(`Finding authority "${source.authorityKey}" has invalid metadata`);
  }
  const shape = classifyInheritedSourceShape(JSON.parse(source.ledgerJson));
  if (shape.kind === 'current') {
    return { kind: 'current', ledger: FindingLedgerSchema.parse(shape.raw) };
  }
  assertNoLegacyPendingManagerCommit(source, shape.raw);
  return {
    kind: 'legacy_provisional_conflict',
    ledger: LegacyProvisionalConflictFindingLedgerSchema.parse(shape.raw),
  } as ParsedInheritedSource;
}
