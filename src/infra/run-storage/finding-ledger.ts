import type { FindingLedger } from '../../core/workflow/findings/types.js';
import { parseFindingLedger } from '../../core/workflow/findings/schemas.js';
import type { RunReadContext, RunWriteContext } from './context.js';
import { canonicalJson, sha256 } from './canonical-json.js';
import { assertFindingContractEnabled } from './finding-contract.js';

interface FindingAuthorityReader {
  get<Row>(sql: string, ...parameters: import('node:sqlite').SQLInputValue[]):
    Row | undefined;
  all<Row>(sql: string, ...parameters: import('node:sqlite').SQLInputValue[]): Row[];
}

interface FindingAuthorityWriter {
  run(
    sql: string,
    ...parameters: import('node:sqlite').SQLInputValue[]
  ): unknown;
}

export interface FindingLedgerRecord {
  readonly runId: string;
  readonly scopeId: string;
  readonly workflowName: string;
  readonly revision: number;
  readonly ledger: FindingLedger;
  readonly updatedAt: number;
}

interface LedgerHeadRow {
  readonly revision: number;
  readonly nextId: number;
  readonly updatedAt: number;
  readonly projectionDigest: string;
}

interface JsonRecordRow {
  readonly ordinal: number;
  readonly record: string;
  readonly digest: string;
}

const ENTITY_TABLES = [
  ['finding_entries', 'finding_id', 'findings'],
  ['finding_evidence_records', 'evidence_id', 'evidenceRecords'],
  ['finding_evidence_bindings', 'binding_id', 'evidenceBindings'],
  ['finding_lifecycle_reservations', 'reservation_id', 'lifecycleReservations'],
  ['finding_lifecycle_events', 'event_id', 'lifecycleEvents'],
  ['finding_raw_recovery_attempts', 'attempt_id', 'rawRecoveryAttempts'],
  ['finding_raw_recovery_results', 'result_id', 'rawRecoveryResults'],
  ['finding_raw_entries', 'raw_finding_id', 'rawFindings'],
  ['finding_conflict_entries', 'conflict_id', 'conflicts'],
  ['finding_interpretation_entries', 'interpretation_key', 'interpretations'],
  ['finding_reviewer_anomaly_entries', 'anomaly_id', 'reviewerAnomalies'],
] as const;

type EntityTable = typeof ENTITY_TABLES[number];

function trustedIsoTime(now: number): string {
  const value = new Date(now);
  if (Number.isNaN(value.getTime())) {
    throw new Error('Finding ledger trusted timestamp is outside the ISO range');
  }
  return value.toISOString();
}

export function storedFindingProjectionDigest(ledger: FindingLedger): string {
  const storedProjection: Partial<FindingLedger> = { ...ledger };
  delete storedProjection.workflowName;
  return sha256(canonicalJson(storedProjection));
}

export function bootstrapFindingAuthority(
  context: FindingAuthorityWriter,
  input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly workflowName: string;
    readonly createdAt: number;
  },
): void {
  const ledger = parseFindingLedger({
    workflowName: input.workflowName,
    nextId: 1,
    updatedAt: trustedIsoTime(input.createdAt),
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
  });
  writeInitialFindingAuthority(context, {
    runId: input.runId,
    scopeId: input.scopeId,
    workflowName: input.workflowName,
    ledger,
    updatedAt: input.createdAt,
  });
}

export function importFindingAuthority(
  context: FindingAuthorityWriter,
  input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly workflowName: string;
    readonly ledger: FindingLedger;
    readonly sourceUpdatedAt: number;
  },
): string {
  const ledger = parseFindingLedger(input.ledger);
  if (
    ledger.workflowName !== input.workflowName
    || Date.parse(ledger.updatedAt) !== input.sourceUpdatedAt
  ) {
    throw new Error('Imported Finding authority does not match its source snapshot');
  }
  return writeInitialFindingAuthority(context, {
    runId: input.runId,
    scopeId: input.scopeId,
    workflowName: input.workflowName,
    ledger,
    updatedAt: input.sourceUpdatedAt,
  });
}

function writeInitialFindingAuthority(
  context: FindingAuthorityWriter,
  input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly workflowName: string;
    readonly ledger: FindingLedger;
    readonly updatedAt: number;
  },
): string {
  const projectionDigest = storedFindingProjectionDigest(input.ledger);
  insertEntities(context, input, 1, input.ledger);
  insertControls(context, input, 1, input.ledger);
  context.run(`
    INSERT INTO finding_ledger_revisions (
      run_id, scope_id, revision, next_id,
      finding_count, raw_finding_count, conflict_count,
      evidence_record_count, evidence_binding_count, lifecycle_reservation_count,
      lifecycle_event_count, raw_recovery_attempt_count, raw_recovery_result_count,
      interpretation_count, reviewer_anomaly_count, control_count,
      projection_digest, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  input.runId,
  input.scopeId,
  input.ledger.nextId,
  input.ledger.findings.length,
  input.ledger.rawFindings.length,
  input.ledger.conflicts.length,
  input.ledger.evidenceRecords.length,
  input.ledger.evidenceBindings.length,
  input.ledger.lifecycleReservations.length,
  input.ledger.lifecycleEvents.length,
  input.ledger.rawRecoveryAttempts.length,
  input.ledger.rawRecoveryResults.length,
  input.ledger.interpretations.length,
  input.ledger.reviewerAnomalies?.length ?? 0,
  [
    input.ledger.fixpoint,
    input.ledger.stopBudget,
    input.ledger.reviewIntegrity,
    input.ledger.pendingManagerCommit,
  ].filter((value) => value !== undefined).length,
  projectionDigest,
  input.updatedAt);
  return projectionDigest;
}

function parseJsonRecord(row: JsonRecordRow, label: string): unknown {
  if (sha256(row.record) !== row.digest) {
    throw new Error(`${label} digest mismatch at ordinal ${row.ordinal}`);
  }
  return JSON.parse(row.record) as unknown;
}

function entityId(entity: EntityTable, record: Record<string, unknown>): string {
  const key = entity[1] === 'finding_id'
    ? 'id'
    : entity[1] === 'evidence_id'
      ? 'evidenceId'
    : entity[1] === 'binding_id'
      ? 'bindingId'
      : entity[1] === 'reservation_id'
        ? 'reservationId'
        : entity[1] === 'event_id'
          ? 'eventId'
        : entity[1] === 'attempt_id'
          ? 'attemptId'
        : entity[1] === 'result_id'
          ? 'resultId'
    : entity[1] === 'raw_finding_id'
      ? 'rawFindingId'
      : entity[1] === 'conflict_id'
        ? 'id'
        : entity[1] === 'interpretation_key'
          ? 'interpretationKey'
          : 'id';
  const id = record[key];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${entity[2]} record is missing "${key}"`);
  }
  return id;
}

export function readFindingLedgerProjection(
  context: FindingAuthorityReader,
  input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly workflowName: string;
    readonly revision?: number;
  },
): FindingLedgerRecord {
  assertFindingContractEnabled(context, input.runId);
  const head = input.revision === undefined
    ? context.get<LedgerHeadRow>(`
    SELECT
      heads.current_revision AS revision,
      revisions.next_id AS nextId,
      revisions.updated_at AS updatedAt,
      revisions.projection_digest AS projectionDigest
    FROM finding_ledger_heads AS heads
    JOIN finding_ledger_revisions AS revisions
      ON revisions.run_id = heads.run_id
      AND revisions.scope_id = heads.scope_id
      AND revisions.revision = heads.current_revision
    WHERE heads.run_id = ? AND heads.scope_id = ?
  `, input.runId, input.scopeId)
    : context.get<LedgerHeadRow>(`
      SELECT
        revision,
        next_id AS nextId,
        updated_at AS updatedAt,
        projection_digest AS projectionDigest
      FROM finding_ledger_revisions
      WHERE run_id = ? AND scope_id = ? AND revision = ?
    `, input.runId, input.scopeId, input.revision);
  if (head === undefined) {
    throw new Error(`Finding ledger "${input.runId}/${input.scopeId}" does not exist`);
  }

  const projection: Record<string, unknown> = {
    workflowName: input.workflowName,
    nextId: head.nextId,
    updatedAt: trustedIsoTime(head.updatedAt),
  };
  for (const entity of ENTITY_TABLES) {
    const rows = context.all<JsonRecordRow>(`
      SELECT ordinal, record, digest
      FROM ${entity[0]}
      WHERE run_id = ? AND scope_id = ? AND revision = ?
      ORDER BY ordinal
    `, input.runId, input.scopeId, head.revision);
    if (rows.length > 0 || entity[2] !== 'reviewerAnomalies') {
      projection[entity[2]] = rows.map((row) => parseJsonRecord(row, entity[2]));
    }
  }
  const controls = context.all<{
    readonly controlKind: string;
    readonly record: string;
    readonly digest: string;
  }>(`
    SELECT control_kind AS controlKind, record, digest
    FROM finding_ledger_controls
    WHERE run_id = ? AND scope_id = ? AND revision = ?
    ORDER BY control_kind
  `, input.runId, input.scopeId, head.revision);
  for (const control of controls) {
    const value = parseJsonRecord(
      { ordinal: 0, record: control.record, digest: control.digest },
      control.controlKind,
    );
    switch (control.controlKind) {
      case 'fixpoint':
        projection.fixpoint = value;
        break;
      case 'stop_budget':
        projection.stopBudget = value;
        break;
      case 'review_integrity':
        projection.reviewIntegrity = value;
        break;
      case 'pending_manager_commit':
        projection.pendingManagerCommit = value;
        break;
      default:
        throw new Error(`Unknown finding ledger control "${control.controlKind}"`);
    }
  }
  const ledger = parseFindingLedger(projection);
  if (storedFindingProjectionDigest(ledger) !== head.projectionDigest) {
    throw new Error(
      `Finding ledger projection digest mismatch for "${input.runId}/${input.scopeId}/${head.revision}"`,
    );
  }
  return {
    runId: input.runId,
    scopeId: input.scopeId,
    workflowName: input.workflowName,
    revision: head.revision,
    ledger,
    updatedAt: head.updatedAt,
  };
}

interface FindingRevisionIntegrityRow {
  readonly scopeId: string;
  readonly revision: number;
  readonly findingCount: number;
  readonly evidenceRecordCount: number;
  readonly evidenceBindingCount: number;
  readonly lifecycleReservationCount: number;
  readonly lifecycleEventCount: number;
  readonly rawRecoveryAttemptCount: number;
  readonly rawRecoveryResultCount: number;
  readonly rawFindingCount: number;
  readonly conflictCount: number;
  readonly interpretationCount: number;
  readonly reviewerAnomalyCount: number;
  readonly controlCount: number;
}

export function validateFindingAuthority(
  context: FindingAuthorityReader,
  runId: string,
): void {
  validateFindingAuthorityScopes(context, runId);
  validateCurrentFindingAuthority(context, runId);
}

function validateFindingAuthorityScopes(
  context: FindingAuthorityReader,
  runId: string,
): void {
  const result = context.get<{
    readonly authorityMismatchCount: number;
    readonly revisionWithoutHeadCount: number;
    readonly headWithoutRevisionCount: number;
  }>(`
    SELECT
      (
        SELECT count(*)
        FROM scopes
        LEFT JOIN finding_ledger_heads AS heads
          ON heads.run_id = scopes.run_id
          AND heads.scope_id = scopes.scope_id
        WHERE
          scopes.run_id = ?
          AND (
            scopes.finding_contract_enabled = 0
            AND heads.scope_id IS NOT NULL
          )
      ) AS authorityMismatchCount,
      (
        SELECT count(*)
        FROM finding_ledger_revisions AS revisions
        LEFT JOIN finding_ledger_heads AS heads
          ON heads.run_id = revisions.run_id
          AND heads.scope_id = revisions.scope_id
        WHERE revisions.run_id = ? AND heads.scope_id IS NULL
      ) AS revisionWithoutHeadCount,
      (
        SELECT count(*)
        FROM finding_ledger_heads AS heads
        LEFT JOIN finding_ledger_revisions AS revisions
          ON revisions.run_id = heads.run_id
          AND revisions.scope_id = heads.scope_id
          AND revisions.revision = heads.current_revision
        WHERE heads.run_id = ? AND revisions.scope_id IS NULL
      ) AS headWithoutRevisionCount
  `, runId, runId, runId);
  if (
    result === undefined
    || result.authorityMismatchCount !== 0
    || result.revisionWithoutHeadCount !== 0
    || result.headWithoutRevisionCount !== 0
  ) {
    throw new Error('Finding Contract scope authority invariant mismatch');
  }
}

function validateCurrentFindingAuthority(
  context: FindingAuthorityReader,
  runId: string,
): void {
  const revisions = context.all<FindingRevisionIntegrityRow>(`
    SELECT
      revisions.scope_id AS scopeId,
      revisions.revision,
      revisions.finding_count AS findingCount,
      revisions.evidence_record_count AS evidenceRecordCount,
      revisions.evidence_binding_count AS evidenceBindingCount,
      revisions.lifecycle_reservation_count AS lifecycleReservationCount,
      revisions.lifecycle_event_count AS lifecycleEventCount,
      revisions.raw_recovery_attempt_count AS rawRecoveryAttemptCount,
      revisions.raw_recovery_result_count AS rawRecoveryResultCount,
      revisions.raw_finding_count AS rawFindingCount,
      revisions.conflict_count AS conflictCount,
      revisions.interpretation_count AS interpretationCount,
      revisions.reviewer_anomaly_count AS reviewerAnomalyCount,
      revisions.control_count AS controlCount
    FROM finding_ledger_heads AS heads
    JOIN finding_ledger_revisions AS revisions
      ON revisions.run_id = heads.run_id
      AND revisions.scope_id = heads.scope_id
      AND revisions.revision = heads.current_revision
    WHERE heads.run_id = ?
    ORDER BY revisions.scope_id
  `, runId);
  for (const revision of revisions) {
    const actualCounts = ENTITY_TABLES.map(([table]) => (
      context.get<{ readonly count: number }>(`
        SELECT count(*) AS count FROM ${table}
        WHERE run_id = ? AND scope_id = ? AND revision = ?
      `, runId, revision.scopeId, revision.revision)?.count
    ));
    const controlCount = context.get<{ readonly count: number }>(`
      SELECT count(*) AS count FROM finding_ledger_controls
      WHERE run_id = ? AND scope_id = ? AND revision = ?
    `, runId, revision.scopeId, revision.revision)?.count;
    if (
      actualCounts[0] !== revision.findingCount
      || actualCounts[1] !== revision.evidenceRecordCount
      || actualCounts[2] !== revision.evidenceBindingCount
      || actualCounts[3] !== revision.lifecycleReservationCount
      || actualCounts[4] !== revision.lifecycleEventCount
      || actualCounts[5] !== revision.rawRecoveryAttemptCount
      || actualCounts[6] !== revision.rawRecoveryResultCount
      || actualCounts[7] !== revision.rawFindingCount
      || actualCounts[8] !== revision.conflictCount
      || actualCounts[9] !== revision.interpretationCount
      || actualCounts[10] !== revision.reviewerAnomalyCount
      || controlCount !== revision.controlCount
    ) {
      throw new Error('Finding authority sealed revision count mismatch');
    }
    readFindingLedgerProjection(context, {
      runId,
      scopeId: revision.scopeId,
      workflowName: 'runtime-workflow',
    });
  }
}

function insertEntities(
  context: FindingAuthorityWriter,
  binding: { readonly runId: string; readonly scopeId: string },
  revision: number,
  ledger: FindingLedger,
): void {
  for (const entity of ENTITY_TABLES) {
    const records = ledger[entity[2]];
    if (records === undefined) {
      continue;
    }
    const insert = `
      INSERT INTO ${entity[0]} (
        run_id, scope_id, revision, ordinal, ${entity[1]}, record, digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    records.forEach((value, ordinal) => {
      const record = value as unknown as Record<string, unknown>;
      const encoded = canonicalJson(record);
      context.run(
        insert,
        binding.runId,
        binding.scopeId,
        revision,
        ordinal,
        entityId(entity, record),
        encoded,
        sha256(encoded),
      );
    });
  }
}

function insertControls(
  context: FindingAuthorityWriter,
  binding: { readonly runId: string; readonly scopeId: string },
  revision: number,
  ledger: FindingLedger,
): void {
  const controls = [
    ['fixpoint', ledger.fixpoint],
    ['stop_budget', ledger.stopBudget],
    ['review_integrity', ledger.reviewIntegrity],
    ['pending_manager_commit', ledger.pendingManagerCommit],
  ] as const;
  for (const [kind, value] of controls) {
    if (value === undefined) {
      continue;
    }
    const encoded = canonicalJson(value);
    context.run(`
      INSERT INTO finding_ledger_controls (
        run_id, scope_id, revision, control_kind, record, digest
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    binding.runId,
    binding.scopeId,
    revision,
    kind,
    encoded,
    sha256(encoded));
  }
}

export class FindingLedgerRepository {
  loadLedger(
    context: RunReadContext,
    input: {
      readonly runId: string;
      readonly scopeId: string;
      readonly workflowName: string;
    },
  ): FindingLedgerRecord {
    return readFindingLedgerProjection(context, input);
  }

  replaceLedger(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly workflowName: string;
    readonly expectedRevision: number;
    readonly ledger: FindingLedger;
    readonly updatedAt: number;
  }): FindingLedgerRecord {
    const current = readFindingLedgerProjection(context, input);
    if (
      current.workflowName !== input.workflowName
      || current.revision !== input.expectedRevision
    ) {
      throw new Error(`Finding ledger CAS mismatch for "${input.runId}/${input.scopeId}"`);
    }
    const ledger = parseFindingLedger({
      ...input.ledger,
      workflowName: input.workflowName,
      updatedAt: trustedIsoTime(input.updatedAt),
    });
    const revision = input.expectedRevision + 1;
    insertEntities(context, input, revision, ledger);
    insertControls(context, input, revision, ledger);
    const projectionDigest = storedFindingProjectionDigest(ledger);
    context.run(`
      INSERT INTO finding_ledger_revisions (
        run_id,
        scope_id,
        revision,
        next_id,
        finding_count,
        evidence_record_count,
        evidence_binding_count,
        lifecycle_reservation_count,
        lifecycle_event_count,
        raw_recovery_attempt_count,
        raw_recovery_result_count,
        raw_finding_count,
        conflict_count,
        interpretation_count,
        reviewer_anomaly_count,
        control_count,
        projection_digest,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    revision,
    ledger.nextId,
    ledger.findings.length,
    ledger.evidenceRecords.length,
    ledger.evidenceBindings.length,
    ledger.lifecycleReservations.length,
    ledger.lifecycleEvents.length,
    ledger.rawRecoveryAttempts.length,
    ledger.rawRecoveryResults.length,
    ledger.rawFindings.length,
    ledger.conflicts.length,
    ledger.interpretations.length,
    ledger.reviewerAnomalies?.length ?? 0,
    [
      ledger.fixpoint,
      ledger.stopBudget,
      ledger.reviewIntegrity,
      ledger.pendingManagerCommit,
    ].filter((value) => value !== undefined).length,
    projectionDigest,
    input.updatedAt);
    return readFindingLedgerProjection(context, input);
  }

}
