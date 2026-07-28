import { computeLineageKey, computeOverflowStableKey } from './raw-canonicalization.js';
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
import { computeClaimIdentityHash } from './evidence-domain.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import type { FindingRejectedObservationCode } from '../../models/finding-types.js';
import {
  applyFindingLifecycleCommands,
  type FindingLifecycleCommand,
} from './lifecycle-transaction.js';
import { FindingLedgerEntrySchema } from '../../models/finding-schemas.js';

export interface ProvisionalSettlement {
  output: FindingManagerOutput;
  /** clean new 証拠で confirmed へ昇格させる provisional finding id。 */
  promotedFindingIds: Set<string>;
  /** clean な決定的 same により解消する provisional finding id → 対応 target。 */
  resolvedByMapping: Map<string, string>;
  resolvedByEvidence: Map<string, string>;
  settledReplayRawIds: Set<string>;
}

/**
 * provisional settlement も claimIdentityHash を唯一の同一性正本にする。
 */
export function fullIdentityKeyOf(
  title: string | undefined,
  description: string | undefined,
): string {
  return computeClaimIdentityHash({
    targetFindingId: null,
    title: title ?? '',
    description: description ?? '',
  });
}

/**
 * clean な後続 raw だけが provisional を確定・解消できる。
 *
 * 確定・解消の根拠は次のどちらかに限る:
 * (a) claimIdentityHash の一致 — SameProof と同格
 * (b) 保存済み lineageKey との一致（claim 形の再計算）
 * どちらも「対応が一意」の場合のみ採用する。複数候補・非一意は確定しない
 * （保守側 — provisional は開いたままで gate は閉じ続ける）。manager の意味判断
 * による match は決定的根拠にならない。
 *
 * 適用:
 * - clean new group が (a)/(b) で open provisional と一意対応 → 新規 finding を
 *   作らず provisional へ match として集約し、metadata を外す（昇格）。
 * - match 先が open provisional 自身で、その match に (a) を満たす clean raw が
 *   含まれる → metadata を外して通常 open へ昇格する。
 * - clean raw が既存 target T へ完全 identity で一致し、同じ identity の open
 *   provisional P（P ≠ T、一意）がある → P を resolved にする（T を記録）。
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
      resolvedByMapping: new Map(),
      resolvedByEvidence: new Map(),
      settledReplayRawIds: new Set(),
    };
  }
  const replay = applyReplayOriginSettlement({
    output: input.output,
    origins: input.replayOrigins,
    freshLedger: input.freshLedger,
  });
  const provisionalById = new Map(openProvisionals.map((finding) => [finding.id, finding]));

  // 一意な identity / lineage だけを索引に載せる（重複 identity は候補から除外）。
  let identityCounts = new Map<string, number>();
  for (const finding of openProvisionals) {
    const key = fullIdentityKeyOf(finding.title, finding.description);
    identityCounts = new Map([...identityCounts, [key, (identityCounts.get(key) ?? 0) + 1]]);
  }
  let byUniqueIdentity = new Map<string, FindingLedgerEntry>();
  for (const finding of openProvisionals) {
    const key = fullIdentityKeyOf(finding.title, finding.description);
    if (identityCounts.get(key) === 1) {
      byUniqueIdentity = new Map([...byUniqueIdentity, [key, finding]]);
    }
  }
  let lineageCounts = new Map<string, number>();
  for (const finding of openProvisionals) {
    const key = finding.provisional!.lineageKey;
    lineageCounts = new Map([...lineageCounts, [key, (lineageCounts.get(key) ?? 0) + 1]]);
  }
  let byUniqueLineage = new Map<string, FindingLedgerEntry>();
  for (const finding of openProvisionals) {
    const key = finding.provisional!.lineageKey;
    if (lineageCounts.get(key) === 1) {
      byUniqueLineage = new Map([...byUniqueLineage, [key, finding]]);
    }
  }

  const findProvisionalForCleanRaw = (wire: RawFinding): FindingLedgerEntry | undefined => {
    const claimIdentityHash = fullIdentityKeyOf(wire.title, wire.description);
    const byIdentity = byUniqueIdentity.get(claimIdentityHash);
    if (byIdentity !== undefined) {
      return byIdentity;
    }
    const claimLineage = computeLineageKey({
      claimIdentityHash,
    });
    return byUniqueLineage.get(claimLineage);
  };

  const freshRawsById = new Map(input.freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const targetHasExactIdentity = (targetId: string, identity: string): boolean => {
    const target = input.freshLedger.findings.find((finding) => finding.id === targetId);
    if (target === undefined) {
      return false;
    }
    if (fullIdentityKeyOf(target.title, target.description) === identity) {
      return true;
    }
    return target.rawFindingIds.some((rawFindingId) => {
      const raw = freshRawsById.get(rawFindingId);
      return raw !== undefined
        && fullIdentityKeyOf(raw.title, raw.description) === identity;
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
  let matches = replay.output.matches.map((match) => ({ ...match, rawFindingIds: [...match.rawFindingIds] }));

  let groupCandidates = new Map<string, { provisional: FindingLedgerEntry; groups: Array<FindingManagerOutput['newFindings'][number]> }>();
  let unmatchedGroups: FindingManagerOutput['newFindings'] = [];
  for (const group of replay.output.newFindings) {
    const cleanRawId = group.rawFindingIds.find((rawFindingId) => input.cleanRawIds.has(rawFindingId));
    const wire = cleanRawId !== undefined ? input.wireById.get(cleanRawId) : undefined;
    const provisional = wire !== undefined ? findProvisionalForCleanRaw(wire) : undefined;
    if (provisional === undefined) {
      unmatchedGroups = [...unmatchedGroups, group];
      continue;
    }
    const entry = groupCandidates.get(provisional.id) ?? { provisional, groups: [] };
    groupCandidates = new Map([...groupCandidates, [
      provisional.id,
      { ...entry, groups: [...entry.groups, group] },
    ]]);
  }
  let newFindings: FindingManagerOutput['newFindings'] = [...unmatchedGroups];
  for (const { provisional, groups } of groupCandidates.values()) {
    if (groups.length !== 1) {
      // 非一意対応: 確定しない（group は通常の new として立ち、provisional は
      // 開いたまま — 誤確定よりも二重 blocker を選ぶ保守側）。
      newFindings = [...newFindings, ...groups];
      continue;
    }
    const group = groups[0]!;
    promotedFindingIds = new Set([...promotedFindingIds, provisional.id]);
    const existing = matches.find((match) => match.findingId === provisional.id);
    if (existing !== undefined) {
      matches = matches.map((match) => (
        match.findingId === provisional.id
          ? { ...match, rawFindingIds: [...new Set([...match.rawFindingIds, ...group.rawFindingIds])] }
          : match
      ));
    } else {
      matches = [...matches, {
        findingId: provisional.id,
        rawFindingIds: [...group.rawFindingIds],
        evidence: 'Clean review evidence deterministically confirmed the provisional observation as a real finding',
      }];
    }
  }

  for (const match of matches) {
    const provisional = provisionalById.get(match.findingId);
    if (provisional === undefined || promotedFindingIds.has(provisional.id)) {
      continue;
    }
    const provisionalIdentity = fullIdentityKeyOf(
      provisional.title,
      provisional.description,
    );
    const hasExactCleanRaw = match.rawFindingIds.some((rawFindingId) => {
      if (!input.cleanRawIds.has(rawFindingId)) {
        return false;
      }
      const wire = input.wireById.get(rawFindingId);
      return wire !== undefined
        && fullIdentityKeyOf(wire.title, wire.description) === provisionalIdentity;
    });
    if (hasExactCleanRaw) {
      promotedFindingIds = new Set([...promotedFindingIds, provisional.id]);
    }
  }

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
      const identity = fullIdentityKeyOf(wire.title, wire.description);
      const provisional = byUniqueIdentity.get(identity);
      if (provisional === undefined || provisional.id === match.findingId || promotedFindingIds.has(provisional.id)) {
        continue;
      }
      if (targetHasExactIdentity(match.findingId, identity)) {
        resolvedByMapping = new Map([...resolvedByMapping, [provisional.id, match.findingId]]);
      }
    }
  }

  return {
    output: { ...replay.output, newFindings, matches },
    promotedFindingIds,
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
      if (settlement.promotedFindingIds.has(finding.id) && finding.provisional !== undefined) {
        const promoted = { ...finding };
        delete promoted.provisional;
        promoted.revision = finding.revision + 1;
        return promoted;
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
    commands.push({
      operation,
      changes: {
        findings: [findingWithoutRevision(finding)],
        conflicts: [],
      },
      authority: { kind: 'verified_evidence' },
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
      settlementRawFindingIds(input.settlement, findingId),
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
    append(
      'resolve_finding',
      findingId,
      settlementRawFindingIds(input.settlement, findingId),
    );
  }
  return commands;
}
