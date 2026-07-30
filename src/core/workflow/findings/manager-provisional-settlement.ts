import { computeOverflowStableKey } from './raw-canonicalization.js';
import {
  applyReplayOriginSettlement,
  type ProvisionalReplayOrigin,
} from './manager-replay-settlement.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerOutput,
  FindingObservation,
  RawFinding,
} from './types.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import {
  CLAIM_BEARING_PROVISIONAL_KINDS,
  type FindingRejectedObservationCode,
} from '../../models/finding-types.js';
import {
  applyFindingLifecycleCommands,
  type FindingLifecycleCommand,
} from './lifecycle-transaction.js';
import { FindingLedgerEntrySchema } from '../../models/finding-schemas.js';
import {
  absenceRawFindings,
  authorityAnchorAdjudications,
  computeAnchorRelevanceDecisionDigest,
} from '../../models/finding-anchor-relevance.js';
import { isProvisionalPromotionSource } from './provisional-promotion-eligibility.js';
import {
  isProvisionalFindingEntry,
  materializeProvisionalFinding,
} from './finding-entry.js';

export interface ProvisionalSettlement {
  output: FindingManagerOutput;
  /** clean new 証拠で confirmed へ昇格させる provisional finding id。 */
  promotedFindingIds: Set<string>;
  promotionSourceRawFindingIds: Map<string, string[]>;
  /** clean な決定的 same により解消する provisional finding id → 対応 target。 */
  resolvedByMapping: Map<string, string>;
  resolvedByEvidence: Map<string, string>;
  settledReplayRawIds: Set<string>;
}

/**
 * claim identity は重複検索にだけ使う。provisional 昇格の正本は
 * findingId + revision precondition + targetIdentityHash。
 */
export function fullIdentityKeyOf(
  value: Pick<RawFinding | FindingLedgerEntry, 'claimIdentityHash'>,
): string | undefined {
  return value.claimIdentityHash ?? undefined;
}

function canResolveProvisionalByExplicitConfirmation(
  finding: FindingLedgerEntry,
): boolean {
  const provisionalKind = finding.provisional?.kind;
  return provisionalKind !== undefined
    && CLAIM_BEARING_PROVISIONAL_KINDS.some(
      (kind) => kind === provisionalKind,
    );
}

/**
 * clean な後続 raw だけが provisional を確定・解消できる。
 *
 * 確定・解消の根拠は次のどちらかに限る:
 * 昇格は findingId + 保存時 revision precondition + targetIdentityHash の一致を
 * 必須とする。claimIdentityHash / lineageKey の一致だけでは provisional を
 * product finding に昇格できない。証拠 matrix はこの関数へ渡る前の admission
 * で検証済みであり、保存時 lifecycle transaction が同じ evidence binding と
 * finding head を再検証する。
 *
 * 適用:
 * - clean new group が (a)/(b) で open provisional と一意対応 → 新規 finding を
 *   作らず provisional へ match として集約し、metadata を外す（昇格）。
 * - match 先が open provisional 自身で、その match に (a) を満たす clean raw が
 *   含まれる → metadata を外して通常 open へ昇格する。
 * - clean raw が既存 target T へ完全 identity で一致し、同じ identity の open
 *   provisional P（P ≠ T、一意）がある → P を resolved にする（T を記録）。
 * - 明示 resolution_confirmation で直接 resolved にできるのは、claim 自体を
 *   保持する raw-meaning-ambiguous / raw-adjudication-unresolved だけ。overflow
 *   や budget / interrupted / stale など処理失敗の provisional は、各 process
 *   固有の機械回復を経由し、product confirmation では消さない。
 */
export function settleProvisionalsWithCleanEvidence(input: {
  output: FindingManagerOutput;
  cleanRawIds: ReadonlySet<string>;
  wireById: ReadonlyMap<string, RawFinding>;
  freshLedger: FindingLedger;
  explicitResolvedByMapping: ReadonlyMap<string, string>;
  explicitPromotedFindingIds: ReadonlySet<string>;
  healthyReviewerStableKeys: ReadonlySet<string>;
  replayOrigins: ReadonlyMap<string, ProvisionalReplayOrigin>;
}): ProvisionalSettlement {
  const openProvisionals = input.freshLedger.findings.filter(
    (finding) => finding.status === 'open' && finding.provisional !== undefined,
  );
  if (openProvisionals.length === 0) {
    return {
      output: input.output,
      promotedFindingIds: new Set(),
      promotionSourceRawFindingIds: new Map(),
      resolvedByMapping: new Map(),
      resolvedByEvidence: new Map(),
      settledReplayRawIds: new Set(),
    };
  }
  const replay = applyReplayOriginSettlement({
    output: input.output,
    origins: input.replayOrigins,
    freshLedger: input.freshLedger,
    cleanRawIds: input.cleanRawIds,
    wireById: input.wireById,
  });
  const provisionalById = new Map(openProvisionals.map((finding) => [finding.id, finding]));
  const ineligibleConfirmationRawIds = new Set(
    replay.output.resolvedFindings.flatMap((resolved) => {
      const provisional = provisionalById.get(resolved.findingId);
      return provisional !== undefined
        && !canResolveProvisionalByExplicitConfirmation(provisional)
        ? resolved.rawFindingIds
        : [];
    }),
  );
  const settlementOutput: FindingManagerOutput = ineligibleConfirmationRawIds.size === 0
    ? replay.output
    : {
        ...replay.output,
        resolvedFindings: replay.output.resolvedFindings.filter((resolved) => (
          !resolved.rawFindingIds.some((rawFindingId) => (
            ineligibleConfirmationRawIds.has(rawFindingId)
          ))
        )),
        anchorAdjudications: replay.output.anchorAdjudications.filter((adjudication) => (
          !ineligibleConfirmationRawIds.has(adjudication.rawFindingId)
        )),
      };

  // 一意な identity / lineage は「既存 product finding への決定的 mapping」
  // にだけ使う。provisional 昇格には使わない。
  let identityCounts = new Map<string, number>();
  for (const finding of openProvisionals) {
    const key = fullIdentityKeyOf(finding);
    if (key === undefined) {
      continue;
    }
    identityCounts = new Map([...identityCounts, [key, (identityCounts.get(key) ?? 0) + 1]]);
  }
  let byUniqueIdentity = new Map<string, FindingLedgerEntry>();
  for (const finding of openProvisionals) {
    const key = fullIdentityKeyOf(finding);
    if (key === undefined) {
      continue;
    }
    if (identityCounts.get(key) === 1) {
      byUniqueIdentity = new Map([...byUniqueIdentity, [key, finding]]);
    }
  }
  const freshRawsById = new Map(input.freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const targetHasExactIdentity = (targetId: string, identity: string): boolean => {
    const target = input.freshLedger.findings.find((finding) => finding.id === targetId);
    if (target === undefined) {
      return false;
    }
    if (fullIdentityKeyOf(target) === identity) {
      return true;
    }
    return target.rawFindingIds.some((rawFindingId) => {
      const raw = freshRawsById.get(rawFindingId);
      return raw !== undefined
        && fullIdentityKeyOf(raw) === identity;
    });
  };

  let promotedFindingIds = new Set([
    ...replay.promotedFindingIds,
    ...input.explicitPromotedFindingIds,
  ]);
  let resolvedByMapping = new Map<string, string>([
    ...input.explicitResolvedByMapping,
    ...replay.resolvedByMapping,
  ]);
  let resolvedByEvidence = new Map<string, string>();
  for (const resolved of settlementOutput.resolvedFindings) {
    const provisional = provisionalById.get(resolved.findingId);
    if (
      provisional === undefined
      || !canResolveProvisionalByExplicitConfirmation(provisional)
    ) {
      continue;
    }
    const hasCleanConfirmation = resolved.rawFindingIds.some((rawFindingId) => {
      const wire = input.wireById.get(rawFindingId);
      return input.cleanRawIds.has(rawFindingId)
        && wire?.relation === 'resolution_confirmation'
        && wire.targetFindingId === resolved.findingId;
    });
    if (hasCleanConfirmation) {
      resolvedByEvidence = new Map([
        ...resolvedByEvidence,
        [resolved.findingId, resolved.evidence],
      ]);
    }
  }
  for (const finding of openProvisionals) {
    if (finding.provisional?.kind !== 'reviewer-output-overflow') {
      continue;
    }
    const reviewerStableKey = finding.provisional.recoveryReviewerStableKey;
    const healed = reviewerStableKey !== undefined
      ? input.healthyReviewerStableKeys.has(reviewerStableKey)
      : [...input.healthyReviewerStableKeys].some(
          (healthyReviewerStableKey) => computeOverflowStableKey(healthyReviewerStableKey)
            === finding.provisional!.stableKey,
        );
    if (healed) {
      resolvedByEvidence = new Map([
        ...resolvedByEvidence,
        [finding.id, 'A later output from the same reviewer passed the intake envelope.'],
      ]);
    }
  }
  const matches = settlementOutput.matches.map(
    (match) => ({ ...match, rawFindingIds: [...match.rawFindingIds] }),
  );

  // relation=new の group には既存 provisional の findingId/revision
  // precondition が無い。identity/lineage が一致しても昇格へ転用しない。
  const newFindings: FindingManagerOutput['newFindings'] = [
    ...settlementOutput.newFindings,
  ];

  for (const match of matches) {
    const provisional = provisionalById.get(match.findingId);
    if (provisional === undefined || promotedFindingIds.has(provisional.id)) {
      continue;
    }
    const hasExactCleanRaw = match.rawFindingIds.some((rawFindingId) => {
      if (!input.cleanRawIds.has(rawFindingId)) {
        return false;
      }
      const wire = input.wireById.get(rawFindingId);
      return wire !== undefined && isProvisionalPromotionSource({
        ledger: input.freshLedger,
        provisional,
        wire,
      });
    });
    if (hasExactCleanRaw) {
      promotedFindingIds = new Set([...promotedFindingIds, provisional.id]);
    }
  }

  // replay / ladder / conflict のどの producer が候補を出しても、最終的な
  // promotion authority は同じ clean targeted persists predicate で決める。
  promotedFindingIds = new Set([...promotedFindingIds].filter((findingId) => {
    const provisional = provisionalById.get(findingId);
    if (provisional === undefined) {
      return false;
    }
    return [...input.cleanRawIds].some((rawFindingId) => {
      const wire = input.wireById.get(rawFindingId);
      return wire !== undefined && isProvisionalPromotionSource({
        ledger: input.freshLedger,
        provisional,
        wire,
      });
    });
  }));

  // manager の意味判断だけでは別の provisional を解消できない。
  for (const match of matches) {
    if (provisionalById.has(match.findingId)) {
      continue;
    }
    for (const rawFindingId of match.rawFindingIds) {
      if (!input.cleanRawIds.has(rawFindingId)) {
        continue;
      }
      const wire = input.wireById.get(rawFindingId);
      if (wire === undefined) {
        continue;
      }
      const identity = fullIdentityKeyOf(wire);
      if (identity === undefined) {
        continue;
      }
      const provisional = byUniqueIdentity.get(identity);
      if (provisional === undefined || provisional.id === match.findingId || promotedFindingIds.has(provisional.id)) {
        continue;
      }
      if (targetHasExactIdentity(match.findingId, identity)) {
        resolvedByMapping = new Map([...resolvedByMapping, [provisional.id, match.findingId]]);
      }
    }
  }

  const promotionSourceRawFindingIds = new Map<string, string[]>();
  promotedFindingIds = new Set([...promotedFindingIds].filter((findingId) => {
    const provisional = provisionalById.get(findingId);
    if (provisional === undefined || !isProvisionalFindingEntry(provisional)) {
      return false;
    }
    const sourceRawFindings = [...input.cleanRawIds]
      .map((rawFindingId) => input.wireById.get(rawFindingId))
      .filter((wire): wire is RawFinding => (
        wire !== undefined
        && isProvisionalPromotionSource({
          ledger: input.freshLedger,
          provisional,
          wire,
        })
      ));
    const materialization = materializeProvisionalFinding({
      ledger: input.freshLedger,
      finding: provisional,
      transitionRawFindings: sourceRawFindings,
    });
    if (materialization.outcome !== 'materialized') {
      return false;
    }
    promotionSourceRawFindingIds.set(
      findingId,
      materialization.transitionRawFindingIds,
    );
    return true;
  }));

  return {
    output: { ...settlementOutput, newFindings, matches },
    promotedFindingIds,
    promotionSourceRawFindingIds,
    resolvedByMapping,
    resolvedByEvidence,
    settledReplayRawIds: replay.settledReplayRawIds,
  };
}

/**
 * 証跡不成立の persists 再観測を open target の rejectedObservations へ
 * 監査添付する。canonical evidence / rawFindingIds / status には
 * 一切触れない（evidence hash の入力にも含まれないため再開口しない）。
 * target が既に gate を塞いでいるため、観測は消えずゲートも開かない。
 */
export function applyRejectedObservationAttachments(
  ledger: FindingLedger,
  attachments: ReadonlyArray<{
    targetFindingId: string;
    rawFindingId: string;
    reason: string;
    rejectionCode: FindingRejectedObservationCode;
  }>,
  observation: FindingObservation,
): FindingLedger {
  let current = ledger;
  for (const attachment of attachments) {
    const target = current.findings.find(
      (finding) => finding.id === attachment.targetFindingId,
    );
    if (target === undefined) {
      throw new Error(
        `Rejected observation references unknown finding "${attachment.targetFindingId}"`,
      );
    }
    if (target.rejectedObservations?.some(
      (rejected) => rejected.rawFindingId === attachment.rawFindingId,
    ) === true) {
      continue;
    }
    const raw = current.rawFindings.find(
      (candidate) => candidate.rawFindingId === attachment.rawFindingId,
    );
    if (raw === undefined) {
      throw new Error(
        `Rejected observation references unknown raw finding "${attachment.rawFindingId}"`,
      );
    }
    const change: Partial<FindingLedgerEntry> = {
      ...target,
      rejectedObservations: [
        ...(target.rejectedObservations ?? []),
        {
          rawFindingId: attachment.rawFindingId,
          reason: attachment.reason,
          observedAt: observation,
        },
      ],
    };
    delete change.revision;
    current = applyFindingLifecycleCommands({
      ledger: current,
      commands: [{
        operation: 'record_rejected_observation',
        changes: {
          findings: [change as Omit<FindingLedgerEntry, 'revision'>],
          conflicts: [],
        },
        authority: {
          kind: 'rejected_observation',
          rawFindingId: raw.rawFindingId,
          rawIntegrityDigest: computeRawFindingIntegrityDigest(raw),
          rejectionCode: attachment.rejectionCode,
        },
        evidenceSourcesByTarget: new Map(),
      }],
      occurredAt: observation,
    });
  }
  return current;
}

export function applyProvisionalSettlement(
  ledger: FindingLedger,
  settlement: ProvisionalSettlement,
  timestamp: string,
): FindingLedger {
  if (settlement.promotedFindingIds.size === 0
    && settlement.resolvedByMapping.size === 0
    && settlement.resolvedByEvidence.size === 0) {
    return ledger;
  }
  return {
    ...ledger,
    findings: ledger.findings.map((finding) => {
      if (settlement.promotedFindingIds.has(finding.id) && isProvisionalFindingEntry(finding)) {
        const sourceRawFindingIds = requiredPromotionSourceRawFindingIds(
          settlement,
          finding.id,
        );
        const materialized = materializeProvisionalFinding({
          ledger,
          finding,
          transitionRawFindings: requireRawFindingsById(
            ledger,
            sourceRawFindingIds,
            `Provisional promotion for "${finding.id}"`,
          ),
        });
        if (materialized.outcome !== 'materialized') {
          throw new Error(
            `Provisional settlement for "${finding.id}" became invalid: ${materialized.reason}`,
          );
        }
        return {
          ...materialized.finding,
          revision: finding.revision + 1,
        };
      }
      const mappedTarget = settlement.resolvedByMapping.get(finding.id);
      if (mappedTarget !== undefined && finding.status === 'open' && finding.provisional !== undefined) {
        return {
          ...finding,
          status: 'resolved' as const,
          lifecycle: 'resolved' as const,
          resolvedAt: timestamp,
          resolvedEvidence: `Deterministically settled through ${mappedTarget}`,
          revision: finding.revision + 1,
        };
      }
      const resolvedEvidence = settlement.resolvedByEvidence.get(finding.id);
      if (resolvedEvidence !== undefined && finding.status === 'open' && finding.provisional !== undefined) {
        return {
          ...finding,
          status: 'resolved' as const,
          lifecycle: 'resolved' as const,
          resolvedAt: timestamp,
          resolvedEvidence,
          revision: finding.revision + 1,
        };
      }
      return finding;
    }),
  };
}

function requiredPromotionSourceRawFindingIds(
  settlement: ProvisionalSettlement,
  findingId: string,
): string[] {
  const sourceRawFindingIds = settlement.promotionSourceRawFindingIds.get(findingId);
  if (sourceRawFindingIds === undefined || sourceRawFindingIds.length === 0) {
    throw new Error(
      `Provisional promotion for "${findingId}" has no materialization source`,
    );
  }
  return [...sourceRawFindingIds];
}

function requireRawFindingsById(
  ledger: FindingLedger,
  rawFindingIds: readonly string[],
  context: string,
): RawFinding[] {
  const rawById = new Map(
    ledger.rawFindings.map((rawFinding) => [rawFinding.rawFindingId, rawFinding]),
  );
  return rawFindingIds.map((rawFindingId) => {
    const rawFinding = rawById.get(rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(`${context} references missing raw finding "${rawFindingId}"`);
    }
    return rawFinding;
  });
}

function findingWithoutRevision(
  finding: FindingLedgerEntry,
): Omit<FindingLedgerEntry, 'revision'> {
  const parsed = FindingLedgerEntrySchema.parse(finding);
  const change: Partial<FindingLedgerEntry> = { ...parsed };
  delete change.revision;
  return change as Omit<FindingLedgerEntry, 'revision'>;
}

function settlementRawFindingIds(
  settlement: ProvisionalSettlement,
  findingId: string,
  mappedTargetFindingId?: string,
): string[] {
  return [...new Set([
    ...settlement.output.matches.flatMap((decision) => (
      decision.findingId === findingId
      || decision.findingId === mappedTargetFindingId
        ? decision.rawFindingIds
        : []
    )),
    ...settlement.output.resolvedFindings.flatMap((decision) => (
      decision.findingId === findingId ? decision.rawFindingIds : []
    )),
  ])];
}

export function buildProvisionalSettlementLifecycleCommands(input: {
  after: FindingLedger;
  settlement: ProvisionalSettlement;
}): FindingLifecycleCommand[] {
  const commands: FindingLifecycleCommand[] = [];
  const append = (
    operation: 'promote_provisional' | 'resolve_finding',
    findingId: string,
    sourceRawFindingIds: readonly string[],
  ): void => {
    const finding = input.after.findings.find((candidate) => candidate.id === findingId);
    if (finding === undefined) {
      throw new Error(`Provisional settlement references unknown finding "${findingId}"`);
    }
    if (sourceRawFindingIds.length === 0) {
      throw new Error(`Provisional settlement for "${findingId}" has no clean evidence source`);
    }
    const sourceRawFindings = requireRawFindingsById(
      input.after,
      sourceRawFindingIds,
      `Provisional settlement for "${findingId}"`,
    );
    const absenceRaws = absenceRawFindings(sourceRawFindings);
    const authority: FindingLifecycleCommand['authority'] =
      absenceRaws.length === 0
        ? { kind: 'verified_evidence' }
        : (() => {
            const anchorAdjudications = authorityAnchorAdjudications({
              rawFindingIds: absenceRaws.map((rawFinding) => rawFinding.rawFindingId),
              adjudications: input.settlement.output.anchorAdjudications,
            });
            return {
            kind: 'engine_policy',
            decisionKind: 'anchor_relevance',
            anchorAdjudications,
            decisionDigest: computeAnchorRelevanceDecisionDigest({
              operation,
              rawFindings: absenceRaws,
              adjudications: anchorAdjudications,
            }),
            };
          })();
    commands.push({
      operation,
      changes: {
        findings: [findingWithoutRevision(finding)],
        conflicts: [],
      },
      authority,
      evidenceSourcesByTarget: new Map([[
        `finding\0${findingId}`,
        { sourceRawFindingIds, authorityEvidenceIds: [] },
      ]]),
    });
  };
  for (const findingId of input.settlement.promotedFindingIds) {
    append(
      'promote_provisional',
      findingId,
      requiredPromotionSourceRawFindingIds(input.settlement, findingId),
    );
  }
  for (const [findingId, targetFindingId] of input.settlement.resolvedByMapping) {
    append(
      'resolve_finding',
      findingId,
      settlementRawFindingIds(input.settlement, findingId, targetFindingId),
    );
  }
  for (const findingId of input.settlement.resolvedByEvidence.keys()) {
    if (input.settlement.output.resolvedFindings.some(
      (resolved) => resolved.findingId === findingId,
    )) {
      continue;
    }
    append(
      'resolve_finding',
      findingId,
      settlementRawFindingIds(input.settlement, findingId),
    );
  }
  return commands;
}
