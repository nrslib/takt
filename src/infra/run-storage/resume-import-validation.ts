import { canonicalJson, sha256 } from './canonical-json.js';
import {
  parseFindingLedger,
} from '../../core/workflow/findings/schemas.js';
import type {
  FindingLedger,
} from '../../core/workflow/findings/types.js';
import {
  assertResumePublicationProvenance,
} from './finding-manager-adapter-contract.js';
import type {
  CompleteResumeSnapshot,
  ScopeResumeSnapshot,
  SnapshotRow,
} from './resume-snapshot-types.js';

export interface ValidatedFindingResumeSnapshot {
  readonly heads: ReadonlyMap<string, SnapshotRow>;
  readonly revisions: ReadonlyMap<string, SnapshotRow>;
  readonly publications: ReadonlyMap<string, SnapshotRow>;
  readonly entries: ReadonlyMap<string, readonly SnapshotRow[]>;
  readonly controls: ReadonlyMap<string, readonly SnapshotRow[]>;
}

export interface ValidatedResumeImportSnapshot {
  readonly scopes: ReadonlyMap<string, ScopeResumeSnapshot>;
  readonly finding: ValidatedFindingResumeSnapshot | null;
}

const FINDING_ENTRY_KINDS = new Set([
  'finding',
  'raw',
  'conflict',
  'interpretation',
  'reviewer_anomaly',
]);

const FINDING_CONTROL_KINDS = new Set([
  'fixpoint',
  'stop_budget',
  'review_integrity',
  'pending_manager_commit',
]);

export function validateResumeImportSnapshot(
  source: CompleteResumeSnapshot,
  input: {
    readonly childWorkflowName: string;
    readonly findingContractEnabled: boolean;
  },
): ValidatedResumeImportSnapshot {
  const definitions = indexUnique(
    source.workflowDefinitions,
    'workflow definition',
    (row) => requiredString(row.definitionId, 'workflow definition id'),
  );
  validateWorkflowDefinitions(definitions);
  const scopes = indexUnique(
    source.scopes,
    'scope',
    (scope) => requiredString(scope.scopeId, 'scope id'),
  );
  validateScopeTree(scopes, definitions);

  if (!input.findingContractEnabled) {
    validateFindingContractDisabled(source);
    return { scopes, finding: null };
  }
  const finding = validateFindingContractEnabled(
    source,
    scopes,
    definitions,
    input.childWorkflowName,
  );
  return { scopes, finding };
}

function validateWorkflowDefinitions(
  definitions: ReadonlyMap<string, SnapshotRow>,
): void {
  for (const [definitionId, definition] of definitions) {
    const name = requiredString(definition.name, 'workflow definition name');
    const codecName = requiredString(
      definition.codecName,
      'workflow definition codec',
    );
    const content = requiredString(
      definition.definition,
      'workflow definition content',
    );
    const digest = requiredDigest(
      definition.digest,
      'workflow definition digest',
    );
    if (
      sha256(content) !== digest
      || sha256([name, codecName, digest].join('\0')) !== definitionId
    ) {
      throw new Error(
        `Run resume workflow definition "${definitionId}" identity is invalid`,
      );
    }
  }
}

function validateScopeTree(
  scopes: ReadonlyMap<string, ScopeResumeSnapshot>,
  definitions: ReadonlyMap<string, SnapshotRow>,
): void {
  const root = scopes.get('root');
  if (root === undefined || root.parentScopeId !== null || root.kind !== 'root') {
    throw new Error('Run resume source root scope identity is invalid');
  }
  const referencedDefinitions = new Set<string>();
  const pending = new Map(scopes);
  pending.delete('root');
  const imported = new Set(['root']);
  referencedDefinitions.add(requireScopeDefinition(root, definitions));
  while (pending.size > 0) {
    let progressed = false;
    for (const [scopeId, scope] of pending) {
      const parentScopeId = requiredString(
        scope.parentScopeId,
        `scope "${scopeId}" parent`,
      );
      if (!imported.has(parentScopeId)) {
        continue;
      }
      requiredChildScopeKind(scope.kind, scopeId);
      referencedDefinitions.add(requireScopeDefinition(scope, definitions));
      imported.add(scopeId);
      pending.delete(scopeId);
      progressed = true;
    }
    if (!progressed) {
      throw new Error('Run resume source scope identities are not a rooted tree');
    }
  }
  assertSameKeys(
    new Set(definitions.keys()),
    referencedDefinitions,
    'workflow definition scope references',
  );
}

function requireScopeDefinition(
  scope: ScopeResumeSnapshot,
  definitions: ReadonlyMap<string, SnapshotRow>,
): string {
  const definitionId = requiredString(
    scope.workflowDefinitionId,
    `scope "${scope.scopeId}" workflow definition`,
  );
  if (!definitions.has(definitionId)) {
    throw new Error(
      `Run resume scope "${scope.scopeId}" references an unknown workflow definition`,
    );
  }
  return definitionId;
}

function validateFindingContractDisabled(
  source: CompleteResumeSnapshot,
): void {
  const findingRows = [
    source.findingReservations,
    source.findingPublications,
    source.findingRevisions,
    source.findingHeads,
    source.findingEntries,
    source.findingControls,
  ];
  if (
    findingRows.some((rows) => rows.length > 0)
    || source.findingLedger !== null
  ) {
    throw new Error(
      'Run resume source contains Finding authority while disabled',
    );
  }
}

function validateFindingContractEnabled(
  source: CompleteResumeSnapshot,
  scopes: ReadonlyMap<string, ScopeResumeSnapshot>,
  definitions: ReadonlyMap<string, SnapshotRow>,
  childWorkflowName: string,
): ValidatedFindingResumeSnapshot {
  const heads = indexUnique(
    source.findingHeads,
    'Finding head',
    (row) => requiredString(row.scope_id, 'Finding head scope'),
  );
  validateFindingHeadScopes(heads, scopes, definitions, childWorkflowName);

  const revisions = indexUnique(
    source.findingRevisions,
    'Finding revision',
    findingRevisionKey,
  );
  const expectedRevisionKeys = validateFindingRevisions(heads, revisions);
  const publications = indexUnique(
    source.findingPublications,
    'Finding publication',
    (row) => findingKey(
      requiredString(row.scopeId, 'Finding publication scope'),
      requiredPositiveInteger(row.revision, 'Finding publication revision'),
    ),
  );
  assertSameKeys(
    expectedRevisionKeys,
    new Set(publications.keys()),
    'Finding revision publications',
  );
  validateFindingPublications(revisions, publications);

  const entries = indexFindingEntries(source.findingEntries, expectedRevisionKeys);
  const controls = indexFindingControls(source.findingControls, expectedRevisionKeys);
  validateFindingRevisionCounts(revisions, entries, controls);
  validateFindingReservations(source.findingReservations, heads);
  const currentLedgers = reconstructCurrentFindingLedgers(
    heads,
    revisions,
    entries,
    controls,
  );
  validateRootFindingProjection(
    source,
    heads,
    currentLedgers,
    childWorkflowName,
  );
  validatePendingPublicationsBoundToSource(
    source,
    heads,
    currentLedgers,
  );
  return { heads, revisions, publications, entries, controls };
}

function validateFindingHeadScopes(
  heads: ReadonlyMap<string, SnapshotRow>,
  scopes: ReadonlyMap<string, ScopeResumeSnapshot>,
  definitions: ReadonlyMap<string, SnapshotRow>,
  childWorkflowName: string,
): void {
  for (const scope of scopes.values()) {
    const findingEnabled = requiredBooleanInteger(
      scope.findingContractEnabled,
      `scope "${scope.scopeId}" Finding Contract state`,
    );
    if (findingEnabled && !heads.has(scope.scopeId)) {
      throw new Error(
        `Run resume Finding head "${scope.scopeId}" is missing`,
      );
    }
    if (!findingEnabled && heads.has(scope.scopeId)) {
      throw new Error(
        `Run resume Finding head "${scope.scopeId}" is not enabled`,
      );
    }
  }
  for (const [scopeId, head] of heads) {
    const scope = scopes.get(scopeId);
    if (scope === undefined) {
      throw new Error(
        `Run resume Finding head "${scopeId}" has no scope`,
      );
    }
    const definitionId = requiredString(
      scope.workflowDefinitionId,
      `scope "${scopeId}" workflow definition`,
    );
    const definition = definitions.get(definitionId);
    const workflowName = requiredString(
      head.workflow_name,
      `Finding head "${scopeId}" workflow`,
    );
    if (definition?.name !== workflowName) {
      throw new Error(
        `Run resume Finding head "${scopeId}" workflow does not match its scope`,
      );
    }
  }
  const rootHead = heads.get('root');
  if (
    rootHead !== undefined
    && rootHead.workflow_name !== childWorkflowName
  ) {
    throw new Error(
      'Run resume source root Finding workflow does not match the child run',
    );
  }
}

function validateFindingRevisions(
  heads: ReadonlyMap<string, SnapshotRow>,
  revisions: ReadonlyMap<string, SnapshotRow>,
): Set<string> {
  const expected = new Set<string>();
  for (const [scopeId, head] of heads) {
    const workflowName = requiredString(
      head.workflow_name,
      `Finding head "${scopeId}" workflow`,
    );
    const currentRevision = requiredPositiveInteger(
      head.current_revision,
      `Finding head "${scopeId}" revision`,
    );
    const updatedAt = requiredNonNegativeInteger(
      head.updated_at,
      `Finding head "${scopeId}" updated time`,
    );
    for (let revision = 1; revision <= currentRevision; revision += 1) {
      const key = findingKey(scopeId, revision);
      expected.add(key);
      const row = revisions.get(key);
      if (row === undefined) {
        throw new Error(`Run resume Finding revision "${key}" is missing`);
      }
      if (row.workflow_name !== workflowName) {
        throw new Error(`Run resume Finding revision "${key}" workflow changed`);
      }
      requiredDigest(row.projection_digest, `Finding revision "${key}" projection`);
      requiredNonNegativeInteger(row.updated_at, `Finding revision "${key}" updated time`);
    }
    if (revisions.get(findingKey(scopeId, currentRevision))?.updated_at !== updatedAt) {
      throw new Error(`Run resume Finding head "${scopeId}" was not preserved`);
    }
  }
  assertSameKeys(expected, new Set(revisions.keys()), 'Finding revisions');
  return expected;
}

function validateFindingPublications(
  revisions: ReadonlyMap<string, SnapshotRow>,
  publications: ReadonlyMap<string, SnapshotRow>,
): void {
  for (const [key, publication] of publications) {
    const revision = revisions.get(key);
    const digest = requiredDigest(
      publication.projectionDigest,
      `Finding publication "${key}" digest`,
    );
    const publishedAt = requiredNonNegativeInteger(
      publication.publishedAt,
      `Finding publication "${key}" time`,
    );
    if (
      revision?.projection_digest !== digest
      || revision.updated_at !== publishedAt
    ) {
      throw new Error(
        `Run resume Finding publication "${key}" does not match its revision`,
      );
    }
  }
}

function indexFindingEntries(
  rows: readonly SnapshotRow[],
  expectedRevisionKeys: ReadonlySet<string>,
): ReadonlyMap<string, readonly SnapshotRow[]> {
  const primary = new Set<string>();
  const authorities = new Set<string>();
  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const kind = requiredString(row.entryKind, 'Finding entry kind');
    if (!FINDING_ENTRY_KINDS.has(kind)) {
      throw new Error(`Run resume Finding entry kind "${kind}" is invalid`);
    }
    const scopeId = requiredString(row.scopeId, 'Finding entry scope');
    const revision = requiredPositiveInteger(row.revision, 'Finding entry revision');
    const revisionKey = findingKey(scopeId, revision);
    if (!expectedRevisionKeys.has(revisionKey)) {
      throw new Error(`Run resume Finding entry references extra revision "${revisionKey}"`);
    }
    const ordinal = requiredNonNegativeInteger(row.ordinal, 'Finding entry ordinal');
    const authorityId = requiredString(row.authorityId, 'Finding entry identity');
    requireUnique(primary, `${revisionKey}\0${kind}\0${ordinal}`, 'Finding entry');
    requireUnique(
      authorities,
      `${revisionKey}\0${kind}\0${authorityId}`,
      'Finding entry authority',
    );
    validateJsonRecord(row, authorityId, kind);
    const current = grouped.get(revisionKey) ?? [];
    current.push(row);
    grouped.set(revisionKey, current);
  }
  return grouped;
}

function indexFindingControls(
  rows: readonly SnapshotRow[],
  expectedRevisionKeys: ReadonlySet<string>,
): ReadonlyMap<string, readonly SnapshotRow[]> {
  const indexed = new Set<string>();
  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const scopeId = requiredString(row.scopeId, 'Finding control scope');
    const revision = requiredPositiveInteger(row.revision, 'Finding control revision');
    const revisionKey = findingKey(scopeId, revision);
    if (!expectedRevisionKeys.has(revisionKey)) {
      throw new Error(`Run resume Finding control references extra revision "${revisionKey}"`);
    }
    const kind = requiredString(row.controlKind, 'Finding control kind');
    if (!FINDING_CONTROL_KINDS.has(kind)) {
      throw new Error(`Run resume Finding control kind "${kind}" is invalid`);
    }
    requireUnique(indexed, `${revisionKey}\0${kind}`, 'Finding control');
    validateJsonRecord(row);
    const current = grouped.get(revisionKey) ?? [];
    current.push(row);
    grouped.set(revisionKey, current);
  }
  return grouped;
}

function validateFindingRevisionCounts(
  revisions: ReadonlyMap<string, SnapshotRow>,
  entries: ReadonlyMap<string, readonly SnapshotRow[]>,
  controls: ReadonlyMap<string, readonly SnapshotRow[]>,
): void {
  const countFields = new Map([
    ['finding', 'finding_count'],
    ['raw', 'raw_finding_count'],
    ['conflict', 'conflict_count'],
    ['interpretation', 'interpretation_count'],
    ['reviewer_anomaly', 'reviewer_anomaly_count'],
  ]);
  for (const [key, revision] of revisions) {
    const revisionEntries = entries.get(key) ?? [];
    for (const [kind, field] of countFields) {
      const actual = revisionEntries.filter((entry) => entry.entryKind === kind).length;
      const expected = requiredNonNegativeInteger(
        revision[field],
        `Finding revision "${key}" ${field}`,
      );
      if (actual !== expected) {
        throw new Error(`Run resume Finding revision "${key}" count mismatch`);
      }
    }
    const expectedControls = requiredNonNegativeInteger(
      revision.control_count,
      `Finding revision "${key}" control count`,
    );
    if ((controls.get(key)?.length ?? 0) !== expectedControls) {
      throw new Error(`Run resume Finding revision "${key}" control count mismatch`);
    }
  }
}

function validateFindingReservations(
  rows: readonly SnapshotRow[],
  heads: ReadonlyMap<string, SnapshotRow>,
): void {
  const keys = new Set<string>();
  for (const row of rows) {
    const scopeId = requiredString(row.scopeId, 'Finding reservation scope');
    const token = requiredString(
      row.reservationToken,
      'Finding reservation token',
    );
    if (!heads.has(scopeId)) {
      throw new Error(
        `Run resume Finding reservation references unknown scope "${scopeId}"`,
      );
    }
    requireUnique(keys, `${scopeId}\0${token}`, 'Finding reservation');
    requiredNonNegativeInteger(
      row.claimedAt,
      'Finding reservation claimed time',
    );
  }
}

function validateRootFindingProjection(
  source: CompleteResumeSnapshot,
  heads: ReadonlyMap<string, SnapshotRow>,
  currentLedgers: ReadonlyMap<string, FindingLedger>,
  childWorkflowName: string,
): void {
  const projection = source.findingLedger;
  const rootHead = heads.get('root');
  if (rootHead === undefined) {
    if (projection !== null) {
      throw new Error('Run resume source has an unexpected root Finding projection');
    }
    return;
  }
  if (projection === null) {
    throw new Error('Run resume source root Finding projection is missing');
  }
  const currentRevision = requiredPositiveInteger(
    rootHead.current_revision,
    'root Finding revision',
  );
  const currentLedger = currentLedgers.get('root');
  if (
    projection.revision !== currentRevision
    || projection.ledger.workflowName !== childWorkflowName
    || currentLedger === undefined
    || projection.updatedAt !== Date.parse(currentLedger.updatedAt)
    || canonicalJson(projection.ledger) !== canonicalJson(currentLedger)
  ) {
    throw new Error(
      'Run resume source root Finding projection does not match its current revision',
    );
  }
}

function reconstructCurrentFindingLedgers(
  heads: ReadonlyMap<string, SnapshotRow>,
  revisions: ReadonlyMap<string, SnapshotRow>,
  entries: ReadonlyMap<string, readonly SnapshotRow[]>,
  controls: ReadonlyMap<string, readonly SnapshotRow[]>,
): ReadonlyMap<string, FindingLedger> {
  const ledgers = new Map<string, FindingLedger>();
  for (const [scopeId, head] of heads) {
    const revision = requiredPositiveInteger(
      head.current_revision,
      `Finding head "${scopeId}" revision`,
    );
    const revisionKey = findingKey(scopeId, revision);
    const revisionRow = revisions.get(revisionKey);
    if (revisionRow === undefined) {
      throw new Error(`Run resume Finding revision "${revisionKey}" is missing`);
    }
    const projection: Record<string, unknown> = {
      workflowName: requiredString(
        head.workflow_name,
        `Finding head "${scopeId}" workflow`,
      ),
      nextId: requiredPositiveInteger(
        revisionRow.next_id,
        `Finding revision "${revisionKey}" next id`,
      ),
      updatedAt: trustedIsoTime(
        requiredNonNegativeInteger(
          revisionRow.updated_at,
          `Finding revision "${revisionKey}" updated time`,
        ),
      ),
      findings: recordsForKind(entries.get(revisionKey), 'finding'),
      rawFindings: recordsForKind(entries.get(revisionKey), 'raw'),
      conflicts: recordsForKind(entries.get(revisionKey), 'conflict'),
      interpretations: recordsForKind(
        entries.get(revisionKey),
        'interpretation',
      ),
    };
    const reviewerAnomalies = recordsForKind(
      entries.get(revisionKey),
      'reviewer_anomaly',
    );
    if (reviewerAnomalies.length > 0) {
      projection.reviewerAnomalies = reviewerAnomalies;
    }
    for (const control of controls.get(revisionKey) ?? []) {
      const value = parseStoredRecord(control, 'Finding control');
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
          throw new Error(
            `Run resume Finding control kind "${String(control.controlKind)}" is invalid`,
          );
      }
    }
    const ledger = parseFindingLedger(projection);
    if (
      sha256(canonicalJson(ledger))
      !== requiredDigest(
        revisionRow.projection_digest,
        `Finding revision "${revisionKey}" projection`,
      )
    ) {
      throw new Error(
        `Run resume Finding projection "${revisionKey}" digest mismatch`,
      );
    }
    ledgers.set(scopeId, ledger);
  }
  return ledgers;
}

function validatePendingPublicationsBoundToSource(
  source: CompleteResumeSnapshot,
  heads: ReadonlyMap<string, SnapshotRow>,
  currentLedgers: ReadonlyMap<string, FindingLedger>,
): void {
  const sourceRunId = requiredString(source.run.runId, 'source run id');
  const originRunIds = new Set<string>([
    sourceRunId,
    ...source.ancestry.map((ancestor) => requiredString(
      ancestor.ancestorRunId,
      'ancestor run id',
    )),
  ]);
  for (const [scopeId, ledger] of currentLedgers) {
    const pending = ledger.pendingManagerCommit;
    if (pending === undefined) {
      continue;
    }
    const head = heads.get(scopeId);
    if (head === undefined) {
      throw new Error(`Run resume Finding head "${scopeId}" is missing`);
    }
    assertResumePublicationProvenance(
      pending.publication,
      pending.roundMarker,
      {
        directSourceRunId: sourceRunId,
        originRunIds,
        originScopeId: scopeId,
        workflowName: requiredString(
          head.workflow_name,
          `Finding head "${scopeId}" workflow`,
        ),
      },
    );
  }
}

function recordsForKind(
  rows: readonly SnapshotRow[] | undefined,
  kind: string,
): unknown[] {
  return (rows ?? [])
    .filter((row) => row.entryKind === kind)
    .map((row) => parseStoredRecord(row, `Finding ${kind} entry`));
}

function parseStoredRecord(row: SnapshotRow, label: string): unknown {
  const record = requiredString(row.record, `${label} record`);
  const digest = requiredDigest(row.digest, `${label} digest`);
  if (sha256(record) !== digest) {
    throw new Error(`Run resume ${label} digest mismatch`);
  }
  return JSON.parse(record) as unknown;
}

function trustedIsoTime(timestamp: number): string {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    throw new Error('Run resume Finding timestamp is outside the ISO range');
  }
  return value.toISOString();
}

function validateJsonRecord(
  row: SnapshotRow,
  authorityId?: string,
  kind?: string,
): void {
  const record = requiredString(row.record, 'Finding record');
  const digest = requiredDigest(row.digest, 'Finding record digest');
  if (sha256(record) !== digest) {
    throw new Error('Run resume Finding record digest mismatch');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(record) as Record<string, unknown>;
  } catch {
    throw new Error('Run resume Finding record is invalid JSON');
  }
  if (authorityId === undefined || kind === undefined) {
    return;
  }
  const identityField = kind === 'raw'
    ? 'rawFindingId'
    : kind === 'interpretation'
      ? 'interpretationKey'
      : 'id';
  if (parsed[identityField] !== authorityId) {
    throw new Error('Run resume Finding record identity mismatch');
  }
}

function findingRevisionKey(row: SnapshotRow): string {
  return findingKey(
    requiredString(row.scope_id, 'Finding revision scope'),
    requiredPositiveInteger(row.revision, 'Finding revision number'),
  );
}

function findingKey(scopeId: string, revision: number): string {
  return `${scopeId}/${revision}`;
}

function indexUnique<Row>(
  rows: readonly Row[],
  label: string,
  keyOf: (row: Row) => string,
): ReadonlyMap<string, Row> {
  const indexed = new Map<string, Row>();
  for (const row of rows) {
    const key = keyOf(row);
    requireUnique(indexed, key, label);
    indexed.set(key, row);
  }
  return indexed;
}

function requireUnique(
  keys: ReadonlyMap<string, unknown> | Set<string>,
  key: string,
  label: string,
): void {
  if (keys.has(key)) {
    throw new Error(`Run resume source contains duplicate ${label} "${key}"`);
  }
}

function assertSameKeys(
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>,
  label: string,
): void {
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Run resume source ${label} mismatch: `
      + `missing=[${missing.join(',')}], extra=[${extra.join(',')}]`,
    );
  }
}

function requiredChildScopeKind(value: unknown, scopeId: string): void {
  if (value !== 'workflow_call' && value !== 'parallel') {
    throw new Error(`Run resume source scope "${scopeId}" kind is invalid`);
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
