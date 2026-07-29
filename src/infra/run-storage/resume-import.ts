import type { DatabaseSync } from 'node:sqlite';
import type { FindingLedger } from '../../core/workflow/findings/types.js';
import { normalizePendingManagerCommitRebind } from '../../core/workflow/findings/ledger-mutation.js';
import { parseFindingLedger } from '../../core/workflow/findings/schemas.js';
import { sha256 } from './canonical-json.js';
import {
  importFindingAuthority,
  storedFindingProjectionDigest,
} from './finding-ledger.js';
import type {
  CompleteResumeSnapshot,
  SnapshotRow,
} from './resume-snapshot-types.js';
import {
  validateResumeImportSnapshot,
  type CurrentFindingResumeSnapshot,
} from './resume-import-validation.js';

export function seedRunResumeImport(
  database: DatabaseSync,
  input: {
    readonly childRunId: string;
    readonly childWorkflowName: string;
    readonly source: CompleteResumeSnapshot;
  },
): void {
  const source = input.source;
  const sourceRunId = requiredString(source.run.runId, 'source run id');
  const validated = validateResumeImportSnapshot(source);
  importScopeIdentities(
    database,
    input.childRunId,
    [...validated.scopes.values()],
  );
  for (const [scopeId, finding] of validated.findings) {
    importCurrentFindingProjection(database, {
      childRunId: input.childRunId,
      childWorkflowName: input.childWorkflowName,
      sourceRunId,
      scopeId,
      finding,
    });
  }
}

function importScopeIdentities(
  database: DatabaseSync,
  childRunId: string,
  scopes: readonly CompleteResumeSnapshot['scopes'][number][],
): void {
  const root = scopes.find((scope) => scope.scopeId === 'root');
  if (root === undefined || root.parentScopeId !== null || root.kind !== 'root') {
    throw new Error('Run resume source root scope identity is invalid');
  }
  const targetRoot = database.prepare(`
    SELECT
      created_at AS createdAt,
      finding_contract_enabled AS findingContractEnabled
    FROM scopes
    WHERE run_id = ? AND scope_id = 'root'
  `).get(childRunId) as {
    readonly createdAt: number;
    readonly findingContractEnabled: number;
  } | undefined;
  if (targetRoot === undefined) {
    throw new Error('Run resume target root scope does not exist');
  }
  const sourceRootFindingContractEnabled = requiredBooleanInteger(
    root.findingContractEnabled,
    'root scope Finding Contract state',
  );
  if (
    sourceRootFindingContractEnabled
    && targetRoot.findingContractEnabled !== 1
  ) {
    throw new Error(
      'Run resume target cannot disable the source root Finding Contract',
    );
  }

  const pending = new Map(
    scopes
      .filter((scope) => scope.scopeId !== 'root')
      .map((scope) => [scope.scopeId, scope]),
  );
  const imported = new Set(['root']);
  while (pending.size !== 0) {
    let progressed = false;
    for (const [scopeId, scope] of pending) {
      const parentScopeId = requiredString(
        scope.parentScopeId,
        `scope "${scopeId}" parent`,
      );
      if (!imported.has(parentScopeId)) {
        continue;
      }
      database.prepare(`
        INSERT INTO scopes (
          run_id, scope_id, parent_scope_id, kind,
          finding_contract_enabled, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        childRunId,
        scopeId,
        parentScopeId,
        requiredChildScopeKind(scope.kind, scopeId),
        requiredBooleanInteger(
          scope.findingContractEnabled,
          `scope "${scopeId}" Finding Contract state`,
        ) ? 1 : 0,
        targetRoot.createdAt,
      );
      database.prepare(`
        INSERT INTO scope_runtime (
          run_id, scope_id, status, updated_at
        ) VALUES (?, ?, 'ready', ?)
      `).run(childRunId, scopeId, targetRoot.createdAt);
      pending.delete(scopeId);
      imported.add(scopeId);
      progressed = true;
    }
    if (!progressed) {
      throw new Error('Run resume source scope identities are not a rooted tree');
    }
  }
  database.prepare(`
    UPDATE runs
    SET finding_contract_enabled = 1
    WHERE run_id = ? AND finding_contract_enabled = 0
      AND EXISTS (
        SELECT 1
        FROM scopes
        WHERE run_id = ? AND finding_contract_enabled = 1
      )
  `).run(childRunId, childRunId);
}

function importCurrentFindingProjection(
  database: DatabaseSync,
  input: {
    readonly childRunId: string;
    readonly childWorkflowName: string;
    readonly sourceRunId: string;
    readonly scopeId: string;
    readonly finding: CurrentFindingResumeSnapshot;
  },
): void {
  const sourceLedger = findingLedgerFromSnapshot(
    input.childWorkflowName,
    input.finding,
  );
  const ledger = rebindPendingPublication(
    sourceLedger,
    input.sourceRunId,
    input.childRunId,
    input.childWorkflowName,
  );
  const revision = input.finding.revision;
  importFindingAuthority({
    run: (sql, ...parameters) => database.prepare(sql).run(...parameters),
  }, {
    runId: input.childRunId,
    scopeId: input.scopeId,
    workflowName: input.childWorkflowName,
    ledger,
    sourceUpdatedAt: requiredNonNegativeInteger(
      revision.updated_at,
      'Finding updated time',
    ),
  });
}

function findingLedgerFromSnapshot(
  workflowName: string,
  snapshot: CurrentFindingResumeSnapshot,
): FindingLedger {
  const revision = snapshot.revision;
  const projection: Record<string, unknown> = {
    workflowName,
    nextId: requiredPositiveInteger(revision.next_id, 'Finding next id'),
    updatedAt: trustedIsoTime(
      requiredNonNegativeInteger(revision.updated_at, 'Finding updated time'),
    ),
  };
  for (const [kind, field] of ENTRY_FIELDS) {
    const records = snapshot.entries
      .filter((entry) => entry.entryKind === kind)
      .sort(compareOrdinal)
      .map((entry) => parseStoredRecord(entry, `Finding ${kind}`));
    if (field !== 'reviewerAnomalies' || records.length > 0) {
      projection[field] = records;
    }
  }
  for (const control of snapshot.controls) {
    const field = CONTROL_FIELDS.get(
      requiredString(control.controlKind, 'Finding control kind'),
    );
    if (field === undefined) {
      throw new Error('Run resume source Finding control kind is invalid');
    }
    projection[field] = parseStoredRecord(control, `Finding ${field}`);
  }
  const ledger = parseFindingLedger(projection);
  const expectedDigest = requiredDigest(
    revision.projection_digest,
    'Finding projection digest',
  );
  if (storedFindingProjectionDigest(ledger) !== expectedDigest) {
    throw new Error('Run resume source Finding projection digest is invalid');
  }
  return ledger;
}

function rebindPendingPublication(
  ledger: FindingLedger,
  sourceRunId: string,
  childRunId: string,
  workflowName: string,
): FindingLedger {
  const pending = ledger.pendingManagerCommit;
  if (pending === undefined) {
    return ledger;
  }
  if (pending.publication.destinationRunId !== sourceRunId) {
    throw new Error(
      'Run resume pending Finding publication does not target the direct source run',
    );
  }
  return normalizePendingManagerCommitRebind(
    ledger,
    {
      ...pending.publication,
      destinationRunId: childRunId,
    },
    workflowName,
  );
}

const ENTRY_FIELDS = [
  ['finding', 'findings'],
  ['evidence', 'evidenceRecords'],
  ['evidence_binding', 'evidenceBindings'],
  ['lifecycle_reservation', 'lifecycleReservations'],
  ['lifecycle_event', 'lifecycleEvents'],
  ['raw_recovery_attempt', 'rawRecoveryAttempts'],
  ['raw_recovery_result', 'rawRecoveryResults'],
  ['raw', 'rawFindings'],
  ['conflict', 'conflicts'],
  ['interpretation', 'interpretations'],
  ['reviewer_anomaly', 'reviewerAnomalies'],
] as const;

const CONTROL_FIELDS = new Map<string, string>([
  ['fixpoint', 'fixpoint'],
  ['stop_budget', 'stopBudget'],
  ['review_integrity', 'reviewIntegrity'],
  ['pending_manager_commit', 'pendingManagerCommit'],
]);

function parseStoredRecord(row: SnapshotRow, label: string): unknown {
  const record = requiredString(row.record, `${label} record`);
  if (sha256(record) !== requiredDigest(row.digest, `${label} digest`)) {
    throw new Error(`Run resume source ${label} digest is invalid`);
  }
  return JSON.parse(record) as unknown;
}

function compareOrdinal(left: SnapshotRow, right: SnapshotRow): number {
  return requiredNonNegativeInteger(left.ordinal, 'Finding ordinal')
    - requiredNonNegativeInteger(right.ordinal, 'Finding ordinal');
}

function requiredChildScopeKind(
  value: unknown,
  scopeId: string,
): 'workflow_call' | 'parallel' {
  if (value !== 'workflow_call' && value !== 'parallel') {
    throw new Error(`Run resume source scope "${scopeId}" kind is invalid`);
  }
  return value;
}

function trustedIsoTime(value: number): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    throw new Error('Run resume source Finding timestamp is invalid');
  }
  return time.toISOString();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Run resume source ${label} is invalid`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Run resume source ${label} is invalid`);
  }
  return Number(value);
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Run resume source ${label} is invalid`);
  }
  return Number(value);
}

function requiredBooleanInteger(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error(`Run resume source ${label} is invalid`);
  }
  return value === 1;
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Run resume source ${label} is invalid`);
  }
  return digest;
}
