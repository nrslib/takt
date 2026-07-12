/**
 * v2 梯子設計の二層スキーマ境界（設計書 §2〜§3）。
 *
 * - reviewer structured output は「寛容な per-item parse」で
 *   ReviewerRawFindingCandidate に落とす。1件の不正 raw が配列全体の Zod parse
 *   失敗として run を殺す構造（v3-r3 実測: gemma の kind/relation 矛盾1件で
 *   run 全体 abort）をここで断つ。
 * - canonical 生成関数は canonicalizeReviewerRawFinding の1つだけ。reviewer 用・
 *   legacy 用・test 用に別の生成関数を作らない。legacy ledger を読む場合も
 *   candidateFromLegacyRawFinding が candidate を作り、同じ関数を通す。
 * - brand は型レベル（unique symbol）に加えて runtime でも強制する: factory が
 *   WeakSet/WeakMap に登録し、downstream（機械分類・reconciler・manager prompt）
 *   の入口が assertCanonicalRawFinding で照合する。型 assertion や spread で
 *   作った object は WeakSet に居ないため runtime で拒否される（攻撃2の固定）。
 * - taint（provenance.ambiguityOrigin）は同一梯子内では消さない。correction で
 *   形式が整っても ambiguityOrigin: true を保持する（設計書 §3）。
 * - capability はエンジンだけが発行する。LLM の出力フィールドからは受け取らない。
 */

import { createHash } from 'node:crypto';
import {
  FINDING_SEVERITIES,
  RAW_FINDING_EVIDENCE_KINDS,
  RAW_FINDING_KINDS,
  RAW_FINDING_RELATIONS,
} from '../../models/finding-types.js';
import type {
  AmbiguousCanonicalRawFinding,
  AmbiguousRawCapabilities,
  CanonicalRawFinding,
  CoherentCanonicalRawFinding,
  FindingLedger,
  FindingLedgerEntry,
  FindingSeverity,
  RawAmbiguityCode,
  RawFinding,
  RawFindingEvidence,
  RawFindingEvidenceKind,
  RawFindingKind,
  RawFindingRelation,
  ReviewerRawFindingCandidate,
} from './types.js';
import { deriveRawFindingRelation, kindForRelation } from './schemas.js';
import { normalizeFindingText, parseFindingLocation, parseFindingLocationRange } from './location.js';
import { RAW_LADDER_POLICY_VERSION } from './raw-finding-limits.js';

// ---------------------------------------------------------------------------
// runtime brand（factory を通らない object を downstream で拒否するための登録簿）
// ---------------------------------------------------------------------------

const CANDIDATE_REGISTRY = new WeakSet<object>();
const CANDIDATE_ORIGINS = new WeakMap<object, 'reviewer' | 'legacy-ledger' | 'system'>();
const CANONICAL_REGISTRY = new WeakSet<object>();

export function isReviewerRawFindingCandidate(value: unknown): value is ReviewerRawFindingCandidate {
  return typeof value === 'object' && value !== null && CANDIDATE_REGISTRY.has(value);
}

export function isCanonicalRawFinding(value: unknown): value is CanonicalRawFinding {
  return typeof value === 'object' && value !== null && CANONICAL_REGISTRY.has(value);
}

/** downstream（機械分類・reconciler・manager prompt 構築）の入口で呼ぶ。 */
export function assertCanonicalRawFinding(value: unknown, context: string): asserts value is CanonicalRawFinding {
  if (!isCanonicalRawFinding(value)) {
    throw new Error(`${context}: received a raw finding that did not come from canonicalizeReviewerRawFinding (candidate/canonical type confusion)`);
  }
}

// ---------------------------------------------------------------------------
// 決定的キー・ハッシュ
// ---------------------------------------------------------------------------

function sha256Of(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export function computeReviewerStableKey(input: {
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
  reviewerPersonaKey: string;
}): string {
  return sha256Of('reviewer-stable-key', input.workflowName, input.callNamespace, input.parentStepName, input.reviewerPersonaKey);
}

function normalizedPathOf(location: string | undefined): string {
  return parseFindingLocation(location)?.path ?? '';
}

function normalizedTitleOf(title: string | undefined): string {
  return title === undefined ? '' : normalizeFindingText(title).toLowerCase();
}

/**
 * 再発同定の lineage key（設計書 §8）。行番号・run ID・step iteration・
 * タイムスタンプ・LLM 説明文全文は入れない。
 */
export function computeLineageKey(input: {
  targetFindingId?: string;
  collidingFindingId?: string;
  location?: string;
  title?: string;
  familyTag?: string;
}): string {
  const path = normalizedPathOf(input.location);
  const title = normalizedTitleOf(input.title);
  if (input.targetFindingId !== undefined) {
    return sha256Of('target', input.targetFindingId, path, title);
  }
  if (input.collidingFindingId !== undefined) {
    return sha256Of('collision', input.collidingFindingId, path, title);
  }
  const familyTag = input.familyTag === undefined ? '' : normalizeFindingText(input.familyTag).toLowerCase();
  return sha256Of('claim', path, title, familyTag);
}

/**
 * raw の evidence hash。行番号・rawFindingId・runId は含めない（それらだけを
 * 変えた再発は「同一 evidence」= manager を再呼び出さない — 攻撃5対策）。
 * description 等の実質変更は hash を変え、再解釈候補になる（ただし epoch 上限
 * MAX 2 / lineage は raw-finding-limits.ts が別途強制する）。
 */
export function computeRawEvidenceHash(fields: {
  relation?: RawFindingRelation;
  targetFindingId?: string;
  title?: string;
  description?: string;
  suggestion?: string;
  severity?: FindingSeverity;
  familyTag?: string;
  location?: string;
}): string {
  return sha256Of(
    'raw-evidence',
    fields.relation ?? '',
    fields.targetFindingId ?? '',
    normalizedPathOf(fields.location),
    fields.title === undefined ? '' : normalizeFindingText(fields.title),
    fields.description === undefined ? '' : normalizeFindingText(fields.description),
    fields.suggestion === undefined ? '' : normalizeFindingText(fields.suggestion),
    fields.severity ?? '',
    fields.familyTag === undefined ? '' : normalizeFindingText(fields.familyTag),
  );
}

export function computeProvisionalStableKey(input: {
  reviewerStableKey: string;
  lineageKey: string;
  provisionalKind: string;
}): string {
  return sha256Of('provisional-stable-key', input.reviewerStableKey, input.lineageKey, input.provisionalKind, String(RAW_LADDER_POLICY_VERSION));
}

/**
 * reviewer anomaly（codex 対策#4: 二系統台帳の review-integrity 側）の再発同定
 * キー。computeProvisionalStableKey と同じ形だが名前空間を分ける
 * （'reviewer-anomaly-stable-key' プレフィックス）ため、同じ
 * (reviewerStableKey, lineageKey) でも provisional と anomaly の stableKey が
 * 衝突しない。
 */
export function computeReviewerAnomalyStableKey(input: {
  reviewerStableKey: string;
  lineageKey: string;
  anomalyKind: string;
}): string {
  return sha256Of('reviewer-anomaly-stable-key', input.reviewerStableKey, input.lineageKey, input.anomalyKind, String(RAW_LADDER_POLICY_VERSION));
}

/** reviewer 全量超過の単一 blocker 用（設計書 §10 の overflow stableKey 規則）。 */
export function computeOverflowStableKey(reviewerStableKey: string): string {
  return sha256Of(reviewerStableKey, 'reviewer-output-overflow');
}

export function computeInterpretationKey(input: {
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
}): string {
  return sha256Of('interpretation-key', input.reviewerStableKey, input.lineageKey, input.candidateEvidenceHash, String(RAW_LADDER_POLICY_VERSION));
}

// ---------------------------------------------------------------------------
// candidate factories（寛容 parse。ここでは絶対に throw しない）
// ---------------------------------------------------------------------------

export interface ReviewerRawIntakeContext {
  workflowName: string;
  /** workflow_call の呼び出し名前空間。トップレベルでは空文字列。 */
  callNamespace: string;
  parentStepName: string;
  stepIteration: number;
  runId: string;
  /** reviewer サブステップ名（raw finding id の名前空間に使う既存規約）。 */
  reviewerStepName: string;
  /** reviewer の persona キー（reviewerStableKey の構成要素、設計書 §8）。 */
  reviewerPersonaKey: string;
}

function namespacedRawFindingId(context: ReviewerRawIntakeContext, rawFindingId: string): string {
  return [
    context.runId,
    ...(context.callNamespace ? [context.callNamespace] : []),
    context.parentStepName,
    String(context.stepIteration),
    context.reviewerStepName,
    rawFindingId,
  ].join(':');
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickSeverity(value: unknown): FindingSeverity | undefined {
  return typeof value === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(value)
    ? value as FindingSeverity
    : undefined;
}

function pickRelation(value: unknown): RawFindingRelation | undefined {
  return typeof value === 'string' && (RAW_FINDING_RELATIONS as readonly string[]).includes(value)
    ? value as RawFindingRelation
    : undefined;
}

function pickKind(value: unknown): RawFindingKind | undefined {
  return typeof value === 'string' && (RAW_FINDING_KINDS as readonly string[]).includes(value)
    ? value as RawFindingKind
    : undefined;
}

function pickEvidenceKind(value: unknown): RawFindingEvidenceKind | undefined {
  return typeof value === 'string' && (RAW_FINDING_EVIDENCE_KINDS as readonly string[]).includes(value)
    ? value as RawFindingEvidenceKind
    : undefined;
}

/**
 * typed evidence protocol(codex 対策#4)の組み立て。provider-facing の flat wire
 * フィールド(evidenceKind/verbatimExcerpt/snapshotId)と location から、ネスト済み
 * RawFindingEvidence を作る唯一の関数 — candidate factory
 * (createReviewerRawFindingCandidates)だけがここを通す。
 *
 * - locationless: explanation は独立の wire フィールドを持たせず description を
 *   流用する(弱いモデルへ要求する必須フィールドを増やさない設計判断)。location が
 *   非空でも(「存在するはずの path」を主張する claim)組み立てる — 「存在しない
 *   ことが根拠」の claim を無理に source_quote へ押し込めない、という codex の
 *   要請どおり、verbatimExcerpt 照合の対象にしない。
 * - source_quote: verbatimExcerpt・snapshotId が両方揃い、かつ location が
 *   「path:line」か「path:start-end」のどちらかの形で行範囲を持つ場合のみ組み立てる。
 *   1点でも欠けたら undefined(evidence なし)を返す — 呼び出し元
 *   (admission-validation.ts の呼び出し側)は「evidence なし」を「location 付き
 *   claim なら不採用」として扱う(欠損を有利に解釈しない)。
 */
export function resolveRawFindingEvidence(fields: {
  evidenceKind?: RawFindingEvidenceKind;
  verbatimExcerpt?: string;
  snapshotId?: string;
  location?: string;
  description?: string;
}): RawFindingEvidence | undefined {
  if (fields.evidenceKind === 'locationless') {
    return { kind: 'locationless', explanation: fields.description ?? '(no description)' };
  }
  if (fields.evidenceKind !== 'source_quote') {
    return undefined;
  }
  if (fields.verbatimExcerpt === undefined || fields.snapshotId === undefined) {
    return undefined;
  }
  const range = parseFindingLocationRange(fields.location) ?? singleLineRange(fields.location);
  if (range === undefined) {
    return undefined;
  }
  return {
    kind: 'source_quote',
    path: range.path,
    startLine: range.startLine,
    endLine: range.endLine,
    verbatimExcerpt: fields.verbatimExcerpt,
    snapshotId: fields.snapshotId,
  };
}

function singleLineRange(location: string | undefined): { path: string; startLine: number; endLine: number } | undefined {
  const parsed = parseFindingLocation(location);
  return parsed?.line !== undefined ? { path: parsed.path, startLine: parsed.line, endLine: parsed.line } : undefined;
}

/** brand プロパティ（unique symbol）を型レベルで付与する唯一の cast 地点。runtime の同一性は WeakSet/WeakMap 登録が担保する。 */
type UnbrandedCandidate = {
  [K in keyof ReviewerRawFindingCandidate as K extends symbol ? never : K]: ReviewerRawFindingCandidate[K];
};

function registerCandidate(
  candidate: UnbrandedCandidate,
  origin: 'reviewer' | 'legacy-ledger' | 'system',
): ReviewerRawFindingCandidate {
  const branded = candidate as unknown as ReviewerRawFindingCandidate;
  CANDIDATE_REGISTRY.add(branded);
  CANDIDATE_ORIGINS.set(branded, origin);
  return branded;
}

type UnbrandedCoherent = {
  [K in keyof CoherentCanonicalRawFinding as K extends symbol ? never : K]: CoherentCanonicalRawFinding[K];
};
type UnbrandedAmbiguous = {
  [K in keyof AmbiguousCanonicalRawFinding as K extends symbol ? never : K]: AmbiguousCanonicalRawFinding[K];
};

function registerCoherentCanonical(value: UnbrandedCoherent): CoherentCanonicalRawFinding {
  const branded = value as unknown as CoherentCanonicalRawFinding;
  CANONICAL_REGISTRY.add(branded);
  return branded;
}

function registerAmbiguousCanonical(value: UnbrandedAmbiguous): AmbiguousCanonicalRawFinding {
  const branded = value as unknown as AmbiguousCanonicalRawFinding;
  CANONICAL_REGISTRY.add(branded);
  return branded;
}

/**
 * reviewer structured output の rawFindings 配列（未検証 unknown）を candidate に
 * 落とす。個々の項目がどれほど壊れていても throw しない — 欠損は candidate 上で
 * optional のまま保持し、canonicalization が ambiguity code に変換する。
 */
export function createReviewerRawFindingCandidates(
  items: readonly unknown[],
  context: ReviewerRawIntakeContext,
): ReviewerRawFindingCandidate[] {
  const reviewerStableKey = computeReviewerStableKey({
    workflowName: context.workflowName,
    callNamespace: context.callNamespace,
    parentStepName: context.parentStepName,
    reviewerPersonaKey: context.reviewerPersonaKey,
  });
  return items.map((item, index) => {
    const record = typeof item === 'object' && item !== null && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const reviewerRawFindingId = pickString(record.rawFindingId);
    const intakeId = namespacedRawFindingId(context, reviewerRawFindingId ?? `item-${index + 1}`);
    // 構造化出力の strict 様式では該当なしの欄が空文字で埋まるため、空文字は
    // 未指定として扱う（pickString が弾く）。
    const evidence = resolveRawFindingEvidence({
      evidenceKind: pickEvidenceKind(record.evidenceKind),
      verbatimExcerpt: pickString(record.verbatimExcerpt),
      snapshotId: pickString(record.snapshotId),
      location: pickString(record.location),
      description: pickString(record.description),
    });
    return registerCandidate({
      intakeId,
      reviewerStableKey,
      ...(reviewerRawFindingId !== undefined ? { reviewerRawFindingId } : {}),
      ...(pickString(record.familyTag) !== undefined ? { familyTag: pickString(record.familyTag)! } : {}),
      ...(pickSeverity(record.severity) !== undefined ? { severity: pickSeverity(record.severity)! } : {}),
      ...(pickString(record.title) !== undefined ? { title: pickString(record.title)! } : {}),
      ...(pickString(record.location) !== undefined ? { location: pickString(record.location)! } : {}),
      ...(pickString(record.description) !== undefined ? { description: pickString(record.description)! } : {}),
      ...(pickString(record.suggestion) !== undefined ? { suggestion: pickString(record.suggestion)! } : {}),
      ...(pickRelation(record.relation) !== undefined ? { relation: pickRelation(record.relation)! } : {}),
      ...(pickString(record.targetFindingId) !== undefined ? { targetFindingId: pickString(record.targetFindingId)! } : {}),
      ...(pickKind(record.kind) !== undefined ? { legacyKind: pickKind(record.kind)! } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
      sourceBytes: Buffer.byteLength(JSON.stringify(item ?? null), 'utf-8'),
      reviewer: context.reviewerStepName,
      stepName: context.reviewerStepName,
    }, 'reviewer');
  });
}

/**
 * legacy adapter: 既存台帳の RawFinding から candidate を作る。kind → relation の
 * 復元（deriveRawFindingRelation）はこの adapter の中だけに許される（設計書 §2.2）。
 */
export function candidateFromLegacyRawFinding(
  raw: RawFinding,
  reviewerStableKey: string,
): ReviewerRawFindingCandidate {
  const relation = deriveRawFindingRelation(raw.kind, raw.relation, raw.targetFindingId);
  return registerCandidate({
    intakeId: raw.rawFindingId,
    reviewerStableKey,
    reviewerRawFindingId: raw.rawFindingId,
    familyTag: raw.familyTag,
    severity: raw.severity,
    title: raw.title,
    ...(raw.location !== undefined ? { location: raw.location } : {}),
    description: raw.description,
    ...(raw.suggestion !== undefined ? { suggestion: raw.suggestion } : {}),
    relation,
    ...(raw.targetFindingId !== undefined ? { targetFindingId: raw.targetFindingId } : {}),
    ...(raw.kind !== undefined ? { legacyKind: raw.kind } : {}),
    // すでに組み立て済みのネスト形（wire と同じ形）なのでそのまま引き継ぐ。
    ...(raw.evidence !== undefined ? { evidence: raw.evidence } : {}),
    sourceBytes: Buffer.byteLength(JSON.stringify(raw), 'utf-8'),
    reviewer: raw.reviewer,
    stepName: raw.stepName,
  }, 'legacy-ledger');
}

/**
 * reviewer 出力全量が上限超過したときの単一 overflow event（設計書 §10）。
 * system 起源の candidate として同じ canonical 生成関数を通す。
 */
export function createOverflowRawCandidate(input: {
  context: ReviewerRawIntakeContext;
  reason: string;
}): ReviewerRawFindingCandidate {
  const reviewerStableKey = computeReviewerStableKey({
    workflowName: input.context.workflowName,
    callNamespace: input.context.callNamespace,
    parentStepName: input.context.parentStepName,
    reviewerPersonaKey: input.context.reviewerPersonaKey,
  });
  return registerCandidate({
    intakeId: namespacedRawFindingId(input.context, 'reviewer-output-overflow'),
    reviewerStableKey,
    reviewerRawFindingId: 'reviewer-output-overflow',
    familyTag: 'reviewer-output-overflow',
    severity: 'high',
    title: 'Reviewer output exceeded Finding Contract limits',
    description: input.reason,
    relation: 'new',
    sourceBytes: Buffer.byteLength(input.reason, 'utf-8'),
    reviewer: input.context.reviewerStepName,
    stepName: input.context.reviewerStepName,
  }, 'system');
}

// ---------------------------------------------------------------------------
// canonical 生成（唯一の関数）
// ---------------------------------------------------------------------------

/** ambiguous 起源 raw の権限格子（設計書 §4.1）。エンジンだけが発行する。 */
export const AMBIGUOUS_RAW_CAPABILITIES: AmbiguousRawCapabilities = Object.freeze({
  mayCreateIndependentFinding: true,
  mayOpenConflict: true,
  mayCreateProvisional: true,
  mayResolve: false,
  mayWaive: false,
  mayInvalidate: false,
  maySupersede: false,
  mayReopenTarget: false,
  mayNonDeterministicallyMatch: false,
});

export interface RawCanonicalizationContext {
  ledger: FindingLedger;
  /** レビュア1回突き返し（correction）を経た再 canonical 化なら true。 */
  clarificationAttempted?: boolean;
  /** correction 前の ambiguity codes。taint は同一梯子内では消さない（設計書 §3）。 */
  priorAmbiguityCodes?: readonly RawAmbiguityCode[];
}

export type CanonicalizationResult =
  | { outcome: 'coherent'; canonical: CoherentCanonicalRawFinding }
  | { outcome: 'ambiguous'; canonical: AmbiguousCanonicalRawFinding };

interface OpenFindingIndexes {
  byId: Map<string, FindingLedgerEntry>;
  openByPathTitle: Map<string, FindingLedgerEntry>;
  openIdentityKeys: Set<string>;
}

function pathTitleKey(location: string | undefined, title: string | undefined): string {
  return JSON.stringify([normalizedPathOf(location), normalizedTitleOf(title)]);
}

function identityKey(location: string | undefined, title: string | undefined, description: string | undefined): string {
  return JSON.stringify([
    normalizedPathOf(location),
    normalizedTitleOf(title),
    description === undefined ? '' : normalizeFindingText(description).toLowerCase(),
  ]);
}

function indexLedgerFindings(ledger: FindingLedger): OpenFindingIndexes {
  const byId = new Map<string, FindingLedgerEntry>();
  const openByPathTitle = new Map<string, FindingLedgerEntry>();
  const openIdentityKeys = new Set<string>();
  for (const finding of ledger.findings) {
    byId.set(finding.id, finding);
    if (finding.status !== 'open') {
      continue;
    }
    // provisional（意味を確定できなかった観測の placeholder）は 'new' 衝突検出の
    // 対象にしない: 同じ claim の clean coherent raw こそが provisional を確定・
    // 解消できる唯一の証拠であり（設計書 §8）、衝突扱いで ambiguous に落とすと
    // provisional が永久に確定不能になる。
    if (finding.provisional !== undefined) {
      continue;
    }
    const key = pathTitleKey(finding.location, finding.title);
    if (!openByPathTitle.has(key)) {
      openByPathTitle.set(key, finding);
    }
    openIdentityKeys.add(identityKey(finding.location, finding.title, finding.description));
  }
  return { byId, openByPathTitle, openIdentityKeys };
}

function buildSafeEvidenceExcerpt(candidate: ReviewerRawFindingCandidate): string {
  const title = candidate.title ?? '(no title)';
  const location = candidate.location ?? '(no location)';
  const description = candidate.description !== undefined
    ? normalizeFindingText(candidate.description).slice(0, 200)
    : '(no description)';
  return `${title} @ ${location}: ${description}`.slice(0, 400);
}

/** ambiguity 検出に必要な raw のフィールド（candidate / 未検証 reviewer 出力の両方が満たせる形）。 */
export interface RawAmbiguityFields {
  relation?: RawFindingRelation;
  legacyKind?: RawFindingKind;
  targetFindingId?: string;
  title?: string;
  description?: string;
  severity?: FindingSeverity;
  familyTag?: string;
  location?: string;
}

export interface RawAmbiguityDetection {
  codes: RawAmbiguityCode[];
  /** 'new-collides-open-finding' のとき、衝突した open finding の id。 */
  collidingFindingId?: string;
  collidingFindingTitle?: string;
}

/**
 * ambiguity 検出の唯一の実装（設計書 §3）。canonicalizeReviewerRawFinding と
 * runner 側のレビュア突き返し検出（relation-coherence.ts）が共有する —
 * 検出条件が二重実装で食い違うと、runner が直したはずの raw が intake で
 * 再び ambiguous になる（またはその逆の緩み）。
 */
export function detectRawFindingAmbiguities(
  fields: RawAmbiguityFields,
  ledger: FindingLedger,
): RawAmbiguityDetection {
  const indexes = indexLedgerFindings(ledger);
  const codes: RawAmbiguityCode[] = [];

  // relation は新規 contract の正本。欠損は ambiguity（reviewer 起源では kind から
  // 推測しない — 「新規 reviewer contract で kind→relation の推測を続けるな」）。
  const claimedRelation = fields.relation;
  if (claimedRelation === undefined) {
    codes.push('missing-required-field');
  }
  if (fields.title === undefined || fields.description === undefined
    || fields.severity === undefined || fields.familyTag === undefined) {
    codes.push('missing-required-field');
  }

  // legacy kind と relation の矛盾（v3-r3 gemma 実測パターン: kind=issue +
  // relation=resolution_confirmation）。parse 失敗ではなく taint にする。
  if (claimedRelation !== undefined && fields.legacyKind !== undefined
    && kindForRelation(claimedRelation) !== fields.legacyKind) {
    codes.push('kind-relation-conflict');
  }

  // relation と targetFindingId の必須・禁止条件。
  if (claimedRelation === 'new' && fields.targetFindingId !== undefined) {
    codes.push('relation-target-mismatch');
  }
  if (claimedRelation !== undefined && claimedRelation !== 'new' && fields.targetFindingId === undefined) {
    codes.push('relation-target-mismatch');
  }

  // target の存在・状態整合。
  const target = fields.targetFindingId !== undefined ? indexes.byId.get(fields.targetFindingId) : undefined;
  if (claimedRelation === 'persists' && fields.targetFindingId !== undefined) {
    if (target === undefined) {
      codes.push('persists-target-unknown');
    } else if (target.status !== 'open') {
      codes.push('persists-target-not-open');
    }
  }
  if (claimedRelation === 'reopened' && fields.targetFindingId !== undefined) {
    if (target === undefined) {
      codes.push('reopened-target-unknown');
    } else if (target.status === 'open') {
      codes.push('reopened-target-open');
    }
  }
  if (claimedRelation === 'resolution_confirmation' && fields.targetFindingId !== undefined) {
    if (target === undefined) {
      codes.push('confirmation-target-unknown');
    } else if (target.status !== 'open') {
      codes.push('confirmation-target-not-open');
    }
  }

  // new の path/title 衝突（完全同一なら決定的 same にできるため ambiguity ではない）。
  let collidingFindingId: string | undefined;
  let collidingFindingTitle: string | undefined;
  if (claimedRelation === 'new' && fields.targetFindingId === undefined) {
    const collided = indexes.openByPathTitle.get(pathTitleKey(fields.location, fields.title));
    if (collided !== undefined
      && !indexes.openIdentityKeys.has(identityKey(fields.location, fields.title, fields.description))) {
      codes.push('new-collides-open-finding');
      collidingFindingId = collided.id;
      collidingFindingTitle = collided.title;
    }
  }

  return {
    codes,
    ...(collidingFindingId !== undefined ? { collidingFindingId } : {}),
    ...(collidingFindingTitle !== undefined ? { collidingFindingTitle } : {}),
  };
}

/**
 * 未検証の reviewer 出力1件から ambiguity 検出・candidate 生成に使うフィールドを
 * 寛容に抜き出す（絶対に throw しない）。
 */
export function extractLenientRawFields(
  item: unknown,
): RawAmbiguityFields & { rawFindingId?: string; suggestion?: string; verbatimExcerpt?: string; snapshotId?: string } {
  const record = typeof item === 'object' && item !== null && !Array.isArray(item)
    ? item as Record<string, unknown>
    : {};
  return {
    ...(pickString(record.rawFindingId) !== undefined ? { rawFindingId: pickString(record.rawFindingId)! } : {}),
    ...(pickRelation(record.relation) !== undefined ? { relation: pickRelation(record.relation)! } : {}),
    ...(pickKind(record.kind) !== undefined ? { legacyKind: pickKind(record.kind)! } : {}),
    ...(pickString(record.targetFindingId) !== undefined ? { targetFindingId: pickString(record.targetFindingId)! } : {}),
    ...(pickString(record.title) !== undefined ? { title: pickString(record.title)! } : {}),
    ...(pickString(record.description) !== undefined ? { description: pickString(record.description)! } : {}),
    ...(pickSeverity(record.severity) !== undefined ? { severity: pickSeverity(record.severity)! } : {}),
    ...(pickString(record.familyTag) !== undefined ? { familyTag: pickString(record.familyTag)! } : {}),
    ...(pickString(record.location) !== undefined ? { location: pickString(record.location)! } : {}),
    ...(pickString(record.suggestion) !== undefined ? { suggestion: pickString(record.suggestion)! } : {}),
    // typed evidence protocol（codex 対策#4）の envelope 検査対象フィールド。
    ...(pickString(record.verbatimExcerpt) !== undefined ? { verbatimExcerpt: pickString(record.verbatimExcerpt)! } : {}),
    ...(pickString(record.snapshotId) !== undefined ? { snapshotId: pickString(record.snapshotId)! } : {}),
  };
}

/**
 * 唯一の canonical 生成関数（設計書 §2.1）。candidate は必ず coherent または
 * ambiguous のどちらかに着地する — 例外で死ぬ経路は無い。
 */
export function canonicalizeReviewerRawFinding(
  candidate: ReviewerRawFindingCandidate,
  context: RawCanonicalizationContext,
): CanonicalizationResult {
  if (!isReviewerRawFindingCandidate(candidate)) {
    throw new Error('canonicalizeReviewerRawFinding: input did not come from a candidate factory');
  }
  const origin = CANDIDATE_ORIGINS.get(candidate) ?? 'reviewer';
  const detection = detectRawFindingAmbiguities(candidate, context.ledger);
  const codes = detection.codes;
  const collidingFindingId = detection.collidingFindingId;
  const claimedRelation = candidate.relation;

  const priorCodes = context.priorAmbiguityCodes ?? [];
  const clarificationAttempted = context.clarificationAttempted === true;
  const ambiguityOrigin = codes.length > 0 || priorCodes.length > 0;
  const allCodes = [...new Set([...priorCodes, ...codes])];

  // canonical の relation/kind は必ず一致する整合ペア（設計書 §2.2）。ambiguous で
  // relation の主張が成立しない場合は最も権限の弱い 'new' に正規化する（権限は
  // capabilities が全遮断しているため、この正規化がゲートを開けることはない）。
  const relationClaimHolds = claimedRelation !== undefined
    && !(claimedRelation === 'new' && candidate.targetFindingId !== undefined)
    && !(claimedRelation !== 'new' && candidate.targetFindingId === undefined);
  const relation: RawFindingRelation = relationClaimHolds ? claimedRelation : 'new';
  const kind = kindForRelation(relation);

  const lineageKey = computeLineageKey({
    ...(candidate.targetFindingId !== undefined ? { targetFindingId: candidate.targetFindingId } : {}),
    ...(collidingFindingId !== undefined ? { collidingFindingId } : {}),
    ...(candidate.location !== undefined ? { location: candidate.location } : {}),
    ...(candidate.title !== undefined ? { title: candidate.title } : {}),
    ...(candidate.familyTag !== undefined ? { familyTag: candidate.familyTag } : {}),
  });
  const evidenceHash = computeRawEvidenceHash({
    ...(claimedRelation !== undefined ? { relation: claimedRelation } : {}),
    ...(candidate.targetFindingId !== undefined ? { targetFindingId: candidate.targetFindingId } : {}),
    ...(candidate.title !== undefined ? { title: candidate.title } : {}),
    ...(candidate.description !== undefined ? { description: candidate.description } : {}),
    ...(candidate.suggestion !== undefined ? { suggestion: candidate.suggestion } : {}),
    ...(candidate.severity !== undefined ? { severity: candidate.severity } : {}),
    ...(candidate.familyTag !== undefined ? { familyTag: candidate.familyTag } : {}),
    ...(candidate.location !== undefined ? { location: candidate.location } : {}),
  });

  const base = {
    rawFindingId: candidate.intakeId,
    reviewerStableKey: candidate.reviewerStableKey,
    lineageKey,
    evidenceHash,
    relation,
    kind,
    reviewer: candidate.reviewer,
    stepName: candidate.stepName,
    provenance: {
      origin,
      ambiguityOrigin,
      clarificationAttempted,
      ambiguityCodes: allCodes,
    },
    // typed evidence protocol(codex 対策#4)。coherent/ambiguous どちらの raw も
    // 持ちうる(ambiguity は relation/target の構造的矛盾であり、evidence の有無とは
    // 直交する — raw-canonicalization.ts のコメント参照)。evidenceHash とは独立に
    // 保持する(evidenceHash は WAL/epoch 用の「同一 claim 判定」であり、
    // verbatimExcerpt が変わっても既存の攻撃回帰の前提を壊さないようスコープ外に
    // 保つ)。
    ...(candidate.evidence !== undefined ? { evidence: candidate.evidence } : {}),
  };

  // 形式が完全（codes 空）なら coherent。ただし taint（priorCodes）は保持する:
  // correction で relation が整った raw は形式上 coherent だが ambiguityOrigin は
  // true のままで、downstream の権限判定は provenance を見る（設計書 §3）。
  if (codes.length === 0
    && candidate.title !== undefined && candidate.description !== undefined
    && candidate.severity !== undefined && candidate.familyTag !== undefined) {
    const canonical = registerCoherentCanonical({
      ...base,
      coherence: 'coherent',
      familyTag: candidate.familyTag,
      severity: candidate.severity,
      title: candidate.title,
      description: candidate.description,
      ...(candidate.location !== undefined ? { location: candidate.location } : {}),
      ...(candidate.suggestion !== undefined ? { suggestion: candidate.suggestion } : {}),
      ...(candidate.targetFindingId !== undefined ? { targetFindingId: candidate.targetFindingId } : {}),
    });
    return { outcome: 'coherent', canonical };
  }

  const canonical = registerAmbiguousCanonical({
    ...base,
    coherence: 'ambiguous',
    safeEvidenceExcerpt: buildSafeEvidenceExcerpt(candidate),
    capabilities: AMBIGUOUS_RAW_CAPABILITIES,
    ...(candidate.targetFindingId !== undefined ? { targetFindingId: candidate.targetFindingId } : {}),
    ...(candidate.familyTag !== undefined ? { familyTag: candidate.familyTag } : {}),
    ...(candidate.severity !== undefined ? { severity: candidate.severity } : {}),
    ...(candidate.title !== undefined ? { title: candidate.title } : {}),
    ...(candidate.description !== undefined ? { description: candidate.description } : {}),
    ...(candidate.location !== undefined ? { location: candidate.location } : {}),
    ...(candidate.suggestion !== undefined ? { suggestion: candidate.suggestion } : {}),
  });
  return { outcome: 'ambiguous', canonical };
}

// ---------------------------------------------------------------------------
// 台帳（wire 形）への写像
// ---------------------------------------------------------------------------

/**
 * canonical を ledger v1 の RawFinding wire 形へ落とす。ambiguous で必須文字列が
 * 欠損している場合も schema-valid な監査値で埋める（「不明な raw を黙って消すな」
 * — 監査経路は必ず残す）。relation/kind は canonical の整合ペアをそのまま使う。
 * relation='new' に正規化された ambiguous の元 targetFindingId 主張は
 * description に追記して監査可能性を保つ（wire schema は new+target を禁止する）。
 */
export function toLedgerRawFinding(canonical: CanonicalRawFinding): RawFinding {
  assertCanonicalRawFinding(canonical, 'toLedgerRawFinding');
  const isCoherent = canonical.coherence === 'coherent';
  const title = canonical.title ?? '(unparseable raw finding)';
  // description は本文のまま保つ（注記を混ぜない）。ambiguity code や正規化で
  // 落ちた targetFindingId 主張の監査情報は canonical.provenance / 検証レポート /
  // provisional.reason 側にあり、description を汚すと provisional entry と後続の
  // clean raw の完全 identity（path+title+description）照合が壊れ、§8 の確定・
  // 解消（codex B2 の決定的照合）が永久に成立しなくなる。
  const description = canonical.description
    ?? (isCoherent ? '(no description)' : (canonical as AmbiguousCanonicalRawFinding).safeEvidenceExcerpt);
  return {
    rawFindingId: canonical.rawFindingId,
    stepName: canonical.stepName,
    reviewer: canonical.reviewer,
    familyTag: canonical.familyTag ?? 'raw-meaning-ambiguous',
    severity: canonical.severity ?? 'high',
    title,
    ...(canonical.location !== undefined ? { location: canonical.location } : {}),
    description,
    ...(canonical.suggestion !== undefined ? { suggestion: canonical.suggestion } : {}),
    kind: canonical.kind,
    relation: canonical.relation,
    ...(canonical.relation !== 'new' && canonical.targetFindingId !== undefined
      ? { targetFindingId: canonical.targetFindingId }
      : {}),
    ...(canonical.evidence !== undefined ? { evidence: canonical.evidence } : {}),
  };
}
