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
  FindingObservation,
  FindingReconcileContext,
  IntakeContractDefect,
  RawFinding,
  RawFindingEvidence,
  ReviewerAnomalyEntry,
  ReviewerAnomalyKind,
} from './types.js';
import { computeReviewerAnomalyStableKey } from './raw-canonicalization.js';
import type { RestatementRequestBinding, RestatementRequestV1 } from './review-publication.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../../models/finding-types.js';

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

/**
 * correspondence が「言い直しとして受理できる」ために要求する claim atom
 * （demandable claim atom）。
 *
 * request が reviewer へ提示する文字列もこの関数へ委譲する。選択規則を2箇所に
 * 持つと、提示と要求が別の文字列になり得る — その request は reviewer が提示文を
 * 1文字も違わずコピーしても correspondence が成立せず、presentationLimit 回だけ
 * 再提示されて毎回 new finding を増やすだけの充足不能な要求になる。
 *
 * undefined を返す anomaly は言い直しでは決着できない。request を作ってはならず、
 * 提示を1回も行わずにその場で terminal disposition
 * （undemandable_claim_atom）へ落とす。title へフォールバックして request を
 * 作ると、まさに上の充足不能な要求になる。
 */
export function selectRestatementSourceClaimAtom(
  anomaly: Pick<ReviewerAnomalyEntry, 'claimedExcerpt'>,
  sourceRaw: Pick<RawFinding, 'description' | 'rawExcerpt'>,
): string | undefined {
  return sourceRaw.description?.trim().length
    ? sourceRaw.description
    : anomaly.claimedExcerpt?.trim().length
      ? anomaly.claimedExcerpt
      : sourceRaw.rawExcerpt?.trim().length
        ? sourceRaw.rawExcerpt
        : undefined;
}

function hasRestatementCorrespondence(input: {
  anomaly: ReviewerAnomalyEntry;
  sourceRaw: RawFinding;
  admittedRaw: RawFinding;
  request: RestatementRequestV1;
}): boolean {
  const { anomaly, sourceRaw, admittedRaw, request } = input;
  // 前段の shape 判定は候補計数と共通の1関数に集約する — 複製すると片方だけが
  // 変更されて「候補として数えるのに昇格しない/その逆」の不整合が生まれる。
  if (!hasRestatementCandidateShape(request, anomaly, sourceRaw, admittedRaw)) {
    return false;
  }
  const sourceAtom = selectRestatementSourceClaimAtom(anomaly, sourceRaw);
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

/**
 * escalation phase では、元の不完全な観測の所有者（owner reviewer）と、格上げで
 * clean な claim を出した reviewer が異なる。これが reviewer 一致要件の唯一の
 * 緩和点で、判別子は request.reviewer === 'escalation-reviewer' だけ。
 * owner が解決された profile に `escalate` が無ければ escalation request 自体が
 * 作られないため、この分岐は発火せず従来の条件式と等価になる。
 */
function hasRestatementCandidateShape(
  request: RestatementRequestV1,
  anomaly: ReviewerAnomalyEntry,
  sourceRaw: RawFinding,
  admittedRaw: RawFinding,
): boolean {
  const ownerReviewer = anomaly.intakeContract?.presentationOwnerReviewer;
  const reviewersMatch = request.reviewer === FINDING_ESCALATION_REVIEWER_ROUTING_KEY
    ? sourceRaw.reviewer === ownerReviewer && admittedRaw.reviewer === request.reviewer
    : request.reviewer === ownerReviewer
      && sourceRaw.reviewer === request.reviewer
      && admittedRaw.reviewer === request.reviewer;
  return request.anomalyId === anomaly.id
    && reviewersMatch
    && admittedRaw.relation === 'new'
    && admittedRaw.targetFindingId === null
    && admittedRaw.targetPrecondition === undefined;
}

/**
 * 「特定の anomaly を言い直した」と自己申告した raw が、照合ゲートを通らなかったか。
 *
 * 通らなかった再主張を新規 product finding として鋳造すると、同じ主張が言い直しの
 * たびに別 finding として積み上がる（実測で findings 膨張の原因）。呼び出し側は
 * これを admission で弾き、当該 anomaly への再試行の記録（rejected observation）
 * として残す。
 */
export function restatementReassertionFailsCorrespondence(input: {
  ledger: FindingLedger;
  admittedRaw: RawFinding;
  bindings: readonly RestatementRequestBinding[];
}): boolean {
  const echoedAnomalyId = input.admittedRaw.reassertsReviewerAnomalyId;
  if (echoedAnomalyId === undefined) {
    return false;
  }
  const echoedBindings = input.bindings.filter(
    (binding) => binding.request.anomalyId === echoedAnomalyId,
  );
  if (echoedBindings.length === 0) {
    // その anomaly の言い直しは、この呼び出しでは要求していない。要求していない
    // ものを「言い直しの失敗」とは判定できないので、echo を落として通常の新規
    // claim として評価させる（正当な新規指摘を殺さない）。台帳に無い anomaly ID を
    // 指す echo も、request が無い以上ここに落ちる。
    return false;
  }
  const anomaly = (input.ledger.reviewerAnomalies ?? []).find(
    (entry) => entry.id === echoedAnomalyId,
  );
  const sourceRaw = anomaly?.sourceRawFindingIds
    .map((rawFindingId) => input.ledger.rawFindings.find((raw) => raw.rawFindingId === rawFindingId))
    .find((raw) => raw !== undefined);
  if (anomaly === undefined || sourceRaw === undefined) {
    // request はあるのに照合対象の観測が台帳から消えている。比較のしようがないので
    // 同じく echo を落とす。
    return false;
  }
  return !echoedBindings.some((binding) => hasRestatementCorrespondence({
    anomaly,
    sourceRaw,
    admittedRaw: input.admittedRaw,
    request: binding.request,
  }));
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
  /**
   * このコミットで決着させる予定の anomaly id（後続レビュー登録による取り下げ
   * 候補。決着させるものが無ければ空集合）。upsert 対象から外し、同じ stableKey の
   * 新しい観測は必ず別 episode として着地させる — 決着する episode へ今ラウンドの
   * 観測を混ぜると、その観測ごとブロッキング効果が消えて「壊れ続けるレビュアーが
   * 一度もゲートを塞がない」状態になる。
   */
  closingAnomalyIds: ReadonlySet<string>,
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
      && !closingAnomalyIds.has(anomalies[index]!.id)
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
  // restatement promotion は「correspondence が成立した edge」だけを数え、anomaly 側・
  // raw 側の双方で exact-one の組だけに authority を与える。request binding は
  // publication（= report）単位で全 admitted raw に配られるため、shape 一致だけを
  // 数えると batch 内の全 raw が全 anomaly の候補になり、複数 restatement の
  // 同時成立が構造的に不可能になる（report 単位 binding の副作用）。
  const restatementEdges: Array<{
    anomalyId: string;
    rawFindingId: string;
    findingId: string;
  }> = [];
  const correspondingRawFindingIds = new Set<string>();
  for (const candidate of candidates) {
    const findingId = findingIdByRawFindingId.get(candidate.rawFindingId);
    const requestBindings = candidate.restatementRequestBindings ?? [];
    const admittedRaw = ledger.rawFindings.find((raw) => raw.rawFindingId === candidate.rawFindingId);
    const edgeAnomalyIds = new Set<string>();
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
        || !hasValidRestatementEcho(admittedRaw, anomaly, requestBindings)
        || edgeAnomalyIds.has(anomaly.id)
        || !hasRestatementCorrespondence({ anomaly, sourceRaw, admittedRaw, request: binding.request })
      ) {
        continue;
      }
      edgeAnomalyIds.add(anomaly.id);
      restatementEdges.push({
        anomalyId: anomaly.id,
        rawFindingId: candidate.rawFindingId,
        findingId,
      });
      correspondingRawFindingIds.add(candidate.rawFindingId);
    }
    // correspondence が成立しなかった raw は通常の新規 claim として扱い、既存の
    // lineage 昇格（非 intake anomaly 用）から除外しない。restatement 由来という
    // だけで一括抑止すると、restatement round 中の clean 観測が他 anomaly の
    // 回復に使えなくなる。
    if (findingId !== undefined && !correspondingRawFindingIds.has(candidate.rawFindingId)) {
      promotedFindingIdByLineageKey.set(candidate.lineageKey, findingId);
    }
  }
  const anomalyEdgeCounts = new Map<string, number>();
  const rawEdgeCounts = new Map<string, number>();
  for (const edge of restatementEdges) {
    anomalyEdgeCounts.set(edge.anomalyId, (anomalyEdgeCounts.get(edge.anomalyId) ?? 0) + 1);
    rawEdgeCounts.set(edge.rawFindingId, (rawEdgeCounts.get(edge.rawFindingId) ?? 0) + 1);
  }
  const restatementPromotionByAnomalyId = new Map<string, string>();
  for (const edge of restatementEdges) {
    if (
      anomalyEdgeCounts.get(edge.anomalyId) === 1
      && rawEdgeCounts.get(edge.rawFindingId) === 1
    ) {
      restatementPromotionByAnomalyId.set(edge.anomalyId, edge.findingId);
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
      const promotedFindingId = restatementPromotionByAnomalyId.get(anomaly.id);
      if (promotedFindingId !== undefined) {
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

/**
 * 「同じレビュアー枠の次の完全なレビューが台帳へ登録された」ことで決着させられる
 * 未決着 anomaly を選ぶ。判定はエンジンの決定的処理で完結する — manager/adjudicator の
 * 判断は要らない（後続レビューの成立は publication の有無で機械判定できる）。
 *
 * intake-contract anomaly は除外する。あちらは言い直し要求の注入 →
 * restatement 昇格 or terminalDisposition という固有の決着経路を持ち、
 * その予算（presentationLimit）の途中でここが取り下げると言い直しの機会を奪う。
 * 除外される他の kind（protocol-anomaly / quote-mismatch / stale-snapshot /
 * lifecycle-admission-failure）は言い直し経路を一切持たないため、この決着だけが
 * 唯一の終端になる。
 *
 * 複数の観測者を持つ anomaly は、その全員が今ラウンドのレビューを登録している
 * ときだけ候補にする（every）。一部のレビュアーしか再レビューしていない状態で
 * 取り下げると、まだ再提示の機会を得ていない観測者の主張ごとゲートを緩めることになる。
 */
export function collectReviewSupersededReviewerAnomalyIds(
  ledger: FindingLedger,
  reviewers: ReadonlySet<string>,
  /**
   * 判定ラダーを通った（verdict を伴う）publication を登録したレビュアー枠。
   * verdict 由来の anomaly はこちらでしか決着しない。
   */
  verdictReviewers: ReadonlySet<string> = reviewers,
): Set<string> {
  return new Set(
    (ledger.reviewerAnomalies ?? [])
      .filter((anomaly) => {
        if (
          !isOutstandingReviewerAnomaly(anomaly)
          || anomaly.intakeContract !== undefined
          || anomaly.reviewers.length === 0
        ) {
          return false;
        }
        // 「非承認判定 + claim ゼロ件」は verdict そのものを根拠に記録した anomaly。
        // verdict を伴わない再レビューで取り下げると、そのゲートが再レビューで
        // 洗い流されて予算に到達しなくなる。
        const settlingReviewers = anomaly.kind === 'verdict-claims-mismatch'
          ? verdictReviewers
          : reviewers;
        return anomaly.reviewers.every((reviewer) => settlingReviewers.has(reviewer));
      })
      .map((anomaly) => anomaly.id),
  );
}

/**
 * 後続レビュー登録による取り下げ（implicit withdrawal）を台帳へ記録する。
 * レコードは削除・改変しない — settlement を足すだけで、監査記録としては残る
 * （観測消去の禁止）。settlement が付いた anomaly は isOutstandingReviewerAnomaly が
 * false になり、when() のカウンタからも外れる（＝ブロッキング効果が消える）。
 *
 * candidateAnomalyIds は同じ publicationIdsByReviewer から
 * collectReviewSupersededReviewerAnomalyIds が選んだ集合であること。候補の全観測者が
 * publication を持つことはそこで保証されるので、ここでは引き直さない。
 */
export function withdrawReviewerAnomaliesSupersededByReview(input: {
  ledger: FindingLedger;
  candidateAnomalyIds: ReadonlySet<string>;
  /** レビュアー枠 → そのラウンドに登録された publication ID 全件（1件とは限らない）。 */
  publicationIdsByReviewer: ReadonlyMap<string, readonly string[]>;
  observation: FindingObservation;
}): FindingLedger {
  const anomalies = input.ledger.reviewerAnomalies;
  if (anomalies === undefined || input.candidateAnomalyIds.size === 0) {
    return input.ledger;
  }
  let changed = false;
  const updated = anomalies.map((anomaly) => {
    // 候補選定は取り込み前の台帳で行うため、選定後に昇格した anomaly が混じり得る。
    // 未決着の再確認だけは必ずここで行う（昇格が取り下げより優先される）。
    if (
      !input.candidateAnomalyIds.has(anomaly.id)
      || !isOutstandingReviewerAnomaly(anomaly)
    ) {
      return anomaly;
    }
    // 候補は「全観測者が今ラウンドの publication を持つ」もののみ（collect 側の
    // every 判定）。取り下げ根拠は観測者全員分を記録する — 1人分だけ残すと
    // 「誰の後続レビューで決着したのか」を監査で再構成できない。
    // 1レビュアー枠が同一ラウンドに複数 publication を持つ場合（格上げ再レビューの
    // owner 別グループ化）は、その全件を展開する。1件へ潰すと別 owner の
    // publication ID が根拠として記録され得る。順序は (reviewer, publicationId) の
    // binary 順で決定的にする。
    const supersedingPublications = [...anomaly.reviewers]
      .sort(compareBinaryStrings)
      .flatMap((reviewer) => [...input.publicationIdsByReviewer.get(reviewer)!]
        .sort(compareBinaryStrings)
        .map((publicationId) => ({ reviewer, publicationId })));
    changed = true;
    return {
      ...anomaly,
      settlement: {
        kind: 'withdrawn_by_subsequent_review' as const,
        supersedingPublications,
        decidedAt: input.observation,
      },
    };
  });
  return changed ? { ...input.ledger, reviewerAnomalies: updated } : input.ledger;
}

export function isOutstandingReviewerAnomaly(anomaly: ReviewerAnomalyEntry): boolean {
  return anomaly.promotedFindingId === undefined
    && anomaly.settlement === undefined
    && anomaly.intakeContract?.terminalDisposition?.workflowOutcome
      !== 'non_claim_observation_rejected';
}
