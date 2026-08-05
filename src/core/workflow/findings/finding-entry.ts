import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingSeverity,
  ProductFindingEntry,
  ProvisionalFindingEntry,
  RawFinding,
} from './types.js';
import {
  FindingLedgerEntrySchema,
  RawFindingSchema,
} from '../../models/finding-schemas.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';

export function isProvisionalFindingEntry(
  finding: FindingLedgerEntry,
): finding is ProvisionalFindingEntry {
  return finding.provisional !== undefined;
}

export function isProductFindingEntry(
  finding: FindingLedgerEntry,
): finding is ProductFindingEntry {
  return finding.provisional === undefined
    && finding.reviewerAnomalyReclassification === undefined
    && finding.severity !== null
    && finding.title !== null
    && finding.description !== undefined
    && finding.target !== null
    && finding.targetIdentityHash !== null
    && finding.claimIdentityHash !== null
    && finding.semanticClaimIdentityHash !== null;
}

export function isReclassifiedReviewerAnomalyFinding(
  finding: FindingLedgerEntry,
): boolean {
  return finding.reviewerAnomalyReclassification !== undefined;
}

function canonicalProvisionalMetadata(
  provisional: NonNullable<FindingLedgerEntry['provisional']>,
): NonNullable<FindingLedgerEntry['provisional']> {
  const {
    actionRecovery,
    actionRecoveryAttempts,
    recoveryReviewerStableKey,
    ...required
  } = provisional;
  return {
    ...required,
    ...(actionRecovery !== undefined
      ? { actionRecovery: structuredClone(actionRecovery) }
      : {}),
    ...(actionRecoveryAttempts !== undefined
      ? { actionRecoveryAttempts: structuredClone(actionRecoveryAttempts) }
      : {}),
    ...(recoveryReviewerStableKey !== undefined
      ? { recoveryReviewerStableKey }
      : {}),
  };
}

/**
 * FindingLedgerEntry の永続化可能な正規形を生成する唯一の入口。
 * optional field は値がある場合だけキーを持ち、明示的な undefined を残さない。
 */
export function createFindingLedgerEntry(
  finding: FindingLedgerEntry,
): FindingLedgerEntry {
  const parsed = FindingLedgerEntrySchema.parse(finding);
  const {
    description,
    suggestion,
    resolvedAt,
    resolvedEvidence,
    reopenedEvidence,
    waivers,
    disputes,
    invalidatedAt,
    invalidatedEvidence,
    supersededByFindingId,
    dismissal,
    provisional,
    reviewerAnomalyReclassification,
    rejectedObservations,
    ...required
  } = parsed;
  return {
    ...structuredClone(required),
    ...(description !== undefined ? { description } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(resolvedEvidence !== undefined ? { resolvedEvidence } : {}),
    ...(reopenedEvidence !== undefined ? { reopenedEvidence } : {}),
    ...(waivers !== undefined ? { waivers: structuredClone(waivers) } : {}),
    ...(disputes !== undefined ? { disputes: structuredClone(disputes) } : {}),
    ...(invalidatedAt !== undefined ? { invalidatedAt } : {}),
    ...(invalidatedEvidence !== undefined ? { invalidatedEvidence } : {}),
    ...(supersededByFindingId !== undefined ? { supersededByFindingId } : {}),
    ...(dismissal !== undefined ? { dismissal: structuredClone(dismissal) } : {}),
    ...(provisional !== undefined
      ? { provisional: canonicalProvisionalMetadata(provisional) }
      : {}),
    ...(reviewerAnomalyReclassification !== undefined
      ? { reviewerAnomalyReclassification: structuredClone(reviewerAnomalyReclassification) }
      : {}),
    ...(rejectedObservations !== undefined
      ? { rejectedObservations: structuredClone(rejectedObservations) }
      : {}),
  };
}

export function createProductFindingEntry(
  finding: FindingLedgerEntry,
): ProductFindingEntry {
  const parsed = createFindingLedgerEntry(finding);
  if (!isProductFindingEntry(parsed)) {
    throw new Error(`Product finding "${finding.id}" has an incomplete claim`);
  }
  return parsed;
}

export function createProvisionalFindingEntry(
  finding: ProvisionalFindingEntry,
): ProvisionalFindingEntry {
  const parsed = createFindingLedgerEntry(finding);
  if (!isProvisionalFindingEntry(parsed)) {
    throw new Error(`Finding "${finding.id}" is not provisional`);
  }
  if (parsed.provisional.gateEffect !== 'block') {
    throw new Error(`Provisional finding "${finding.id}" must block completion`);
  }
  return parsed;
}

export function hasSameProductClaim(
  left: ProductFindingEntry,
  right: ProductFindingEntry,
): boolean {
  return canonicalJson(productFindingClaimProjection(left))
    === canonicalJson(productFindingClaimProjection(right));
}

export function productFindingClaimProjection(
  finding: ProductFindingEntry,
): {
  target: ProductFindingEntry['target'];
  targetIdentityHash: string;
  claimIdentityHash: string;
  semanticClaimIdentityHash: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  suggestion: string | null;
} {
  return {
    target: finding.target,
    targetIdentityHash: finding.targetIdentityHash,
    claimIdentityHash: finding.claimIdentityHash,
    semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    suggestion: finding.suggestion ?? null,
  };
}

export interface ProvisionalClaimProjection {
  target?: RawFinding['target'];
  targetIdentityHash?: string;
  claimIdentityHash?: string;
  semanticClaimIdentityHash?: string;
  severity: FindingSeverity | null;
  title: string | null;
  description?: string;
  suggestion?: string;
}

function mergeNonNullClaimField<T>(
  findingId: string,
  field: string,
  current: T | null | undefined,
  incoming: T | null | undefined,
): T | null | undefined {
  if (current !== null && current !== undefined
    && incoming !== null && incoming !== undefined
    && current !== incoming) {
    throw new Error(
      `Provisional finding "${findingId}" has conflicting ${field}`,
    );
  }
  return current ?? incoming;
}

/**
 * provisional の claim 投影を更新する唯一の入口。
 * target と3つの identity は、未設定のまま維持するか4項目を一括で設定する。
 */
export function mergeProvisionalClaimProjection(
  finding: ProvisionalFindingEntry,
  incoming: ProvisionalClaimProjection,
): ProvisionalFindingEntry {
  const identityValues = [
    incoming.target,
    incoming.targetIdentityHash,
    incoming.claimIdentityHash,
    incoming.semanticClaimIdentityHash,
  ];
  const identityAbsent = identityValues.every((value) => value === undefined);
  const identityPresent = identityValues.every((value) => value !== undefined);
  if (!identityAbsent && !identityPresent) {
    throw new Error(
      `Provisional finding "${finding.id}" claim identity must be supplied atomically`,
    );
  }

  const severity = mergeNonNullClaimField(
    finding.id,
    'severity',
    finding.severity,
    incoming.severity,
  );
  const title = mergeNonNullClaimField(
    finding.id,
    'title',
    finding.title,
    incoming.title,
  );
  const description = mergeNonNullClaimField(
    finding.id,
    'description',
    finding.description,
    incoming.description,
  );
  const suggestion = mergeNonNullClaimField(
    finding.id,
    'suggestion',
    finding.suggestion,
    incoming.suggestion,
  );

  const claimProjectionChanged = severity !== finding.severity
    || title !== finding.title
    || description !== finding.description
    || suggestion !== finding.suggestion;
  if (
    identityAbsent
    && finding.targetIdentityHash !== null
    && claimProjectionChanged
  ) {
    throw new Error(
      `Provisional finding "${finding.id}" claim changed without an atomic identity update`,
    );
  }

  let identityProjection: Pick<
    ProvisionalFindingEntry,
    'target' | 'targetIdentityHash' | 'claimIdentityHash' | 'semanticClaimIdentityHash'
  > = {
    target: finding.target,
    targetIdentityHash: finding.targetIdentityHash,
    claimIdentityHash: finding.claimIdentityHash,
    semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
  };
  if (identityPresent) {
    const target = incoming.target!;
    const targetIdentityHash = incoming.targetIdentityHash!;
    const claimIdentityHash = incoming.claimIdentityHash!;
    const semanticClaimIdentityHash = incoming.semanticClaimIdentityHash!;
    if (
      finding.target !== null
      && (
        canonicalJson(finding.target) !== canonicalJson(target)
        || finding.targetIdentityHash !== targetIdentityHash
        || finding.claimIdentityHash !== claimIdentityHash
        || finding.semanticClaimIdentityHash !== semanticClaimIdentityHash
      )
    ) {
      throw new Error(
        `Provisional finding "${finding.id}" has conflicting claim identity`,
      );
    }
    identityProjection = {
      target: structuredClone(target),
      targetIdentityHash,
      claimIdentityHash,
      semanticClaimIdentityHash,
    };
  }

  return createProvisionalFindingEntry({
    ...finding,
    ...identityProjection,
    severity: severity ?? null,
    title: title ?? null,
    ...(description !== undefined && description !== null
      ? { description }
      : {}),
    ...(suggestion !== undefined && suggestion !== null
      ? { suggestion }
      : {}),
  });
}

interface CompleteRawClaim {
  target: RawFinding['target'];
  targetIdentityHash: string;
  claimIdentityHash: string;
  semanticClaimIdentityHash: string;
  familyTag: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  suggestion: string | null;
}

export type ProvisionalMaterializationResult =
  | {
    outcome: 'materialized';
    finding: ProductFindingEntry;
    transitionRawFindingIds: string[];
  }
  | {
    outcome: 'blocked';
    reason:
      | 'incomplete-transition-claim'
      | 'inconsistent-transition-claim'
      | 'existing-source-claim-conflict'
      | 'provisional-claim-conflict';
  };

function completeConsistentRawClaim(
  rawFindings: readonly RawFinding[],
): CompleteRawClaim | ProvisionalMaterializationResult {
  if (rawFindings.length === 0) {
    return {
      outcome: 'blocked',
      reason: 'incomplete-transition-claim',
    };
  }
  const ordered = [...rawFindings].sort((left, right) => (
    compareBinaryStrings(left.rawFindingId, right.rawFindingId)
  ));
  const primary = ordered[0]!;
  if (
    primary.familyTag === null
    || primary.severity === null
    || primary.title === null
    || primary.description === null
    || ordered.some((raw) => (
      raw.familyTag === null
      || raw.severity === null
      || raw.title === null
      || raw.description === null
    ))
  ) {
    return {
      outcome: 'blocked',
      reason: 'incomplete-transition-claim',
    };
  }
  if (ordered.some((raw) => (
    raw.claimIdentityHash !== primary.claimIdentityHash
    || raw.targetIdentityHash !== primary.targetIdentityHash
    || raw.semanticClaimIdentityHash !== primary.semanticClaimIdentityHash
  ))) {
    return {
      outcome: 'blocked',
      reason: 'inconsistent-transition-claim',
    };
  }
  return {
    target: structuredClone(primary.target),
    targetIdentityHash: primary.targetIdentityHash,
    claimIdentityHash: primary.claimIdentityHash,
    semanticClaimIdentityHash: primary.semanticClaimIdentityHash,
    familyTag: primary.familyTag,
    severity: primary.severity,
    title: primary.title,
    description: primary.description,
    suggestion: primary.suggestion,
  };
}

function rawClaimConflicts(
  existing: RawFinding,
  claim: CompleteRawClaim,
): boolean {
  if (
    existing.targetIdentityHash !== claim.targetIdentityHash
    || canonicalJson(existing.target) !== canonicalJson(claim.target)
  ) {
    return true;
  }
  const comparableFields = [
    [existing.familyTag, claim.familyTag],
    [existing.severity, claim.severity],
    [existing.title, claim.title],
    [existing.description, claim.description],
    [existing.suggestion, claim.suggestion],
  ] as const;
  return comparableFields.some(([current, next]) => (
    current !== null && current !== next
  ));
}

function provisionalClaimConflicts(
  finding: ProvisionalFindingEntry,
  claim: CompleteRawClaim,
): boolean {
  if (
    finding.target !== null
    && (
      finding.targetIdentityHash !== claim.targetIdentityHash
      || canonicalJson(finding.target) !== canonicalJson(claim.target)
    )
  ) {
    return true;
  }
  return (
    (finding.severity !== null && finding.severity !== claim.severity)
    || (finding.title !== null && finding.title !== claim.title)
    || (finding.description !== undefined && finding.description !== claim.description)
    || (
      finding.suggestion !== undefined
      && finding.suggestion !== claim.suggestion
    )
  );
}

/**
 * provisional を product finding へ変換する唯一の入口。
 * 保存済みsourceの内容アドレスと、新しい遷移rawの完全claimを同時に検証する。
 * 遷移rawの relation/CAS authority は呼び出し側の source predicate が担う。
 */
export function materializeProvisionalFinding(input: {
  ledger: Pick<FindingLedger, 'rawFindings'>;
  finding: ProvisionalFindingEntry;
  transitionRawFindings: readonly RawFinding[];
}): ProvisionalMaterializationResult {
  const persistedRawById = new Map(
    input.ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]),
  );
  const existingSourceRaws = input.finding.provisional.sourceRawFindingIds.map(
    (rawFindingId) => {
      const persisted = persistedRawById.get(rawFindingId);
      if (persisted === undefined) {
        throw new Error(
          `Provisional finding "${input.finding.id}" references missing source raw "${rawFindingId}"`,
        );
      }
      return RawFindingSchema.parse(persisted);
    },
  );
  const transitionRawFindings = input.transitionRawFindings.map(
    (raw) => RawFindingSchema.parse(raw),
  );
  const claim = completeConsistentRawClaim(transitionRawFindings);
  if ('outcome' in claim) {
    return claim;
  }
  if (existingSourceRaws.some((raw) => rawClaimConflicts(raw, claim))) {
    return {
      outcome: 'blocked',
      reason: 'existing-source-claim-conflict',
    };
  }
  if (provisionalClaimConflicts(input.finding, claim)) {
    return {
      outcome: 'blocked',
      reason: 'provisional-claim-conflict',
    };
  }

  const base: FindingLedgerEntry = structuredClone(input.finding);
  delete base.provisional;
  delete base.suggestion;
  return {
    outcome: 'materialized',
    finding: createProductFindingEntry({
      ...base,
      target: claim.target,
      targetIdentityHash: claim.targetIdentityHash,
      claimIdentityHash: claim.claimIdentityHash,
      semanticClaimIdentityHash: claim.semanticClaimIdentityHash,
      severity: claim.severity,
      title: claim.title,
      description: claim.description,
      ...(claim.suggestion !== null ? { suggestion: claim.suggestion } : {}),
    }),
    transitionRawFindingIds: transitionRawFindings
      .map((rawFinding) => rawFinding.rawFindingId)
      .sort(compareBinaryStrings),
  };
}
