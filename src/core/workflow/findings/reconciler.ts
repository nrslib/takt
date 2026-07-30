import type {
  FindingLedger,
  FindingEvidenceRecord,
  FindingLedgerConflict,
  FindingManagerOutput,
  FindingObservation,
  FindingProvisionalKind,
  FindingProvisionalMetadata,
  FindingReconcileContext,
  FindingRecord,
  FindingSeverity,
  CanonicalRawFindingProvenance,
  RawFindingDisposition,
  RawFinding,
} from './types.js';
import { RAW_FINDING_DISPOSITION_OUTCOMES } from './types.js';
import { assertFindingLedgerProjectionInvariant } from '../../models/finding-ledger-invariants.js';
import {
  validateFindingManagerOutput,
  validateManagerActionRecoveryOutput,
} from './manager-output-validation.js';
import { countInterpretationEpochs } from './interpretation-wal.js';
import { formatConflictId } from '../../models/finding-conflict-identity.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import {
  foldFindingObservation,
  foldRawFindingEvidence,
  selectPrimaryRawFinding,
} from './finding-evidence-fold.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  canonicalJson,
  compareCanonicalJsonValues,
} from '../../../shared/utils/canonical-json.js';
import {
  verifyOpenConflictOutcomeAuthority,
  type OpenConflictOutcomeAuthority,
} from './raw-capabilities.js';
import {
  absenceRawFindings,
  authorityAnchorAdjudications,
  computeAnchorRelevanceDecisionDigest,
} from '../../models/finding-anchor-relevance.js';
import {
  assertRawFindingsAppendOnly,
  computeCanonicalRawIntegrityDigest,
} from './finding-integrity.js';
import {
  evidenceRecordMatchesRawEvidence,
  findingEvidenceRecordIdentityViolation,
} from '../../models/finding-evidence-record.js';
import type {
  FindingLifecycleCommand,
  LifecycleEvidenceSource,
} from './lifecycle-transaction.js';
import {
  createFindingLedgerEntry,
  createProductFindingEntry,
  createProvisionalFindingEntry,
  isProvisionalFindingEntry,
  materializeProvisionalFinding,
  mergeProvisionalClaimProjection,
} from './finding-entry.js';
import { isProvisionalReopenSource } from './provisional-promotion-eligibility.js';
import type {
  PreAdmissionEntityMutationResult,
  PreAdmissionEntityProvisionalMutation,
} from './pre-admission-entity-binding-types.js';
import { entityBindingDigest } from './pre-admission-entity-binding-identity.js';

/**
 * provisional finding の upsert 指示。stableKey が同じ
 * open provisional が既にあれば同一 ID を更新し（新しい finding ID を作らない —
 * 再発同定キー）、無ければ新規 open finding を provisional メタデータ付きで作る。
 */
export interface ProvisionalFindingSpec {
  kind: FindingProvisionalKind;
  stableKey: string;
  lineageKey: string;
  sourceRawFindingIds: string[];
  reason: string;
  title: string | null;
  /** raw 由来なら元 severity、system overflow / budget failure は 'high'。 */
  severity: FindingSeverity | null;
  description?: string;
  suggestion?: string;
  reviewers: string[];
  /** raw 由来 provisional の対象。値を持っても product lifecycle authority ではない。 */
  target?: RawFinding['target'];
  targetIdentityHash?: string;
  claimIdentityHash?: string;
  semanticClaimIdentityHash?: string;
  recoveryReviewerStableKey?: string;
  actionRecovery?: FindingProvisionalMetadata['actionRecovery'];
}

export interface CanonicalRawReconcileProvenance {
  reviewerStableKey: string;
  lineageKey: string;
  claimIdentityHash: string;
  canonicalIntegrityDigest: string;
  canonicalProvenance: CanonicalRawFindingProvenance;
  openConflictOutcomeAuthority?: OpenConflictOutcomeAuthority;
}

interface ReconcileFindingLedgerInput {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
  managerOutput: FindingManagerOutput;
  context: FindingReconcileContext;
  priorStepResponseText?: string;
  provisionalFindings: ProvisionalFindingSpec[];
  entityProvisionalMutations: PreAdmissionEntityProvisionalMutation[];
  terminalEntityAttachmentFindingIds: ReadonlySet<string>;
  rawFindingDispositions: readonly RawFindingDisposition[];
  rawProvenanceByRawFindingId: ReadonlyMap<string, CanonicalRawReconcileProvenance>;
  verifiedEvidenceRecordsByRawFindingId: ReadonlyMap<
    string,
    readonly FindingEvidenceRecord[]
  >;
}

function evidenceIdsForRawFindings(
  rawFindingIds: readonly string[],
  recordsByRawFindingId: ReconcileFindingLedgerInput['verifiedEvidenceRecordsByRawFindingId'],
): string[] {
  return [...new Set(rawFindingIds.flatMap(
    (rawFindingId) => (recordsByRawFindingId.get(rawFindingId) ?? [])
      .map((record) => record.evidenceId),
  ))].sort(compareBinaryStrings);
}

function mergeEvidenceRecords(
  current: readonly FindingEvidenceRecord[],
  recordsByRawFindingId: ReconcileFindingLedgerInput['verifiedEvidenceRecordsByRawFindingId'],
): FindingEvidenceRecord[] {
  const byId = new Map(current.map((record) => [record.evidenceId, record]));
  const additions = [...recordsByRawFindingId.values()].flat();
  for (const record of additions) {
    const existing = byId.get(record.evidenceId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(record)) {
      throw new Error(`Evidence record "${record.evidenceId}" has conflicting content`);
    }
    byId.set(record.evidenceId, record);
  }
  const currentIds = new Set(current.map((record) => record.evidenceId));
  return [
    ...current,
    ...[...byId.values()]
      .filter((record) => !currentIds.has(record.evidenceId))
      .sort((left, right) => compareBinaryStrings(left.evidenceId, right.evidenceId)),
  ];
}

function formatFindingId(nextId: number): string {
  return `F-${String(nextId).padStart(4, '0')}`;
}

function assertKnownFinding(findingIds: Set<string>, findingId: string): void {
  if (!findingIds.has(findingId)) {
    throw new Error(`Unknown finding id "${findingId}"`);
  }
}

function assertKnownConflict(conflictsById: ReadonlyMap<string, FindingLedgerConflict>, conflictId: string): void {
  if (!conflictsById.has(conflictId)) {
    throw new Error(`Unknown conflict id "${conflictId}"`);
  }
}

function assertKnownRawFindings(rawFindingIds: Set<string>, referencedIds: readonly string[]): void {
  if (referencedIds.length === 0) {
    throw new Error('Manager output must reference at least one raw finding id');
  }
  assertUniqueIds(referencedIds, 'raw finding id');
  for (const rawFindingId of referencedIds) {
    if (!rawFindingIds.has(rawFindingId)) {
      throw new Error(`Unknown raw finding id "${rawFindingId}"`);
    }
  }
}

function assertUniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${label} "${id}"`);
    }
    seen.add(id);
  }
}

function assertFindingStatus(finding: FindingRecord, expectedStatus: FindingRecord['status'], action: string): void {
  if (finding.status !== expectedStatus) {
    throw new Error(`Cannot ${action} finding "${finding.id}" because it is not ${expectedStatus}`);
  }
}

function markRawFindingIdsUsed(usedRawFindingIds: Set<string>, rawFindingIds: readonly string[]): void {
  for (const rawFindingId of rawFindingIds) {
    if (usedRawFindingIds.has(rawFindingId)) {
      throw new Error(`Raw finding id "${rawFindingId}" is referenced by multiple manager decisions`);
    }
    usedRawFindingIds.add(rawFindingId);
  }
}

function assertNonEmptyIds(ids: readonly string[], label: string): void {
  if (ids.length === 0) {
    throw new Error(`Manager output must reference at least one ${label}`);
  }
}

function mergeBinarySortedUniqueStrings(
  current: readonly string[],
  next: readonly string[],
): string[] {
  return Array.from(new Set([...current, ...next])).sort(compareBinaryStrings);
}

function bumpRevision(finding: Pick<FindingRecord, 'revision'>): number {
  return finding.revision + 1;
}

function mergeRawFindingDetails(current: readonly RawFinding[], next: readonly RawFinding[]): RawFinding[] {
  assertRawFindingsAppendOnly([], next);
  const byId = new Map<string, RawFinding>();
  for (const rawFinding of current) {
    byId.set(rawFinding.rawFindingId, rawFinding);
  }
  for (const rawFinding of next) {
    byId.set(rawFinding.rawFindingId, rawFinding);
  }
  const merged = [...byId.values()].sort((left, right) => (
    compareBinaryStrings(left.rawFindingId, right.rawFindingId)
  ));
  assertRawFindingsAppendOnly(current, merged);
  return merged;
}

function assertResolvedEvidenceRawFindings(input: {
  finding: FindingRecord;
  resolvedRawFindingIds: readonly string[];
  previousRawFindingsById: ReadonlyMap<string, RawFinding>;
  currentRawFindingsById: ReadonlyMap<string, RawFinding>;
}): void {
  let hasCurrentConfirmation = false;
  for (const rawFindingId of input.resolvedRawFindingIds) {
    const currentRawFinding = input.currentRawFindingsById.get(rawFindingId);
    if (currentRawFinding !== undefined) {
      if (currentRawFinding.relation !== 'resolution_confirmation') {
        throw new Error(
          `Resolved finding "${input.finding.id}" references current raw finding "${rawFindingId}" that is not a resolution_confirmation`,
        );
      }
      if (currentRawFinding.targetFindingId !== input.finding.id) {
        throw new Error(
          `Resolution confirmation "${rawFindingId}" targets "${currentRawFinding.targetFindingId ?? '(none)'}" but was cited for "${input.finding.id}"`,
        );
      }
      hasCurrentConfirmation = true;
      continue;
    }
    if (!input.finding.rawFindingIds.includes(rawFindingId)) {
      throw new Error(`Unknown raw finding id "${rawFindingId}"`);
    }
    if (input.previousRawFindingsById.get(rawFindingId) === undefined) {
      throw new Error(
        `Resolved finding "${input.finding.id}" references previous raw finding "${rawFindingId}" that is not in the ledger`,
      );
    }
  }
  // 解消には現在ラウンドの解消確認が必須（レビュアーの沈黙では解消させない）。
  if (!hasCurrentConfirmation) {
    throw new Error(
      `Resolved finding "${input.finding.id}" requires at least one current resolution_confirmation raw finding targeting it`,
    );
  }
}

function getRawFindings(rawFindings: readonly RawFinding[], rawFindingIds: readonly string[]): RawFinding[] {
  return rawFindingIds.map((rawFindingId) => {
    const rawFinding = rawFindings.find((finding) => finding.rawFindingId === rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(`Raw finding id was validated but not found: ${rawFindingId}`);
    }
    return rawFinding;
  });
}

function canonicalNewFindingKey(
  newFinding: FindingManagerOutput['newFindings'][number],
  rawFindingsById: ReadonlyMap<string, RawFinding>,
): string {
  const rawFindings = newFinding.rawFindingIds.map((rawFindingId) => {
    const rawFinding = rawFindingsById.get(rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(`Unknown raw finding id "${rawFindingId}"`);
    }
    return rawFinding;
  }).sort((left, right) => (
    compareBinaryStrings(canonicalJson(left), canonicalJson(right))
  ));
  return canonicalJson({
    rawFindings,
    severity: newFinding.severity,
    title: newFinding.title,
  });
}

function buildNewFinding(input: {
  id: string;
  rawFindingIds: string[];
  title: string;
  severity: FindingSeverity;
  rawFindings: RawFinding[];
  firstSeenStepName: string;
  context: FindingReconcileContext;
  evidenceIds: string[];
}): FindingRecord {
  const observation = {
    runId: input.context.runId,
    stepName: input.firstSeenStepName,
    timestamp: input.context.timestamp,
  };
  return createProductFindingEntry({
    id: input.id,
    status: 'open',
    lifecycle: 'new',
    target: structuredClone(input.rawFindings[0]!.target),
    targetIdentityHash: input.rawFindings[0]!.targetIdentityHash,
    claimIdentityHash: input.rawFindings[0]!.claimIdentityHash,
    semanticClaimIdentityHash: input.rawFindings[0]!.semanticClaimIdentityHash,
    severity: input.severity,
    title: input.title,
    evidenceIds: input.evidenceIds,
    ...foldRawFindingEvidence(input.rawFindings),
    rawFindingIds: input.rawFindingIds,
    firstSeen: observation,
    lastSeen: observationFromContext(input.context),
    revision: 1,
  });
}

function observationFromContext(context: FindingReconcileContext): FindingObservation {
  return {
    stepName: context.stepName,
    runId: context.runId,
    timestamp: context.timestamp,
  };
}

function withoutResolutionFields(finding: FindingRecord): Omit<FindingRecord, 'resolvedAt' | 'resolvedEvidence'> {
  return {
    id: finding.id,
    status: finding.status,
    lifecycle: finding.lifecycle,
    target: finding.target,
    targetIdentityHash: finding.targetIdentityHash,
    claimIdentityHash: finding.claimIdentityHash,
    semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
    severity: finding.severity,
    title: finding.title,
    evidenceIds: finding.evidenceIds,
    rawFindingIds: finding.rawFindingIds,
    ...(finding.waivers !== undefined ? { waivers: finding.waivers } : {}),
    ...(finding.disputes !== undefined ? { disputes: finding.disputes } : {}),
    ...(finding.description !== undefined ? { description: finding.description } : {}),
    ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
    reviewers: finding.reviewers,
    firstSeen: finding.firstSeen,
    lastSeen: finding.lastSeen,
    ...(finding.reopenedEvidence !== undefined ? { reopenedEvidence: finding.reopenedEvidence } : {}),
    revision: finding.revision,
    ...(finding.provisional !== undefined ? { provisional: finding.provisional } : {}),
    ...(finding.dismissal !== undefined ? { dismissal: finding.dismissal } : {}),
    // rejectedObservations の監査添付履歴も解消情報ではないため保持する。
    ...(finding.rejectedObservations !== undefined ? { rejectedObservations: finding.rejectedObservations } : {}),
  };
}

function withoutConflictResolutionFields(
  conflict: FindingLedgerConflict,
): Omit<FindingLedgerConflict, 'resolvedAt' | 'resolvedEvidence'> {
  return {
    id: conflict.id,
    status: conflict.status,
    findingIds: conflict.findingIds,
    rawFindingIds: conflict.rawFindingIds,
    description: conflict.description,
    firstSeen: conflict.firstSeen,
    lastSeen: conflict.lastSeen,
    ...(conflict.adjudications !== undefined ? { adjudications: conflict.adjudications } : {}),
    revision: conflict.revision,
  };
}

function reconcileLedgerConflicts(input: {
  previousLedger: FindingLedger;
  managerOutput: FindingManagerOutput;
  knownFindingIds: Set<string>;
  rawFindingIds: Set<string>;
  usedRawFindingIds: Set<string>;
  context: FindingReconcileContext;
  rawFindings: readonly RawFinding[];
}): {
  conflicts: FindingLedgerConflict[];
  lifecycleCommands: FindingLifecycleCommand[];
} {
  const conflictsById = new Map(input.previousLedger.conflicts.map((conflict) => [conflict.id, { ...conflict }]));
  const lifecycleCommands: FindingLifecycleCommand[] = [];
  const appendCommand = (
    operation: 'create_conflict' | 'observe_conflict' | 'resolve_conflict',
    conflict: FindingLedgerConflict,
    authority: FindingLifecycleCommand['authority'],
    rawFindingIds: readonly string[],
  ): void => {
    const { revision: _revision, ...projection } = conflict;
    void _revision;
    lifecycleCommands.push({
      operation,
      changes: { findings: [], conflicts: [projection] },
      authority,
      evidenceSourcesByTarget: new Map([[
        `conflict\0${conflict.id}`,
        {
          sourceRawFindingIds: [...rawFindingIds].sort(compareBinaryStrings),
          authorityEvidenceIds: [],
        },
      ]]),
    });
  };

  for (const resolvedConflict of input.managerOutput.resolvedConflicts) {
    assertKnownConflict(conflictsById, resolvedConflict.conflictId);
    const conflict = conflictsById.get(resolvedConflict.conflictId)!;
    if (conflict.status !== 'active') {
      throw new Error(`Cannot resolve conflict "${conflict.id}" because it is not active`);
    }
    const updated: FindingLedgerConflict = {
      ...conflict,
      status: 'resolved',
      resolvedAt: input.context.timestamp,
      resolvedEvidence: resolvedConflict.evidence,
      revision: conflict.revision + 1,
    };
    conflictsById.set(conflict.id, updated);
    appendCommand(
      'resolve_conflict',
      updated,
      {
        kind: 'engine_policy',
        decisionKind: 'resolve_conflict',
        decisionDigest: createHash('sha256')
          .update(canonicalJson(resolvedConflict))
          .digest('hex'),
      },
      [],
    );
  }

  for (const conflict of input.managerOutput.conflicts) {
    if (conflict.findingIds.length === 0) {
      assertNonEmptyIds(conflict.rawFindingIds, 'raw finding id');
    }
    assertUniqueIds(conflict.rawFindingIds, 'raw finding id');
    for (const findingId of conflict.findingIds) {
      assertKnownFinding(input.knownFindingIds, findingId);
    }
    if (conflict.rawFindingIds.length > 0) {
      assertKnownRawFindings(input.rawFindingIds, conflict.rawFindingIds);
      markRawFindingIdsUsed(input.usedRawFindingIds, conflict.rawFindingIds);
    }

    const conflictId = formatConflictId(conflict);
    const existing = conflictsById.get(conflictId);
    const base = existing !== undefined
      ? withoutConflictResolutionFields(existing)
      : {
        id: conflictId,
        status: 'active' as const,
        findingIds: [...conflict.findingIds],
        rawFindingIds: [],
        description: conflict.description,
        firstSeen: observationFromContext(input.context),
        lastSeen: observationFromContext(input.context),
        revision: 1,
      };

    const updated: FindingLedgerConflict = {
      ...base,
      status: 'active',
      rawFindingIds: mergeBinarySortedUniqueStrings(base.rawFindingIds, conflict.rawFindingIds),
      description: conflict.description,
      lastSeen: observationFromContext(input.context),
      revision: existing === undefined ? 1 : existing.revision + 1,
    };
    conflictsById.set(conflictId, updated);
    appendCommand(
      existing === undefined ? 'create_conflict' : 'observe_conflict',
      updated,
      rawFindingLifecycleAuthority({
        operation: existing === undefined ? 'create_conflict' : 'observe_conflict',
        rawFindingIds: conflict.rawFindingIds,
        rawFindings: input.rawFindings,
        adjudications: input.managerOutput.anchorAdjudications,
      }),
      conflict.rawFindingIds,
    );
  }

  return {
    conflicts: [...conflictsById.values()],
    lifecycleCommands,
  };
}

type ManagerOutputValidator = typeof validateFindingManagerOutput;

function rawFindingLifecycleAuthority(input: {
  operation: FindingLifecycleCommand['operation'];
  rawFindingIds: readonly string[];
  rawFindings: readonly RawFinding[];
  adjudications: readonly FindingManagerOutput['anchorAdjudications'][number][];
}): FindingLifecycleCommand['authority'] {
  const ids = new Set(input.rawFindingIds);
  const sourceRawFindings = input.rawFindings.filter((rawFinding) => (
    ids.has(rawFinding.rawFindingId)
  ));
  const absenceRaws = absenceRawFindings(sourceRawFindings);
  if (absenceRaws.length === 0) {
    return { kind: 'verified_evidence' };
  }
  const anchorAdjudications = authorityAnchorAdjudications({
    rawFindingIds: absenceRaws.map((rawFinding) => rawFinding.rawFindingId),
    adjudications: input.adjudications,
  });
  return {
    kind: 'engine_policy',
    decisionKind: 'anchor_relevance',
    anchorAdjudications,
    decisionDigest: computeAnchorRelevanceDecisionDigest({
      operation: input.operation,
      rawFindings: absenceRaws,
      adjudications: anchorAdjudications,
    }),
  };
}

export function reconcileFindingLedger(input: ReconcileFindingLedgerInput): FindingLedger {
  return reconcileFindingLedgerPlan(input).ledger;
}

export interface ReconcileFindingLedgerPlan {
  ledger: FindingLedger;
  lifecycleCommands: FindingLifecycleCommand[];
  entityMutationResults: PreAdmissionEntityMutationResult[];
}

export function reconcileFindingLedgerPlan(
  input: ReconcileFindingLedgerInput,
): ReconcileFindingLedgerPlan {
  assertCanonicalReconcileInput(input);
  return reconcileFindingLedgerWithValidator(input, validateFindingManagerOutput);
}

export function reconcileManagerActionRecovery(input: Pick<
  ReconcileFindingLedgerInput,
  'previousLedger' | 'managerOutput' | 'context'
>): FindingLedger {
  return reconcileFindingLedgerWithValidator(
    {
      ...input,
      rawFindings: [],
      provisionalFindings: [],
      entityProvisionalMutations: [],
      terminalEntityAttachmentFindingIds: new Set(),
      rawFindingDispositions: [],
      rawProvenanceByRawFindingId: new Map(),
      verifiedEvidenceRecordsByRawFindingId: new Map(),
    },
    validateManagerActionRecoveryOutput,
  ).ledger;
}

function assertCanonicalReconcileInput(input: ReconcileFindingLedgerInput): void {
  if (!Array.isArray(input.provisionalFindings)) {
    throw new Error('Reconciler input provisionalFindings must be an explicit array');
  }
  if (!Array.isArray(input.entityProvisionalMutations)) {
    throw new Error('Reconciler input entityProvisionalMutations must be an explicit array');
  }
  if (!(input.terminalEntityAttachmentFindingIds instanceof Set)) {
    throw new Error(
      'Reconciler input terminalEntityAttachmentFindingIds must be an explicit Set',
    );
  }
  if (!Array.isArray(input.rawFindingDispositions)) {
    throw new Error('Reconciler input rawFindingDispositions must be an explicit array');
  }
  if (!(input.rawProvenanceByRawFindingId instanceof Map)) {
    throw new Error('Reconciler input rawProvenanceByRawFindingId must be an explicit Map');
  }
  for (const rawFinding of input.rawFindings) {
    const provenance = input.rawProvenanceByRawFindingId.get(rawFinding.rawFindingId);
    if (provenance === undefined) {
      throw new Error(`Reconciler input is missing canonical provenance for raw finding "${rawFinding.rawFindingId}"`);
    }
    const observedDigest = computeCanonicalRawIntegrityDigest({
      canonicalWire: rawFinding,
      provenance: provenance.canonicalProvenance,
      reviewerStableKey: provenance.reviewerStableKey,
      lineageKey: provenance.lineageKey,
      claimIdentityHash: provenance.claimIdentityHash,
    });
    if (observedDigest !== provenance.canonicalIntegrityDigest) {
      throw new Error(
        `Reconciler input canonical integrity digest does not match raw finding "${rawFinding.rawFindingId}"`,
      );
    }
  }
  assertVerifiedEvidenceBindings(input);
  const knownRawFindingIds = new Set(input.rawFindings.map((rawFinding) => rawFinding.rawFindingId));
  const dispositionRawFindingIds = new Set<string>();
  for (const disposition of input.rawFindingDispositions) {
    if (!knownRawFindingIds.has(disposition.rawFindingId)) {
      throw new Error(`Raw finding disposition references unknown raw finding "${disposition.rawFindingId}"`);
    }
    if (dispositionRawFindingIds.has(disposition.rawFindingId)) {
      throw new Error(`Raw finding "${disposition.rawFindingId}" has multiple dispositions`);
    }
    if (!RAW_FINDING_DISPOSITION_OUTCOMES.includes(disposition.outcome)) {
      throw new Error(`Raw finding disposition has unknown outcome "${disposition.outcome}"`);
    }
    if (disposition.reason.trim().length === 0) {
      throw new Error(`Raw finding disposition "${disposition.rawFindingId}" must include a reason`);
    }
    dispositionRawFindingIds.add(disposition.rawFindingId);
  }
}

function assertVerifiedEvidenceBindings(input: ReconcileFindingLedgerInput): void {
  if (!(input.verifiedEvidenceRecordsByRawFindingId instanceof Map)) {
    throw new Error(
      'Reconciler input verifiedEvidenceRecordsByRawFindingId must be an explicit Map',
    );
  }
  const rawById = new Map(input.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const boundEvidenceRecords = new Map<string, FindingEvidenceRecord>();
  for (const [rawFindingId, records] of input.verifiedEvidenceRecordsByRawFindingId) {
    const raw = rawById.get(rawFindingId);
    if (raw === undefined) {
      throw new Error(
        `Verified evidence binding references unknown current raw finding "${rawFindingId}"`,
      );
    }
    const provenance = input.rawProvenanceByRawFindingId.get(rawFindingId);
    if (provenance === undefined) {
      throw new Error(
        `Verified evidence binding is missing canonical provenance for raw finding "${rawFindingId}"`,
      );
    }
    if (records.length === 0) {
      throw new Error(
        `Verified evidence binding for raw finding "${rawFindingId}" must not be empty`,
      );
    }
    const matchedRawEvidence = new Set<number>();
    for (const record of records) {
      const identityViolation = findingEvidenceRecordIdentityViolation(record);
      if (identityViolation !== undefined) {
        throw new Error(identityViolation);
      }
      const existingRecord = boundEvidenceRecords.get(record.evidenceId);
      if (
        existingRecord !== undefined
        && canonicalJson(existingRecord) !== canonicalJson(record)
      ) {
        throw new Error(
          `Verified evidence record "${record.evidenceId}" has conflicting binding content`,
        );
      }
      boundEvidenceRecords.set(record.evidenceId, record);
      if (record.claimIdentityHash !== provenance.claimIdentityHash) {
        throw new Error(
          `Verified evidence record "${record.evidenceId}" claim identity does not match raw finding "${rawFindingId}"`,
        );
      }
      const evidenceIndex = raw.evidence.findIndex((evidence, index) => (
        !matchedRawEvidence.has(index)
        && evidenceRecordMatchesRawEvidence(record, evidence)
      ));
      if (evidenceIndex < 0) {
        throw new Error(
          `Verified evidence record "${record.evidenceId}" is not bound to raw finding "${rawFindingId}" evidence`,
        );
      }
      matchedRawEvidence.add(evidenceIndex);
    }
    if (matchedRawEvidence.size !== raw.evidence.length) {
      throw new Error(
        `Verified evidence binding for raw finding "${rawFindingId}" has unbound or surplus evidence`,
      );
    }
  }
}

function findingOutcomeRawFindingIds(output: FindingManagerOutput): string[] {
  return [
    ...output.matches.flatMap((entry) => entry.rawFindingIds),
    ...output.newFindings.flatMap((entry) => entry.rawFindingIds),
    ...output.resolvedFindings.flatMap((entry) => entry.rawFindingIds),
    ...output.reopenedFindings.flatMap((entry) => entry.rawFindingIds),
  ];
}

interface RawOutcomeCounts {
  finding: number;
  conflict: number;
  provisionalKinds: FindingProvisionalKind[];
  disposition: number;
}

function assertAuthorizedConflictProvisionalOutcome(input: {
  reconcileInput: ReconcileFindingLedgerInput;
  rawFindingId: string;
}): void {
  const conflicts = input.reconcileInput.managerOutput.conflicts.filter((entry) => (
    entry.rawFindingIds.includes(input.rawFindingId)
  ));
  const provisionalFindings = input.reconcileInput.provisionalFindings.filter((spec) => (
    spec.sourceRawFindingIds.includes(input.rawFindingId)
  ));
  const rawFinding = input.reconcileInput.rawFindings.find((raw) => (
    raw.rawFindingId === input.rawFindingId
  ));
  const provenance = input.reconcileInput.rawProvenanceByRawFindingId.get(input.rawFindingId);
  const authority = provenance?.openConflictOutcomeAuthority;
  if (
    rawFinding === undefined
    || provenance === undefined
    || authority === undefined
  ) {
    throw new Error(
      `Raw finding "${input.rawFindingId}" has an unauthorized conflict + provisional compound outcome`,
    );
  }
  const verification = verifyOpenConflictOutcomeAuthority({
    authority,
    ledger: input.reconcileInput.previousLedger,
    rawFinding,
    conflicts,
    provisionalFindings,
    provenance: {
      reviewerStableKey: provenance.reviewerStableKey,
      lineageKey: provenance.lineageKey,
      claimIdentityHash: provenance.claimIdentityHash,
      canonicalIntegrityDigest: provenance.canonicalIntegrityDigest,
      canonicalProvenance: provenance.canonicalProvenance,
    },
  });
  if (!verification.ok) {
    throw new Error(
      `Raw finding "${input.rawFindingId}" has an unauthorized conflict + provisional compound outcome: ${verification.reason}`,
    );
  }
}

function assertExactlyOneRawOutcome(input: ReconcileFindingLedgerInput): void {
  const knownRawFindingIds = new Set(input.rawFindings.map((rawFinding) => rawFinding.rawFindingId));
  const outcomeCounts = new Map<string, RawOutcomeCounts>(input.rawFindings.map((rawFinding) => [
    rawFinding.rawFindingId,
    { finding: 0, conflict: 0, provisionalKinds: [], disposition: 0 },
  ]));
  const recordKnownOutcome = (
    rawFindingId: string,
    kind: 'finding' | 'conflict' | 'disposition',
  ): void => {
    if (knownRawFindingIds.has(rawFindingId)) {
      const counts = outcomeCounts.get(rawFindingId)!;
      counts[kind] += 1;
    }
  };
  for (const rawFindingId of findingOutcomeRawFindingIds(input.managerOutput)) {
    recordKnownOutcome(rawFindingId, 'finding');
  }
  for (const rawFindingId of input.managerOutput.conflicts.flatMap((entry) => entry.rawFindingIds)) {
    recordKnownOutcome(rawFindingId, 'conflict');
  }
  for (const spec of input.provisionalFindings) {
    for (const rawFindingId of spec.sourceRawFindingIds) {
      if (!knownRawFindingIds.has(rawFindingId)) {
        throw new Error(`Provisional outcome references unknown raw finding "${rawFindingId}"`);
      }
      outcomeCounts.get(rawFindingId)!.provisionalKinds.push(spec.kind);
    }
  }
  for (const mutation of input.entityProvisionalMutations) {
    for (const rawFindingId of mutation.sourceRawFindingIds) {
      if (!knownRawFindingIds.has(rawFindingId)) {
        throw new Error(
          `Entity provisional outcome references unknown raw finding "${rawFindingId}"`,
        );
      }
      outcomeCounts.get(rawFindingId)!.provisionalKinds.push(
        mutation.operation === 'create_new'
          ? mutation.provisionalKind
          : mutation.expectedKind,
      );
    }
  }
  for (const disposition of input.rawFindingDispositions) {
    recordKnownOutcome(disposition.rawFindingId, 'disposition');
  }
  for (const [rawFindingId, counts] of outcomeCounts) {
    const count = counts.finding + counts.conflict + counts.provisionalKinds.length + counts.disposition;
    if (count === 0) {
      throw new Error(`Raw finding "${rawFindingId}" has no explicit reconcile outcome`);
    }
    const hasConflictProvisionalClaim = counts.finding === 0
      && counts.conflict > 0
      && counts.provisionalKinds.includes('raw-meaning-ambiguous')
      && counts.disposition === 0;
    if (hasConflictProvisionalClaim) {
      assertAuthorizedConflictProvisionalOutcome({
        reconcileInput: input,
        rawFindingId,
      });
    }
    const isConflictProvisionalOutcome = counts.conflict === 1
      && counts.provisionalKinds.length === 1
      && hasConflictProvisionalClaim;
    if (count > 1 && !isConflictProvisionalOutcome) {
      throw new Error(
        `Raw finding "${rawFindingId}" must have exactly one reconcile outcome; received ${count} (multiple explicit reconcile outcomes)`,
      );
    }
  }
}

function reconcileFindingLedgerWithValidator(
  input: ReconcileFindingLedgerInput,
  validateOutput: ManagerOutputValidator,
): ReconcileFindingLedgerPlan {
  const validation = validateOutput({
    previousLedger: input.previousLedger,
    rawFindings: input.rawFindings,
    managerOutput: input.managerOutput,
    priorStepResponseText: input.priorStepResponseText,
  });
  if (!validation.ok) {
    throw new Error(validation.errors.join('\n'));
  }
  assertExactlyOneRawOutcome(input);
  const rawFindingIds = new Set(input.rawFindings.map((finding) => finding.rawFindingId));
  assertUniqueIds(input.rawFindings.map((finding) => finding.rawFindingId), 'raw finding id');
  assertFindingLedgerProjectionInvariant(input.previousLedger);
  const previousById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const previousRawFindingsById = new Map(input.previousLedger.rawFindings.map((finding) => [
    finding.rawFindingId,
    finding,
  ]));
  const knownFindingIds = new Set(previousById.keys());
  const currentRawFindingsById = new Map(input.rawFindings.map((finding) => [finding.rawFindingId, finding]));
  let nextId = input.previousLedger.nextId;
  const usedRawFindingIds = new Set<string>();

  const updatedById = new Map<string, FindingRecord>(
    input.previousLedger.findings.map((finding) => [finding.id, { ...finding }]),
  );
  const lifecycleCommands: FindingLifecycleCommand[] = [];
  const findingCommand = (
    operation: FindingLifecycleCommand['operation'],
    findings: readonly FindingRecord[],
    authority: FindingLifecycleCommand['authority'],
    sources: ReadonlyMap<string, LifecycleEvidenceSource>,
  ): void => {
    lifecycleCommands.push({
      operation,
      changes: {
        findings: findings.map((finding) => {
          const { revision: _revision, ...projection } = finding;
          void _revision;
          return projection;
        }),
        conflicts: [],
      },
      authority,
      evidenceSourcesByTarget: sources,
    });
  };
  const verifiedFindingSources = (
    findingIds: readonly string[],
    rawFindingIds: readonly string[],
  ): Map<string, LifecycleEvidenceSource> => new Map(findingIds.map((findingId) => [
    `finding\0${findingId}`,
    {
      sourceRawFindingIds: [...rawFindingIds].sort(compareBinaryStrings),
      authorityEvidenceIds: [],
    },
  ]));
  const policyAuthority = (
    decisionKind: 'waive' | 'dispute' | 'dismiss' | 'semantic_duplicate',
    decision: unknown,
  ): FindingLifecycleCommand['authority'] => ({
    kind: 'engine_policy',
    decisionKind,
    decisionDigest: createHash('sha256').update(canonicalJson(decision)).digest('hex'),
  });

  for (const match of input.managerOutput.matches) {
    assertKnownFinding(knownFindingIds, match.findingId);
    assertKnownRawFindings(rawFindingIds, match.rawFindingIds);
    markRawFindingIdsUsed(usedRawFindingIds, match.rawFindingIds);
    const finding = updatedById.get(match.findingId)!;
    assertFindingStatus(finding, 'open', 'match');
    const matchedRawFindings = getRawFindings(input.rawFindings, match.rawFindingIds);
    const evidence = foldFindingObservation({
      finding,
      rawFindings: matchedRawFindings,
      observation: observationFromContext(input.context),
    });
    const updated: FindingRecord = {
      ...finding,
      status: 'open',
      lifecycle: finding.lifecycle === 'reopened' ? 'reopened' : 'persists',
      revision: bumpRevision(finding),
      evidenceIds: mergeBinarySortedUniqueStrings(
        finding.evidenceIds,
        evidenceIdsForRawFindings(
          match.rawFindingIds,
          input.verifiedEvidenceRecordsByRawFindingId,
        ),
      ),
      ...evidence,
    };
    updatedById.set(match.findingId, updated);
    findingCommand(
      'persist_finding',
      [updated],
      rawFindingLifecycleAuthority({
        operation: 'persist_finding',
        rawFindingIds: match.rawFindingIds,
        rawFindings: input.rawFindings,
        adjudications: input.managerOutput.anchorAdjudications,
      }),
      verifiedFindingSources([match.findingId], match.rawFindingIds),
    );
  }

  for (const resolved of input.managerOutput.resolvedFindings) {
    assertKnownFinding(knownFindingIds, resolved.findingId);
    const finding = updatedById.get(resolved.findingId)!;
    assertFindingStatus(finding, 'open', 'resolve');
    assertResolvedEvidenceRawFindings({
      finding,
      resolvedRawFindingIds: resolved.rawFindingIds,
      previousRawFindingsById,
      currentRawFindingsById,
    });
    markRawFindingIdsUsed(
      usedRawFindingIds,
      resolved.rawFindingIds.filter((rawFindingId) => currentRawFindingsById.has(rawFindingId)),
    );
    const updated: FindingRecord = {
      ...finding,
      status: 'resolved',
      lifecycle: 'resolved',
      revision: bumpRevision(finding),
      rawFindingIds: mergeBinarySortedUniqueStrings(finding.rawFindingIds, resolved.rawFindingIds),
      evidenceIds: mergeBinarySortedUniqueStrings(
        finding.evidenceIds,
        evidenceIdsForRawFindings(
          resolved.rawFindingIds,
          input.verifiedEvidenceRecordsByRawFindingId,
        ),
      ),
      reviewers: mergeBinarySortedUniqueStrings(
        finding.reviewers,
        getRawFindings(
          input.rawFindings,
          resolved.rawFindingIds.filter((rawFindingId) => currentRawFindingsById.has(rawFindingId)),
        ).map((raw) => raw.reviewer),
      ),
      lastSeen: observationFromContext(input.context),
      resolvedAt: input.context.timestamp,
      resolvedEvidence: resolved.evidence,
    };
    updatedById.set(resolved.findingId, updated);
    findingCommand(
      'resolve_finding',
      [updated],
      rawFindingLifecycleAuthority({
        operation: 'resolve_finding',
        rawFindingIds: resolved.rawFindingIds,
        rawFindings: input.rawFindings,
        adjudications: input.managerOutput.anchorAdjudications,
      }),
      verifiedFindingSources([resolved.findingId], resolved.rawFindingIds),
    );
  }

  for (const reopened of input.managerOutput.reopenedFindings) {
    assertKnownFinding(knownFindingIds, reopened.findingId);
    assertKnownRawFindings(rawFindingIds, reopened.rawFindingIds);
    markRawFindingIdsUsed(usedRawFindingIds, reopened.rawFindingIds);
    const finding = updatedById.get(reopened.findingId)!;
    if (finding.status !== 'resolved' && finding.status !== 'waived' && finding.status !== 'dismissed') {
      throw new Error(`Cannot reopen finding "${finding.id}" because it is not resolved, waived, or dismissed`);
    }
    const reopenedRawFindings = getRawFindings(input.rawFindings, reopened.rawFindingIds);
    const evidence = foldFindingObservation({
      finding,
      rawFindings: reopenedRawFindings,
      observation: observationFromContext(input.context),
    });
    let reopenedBase: FindingRecord = finding;
    if (finding.status === 'dismissed' && isProvisionalFindingEntry(finding)) {
      for (const rawFinding of reopenedRawFindings) {
        if (!isProvisionalReopenSource({
          ledger: input.previousLedger,
          provisional: finding,
          wire: rawFinding,
        })) {
          throw new Error(
            `Dismissed provisional finding "${finding.id}" has an ineligible reopen source "${rawFinding.rawFindingId}"`,
          );
        }
      }
      const materialized = materializeProvisionalFinding({
        ledger: input.previousLedger,
        finding,
        transitionRawFindings: reopenedRawFindings,
      });
      if (materialized.outcome === 'materialized') {
        reopenedBase = materialized.finding;
      }
    }
    const reopenedFinding = withoutResolutionFields(reopenedBase);
    const updated: FindingRecord = {
      ...reopenedFinding,
      status: 'open',
      lifecycle: 'reopened',
      revision: bumpRevision(finding),
      evidenceIds: mergeBinarySortedUniqueStrings(
        finding.evidenceIds,
        evidenceIdsForRawFindings(
          reopened.rawFindingIds,
          input.verifiedEvidenceRecordsByRawFindingId,
        ),
      ),
      ...evidence,
      reopenedEvidence: reopened.evidence,
    };
    updatedById.set(reopened.findingId, updated);
    findingCommand(
      'reopen_finding',
      [updated],
      rawFindingLifecycleAuthority({
        operation: 'reopen_finding',
        rawFindingIds: reopened.rawFindingIds,
        rawFindings: input.rawFindings,
        adjudications: input.managerOutput.anchorAdjudications,
      }),
      verifiedFindingSources([reopened.findingId], reopened.rawFindingIds),
    );
  }

  for (const waived of input.managerOutput.waivedFindings) {
    assertKnownFinding(knownFindingIds, waived.findingId);
    const finding = updatedById.get(waived.findingId)!;
    assertFindingStatus(finding, 'open', 'waive');
    if (finding.severity === 'critical') {
      throw new Error(`Cannot waive finding "${finding.id}" because critical findings must stay open`);
    }
    const updated: FindingRecord = {
      ...finding,
      status: 'waived',
      lifecycle: 'waived',
      revision: bumpRevision(finding),
      waivers: [
        ...(finding.waivers ?? []),
        { reason: waived.reason, evidence: waived.evidence, decidedAt: observationFromContext(input.context) },
      ],
      lastSeen: observationFromContext(input.context),
    };
    updatedById.set(waived.findingId, updated);
    findingCommand(
      'waive_finding',
      [updated],
      policyAuthority('waive', waived),
      verifiedFindingSources([waived.findingId], []),
    );
  }

  for (const note of input.managerOutput.disputeNotes) {
    assertKnownFinding(knownFindingIds, note.findingId);
    const finding = updatedById.get(note.findingId)!;
    assertFindingStatus(finding, 'open', 'record a dispute on');
    // 却下された異議は記録のみ: status は open のまま（ゲートを塞ぎ続ける）
    const updated: FindingRecord = {
      ...finding,
      revision: bumpRevision(finding),
      disputes: [
        ...(finding.disputes ?? []),
        { reason: note.reason, evidence: note.evidence, recordedAt: observationFromContext(input.context) },
      ],
    };
    updatedById.set(note.findingId, updated);
    findingCommand(
      'record_dispute',
      [updated],
      policyAuthority('dispute', note),
      verifiedFindingSources([note.findingId], []),
    );
  }

  // invalidate はエンジンが decision-assembly.ts / manager-runner.ts で既に
  // 決定的検証済みの候補だけを通してくる。critical でも invalidate 可能
  // （waive とは異なりブロック対象にしない — 前提事実が成立しないという主張）。
  for (const invalidated of input.managerOutput.invalidatedFindings) {
    assertKnownFinding(knownFindingIds, invalidated.findingId);
    const finding = updatedById.get(invalidated.findingId)!;
    assertFindingStatus(finding, 'open', 'invalidate');
    const updated: FindingRecord = {
      ...finding,
      status: 'invalidated',
      lifecycle: 'invalidated',
      revision: bumpRevision(finding),
      invalidatedAt: input.context.timestamp,
      invalidatedEvidence: invalidated.evidence,
    };
    updatedById.set(invalidated.findingId, updated);
    findingCommand(
      'invalidate_finding',
      [updated],
      { kind: 'verified_evidence' },
      verifiedFindingSources([invalidated.findingId], []),
    );
  }

  // dismiss はエンジンが decision-assembly.ts で候補集合（open な provisional
  // かつ DISMISSABLE_PROVISIONAL_KINDS）と照合済みの裁定だけを通してくる。
  // 監査記録（basis / reason / decidedAt）を残して終端し、黙って消さない。
  for (const dismissed of input.managerOutput.dismissedFindings) {
    assertKnownFinding(knownFindingIds, dismissed.findingId);
    const finding = updatedById.get(dismissed.findingId)!;
    assertFindingStatus(finding, 'open', 'dismiss');
    if (finding.provisional === undefined) {
      throw new Error(`Cannot dismiss finding "${dismissed.findingId}" because it is not provisional`);
    }
    const updated: FindingRecord = {
      ...finding,
      status: 'dismissed',
      lifecycle: 'dismissed',
      revision: bumpRevision(finding),
      dismissal: {
        basis: dismissed.basis,
        reason: dismissed.reason,
        decidedAt: observationFromContext(input.context),
      },
    };
    updatedById.set(dismissed.findingId, updated);
    findingCommand(
      'dismiss_finding',
      [updated],
      policyAuthority('dismiss', dismissed),
      verifiedFindingSources([dismissed.findingId], []),
    );
  }

  // duplicateDecisions: duplicate 側の rawFindingIds/reviewers/disputes を
  // canonical へ統合し、duplicate を superseded にする。証拠レコード自体と
  // duplicate 側の evidenceIds は監査のため保持し、canonical には全 duplicate
  // の evidenceIds を binary-sorted set union する。canonical 自身は
  // open のまま（他の決定でこのラウンド中に状態が変わっていればそちらが優先）。
  // resolved/waived への流用は無い — 「重複だった」は「修正済み」とは別の意味。
  for (const duplicate of input.managerOutput.duplicateFindings) {
    assertKnownFinding(knownFindingIds, duplicate.canonicalFindingId);
    const canonical = updatedById.get(duplicate.canonicalFindingId)!;
    let mergedRawFindingIds = canonical.rawFindingIds;
    let mergedReviewers = canonical.reviewers;
    let mergedDisputes = canonical.disputes;
    let mergedEvidenceIds = canonical.evidenceIds;
    for (const duplicateFindingId of duplicate.duplicateFindingIds) {
      assertKnownFinding(knownFindingIds, duplicateFindingId);
      const duplicateFinding = updatedById.get(duplicateFindingId)!;
      assertFindingStatus(duplicateFinding, 'open', 'supersede');
      mergedRawFindingIds = mergeBinarySortedUniqueStrings(
        mergedRawFindingIds,
        duplicateFinding.rawFindingIds,
      );
      mergedReviewers = mergeBinarySortedUniqueStrings(
        mergedReviewers,
        duplicateFinding.reviewers,
      );
      mergedDisputes = [...(mergedDisputes ?? []), ...(duplicateFinding.disputes ?? [])];
      mergedEvidenceIds = mergeBinarySortedUniqueStrings(
        mergedEvidenceIds,
        duplicateFinding.evidenceIds,
      );
      updatedById.set(duplicateFindingId, {
        ...duplicateFinding,
        status: 'superseded',
        lifecycle: 'superseded',
        revision: bumpRevision(duplicateFinding),
        supersededByFindingId: duplicate.canonicalFindingId,
      });
    }
    const canonicalCurrent = updatedById.get(duplicate.canonicalFindingId)!;
    updatedById.set(duplicate.canonicalFindingId, {
      ...canonicalCurrent,
      revision: bumpRevision(canonicalCurrent),
      rawFindingIds: mergedRawFindingIds,
      reviewers: mergedReviewers,
      evidenceIds: mergedEvidenceIds,
      ...(mergedDisputes !== undefined && mergedDisputes.length > 0 ? { disputes: mergedDisputes } : {}),
      lastSeen: observationFromContext(input.context),
    });
    const duplicateFindingIds = [
      duplicate.canonicalFindingId,
      ...duplicate.duplicateFindingIds,
    ];
    findingCommand(
      'supersede_findings',
      duplicateFindingIds.map((findingId) => updatedById.get(findingId)!),
      policyAuthority('semantic_duplicate', duplicate),
      verifiedFindingSources(duplicateFindingIds, []),
    );
  }

  const orderedNewFindings = [...input.managerOutput.newFindings].sort((left, right) => (
    compareBinaryStrings(
      canonicalNewFindingKey(left, currentRawFindingsById),
      canonicalNewFindingKey(right, currentRawFindingsById),
    )
  ));
  const newFindings: FindingRecord[] = orderedNewFindings.map((newFinding) => {
    assertKnownRawFindings(rawFindingIds, newFinding.rawFindingIds);
    markRawFindingIdsUsed(usedRawFindingIds, newFinding.rawFindingIds);
    const newRawFindings = getRawFindings(input.rawFindings, newFinding.rawFindingIds);
    const primaryRawFinding = selectPrimaryRawFinding(newRawFindings);
    const id = formatFindingId(nextId);
    nextId += 1;
    const created = buildNewFinding({
      id,
      severity: newFinding.severity,
      title: newFinding.title,
      rawFindingIds: mergeBinarySortedUniqueStrings([], newFinding.rawFindingIds),
      rawFindings: newRawFindings,
      firstSeenStepName: primaryRawFinding.stepName,
      context: input.context,
      evidenceIds: evidenceIdsForRawFindings(
        newFinding.rawFindingIds,
        input.verifiedEvidenceRecordsByRawFindingId,
      ),
    });
    findingCommand(
      'create_finding',
      [created],
      rawFindingLifecycleAuthority({
        operation: 'create_finding',
        rawFindingIds: newFinding.rawFindingIds,
        rawFindings: input.rawFindings,
        adjudications: input.managerOutput.anchorAdjudications,
      }),
      verifiedFindingSources([created.id], newFinding.rawFindingIds),
    );
    return created;
  });

  const conflictPlan = reconcileLedgerConflicts({
    previousLedger: input.previousLedger,
    managerOutput: input.managerOutput,
    knownFindingIds,
    rawFindingIds,
    usedRawFindingIds,
    context: input.context,
    rawFindings: input.rawFindings,
  });
  lifecycleCommands.push(...conflictPlan.lifecycleCommands);
  const conflicts = conflictPlan.conflicts;

  const provisionalSpecs = input.provisionalFindings;
  const provisionalBeforeById = new Map(
    [...updatedById.entries()].map(([id, finding]) => [
      id,
      canonicalJson(JSON.parse(JSON.stringify(finding))),
    ]),
  );
  const provisionalNewFindings = applyProvisionalFindingSpecs({
    updatedById,
    ledger: input.previousLedger,
    specs: provisionalSpecs,
    allocateId: () => {
      const id = formatFindingId(nextId);
      nextId += 1;
      return id;
    },
    context: input.context,
  });
  const provisionalChanges = [
    ...[...updatedById.values()].filter((finding) => (
      finding.provisional !== undefined
      && provisionalBeforeById.get(finding.id)
        !== canonicalJson(JSON.parse(JSON.stringify(finding)))
    )),
    ...provisionalNewFindings,
  ];
  const entityMutationApplication = applyPreAdmissionEntityProvisionalMutations({
    updatedById,
    ledger: input.previousLedger,
    mutations: input.entityProvisionalMutations,
    terminalAttachmentFindingIds: input.terminalEntityAttachmentFindingIds,
    alreadyUpdatedFindingIds: new Set(
      provisionalChanges.map((finding) => finding.id),
    ),
    allocateId: () => {
      const id = formatFindingId(nextId);
      nextId += 1;
      return id;
    },
    context: input.context,
  });
  const provisionalChangesById = new Map(
    [...provisionalChanges, ...entityMutationApplication.changes]
      .map((finding) => [finding.id, finding]),
  );
  for (const finding of [...provisionalChangesById.values()]
    .sort((left, right) => compareBinaryStrings(left.id, right.id))) {
    findingCommand(
      'update_provisional',
      [finding],
      { kind: 'verified_evidence' },
      verifiedFindingSources([finding.id], []),
    );
  }

  const ledger: FindingLedger = {
    workflowName: input.context.workflowName,
    nextId,
    updatedAt: input.context.timestamp,
    findings: [...updatedById.values(), ...newFindings, ...provisionalNewFindings]
      .map((finding) => createFindingLedgerEntry(finding))
      .sort((left, right) => compareBinaryStrings(left.id, right.id)),
    evidenceRecords: mergeEvidenceRecords(
      input.previousLedger.evidenceRecords,
      input.verifiedEvidenceRecordsByRawFindingId,
    ),
    evidenceBindings: input.previousLedger.evidenceBindings,
    lifecycleReservations: input.previousLedger.lifecycleReservations,
    lifecycleEvents: input.previousLedger.lifecycleEvents,
    rawRecoveryAttempts: input.previousLedger.rawRecoveryAttempts,
    rawRecoveryResults: input.previousLedger.rawRecoveryResults,
    rawFindings: mergeRawFindingDetails(input.previousLedger.rawFindings, input.rawFindings),
    conflicts: [...conflicts].sort((left, right) => compareBinaryStrings(left.id, right.id)),
    interpretations: input.previousLedger.interpretations,
    ...(input.previousLedger.reviewerAnomalies !== undefined
      ? { reviewerAnomalies: input.previousLedger.reviewerAnomalies }
      : {}),
  };
  return {
    ledger,
    lifecycleCommands,
    entityMutationResults: entityMutationApplication.results,
  };
}

/**
 * reconcile 済みの台帳へ provisional spec を追加適用する。証跡不成立 persists の
 * 添付判断は reconcile 後の台帳に対して行うため、その時点で target が閉じていた分は
 * reconcile の provisionalFindings ではなくこの関数で upsert する。更新則は
 * applyProvisionalFindingSpecs と同一（同じ stableKey の open provisional へ
 * upsert、無ければ新規 ID を採番）。
 */
export function applyProvisionalFindingSpecsToLedger(
  ledger: FindingLedger,
  specs: readonly ProvisionalFindingSpec[],
  context: FindingReconcileContext,
): FindingLedger {
  if (specs.length === 0) {
    return ledger;
  }
  const updatedById = new Map<string, FindingRecord>(
    ledger.findings.map((finding) => [finding.id, { ...finding }]),
  );
  let nextId = ledger.nextId;
  const created = applyProvisionalFindingSpecs({
    updatedById,
    ledger,
    specs,
    allocateId: () => {
      const id = formatFindingId(nextId);
      nextId += 1;
      return id;
    },
    context,
  });
  return {
    ...ledger,
    nextId,
    updatedAt: context.timestamp,
    findings: [...updatedById.values(), ...created]
      .sort((left, right) => compareBinaryStrings(left.id, right.id)),
  };
}

type EntityAttachMutation = Extract<
  PreAdmissionEntityProvisionalMutation,
  { operation: 'attach_existing' }
>;

type EntityCreateMutation = Extract<
  PreAdmissionEntityProvisionalMutation,
  { operation: 'create_new' }
>;

function normalizeEntityAttachMutations(
  mutations: readonly EntityAttachMutation[],
): EntityAttachMutation[] {
  const byFindingId = new Map<string, EntityAttachMutation[]>();
  for (const mutation of mutations) {
    byFindingId.set(
      mutation.findingId,
      [...(byFindingId.get(mutation.findingId) ?? []), mutation],
    );
  }
  return [...byFindingId.entries()]
    .sort(([left], [right]) => compareBinaryStrings(left, right))
    .map(([findingId, grouped]) => {
      const expected = grouped[0];
      if (expected === undefined) {
        throw new Error(`Pre-admission entity attachment group "${findingId}" is empty`);
      }
      if (grouped.some((mutation) => (
        mutation.expectedKind !== expected.expectedKind
        || mutation.expectedStableKey !== expected.expectedStableKey
        || mutation.expectedLineageKey !== expected.expectedLineageKey
      ))) {
        throw new Error(
          `Pre-admission entity attachment declarations disagree for finding "${findingId}"`,
        );
      }
      return {
        ...expected,
        sourceRawFindingIds: mergeBinarySortedUniqueStrings(
          [],
          grouped.flatMap((mutation) => mutation.sourceRawFindingIds),
        ),
        reviewers: mergeBinarySortedUniqueStrings(
          [],
          grouped.flatMap((mutation) => mutation.reviewers),
        ),
        reason: [...new Set(grouped.map((mutation) => mutation.reason))]
          .sort(compareBinaryStrings)
          .join('; '),
      };
    });
}

function entityCreateCommitOrderKey(mutation: EntityCreateMutation): string {
  return canonicalJson({
    provisionalKind: mutation.provisionalKind,
    target: mutation.target,
    targetIdentityHash: mutation.targetIdentityHash,
    claimIdentityHash: mutation.claimIdentityHash,
    semanticClaimIdentityHash: mutation.semanticClaimIdentityHash,
    title: mutation.title,
    severity: mutation.severity,
    description: mutation.description ?? null,
    suggestion: mutation.suggestion ?? null,
  });
}

function normalizeEntityMutations(
  mutations: readonly PreAdmissionEntityProvisionalMutation[],
): {
  attaches: EntityAttachMutation[];
  creates: EntityCreateMutation[];
} {
  const attaches = normalizeEntityAttachMutations(
    mutations.filter((mutation): mutation is EntityAttachMutation => (
      mutation.operation === 'attach_existing'
    )),
  );
  const creates = mutations
    .filter((mutation): mutation is EntityCreateMutation => (
      mutation.operation === 'create_new'
    ))
    .map((mutation) => ({
      mutation,
      orderKey: entityCreateCommitOrderKey(mutation),
    }))
    .sort((left, right) => compareBinaryStrings(left.orderKey, right.orderKey))
    .map(({ mutation }) => mutation);
  return { attaches, creates };
}

function applyPreAdmissionEntityProvisionalMutations(input: {
  updatedById: Map<string, FindingRecord>;
  ledger: FindingLedger;
  mutations: readonly PreAdmissionEntityProvisionalMutation[];
  terminalAttachmentFindingIds: ReadonlySet<string>;
  alreadyUpdatedFindingIds: ReadonlySet<string>;
  allocateId: () => string;
  context: FindingReconcileContext;
}): {
  changes: FindingRecord[];
  results: PreAdmissionEntityMutationResult[];
} {
  const changes: FindingRecord[] = [];
  const results: PreAdmissionEntityMutationResult[] = [];
  const creationRequestKeys = new Set<string>();
  const observation = observationFromContext(input.context);
  const normalized = normalizeEntityMutations(input.mutations);
  for (const mutation of normalized.attaches) {
    const existing = input.updatedById.get(mutation.findingId);
    const original = input.ledger.findings.find(
      (finding) => finding.id === mutation.findingId,
    );
    if (existing === undefined) {
      throw new Error(
        `Pre-admission entity attachment target "${mutation.findingId}" is missing`,
      );
    }
    if (
      input.terminalAttachmentFindingIds.has(existing.id)
      || existing.status !== 'open'
      || existing.provisional?.kind !== 'raw-meaning-ambiguous'
    ) {
      results.push({
        outcome: 'terminal_audit',
        targetFindingId: existing.id,
        sourceRawFindingIds: mutation.sourceRawFindingIds,
        reason: mutation.reason,
      });
      continue;
    }
    if (
      original?.status !== 'open'
      || original.provisional?.kind !== mutation.expectedKind
      || original.provisional.stableKey !== mutation.expectedStableKey
      || original.provisional.lineageKey !== mutation.expectedLineageKey
    ) {
      throw new Error(
        `Pre-admission entity attachment precondition failed for finding "${mutation.findingId}"`,
      );
    }
    const updated = createProvisionalFindingEntry({
      ...existing,
      lifecycle: 'persists',
      revision: input.alreadyUpdatedFindingIds.has(existing.id)
        ? existing.revision
        : bumpRevision(existing),
      rawFindingIds: mergeBinarySortedUniqueStrings(
        existing.rawFindingIds,
        mutation.sourceRawFindingIds,
      ),
      reviewers: mergeBinarySortedUniqueStrings(
        existing.reviewers,
        mutation.reviewers,
      ),
      lastSeen: observation,
      provisional: {
        ...existing.provisional,
        sourceRawFindingIds: mergeBinarySortedUniqueStrings(
          existing.provisional.sourceRawFindingIds,
          mutation.sourceRawFindingIds,
        ),
        reason: `${existing.provisional.reason}; ${mutation.reason}`,
        lastObservedAt: observation,
      },
    });
    input.updatedById.set(updated.id, updated);
    changes.push(updated);
    results.push({
      outcome: 'applied_provisional',
      findingId: updated.id,
      mutation,
    });
  }
  for (const mutation of normalized.creates) {
    if (creationRequestKeys.has(mutation.creationRequestKey)) {
      throw new Error(
        `Duplicate pre-admission entity creation request "${mutation.creationRequestKey}"`,
      );
    }
    creationRequestKeys.add(mutation.creationRequestKey);
    const findingId = input.allocateId();
    const stableKey = entityBindingDigest(
      'finding-provisional-entity-v1',
      findingId,
    );
    const lineageKey = entityBindingDigest(
      'finding-provisional-lineage-v1',
      findingId,
    );
    const created = createProvisionalFindingEntry({
      id: findingId,
      status: 'open',
      lifecycle: 'new',
      target: mutation.target,
      targetIdentityHash: mutation.targetIdentityHash,
      claimIdentityHash: mutation.claimIdentityHash,
      semanticClaimIdentityHash: mutation.semanticClaimIdentityHash,
      severity: mutation.severity,
      title: mutation.title,
      evidenceIds: [],
      ...(mutation.description !== undefined
        ? { description: mutation.description }
        : {}),
      ...(mutation.suggestion !== undefined
        ? { suggestion: mutation.suggestion }
        : {}),
      reviewers: [...mutation.reviewers],
      rawFindingIds: [...mutation.sourceRawFindingIds],
      firstSeen: observation,
      lastSeen: observation,
      revision: 1,
      provisional: {
        kind: mutation.provisionalKind,
        stableKey,
        lineageKey,
        sourceRawFindingIds: [...mutation.sourceRawFindingIds],
        reason: mutation.reason,
        firstObservedAt: observation,
        lastObservedAt: observation,
        interpretationEpochs: 0,
        gateEffect: 'block',
        firstObservedRound: stopBudgetRoundsCompleted(input.ledger) + 1,
      },
    });
    input.updatedById.set(created.id, created);
    changes.push(created);
    results.push({
      outcome: 'applied_provisional',
      findingId: created.id,
      mutation,
    });
  }
  return { changes, results };
}

export function applyPreAdmissionEntityProvisionalMutationsToLedger(
  ledger: FindingLedger,
  mutations: readonly PreAdmissionEntityProvisionalMutation[],
  context: FindingReconcileContext,
): FindingLedger {
  if (mutations.length === 0) {
    return ledger;
  }
  const updatedById = new Map<string, FindingRecord>(
    ledger.findings.map((finding) => [finding.id, structuredClone(finding)]),
  );
  let nextId = ledger.nextId;
  applyPreAdmissionEntityProvisionalMutations({
    updatedById,
    ledger,
    mutations,
    terminalAttachmentFindingIds: new Set(),
    alreadyUpdatedFindingIds: new Set(),
    allocateId: () => {
      const id = formatFindingId(nextId);
      nextId += 1;
      return id;
    },
    context,
  });
  return {
    ...ledger,
    nextId,
    updatedAt: context.timestamp,
    findings: [...updatedById.values()]
      .map((finding) => createFindingLedgerEntry(finding))
      .sort((left, right) => compareBinaryStrings(left.id, right.id)),
  };
}

/**
 * provisional spec を台帳へ適用する。
 *
 * - 同じ stableKey の open provisional が既にあれば同一 ID を更新する（新しい
 *   finding ID を作らない）: rawFindingIds / reason / lastSeen を更新し、
 *   revision += 1、lifecycle は 'persists'。
 * - 無ければ新規 open finding を provisional メタデータ付きで作る。
 * - 「現在のラウンドで観測されなかった」だけでは resolve しない（この関数は既存 provisional
 *   に一切触れない — 解消は clean な後続 raw の CAS 経路だけが行う）。
 */
function applyProvisionalFindingSpecs(input: {
  updatedById: Map<string, FindingRecord>;
  ledger: FindingLedger;
  specs: readonly ProvisionalFindingSpec[];
  allocateId: () => string;
  context: FindingReconcileContext;
}): FindingRecord[] {
  const observation = observationFromContext(input.context);
  const openProvisionalByStableKey = new Map<string, string>();
  for (const finding of input.updatedById.values()) {
    if (finding.status === 'open' && finding.provisional !== undefined) {
      openProvisionalByStableKey.set(finding.provisional.stableKey, finding.id);
    }
  }
  const createdByStableKey = new Map<string, FindingRecord>();

  const orderedSpecs = [...input.specs].sort((left, right) => (
    compareBinaryStrings(left.stableKey, right.stableKey)
    || compareCanonicalJsonValues(left, right)
  ));
  for (const spec of orderedSpecs) {
    const existingId = openProvisionalByStableKey.get(spec.stableKey);
    if (existingId !== undefined) {
      const existing = input.updatedById.get(existingId)!;
      if (!isProvisionalFindingEntry(existing)) {
        throw new Error(`Finding "${existing.id}" is not provisional`);
      }
      const claim = mergeProvisionalClaimProjection(existing, {
        severity: spec.severity,
        title: spec.title,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        ...(spec.suggestion !== undefined ? { suggestion: spec.suggestion } : {}),
        ...(spec.target !== undefined ? {
          target: spec.target,
          targetIdentityHash: spec.targetIdentityHash,
          claimIdentityHash: spec.claimIdentityHash,
          semanticClaimIdentityHash: spec.semanticClaimIdentityHash,
        } : {}),
      });
      input.updatedById.set(existingId, createProvisionalFindingEntry({
        ...claim,
        lifecycle: 'persists',
        rawFindingIds: mergeBinarySortedUniqueStrings(existing.rawFindingIds, spec.sourceRawFindingIds),
        reviewers: Array.from(new Set([...existing.reviewers, ...spec.reviewers])),
        lastSeen: observation,
        revision: bumpRevision(existing),
        provisional: {
          ...existing.provisional!,
          sourceRawFindingIds: mergeBinarySortedUniqueStrings(
            existing.provisional!.sourceRawFindingIds,
            spec.sourceRawFindingIds,
          ),
          reason: spec.reason,
          lastObservedAt: observation,
          interpretationEpochs: countInterpretationEpochs(input.ledger, spec.lineageKey),
          ...(spec.recoveryReviewerStableKey !== undefined
            ? { recoveryReviewerStableKey: spec.recoveryReviewerStableKey }
            : {}),
          ...(spec.actionRecovery !== undefined ? { actionRecovery: spec.actionRecovery } : {}),
        },
      }));
      continue;
    }
    // 同一ラウンド内で同じ stableKey の spec が複数来た場合も ID を増やさない。
    const createdExisting = createdByStableKey.get(spec.stableKey);
    if (createdExisting !== undefined) {
      if (!isProvisionalFindingEntry(createdExisting)) {
        throw new Error(`Finding "${createdExisting.id}" is not provisional`);
      }
      const claim = mergeProvisionalClaimProjection(createdExisting, {
        severity: spec.severity,
        title: spec.title,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        ...(spec.suggestion !== undefined ? { suggestion: spec.suggestion } : {}),
        ...(spec.target !== undefined ? {
          target: spec.target,
          targetIdentityHash: spec.targetIdentityHash,
          claimIdentityHash: spec.claimIdentityHash,
          semanticClaimIdentityHash: spec.semanticClaimIdentityHash,
        } : {}),
      });
      createdByStableKey.set(spec.stableKey, createProvisionalFindingEntry({
        ...claim,
        rawFindingIds: mergeBinarySortedUniqueStrings(
          createdExisting.rawFindingIds,
          spec.sourceRawFindingIds,
        ),
        reviewers: Array.from(new Set([...createdExisting.reviewers, ...spec.reviewers])),
        provisional: {
          ...createdExisting.provisional,
          sourceRawFindingIds: mergeBinarySortedUniqueStrings(
            createdExisting.provisional.sourceRawFindingIds,
            spec.sourceRawFindingIds,
          ),
          interpretationEpochs: countInterpretationEpochs(input.ledger, spec.lineageKey),
        },
      }));
      continue;
    }
    const entry = createProvisionalFindingEntry({
      id: input.allocateId(),
      status: 'open',
      lifecycle: 'new',
      target: spec.target ?? null,
      targetIdentityHash: spec.targetIdentityHash ?? null,
      claimIdentityHash: spec.claimIdentityHash ?? null,
      semanticClaimIdentityHash: spec.semanticClaimIdentityHash ?? null,
      severity: spec.severity,
      title: spec.title,
      evidenceIds: [],
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.suggestion !== undefined ? { suggestion: spec.suggestion } : {}),
      reviewers: [...spec.reviewers],
      rawFindingIds: [...spec.sourceRawFindingIds],
      firstSeen: observation,
      lastSeen: observation,
      revision: 1,
      provisional: {
        kind: spec.kind,
        stableKey: spec.stableKey,
        lineageKey: spec.lineageKey,
        sourceRawFindingIds: [...spec.sourceRawFindingIds],
        reason: spec.reason,
        firstObservedAt: observation,
        lastObservedAt: observation,
        interpretationEpochs: countInterpretationEpochs(input.ledger, spec.lineageKey),
        gateEffect: 'block',
        ...(spec.recoveryReviewerStableKey !== undefined
          ? { recoveryReviewerStableKey: spec.recoveryReviewerStableKey }
          : {}),
        ...(spec.actionRecovery !== undefined ? { actionRecovery: spec.actionRecovery } : {}),
        // このラウンドの marker は commit 側で reconcile 後に追記されるため、
        // 現在ラウンド序数 = 記録済みラウンド数 + 1。
        firstObservedRound: stopBudgetRoundsCompleted(input.ledger) + 1,
      },
    });
    createdByStableKey.set(spec.stableKey, entry);
  }
  return [...createdByStableKey.values()];
}
import { createHash } from 'node:crypto';
