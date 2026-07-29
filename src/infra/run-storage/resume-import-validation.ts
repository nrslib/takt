import type {
  CompleteResumeSnapshot,
  ScopeResumeSnapshot,
  SnapshotRow,
} from './resume-snapshot-types.js';

export interface CurrentFindingResumeSnapshot {
  readonly head: SnapshotRow;
  readonly revision: SnapshotRow;
  readonly entries: readonly SnapshotRow[];
  readonly controls: readonly SnapshotRow[];
}

export interface ValidatedResumeImportSnapshot {
  readonly scopes: ReadonlyMap<string, ScopeResumeSnapshot>;
  readonly findings: ReadonlyMap<string, CurrentFindingResumeSnapshot>;
}

export function validateResumeImportSnapshot(
  source: CompleteResumeSnapshot,
): ValidatedResumeImportSnapshot {
  const scopes = validateScopes(source.scopes);
  const findings = validateCurrentFindings(source, scopes);
  const hasEnabledScope = [...scopes.values()].some(
    (scope) => scope.findingContractEnabled === 1,
  );
  if (
    requiredBooleanInteger(
      source.run.findingContractEnabled,
      'run Finding Contract aggregate',
    ) !== hasEnabledScope
  ) {
    throw new Error('Run resume source Finding Contract aggregate is invalid');
  }
  if (!hasEnabledScope && findings.size !== 0) {
    throw new Error(
      'Run resume source contains Finding state while the contract is disabled',
    );
  }
  return { scopes, findings };
}

function validateScopes(
  rows: readonly ScopeResumeSnapshot[],
): ReadonlyMap<string, ScopeResumeSnapshot> {
  const scopes = new Map<string, ScopeResumeSnapshot>();
  for (const scope of rows) {
    const scopeId = requiredString(scope.scopeId, 'scope id');
    if (scopes.has(scopeId)) {
      throw new Error(`Run resume source scope "${scopeId}" is duplicated`);
    }
    requiredBooleanInteger(
      scope.findingContractEnabled,
      `scope "${scopeId}" Finding Contract state`,
    );
    scopes.set(scopeId, scope);
  }
  const root = scopes.get('root');
  if (root?.kind !== 'root' || root.parentScopeId !== null) {
    throw new Error('Run resume source root scope identity is invalid');
  }
  for (const [scopeId, scope] of scopes) {
    if (scopeId === 'root') {
      continue;
    }
    if (
      (scope.kind !== 'workflow_call' && scope.kind !== 'parallel')
      || typeof scope.parentScopeId !== 'string'
      || !scopes.has(scope.parentScopeId)
    ) {
      throw new Error(
        `Run resume source scope "${scopeId}" parent relationship is invalid`,
      );
    }
    assertReachesRoot(scopeId, scopes);
  }
  return scopes;
}

function assertReachesRoot(
  scopeId: string,
  scopes: ReadonlyMap<string, ScopeResumeSnapshot>,
): void {
  const visited = new Set<string>();
  let current = scopeId;
  while (current !== 'root') {
    if (visited.has(current)) {
      throw new Error('Run resume source scope identities are not a rooted tree');
    }
    visited.add(current);
    const parent = scopes.get(current)?.parentScopeId;
    if (typeof parent !== 'string') {
      throw new Error('Run resume source scope identities are not a rooted tree');
    }
    current = parent;
  }
}

function validateCurrentFindings(
  source: CompleteResumeSnapshot,
  scopes: ReadonlyMap<string, ScopeResumeSnapshot>,
): ReadonlyMap<string, CurrentFindingResumeSnapshot> {
  const revisions = uniqueByScope(source.findingRevisions, 'Finding revision');
  const entries = groupByScope(source.findingEntries);
  const controls = groupByScope(source.findingControls);
  const findings = new Map<string, CurrentFindingResumeSnapshot>();
  for (const head of source.findingHeads) {
    const scopeId = requiredString(head.scope_id, 'Finding head scope');
    if (findings.has(scopeId)) {
      throw new Error(`Run resume Finding head "${scopeId}" is duplicated`);
    }
    const scope = scopes.get(scopeId);
    if (
      scope === undefined
      || requiredBooleanInteger(
        scope.findingContractEnabled,
        `scope "${scopeId}" Finding Contract state`,
      ) === false
    ) {
      throw new Error(`Run resume Finding head "${scopeId}" has no authority scope`);
    }
    const currentRevision = requiredPositiveInteger(
      head.current_revision,
      `Finding head "${scopeId}" revision`,
    );
    const revision = revisions.get(scopeId);
    if (
      revision === undefined
      || requiredPositiveInteger(
        revision.revision,
        `Finding revision "${scopeId}" revision`,
      ) !== currentRevision
    ) {
      throw new Error(`Run resume Finding head "${scopeId}" has no current revision`);
    }
    const scopeEntries = entries.get(scopeId) ?? [];
    const scopeControls = controls.get(scopeId) ?? [];
    assertCurrentRevisionRows(scopeId, currentRevision, scopeEntries);
    assertCurrentRevisionRows(scopeId, currentRevision, scopeControls);
    assertRevisionCounts(revision, scopeEntries, scopeControls);
    findings.set(scopeId, {
      head,
      revision,
      entries: scopeEntries,
      controls: scopeControls,
    });
  }
  if (
    revisions.size !== findings.size
    || [...entries.keys()].some((scopeId) => !findings.has(scopeId))
    || [...controls.keys()].some((scopeId) => !findings.has(scopeId))
  ) {
    throw new Error('Run resume Finding current projection is incomplete');
  }
  return findings;
}

function uniqueByScope(
  rows: readonly SnapshotRow[],
  label: string,
): ReadonlyMap<string, SnapshotRow> {
  const result = new Map<string, SnapshotRow>();
  for (const row of rows) {
    const scopeId = requiredString(row.scope_id, `${label} scope`);
    if (result.has(scopeId)) {
      throw new Error(`${label} "${scopeId}" is duplicated`);
    }
    result.set(scopeId, row);
  }
  return result;
}

function groupByScope(
  rows: readonly SnapshotRow[],
): ReadonlyMap<string, readonly SnapshotRow[]> {
  const result = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const scopeId = requiredString(row.scopeId, 'Finding row scope');
    const current = result.get(scopeId);
    if (current === undefined) {
      result.set(scopeId, [row]);
    } else {
      current.push(row);
    }
  }
  return result;
}

function assertCurrentRevisionRows(
  scopeId: string,
  currentRevision: number,
  rows: readonly SnapshotRow[],
): void {
  for (const row of rows) {
    if (row.revision !== currentRevision) {
      throw new Error(
        `Run resume Finding row "${scopeId}" is not from its current revision`,
      );
    }
  }
}

function assertRevisionCounts(
  revision: SnapshotRow,
  entries: readonly SnapshotRow[],
  controls: readonly SnapshotRow[],
): void {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const kind = requiredString(entry.entryKind, 'Finding entry kind');
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const expected = [
    ['finding_count', 'finding'],
    ['evidence_record_count', 'evidence'],
    ['evidence_binding_count', 'evidence_binding'],
    ['lifecycle_reservation_count', 'lifecycle_reservation'],
    ['lifecycle_event_count', 'lifecycle_event'],
    ['raw_recovery_attempt_count', 'raw_recovery_attempt'],
    ['raw_recovery_result_count', 'raw_recovery_result'],
    ['raw_finding_count', 'raw'],
    ['conflict_count', 'conflict'],
    ['interpretation_count', 'interpretation'],
    ['reviewer_anomaly_count', 'reviewer_anomaly'],
  ] as const;
  for (const [field, kind] of expected) {
    if (revision[field] !== (counts.get(kind) ?? 0)) {
      throw new Error(`Run resume Finding revision count "${field}" is invalid`);
    }
  }
  if (revision.control_count !== controls.length) {
    throw new Error('Run resume Finding revision control count is invalid');
  }
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

function requiredBooleanInteger(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error(`Run resume source ${label} is invalid`);
  }
  return value === 1;
}
