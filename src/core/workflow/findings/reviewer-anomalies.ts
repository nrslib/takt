/**
 * 二系統台帳（review-integrity protocol: typed evidence protocol + verbatimExcerpt 機械照合 +
 * 二系統台帳 + gate 分離）の review-integrity 側の台帳操作。
 *
 * product finding（FindingLedgerEntry、findings 配列）とは完全に独立した配列
 * （reviewerAnomalies）へ隔離する。安全不変条件（すべてこのモジュール
 * だけで守る）:
 *   - invalidated/resolved/waived として扱わない（ReviewerAnomalyEntry に
 *     そもそもそういう状態フィールドが無い — 型で保証）
 *   - 既存 finding の状態・revision・evidence hash を変更しない（別配列を返す
 *     だけで、呼び出し元は findings 配列に一切触れない）
 *   - 観測を削除しない（未決着 episode の upsert は source を包含し、決着済み
 *     episode の再観測は別レコードへ保存する）
 *   - 「引用が違うので問題は存在しない」と記録しない（mismatchReason は
 *     「証拠が不成立」の事実だけを記述する契約 — 呼び出し元の責務）
 */
import { createHash } from 'node:crypto';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  CanonicalRawFinding,
  FindingLedger,
  FindingReconcileContext,
  IntakeContractDefect,
  RawFinding,
  RawFindingEvidence,
  ReviewerAnomalyEntry,
  ReviewerAnomalyKind,
} from './types.js';
import { computeReviewerAnomalyStableKey } from './raw-canonicalization.js';
import type { RestatementRequestBinding, RestatementRequestV1 } from './review-publication.js';

export interface ReviewerAnomalySpec {
  kind: ReviewerAnomalyKind;
  stableKey: string;
  lineageKey: string;
  sourceRawFindingIds: string[];
  sourceIntakeIds: string[];
  reviewers: string[];
  title: string;
  claimedLocation?: string;
  claimedExcerpt?: string;
  mismatchReason: string;
  intakeContract?: IntakeContractDefect;
}

export function createReviewerAnomalySpec(input: {
  wire: RawFinding;
  canonical: CanonicalRawFinding;
  anomalyKind: ReviewerAnomalyKind;
  reason: string;
  failedEvidence?: RawFindingEvidence;
  intakeContract?: IntakeContractDefect;
}): ReviewerAnomalySpec {
  const fileQuote = input.failedEvidence?.kind === 'file_quote'
    ? input.failedEvidence
    : undefined;
  const originalClaimExcerpt = input.wire.description?.trim().length
    ? input.wire.description
    : input.wire.rawExcerpt?.trim().length
      ? input.wire.rawExcerpt
      : input.canonical.rawExcerpt;
  const claimedExcerpt = fileQuote?.kind === 'file_quote'
    ? fileQuote.verbatimExcerpt
    : originalClaimExcerpt ?? input.canonical.rawExcerpt;
  return {
    kind: input.anomalyKind,
    stableKey: computeReviewerAnomalyStableKey({
      reviewerStableKey: input.canonical.reviewerStableKey,
      lineageKey: input.canonical.lineageKey,
      anomalyKind: input.anomalyKind,
      ...(input.anomalyKind === 'intake-contract-incomplete'
        ? { sourceExcerptDigest: input.wire.sourceBinding.excerptDigest }
        : {}),
    }),
    lineageKey: input.canonical.lineageKey,
    sourceRawFindingIds: [input.wire.rawFindingId],
    sourceIntakeIds: [],
    reviewers: [input.wire.reviewer],
    title: input.wire.title ?? `Reviewer evidence anomaly ${input.wire.rawFindingId}`,
    ...(fileQuote?.kind === 'file_quote' ? { claimedLocation: fileQuote.path } : {}),
    ...(claimedExcerpt !== undefined && claimedExcerpt.length > 0
      ? { claimedExcerpt }
      : {}),
    mismatchReason: input.reason,
    ...(input.intakeContract === undefined ? {} : { intakeContract: structuredClone(input.intakeContract) }),
  };
}

/**
 * 決定的・内容アドレス方式の id（conflict-identity.ts の formatConflictId と同じ発想:
 * LLM が id を採番・参照することは無い — reviewer anomaly は product finding と
 * 違い、どの LLM にも id を返させないため、F-XXXX のような密な連番カウンタは
 * 不要）。未決着 episode は stableKey で upsert し、決着後の再観測だけは
 * 新しい source observation を seed に別 id を決定する。
 */
function formatReviewerAnomalyId(stableKey: string, episodeSeed?: string): string {
  const identity = episodeSeed === undefined
    ? stableKey
    : `${stableKey}\0episode\0${episodeSeed}`;
  return `RA-${createHash('sha256').update(identity).digest('hex').slice(0, 12).toUpperCase()}`;
}

function mergeUnique(current: readonly string[], next: readonly string[]): string[] {
  return Array.from(new Set([...current, ...next]));
}

function normalizeClaimAtom(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function hasRestatementCorrespondence(input: {
  anomaly: ReviewerAnomalyEntry;
  sourceRaw: RawFinding;
  admittedRaw: RawFinding;
  request: RestatementRequestV1;
}): boolean {
  const { anomaly, sourceRaw, admittedRaw, request } = input;
  if (
    request.anomalyId !== anomaly.id
    || request.reviewer !== anomaly.intakeContract?.presentationOwnerReviewer
    || sourceRaw.reviewer !== request.reviewer
    || admittedRaw.reviewer !== request.reviewer
    || admittedRaw.relation !== 'new'
    || admittedRaw.targetFindingId !== null
    || admittedRaw.targetPrecondition !== undefined
  ) {
    return false;
  }
  const sourceAtom = sourceRaw.description?.trim().length
    ? sourceRaw.description
    : anomaly.claimedExcerpt?.trim().length
      ? anomaly.claimedExcerpt
      : sourceRaw.rawExcerpt?.trim().length
        ? sourceRaw.rawExcerpt
        : undefined;
  const admittedAtom = admittedRaw.description?.trim().length
    ? admittedRaw.description
    : undefined;
  if (sourceAtom === undefined || admittedAtom === undefined) {
    return false;
  }
  if (normalizeClaimAtom(sourceAtom) !== normalizeClaimAtom(admittedAtom)) {
    return false;
  }
  const sourceQuotes = sourceRaw.evidence.filter((evidence) => evidence.kind === 'file_quote');
  if (sourceQuotes.length === 0) {
    return true;
  }
  const admittedQuotes = admittedRaw.evidence.filter((evidence) => evidence.kind === 'file_quote');
  return sourceQuotes.every((sourceQuote) => admittedQuotes.some((admittedQuote) => (
    admittedQuote.path === sourceQuote.path
    && admittedQuote.startLine === sourceQuote.startLine
    && admittedQuote.endLine === sourceQuote.endLine
    && admittedQuote.verbatimExcerpt === sourceQuote.verbatimExcerpt
  )));
}

function hasRestatementCandidateShape(
  request: RestatementRequestV1,
  anomaly: ReviewerAnomalyEntry,
  sourceRaw: RawFinding,
  admittedRaw: RawFinding,
): boolean {
  return request.anomalyId === anomaly.id
    && request.reviewer === anomaly.intakeContract?.presentationOwnerReviewer
    && sourceRaw.reviewer === request.reviewer
    && admittedRaw.reviewer === request.reviewer
    && admittedRaw.relation === 'new'
    && admittedRaw.targetFindingId === null
    && admittedRaw.targetPrecondition === undefined;
}

function hasValidRestatementEcho(
  admittedRaw: RawFinding,
  anomaly: ReviewerAnomalyEntry,
  bindings: readonly RestatementRequestBinding[],
): boolean {
  const echoedAnomalyId = admittedRaw.reassertsReviewerAnomalyId;
  if (echoedAnomalyId === undefined) {
    return true;
  }
  return echoedAnomalyId === anomaly.id
    && bindings.some((binding) => binding.request.anomalyId === echoedAnomalyId);
}

function anomalySpecObservationKey(spec: ReviewerAnomalySpec): string {
  const observations = [
    ...spec.sourceRawFindingIds.map((id) => `raw:${id}`),
    ...spec.sourceIntakeIds.map((id) => `intake:${id}`),
  ].sort(compareBinaryStrings);
  if (observations.length === 0) {
    throw new Error(`Reviewer anomaly "${spec.stableKey}" has no source observation`);
  }
  return observations.join('\0');
}

function specAlreadyApplied(
  anomaly: ReviewerAnomalyEntry,
  spec: ReviewerAnomalySpec,
): boolean {
  return spec.sourceRawFindingIds.every((id) => anomaly.sourceRawFindingIds.includes(id))
    && spec.sourceIntakeIds.every((id) => anomaly.sourceIntakeIds.includes(id));
}

function assertSameAnomalyIdentity(
  anomaly: ReviewerAnomalyEntry,
  spec: ReviewerAnomalySpec,
): void {
  if (
    anomaly.kind !== spec.kind
    || (anomaly.kind !== 'intake-contract-incomplete' && anomaly.lineageKey !== spec.lineageKey)
  ) {
    throw new Error(
      `Reviewer anomaly stable key "${spec.stableKey}" cannot identify different anomaly content`,
    );
  }
  if (anomaly.kind === 'intake-contract-incomplete') {
    if (anomaly.intakeContract === undefined || spec.intakeContract === undefined) {
      throw new Error(`Reviewer anomaly stable key "${spec.stableKey}" is missing intake contract metadata`);
    }
    if (
      anomaly.intakeContract.presentationOwnerReviewer !== spec.intakeContract.presentationOwnerReviewer
      || anomaly.intakeContract.classificationAuthorityId !== spec.intakeContract.classificationAuthorityId
    ) {
      throw new Error(`Reviewer anomaly stable key "${spec.stableKey}" cannot change intake contract ownership or limit`);
    }
  }
}

/**
 * reviewer anomaly spec を台帳へ追記適用する（upsert by outstanding stableKey）。
 * provisional の applyProvisionalFindingSpecs（reconciler.ts）と同じ「同じ
 * stableKey の未決着 episode があれば更新、無ければ新規」則だが、意図的に別実装にしている —
 * 対象レコード型（ReviewerAnomalyEntry には status/lifecycle/revision/waivers が
 * 無く、gate-blocking の概念も無い）も安全不変条件（既存 finding 側は一切
 * 触らない）もドメインとして別物であり、無理に共通化すると「product finding の
 * upsert 則」と「review-integrity の upsert 則」の差分が読みにくくなる。
 */
export function applyReviewerAnomalySpecsToLedger(
  ledger: FindingLedger,
  specs: readonly ReviewerAnomalySpec[],
  context: FindingReconcileContext,
): FindingLedger {
  if (specs.length === 0) {
    return ledger;
  }
  const observation = { runId: context.runId, stepName: context.stepName, timestamp: context.timestamp };
  const anomalies = [...(ledger.reviewerAnomalies ?? [])];
  const orderedSpecs = [...specs].sort((left, right) => (
    compareBinaryStrings(left.stableKey, right.stableKey)
    || compareBinaryStrings(
      anomalySpecObservationKey(left),
      anomalySpecObservationKey(right),
    )
  ));

  for (const spec of orderedSpecs) {
    const matchingIndexes = anomalies.flatMap((entry, index) => (
      entry.stableKey === spec.stableKey ? [index] : []
    ));
    for (const index of matchingIndexes) {
      assertSameAnomalyIdentity(anomalies[index]!, spec);
    }
    const outstandingIndexes = matchingIndexes.filter((index) => (
      isOutstandingReviewerAnomaly(anomalies[index]!)
    ));
    if (outstandingIndexes.length > 1) {
      throw new Error(
        `Reviewer anomaly stable key "${spec.stableKey}" has multiple outstanding episodes`,
      );
    }
    const existingIndex = outstandingIndexes[0];
    const existing = existingIndex === undefined ? undefined : anomalies[existingIndex];
    if (existing !== undefined) {
      // crash/replay 冪等（review-integrity requirement）: occurrences は「観測された
      // 回数」なので、同一 raw finding id の再適用（同一ラウンドが二度コミット
      // される crash/replay）で二重計上してはならない。stop budget の round
      // marker（適用済みマーカー集合）と同じ思想で、適用済みの raw finding id
      // または intake id を冪等判定キーにする — 入力 spec が既存に無い新しい
      // 観測 id を1件も持ち込まないなら、それは既適用の再来なので完全な no-op にする
      // （occurrences も lastObserved も mismatchReason も動かさない）。別ラウンドの
      // 再観測は名前空間付き raw finding id（runId:step:iter:reviewer:localId）が
      // 必ず異なるため新規 id として現れ、正しく +1 される。
      const bringsNewObservation = spec.sourceRawFindingIds.some(
        (id) => !existing.sourceRawFindingIds.includes(id),
      ) || spec.sourceIntakeIds.some(
        (id) => !existing.sourceIntakeIds.includes(id),
      );
      if (!bringsNewObservation) {
        continue;
      }
      anomalies[existingIndex!] = {
        ...existing,
        sourceRawFindingIds: mergeUnique(existing.sourceRawFindingIds, spec.sourceRawFindingIds),
        sourceIntakeIds: mergeUnique(existing.sourceIntakeIds, spec.sourceIntakeIds),
        reviewers: mergeUnique(existing.reviewers, spec.reviewers),
        mismatchReason: spec.mismatchReason,
        lastObserved: observation,
        occurrences: existing.occurrences + 1,
        // 最新の claim を監査用に保持する（無ければ前回値を残す）。
        ...(spec.claimedLocation !== undefined ? { claimedLocation: spec.claimedLocation } : {}),
        ...(spec.claimedExcerpt !== undefined ? { claimedExcerpt: spec.claimedExcerpt } : {}),
      };
      continue;
    }
    if (matchingIndexes.some((index) => specAlreadyApplied(anomalies[index]!, spec))) {
      continue;
    }
    const episodeSeed = matchingIndexes.length === 0
      ? undefined
      : anomalySpecObservationKey(spec);
    const id = formatReviewerAnomalyId(spec.stableKey, episodeSeed);
    if (anomalies.some((entry) => entry.id === id)) {
      throw new Error(`Reviewer anomaly id "${id}" identifies a different episode`);
    }
    anomalies.push({
      id,
      kind: spec.kind,
      stableKey: spec.stableKey,
      lineageKey: spec.lineageKey,
      sourceRawFindingIds: [...spec.sourceRawFindingIds],
      sourceIntakeIds: [...spec.sourceIntakeIds],
      reviewers: [...spec.reviewers],
      title: spec.title,
      ...(spec.claimedLocation !== undefined ? { claimedLocation: spec.claimedLocation } : {}),
      ...(spec.claimedExcerpt !== undefined ? { claimedExcerpt: spec.claimedExcerpt } : {}),
      mismatchReason: spec.mismatchReason,
      ...(spec.intakeContract === undefined ? {} : { intakeContract: structuredClone(spec.intakeContract) }),
      firstObserved: observation,
      lastObserved: observation,
      occurrences: 1,
    });
  }

  return { ...ledger, reviewerAnomalies: anomalies };
}

export interface ReviewerAnomalyPromotionCandidate {
  /** 昇格判定に使う lineageKey（同一 claim の同定キー）。 */
  lineageKey: string;
  /** この raw を含む product finding を reconciled ledger から探すためのキー。 */
  rawFindingId: string;
  /** engine-owned request binding for intake-contract correspondence */
  restatementRequestBindings?: readonly RestatementRequestBinding[];
}

/**
 * 後続ラウンドの clean な verbatimExcerpt 一致が product finding を確定させた
 * 場合に、同じ lineageKey を持つ未決着の reviewer anomaly へ promotedFindingId を
 * 記録する。レコード自体は削除・改変しない — 昇格後も監査履歴として
 * 残る（観測消去の禁止）。呼び出し元は reconcile 完了後の最終 ledger（finding id
 * 割当済み）を渡すこと — このタイミングでしか「どの finding id に着地したか」が
 * 確定しない。
 */
export function linkPromotedReviewerAnomalies(
  ledger: FindingLedger,
  candidates: readonly ReviewerAnomalyPromotionCandidate[],
): FindingLedger {
  const anomalies = ledger.reviewerAnomalies;
  if (anomalies === undefined || anomalies.length === 0 || candidates.length === 0) {
    return ledger;
  }
  const findingIdByRawFindingId = new Map<string, string>();
  for (const finding of ledger.findings) {
    for (const rawFindingId of finding.rawFindingIds) {
      findingIdByRawFindingId.set(rawFindingId, finding.id);
    }
  }
  const promotedFindingIdByLineageKey = new Map<string, string>();
  const restatementCandidateCountByAnomalyId = new Map<string, number>();
  const restatementPromotionByAnomalyId = new Map<string, string>();
  for (const candidate of candidates) {
    const findingId = findingIdByRawFindingId.get(candidate.rawFindingId);
    let handledAsRestatement = false;
    const requestBindings = candidate.restatementRequestBindings ?? [];
    const admittedRaw = ledger.rawFindings.find((raw) => raw.rawFindingId === candidate.rawFindingId);
    const handledRestatementAnomalyIds = new Set<string>();
    for (const binding of requestBindings) {
      const anomaly = anomalies.find((entry) => entry.id === binding.request.anomalyId);
      const sourceRaw = anomaly?.sourceRawFindingIds
        .map((rawFindingId) => ledger.rawFindings.find((raw) => raw.rawFindingId === rawFindingId))
        .find((raw) => raw !== undefined);
      if (
        findingId === undefined
        || anomaly?.kind !== 'intake-contract-incomplete'
        || anomaly.promotedFindingId !== undefined
        || anomaly.settlement !== undefined
        || sourceRaw === undefined
        || admittedRaw === undefined
        || binding.reportDigest !== admittedRaw.sourceBinding.reportDigest
        || !hasRestatementCandidateShape(binding.request, anomaly, sourceRaw, admittedRaw)
        || !hasValidRestatementEcho(admittedRaw, anomaly, requestBindings)
      ) {
        continue;
      }
      handledAsRestatement = true;
      const anomalyId = anomaly.id;
      if (handledRestatementAnomalyIds.has(anomalyId)) {
        continue;
      }
      handledRestatementAnomalyIds.add(anomalyId);
      restatementCandidateCountByAnomalyId.set(
        anomalyId,
        (restatementCandidateCountByAnomalyId.get(anomalyId) ?? 0) + 1,
      );
      if (hasRestatementCorrespondence({ anomaly, sourceRaw, admittedRaw, request: binding.request })) {
        restatementPromotionByAnomalyId.set(anomalyId, findingId);
      }
    }
    if (requestBindings.length > 0) {
      handledAsRestatement = true;
    }
    if (findingId !== undefined && !handledAsRestatement) {
      promotedFindingIdByLineageKey.set(candidate.lineageKey, findingId);
    }
  }
  if (promotedFindingIdByLineageKey.size === 0 && restatementPromotionByAnomalyId.size === 0) {
    return ledger;
  }
  let changed = false;
  const updated = anomalies.map((anomaly) => {
    if (!isOutstandingReviewerAnomaly(anomaly)) {
      return anomaly;
    }
    if (anomaly.kind === 'intake-contract-incomplete') {
      const candidateCount = restatementCandidateCountByAnomalyId.get(anomaly.id) ?? 0;
      const promotedFindingId = restatementPromotionByAnomalyId.get(anomaly.id);
      if (candidateCount === 1 && promotedFindingId !== undefined) {
        changed = true;
        return { ...anomaly, promotedFindingId };
      }
      return anomaly;
    }
    const promotedFindingId = promotedFindingIdByLineageKey.get(anomaly.lineageKey);
    if (promotedFindingId === undefined) {
      return anomaly;
    }
    changed = true;
    return { ...anomaly, promotedFindingId };
  });
  return changed ? { ...ledger, reviewerAnomalies: updated } : ledger;
}

export function isOutstandingReviewerAnomaly(anomaly: ReviewerAnomalyEntry): boolean {
  return anomaly.promotedFindingId === undefined
    && anomaly.settlement === undefined
    && anomaly.intakeContract?.terminalDisposition?.workflowOutcome
      !== 'non_claim_observation_rejected';
}
