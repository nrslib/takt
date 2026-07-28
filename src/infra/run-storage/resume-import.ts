import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256 } from './canonical-json.js';
import type {
  CompleteResumeSnapshot,
  SnapshotRow,
} from './resume-snapshot-types.js';
import {
  validateResumeImportSnapshot,
  type ValidatedFindingResumeSnapshot,
} from './resume-import-validation.js';

export interface TrustedRunStorageResumeSnapshot {
  readonly snapshot: CompleteResumeSnapshot;
  readonly digest: string;
}

export function captureTrustedRunStorageResumeSnapshot(
  snapshot: CompleteResumeSnapshot,
): TrustedRunStorageResumeSnapshot {
  return Object.freeze({
    snapshot,
    digest: sha256(canonicalJson(snapshot)),
  });
}

export function seedRunResumeImport(
  database: DatabaseSync,
  input: {
    readonly childRunId: string;
    readonly childWorkflowName: string;
    readonly findingContractEnabled: boolean;
    readonly source: TrustedRunStorageResumeSnapshot;
  },
): void {
  const source = input.source.snapshot;
  if (sha256(canonicalJson(source)) !== input.source.digest) {
    throw new Error('Run resume source snapshot changed before import');
  }
  const sourceRunId = requiredString(source.run.runId, 'source run id');
  const sourceFindingEnabled = requiredBooleanInteger(
    source.run.findingContractEnabled,
    'Finding Contract state',
  );
  if (sourceFindingEnabled !== input.findingContractEnabled) {
    throw new Error('Run resume source Finding Contract does not match the child run');
  }
  const validated = validateResumeImportSnapshot(source, {
    childWorkflowName: input.childWorkflowName,
    findingContractEnabled: input.findingContractEnabled,
  });

  seedAncestry(
    database,
    input.childRunId,
    sourceRunId,
    input.source,
  );
  importWorkflowDefinitions(database, source.workflowDefinitions);
  importScopeIdentities(
    database,
    input.childRunId,
    [...validated.scopes.values()],
  );
  insertResumeSource(database, {
    childRunId: input.childRunId,
    sourceRunId,
    sourceSnapshotDigest: input.source.digest,
  });

  if (validated.finding === null) {
    return;
  }
  importFindingAuthorities(database, {
    childRunId: input.childRunId,
    childWorkflowName: input.childWorkflowName,
    sourceRunId,
    sourceSnapshotDigest: input.source.digest,
    source,
    finding: validated.finding,
  });
}

function importWorkflowDefinitions(
  database: DatabaseSync,
  definitions: readonly SnapshotRow[],
): void {
  for (const definition of definitions) {
    const definitionId = requiredString(
      definition.definitionId,
      'workflow definition id',
    );
    const values = {
      name: requiredString(definition.name, 'workflow definition name'),
      codecName: requiredString(
        definition.codecName,
        'workflow definition codec',
      ),
      definition: requiredString(
        definition.definition,
        'workflow definition content',
      ),
      digest: requiredDigest(
        definition.digest,
        'workflow definition digest',
      ),
    };
    const existing = database.prepare(`
      SELECT
        name,
        codec_name AS codecName,
        definition,
        digest
      FROM workflow_definitions
      WHERE definition_id = ?
    `).get(definitionId) as typeof values | undefined;
    if (existing !== undefined) {
      if (
        existing.name !== values.name
        || existing.codecName !== values.codecName
        || existing.definition !== values.definition
        || existing.digest !== values.digest
      ) {
        throw new Error(`Run resume workflow definition "${definitionId}" changed`);
      }
      continue;
    }
    database.prepare(`
      INSERT INTO workflow_definitions (
        definition_id, name, codec_name, definition, digest
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      definitionId,
      values.name,
      values.codecName,
      values.definition,
      values.digest,
    );
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
  if (
    targetRoot.findingContractEnabled
      !== (requiredBooleanInteger(
        root.findingContractEnabled,
        'root scope Finding Contract state',
      ) ? 1 : 0)
  ) {
    throw new Error(
      'Run resume source root Finding Contract does not match the child run',
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
      const kind = requiredChildScopeKind(scope.kind, scopeId);
      database.prepare(`
        INSERT INTO scopes (
          run_id, scope_id, parent_scope_id, kind,
          workflow_definition_id, finding_contract_enabled, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        childRunId,
        scopeId,
        parentScopeId,
        kind,
        requiredString(
          scope.workflowDefinitionId,
          `scope "${scopeId}" workflow definition`,
        ),
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
}

function importFindingAuthorities(
  database: DatabaseSync,
  input: {
    readonly childRunId: string;
    readonly childWorkflowName: string;
    readonly sourceRunId: string;
    readonly sourceSnapshotDigest: string;
    readonly source: CompleteResumeSnapshot;
    readonly finding: ValidatedFindingResumeSnapshot;
  },
): void {
  for (const head of input.finding.heads.values()) {
    importFindingAuthority(database, input, head);
  }
}

function importFindingAuthority(
  database: DatabaseSync,
  input: {
    readonly childRunId: string;
    readonly sourceRunId: string;
    readonly sourceSnapshotDigest: string;
    readonly source: CompleteResumeSnapshot;
    readonly finding: ValidatedFindingResumeSnapshot;
  },
  head: SnapshotRow,
): void {
  const scopeId = requiredString(head.scope_id, 'Finding head scope');
  const workflowName = requiredString(
    head.workflow_name,
    `Finding head "${scopeId}" workflow`,
  );
  const currentRevision = requiredPositiveInteger(
    head.current_revision,
    `Finding head "${scopeId}" revision`,
  );
  for (let revision = 1; revision <= currentRevision; revision += 1) {
    importFindingRevision(database, input, {
      scopeId,
      workflowName,
      revision,
    });
  }

  const importedHead = database.prepare(`
    SELECT
      workflow_name AS workflowName,
      current_revision AS currentRevision,
      updated_at AS updatedAt
    FROM finding_ledger_heads
    WHERE run_id = ? AND scope_id = ?
  `).get(input.childRunId, scopeId) as {
    readonly workflowName: string;
    readonly currentRevision: number;
    readonly updatedAt: number;
  } | undefined;
  const expectedUpdatedAt = requiredNonNegativeInteger(
    head.updated_at,
    `Finding head "${scopeId}" updated time`,
  );
  if (
    importedHead?.workflowName !== workflowName
    || importedHead.currentRevision !== currentRevision
    || importedHead.updatedAt !== expectedUpdatedAt
  ) {
    throw new Error(`Run resume Finding head "${scopeId}" was not preserved`);
  }
  const current = input.finding.revisions.get(
    findingRevisionKey(scopeId, currentRevision),
  );
  if (current === undefined) {
    throw new Error(
      `Run resume Finding revision "${scopeId}/${currentRevision}" is missing`,
    );
  }
  database.prepare(`
    INSERT INTO finding_resume_authorities (
      run_id, scope_id, source_run_id, source_scope_id,
      source_revision, imported_revision, projection_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.childRunId,
    scopeId,
    input.sourceRunId,
    scopeId,
    currentRevision,
    currentRevision,
    requiredDigest(
      current.projection_digest,
      `Finding revision "${scopeId}/${currentRevision}" projection`,
    ),
  );
}

function importFindingRevision(
  database: DatabaseSync,
  input: {
    readonly childRunId: string;
    readonly source: CompleteResumeSnapshot;
    readonly finding: ValidatedFindingResumeSnapshot;
  },
  authority: {
    readonly scopeId: string;
    readonly workflowName: string;
    readonly revision: number;
  },
): void {
  const revisionKey = findingRevisionKey(
    authority.scopeId,
    authority.revision,
  );
  const sourceRevision = input.finding.revisions.get(revisionKey);
  if (sourceRevision === undefined) {
    throw new Error(`Run resume Finding revision "${revisionKey}" is missing`);
  }
  if (sourceRevision.workflow_name !== authority.workflowName) {
    throw new Error(
      `Run resume Finding revision "${authority.scopeId}/${authority.revision}" workflow changed`,
    );
  }
  const publication = input.finding.publications.get(revisionKey);
  if (publication === undefined) {
    throw new Error(
      `Run resume Finding revision "${authority.scopeId}/${authority.revision}" has no publication`,
    );
  }
  database.prepare(`
    INSERT INTO finding_revision_publications (
      run_id, scope_id, revision, projection_digest, published_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    input.childRunId,
    authority.scopeId,
    authority.revision,
    requiredDigest(publication.projectionDigest, 'Finding publication digest'),
    requiredNonNegativeInteger(
      publication.publishedAt,
      'Finding publication time',
    ),
  );

  for (const entry of input.finding.entries.get(revisionKey) ?? []) {
    insertFindingEntry(database, input.childRunId, entry);
  }
  for (const control of input.finding.controls.get(revisionKey) ?? []) {
    database.prepare(`
      INSERT INTO finding_ledger_controls (
        run_id, scope_id, revision, control_kind, record, digest
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.childRunId,
      authority.scopeId,
      authority.revision,
      requiredString(control.controlKind, 'Finding control kind'),
      requiredString(control.record, 'Finding control record'),
      requiredDigest(control.digest, 'Finding control digest'),
    );
  }
  database.prepare(`
    INSERT INTO finding_ledger_revisions (
      run_id, scope_id, revision, workflow_name, next_id,
      finding_count, evidence_record_count, raw_finding_count, conflict_count,
      evidence_binding_count, lifecycle_reservation_count, lifecycle_event_count,
      raw_recovery_attempt_count, raw_recovery_result_count,
      interpretation_count, reviewer_anomaly_count, control_count,
      projection_digest, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.childRunId,
    authority.scopeId,
    authority.revision,
    authority.workflowName,
    requiredPositiveInteger(sourceRevision.next_id, 'Finding next id'),
    requiredNonNegativeInteger(sourceRevision.finding_count, 'Finding count'),
    requiredNonNegativeInteger(
      sourceRevision.evidence_record_count,
      'evidence record count',
    ),
    requiredNonNegativeInteger(
      sourceRevision.raw_finding_count,
      'raw Finding count',
    ),
    requiredNonNegativeInteger(sourceRevision.conflict_count, 'conflict count'),
    requiredNonNegativeInteger(
      sourceRevision.evidence_binding_count,
      'evidence binding count',
    ),
    requiredNonNegativeInteger(
      sourceRevision.lifecycle_reservation_count,
      'lifecycle reservation count',
    ),
    requiredNonNegativeInteger(
      sourceRevision.lifecycle_event_count,
      'lifecycle event count',
    ),
    requiredNonNegativeInteger(
      sourceRevision.raw_recovery_attempt_count,
      'raw recovery attempt count',
    ),
    requiredNonNegativeInteger(
      sourceRevision.raw_recovery_result_count,
      'raw recovery result count',
    ),
    requiredNonNegativeInteger(
      sourceRevision.interpretation_count,
      'interpretation count',
    ),
    requiredNonNegativeInteger(
      sourceRevision.reviewer_anomaly_count,
      'reviewer anomaly count',
    ),
    requiredNonNegativeInteger(sourceRevision.control_count, 'control count'),
    requiredDigest(sourceRevision.projection_digest, 'Finding projection digest'),
    requiredNonNegativeInteger(sourceRevision.updated_at, 'Finding updated time'),
  );
}

function insertFindingEntry(
  database: DatabaseSync,
  childRunId: string,
  entry: SnapshotRow,
): void {
  const identity = {
    scopeId: requiredString(entry.scopeId, 'Finding entry scope'),
    revision: requiredPositiveInteger(entry.revision, 'Finding entry revision'),
    ordinal: requiredNonNegativeInteger(entry.ordinal, 'Finding entry ordinal'),
    authorityId: requiredString(entry.authorityId, 'Finding entry identity'),
    record: requiredString(entry.record, 'Finding entry record'),
    digest: requiredDigest(entry.digest, 'Finding entry digest'),
  };
  const kind = requiredString(entry.entryKind, 'Finding entry kind');
  switch (kind) {
    case 'finding':
      insertFindingEntryRow(database, childRunId, identity, 'finding_entries', 'finding_id');
      return;
    case 'evidence':
      insertFindingEntryRow(database, childRunId, identity, 'finding_evidence_records', 'evidence_id');
      return;
    case 'evidence_binding':
      insertFindingEntryRow(database, childRunId, identity, 'finding_evidence_bindings', 'binding_id');
      return;
    case 'lifecycle_reservation':
      insertFindingEntryRow(database, childRunId, identity, 'finding_lifecycle_reservations', 'reservation_id');
      return;
    case 'lifecycle_event':
      insertFindingEntryRow(database, childRunId, identity, 'finding_lifecycle_events', 'event_id');
      return;
    case 'raw_recovery_attempt':
      insertFindingEntryRow(database, childRunId, identity, 'finding_raw_recovery_attempts', 'attempt_id');
      return;
    case 'raw_recovery_result':
      insertFindingEntryRow(database, childRunId, identity, 'finding_raw_recovery_results', 'result_id');
      return;
    case 'raw':
      insertFindingEntryRow(database, childRunId, identity, 'finding_raw_entries', 'raw_finding_id');
      return;
    case 'conflict':
      insertFindingEntryRow(database, childRunId, identity, 'finding_conflict_entries', 'conflict_id');
      return;
    case 'interpretation':
      insertFindingEntryRow(database, childRunId, identity, 'finding_interpretation_entries', 'interpretation_key');
      return;
    case 'reviewer_anomaly':
      insertFindingEntryRow(database, childRunId, identity, 'finding_reviewer_anomaly_entries', 'anomaly_id');
      return;
    default:
      throw new Error(`Run resume Finding entry kind "${kind}" is invalid`);
  }
}

function insertFindingEntryRow(
  database: DatabaseSync,
  childRunId: string,
  entry: {
    readonly scopeId: string;
    readonly revision: number;
    readonly ordinal: number;
    readonly authorityId: string;
    readonly record: string;
    readonly digest: string;
  },
  table: string,
  identityColumn: string,
): void {
  database.prepare(`
    INSERT INTO ${table} (
      run_id, scope_id, revision, ordinal, ${identityColumn}, record, digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    childRunId,
    entry.scopeId,
    entry.revision,
    entry.ordinal,
    entry.authorityId,
    entry.record,
    entry.digest,
  );
}

function findingRevisionKey(
  scopeId: string,
  revision: number,
): string {
  return `${scopeId}/${revision}`;
}

function seedAncestry(
  database: DatabaseSync,
  childRunId: string,
  sourceRunId: string,
  source: TrustedRunStorageResumeSnapshot,
): void {
  database.prepare(`
    INSERT INTO run_ancestry (
      run_id, ancestor_run_id, depth, snapshot_digest
    ) VALUES (?, ?, 1, ?)
  `).run(childRunId, sourceRunId, source.digest);
  source.snapshot.ancestry.forEach((ancestor, index) => {
    const ancestorRunId = requiredString(
      ancestor.ancestorRunId,
      'ancestor run id',
    );
    const depth = requiredPositiveInteger(ancestor.depth, 'ancestor depth');
    const snapshotDigest = requiredDigest(
      ancestor.snapshotDigest,
      'ancestor snapshot digest',
    );
    if (
      depth !== index + 1
      || ancestorRunId === childRunId
      || ancestorRunId === sourceRunId
    ) {
      throw new Error('Run resume source ancestry is not a direct linear chain');
    }
    database.prepare(`
      INSERT INTO run_ancestry (
        run_id, ancestor_run_id, depth, snapshot_digest
      ) VALUES (?, ?, ?, ?)
    `).run(
      childRunId,
      ancestorRunId,
      depth + 1,
      snapshotDigest,
    );
  });
}

function insertResumeSource(
  database: DatabaseSync,
  input: {
    readonly childRunId: string;
    readonly sourceRunId: string;
    readonly sourceSnapshotDigest: string;
  },
): void {
  database.prepare(`
    INSERT INTO run_resume_sources (
      run_id, source_run_id, source_snapshot_digest
    ) VALUES (?, ?, ?)
  `).run(
    input.childRunId,
    input.sourceRunId,
    input.sourceSnapshotDigest,
  );
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
