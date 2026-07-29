/**
 * raw finding の二層スキーマ境界。
 *
 * - reviewer structured output は「寛容な per-item parse」で
 *   ReviewerRawFindingCandidate に落とす。1件の不正 raw が配列全体の Zod parse
 *   失敗として run を殺す構造をここで断つ。
 * - canonical 生成関数は canonicalizeReviewerRawFinding の1つだけ。reviewer 出力と
 *   保存済み raw のどちらも candidate を作り、同じ関数を通す。
 * - brand は型レベル（unique symbol）に加えて runtime でも強制する: factory が
 *   WeakSet/WeakMap に登録し、downstream（機械分類・reconciler・manager prompt）
 *   の入口が assertCanonicalRawFinding で照合する。型 assertion や spread で
 *   作った object は WeakSet に居ないため runtime で拒否される。
 * - taint（provenance.ambiguityOrigin）は同一梯子内では消さない。correction で
 *   形式が整っても ambiguityOrigin: true を保持する。
 * - capability はエンジンだけが発行する。LLM の出力フィールドからは受け取らない。
 */

import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  FINDING_SEVERITIES,
  RAW_FINDING_RELATIONS,
} from '../../models/finding-types.js';
import type {
  AmbiguousCanonicalRawFinding,
  AmbiguousRawCapabilities,
  CanonicalRawFinding,
  CoherentCanonicalRawFinding,
  EngineProofRecord,
  FindingLedger,
  FindingLedgerEntry,
  FindingEvidenceRequest,
  FindingTarget,
  FindingMutationPrecondition,
  FindingSeverity,
  RawAmbiguityCode,
  RawFinding,
  RawFindingEvidence,
  RawFindingRelation,
  ReviewerRawFindingCandidate,
} from './types.js';
import {
  computeCandidateIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
  normalizeFindingText,
} from '../../models/finding-claim-identity.js';
import {
  captureFindingMutationPrecondition,
} from './finding-preconditions.js';
import { hashRawFindingIdAllocationContent } from './raw-finding-id-allocation-hash.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  canonicalJson,
  deepFreezeCanonicalJsonValue,
} from '../../../shared/utils/canonical-json.js';
import { computeCanonicalRawIntegrityDigest } from './finding-integrity.js';
import {
  computeClaimIdentityHash,
  computeEvidenceSetHash,
  deduplicateRawEvidence,
} from './evidence-domain.js';
import {
  formatFileQuoteLocation,
  rawEvidenceFileQuoteLocations,
} from './evidence-location.js';

// ---------------------------------------------------------------------------
// runtime brand（factory を通らない object を downstream で拒否するための登録簿）
// ---------------------------------------------------------------------------

const CANDIDATE_REGISTRY = new WeakSet<object>();
const CANDIDATE_ORIGINS = new WeakMap<object, 'reviewer' | 'stored-ledger' | 'system'>();
const CANDIDATE_TARGET_PRECONDITIONS = new WeakMap<object, FindingMutationPrecondition>();
const CANDIDATE_INVALID_EVIDENCE_SHAPES = new WeakSet<object>();
const CANONICAL_REGISTRY = new WeakSet<object>();

export const RAW_FINDINGS_SCHEMA_REF = 'takt.findings.raw';

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
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function computeReviewerStableKey(input: {
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
  reviewerPersonaKey: string;
}): string {
  return sha256Of('reviewer-stable-key', input.workflowName, input.callNamespace, input.parentStepName, input.reviewerPersonaKey);
}

function evidenceLocation(evidence: readonly RawFindingEvidence[]): string | undefined {
  const location = rawEvidenceFileQuoteLocations(evidence)[0];
  return location === undefined ? undefined : formatFileQuoteLocation(location);
}

/**
 * 再発同定の lineage key。行番号・run ID・step iteration・
 * タイムスタンプ・LLM 説明文全文は入れない。
 */
export function computeLineageKey(input: {
  claimIdentityHash: string;
  targetFindingId?: string;
  collidingFindingId?: string;
}): string {
  if (input.targetFindingId !== undefined) {
    return sha256Of('target', input.targetFindingId, input.claimIdentityHash);
  }
  if (input.collidingFindingId !== undefined) {
    return sha256Of('collision', input.collidingFindingId, input.claimIdentityHash);
  }
  return sha256Of('claim', input.claimIdentityHash);
}

/**
 * raw の evidence hash。行番号・rawFindingId・runId は含めない（それらだけを
 * 変えた再発は「同一 evidence」= manager を再呼び出さない）。
 * description 等の実質変更は hash を変え、再解釈候補になる（ただし epoch 上限
 * MAX 2 / lineage は raw-finding-limits.ts が別途強制する）。
 */
export function computeRawEvidenceHash(fields: {
  evidence?: readonly RawFindingEvidence[];
}): string {
  const ids = (fields.evidence ?? []).map((item) => sha256Of('raw-evidence-item', canonicalJson(item)));
  return computeEvidenceSetHash(ids);
}

export function computeProvisionalStableKey(input: {
  reviewerStableKey: string;
  lineageKey: string;
  provisionalKind: string;
}): string {
  return sha256Of('provisional-stable-key', input.reviewerStableKey, input.lineageKey, input.provisionalKind);
}

/**
 * reviewer anomaly（review-integrity protocol: 二系統台帳の review-integrity 側）の再発同定
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
  return sha256Of('reviewer-anomaly-stable-key', input.reviewerStableKey, input.lineageKey, input.anomalyKind);
}

/** reviewer 全量超過の単一 blocker 用 overflow stableKey。 */
export function computeOverflowStableKey(reviewerStableKey: string): string {
  return sha256Of(reviewerStableKey, 'reviewer-output-overflow');
}

export function computeBaseInterpretationKey(input: {
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
}): string {
  return sha256Of('interpretation-base-key', input.reviewerStableKey, input.lineageKey, input.candidateEvidenceHash);
}

export function computeInterpretationAttemptKey(
  baseInterpretationKey: string,
  attemptOrdinal: number,
): string {
  return sha256Of('interpretation-attempt-key', baseInterpretationKey, String(attemptOrdinal));
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
  /** reviewer の persona キー（reviewerStableKey の構成要素）。 */
  reviewerPersonaKey: string;
  /** rawExcerpt を一意な完全一致で束縛する reviewer report 本文。 */
  reviewReport: string;
  issueEvidenceRequests(input: {
    target: FindingTarget;
    claimIdentityHash: string;
    targetFindingId: string | null;
    requests: readonly FindingEvidenceRequest[];
  }): {
    evidence: RawFindingEvidence[];
    engineProofRecords: EngineProofRecord[];
    coverageGaps: string[];
  };
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

const REVIEWER_RAW_ITEM_KEYS: ReadonlySet<string> = new Set([
  'rawExcerpt',
  'candidate',
]);
const REVIEWER_CANDIDATE_KEYS: ReadonlySet<string> = new Set([
  'target',
  'rawFindingId',
  'relation',
  'targetFindingId',
  'familyTag',
  'severity',
  'title',
  'evidenceRequests',
  'description',
  'suggestion',
]);
const REVIEWER_RAW_EMPTY_STRING_KEYS: ReadonlySet<string> = new Set([
]);

function projectEvidenceRequests(value: unknown): FindingEvidenceRequest[] | undefined {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 16) {
    return undefined;
  }
  const projected: FindingEvidenceRequest[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || types.isProxy(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      record.kind === 'file_quote'
      && keys.length === 5
      && keys.every((key) => (
        ['kind', 'path', 'startLine', 'endLine', 'verbatimExcerpt'].includes(key)
      ))
      && typeof record.path === 'string'
      && record.path.length > 0
      && Number.isSafeInteger(record.startLine)
      && Number(record.startLine) > 0
      && Number.isSafeInteger(record.endLine)
      && Number(record.endLine) > 0
      && typeof record.verbatimExcerpt === 'string'
      && record.verbatimExcerpt.length > 0
    ) {
      projected.push({
        kind: 'file_quote',
        path: record.path,
        startLine: Number(record.startLine),
        endLine: Number(record.endLine),
        verbatimExcerpt: record.verbatimExcerpt,
      });
      continue;
    }
    if (
      record.kind !== 'engine_proof'
      || keys.length !== 2
      || !keys.every((key) => key === 'kind' || key === 'subject')
      || typeof record.subject !== 'object'
      || record.subject === null
      || Array.isArray(record.subject)
      || types.isProxy(record.subject)
    ) {
      return undefined;
    }
    const subject = record.subject as Record<string, unknown>;
    const subjectKeys = Object.keys(subject);
    if (subject.kind === 'repository_manifest' && subjectKeys.length === 1) {
      projected.push({
        kind: 'engine_proof',
        subject: { kind: 'repository_manifest' },
      });
      continue;
    }
    if (subject.kind === 'repository_query' && subjectKeys.length === 1) {
      projected.push({
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      });
      continue;
    }
    if (
      subject.kind === 'authoritative_quote'
      && subjectKeys.length === 4
      && subjectKeys.every((key) => (
        ['kind', 'source', 'declarationId', 'verbatimExcerpt'].includes(key)
      ))
      && (subject.source === 'task' || subject.source === 'public_declaration')
      && typeof subject.declarationId === 'string'
      && subject.declarationId.length > 0
      && typeof subject.verbatimExcerpt === 'string'
      && subject.verbatimExcerpt.length > 0
    ) {
      projected.push({
        kind: 'engine_proof',
        subject: {
          kind: 'authoritative_quote',
          source: subject.source,
          declarationId: subject.declarationId,
          verbatimExcerpt: subject.verbatimExcerpt,
        },
      });
      continue;
    }
    return undefined;
  }
  return projected;
}

function canonicalStringSet(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    return undefined;
  }
  return [...new Set(value)].sort(compareBinaryStrings);
}

function projectFindingTarget(value: unknown): FindingTarget | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || types.isProxy(value)) {
    return undefined;
  }
  const target = value as Record<string, unknown>;
  if (target.kind === 'code') {
    const paths = canonicalStringSet(target.paths);
    return paths !== undefined && paths.length > 0
      ? { kind: 'code', paths }
      : undefined;
  }
  if (target.kind === 'structure') {
    const scope = target.scope;
    if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
      return undefined;
    }
    const roots = canonicalStringSet((scope as Record<string, unknown>).roots);
    const manifestTargets = canonicalStringSet(target.manifestTargets);
    return (scope as Record<string, unknown>).kind === 'review_scope'
      && roots !== undefined
      && roots.length > 0
      && manifestTargets !== undefined
      && manifestTargets.length > 0
      ? {
          kind: 'structure',
          scope: { kind: 'review_scope', roots },
          manifestTargets,
        }
      : undefined;
  }
  if (target.kind !== 'absence') {
    return undefined;
  }
  const predicate = target.predicate;
  if (typeof predicate !== 'object' || predicate === null || Array.isArray(predicate)) {
    return undefined;
  }
  const record = predicate as Record<string, unknown>;
  if (
    record.kind === 'path_state'
    && typeof record.path === 'string'
    && record.path.length > 0
    && record.expected === 'absent'
  ) {
    return {
      kind: 'absence',
      predicate: { kind: 'path_state', path: record.path, expected: 'absent' },
    };
  }
  const roots = canonicalStringSet(record.roots);
  return record.kind === 'exact_literal_search'
    && roots !== undefined
    && roots.length > 0
    && typeof record.literal === 'string'
    && record.literal.length > 0
    && record.textDomain === 'utf8'
    ? {
        kind: 'absence',
        predicate: {
          kind: 'exact_literal_search',
          roots,
          literal: record.literal,
          textDomain: 'utf8',
        },
      }
    : undefined;
}

function bindCandidateSource(
  report: string,
  rawExcerpt: string,
): ReviewerRawFindingCandidate['sourceBinding'] {
  const reportBytes = Buffer.from(report, 'utf8');
  const excerptBytes = Buffer.from(rawExcerpt, 'utf8');
  if (excerptBytes.length === 0) {
    throw new Error('rawExcerpt must not be empty');
  }
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= reportBytes.length - excerptBytes.length && offsets.length < 2) {
    const offset = reportBytes.indexOf(excerptBytes, cursor);
    if (offset < 0) {
      break;
    }
    offsets.push(offset);
    cursor = offset + 1;
  }
  if (offsets.length !== 1) {
    throw new Error(
      `rawExcerpt must occur exactly once in the review report; observed ${offsets.length === 0 ? 'zero' : 'multiple'} matches`,
    );
  }
  const startByte = offsets[0]!;
  return {
    reportDigest: createHash('sha256').update(reportBytes).digest('hex'),
    startByte,
    endByte: startByte + excerptBytes.length,
    excerptDigest: createHash('sha256').update(excerptBytes).digest('hex'),
  };
}

export interface ProjectedReviewerRawItem {
  readonly record: Record<string, unknown>;
  readonly sourceBytes: number;
  readonly evidenceShapeValid: boolean;
  readonly candidateShapeValid: boolean;
}

export interface ReviewerRawResourceEnvelope {
  readonly itemCount: number;
  readonly jsonBytes: number;
  readonly itemSourceBytes: readonly number[];
}

export interface ProjectedReviewerRawStructuredOutput {
  readonly structuredOutput: Record<string, unknown>;
  readonly resourceEnvelope: ReviewerRawResourceEnvelope;
}

function rejectedReviewerRawItem(sourceBytes: number): ProjectedReviewerRawItem {
  return {
    record: {},
    sourceBytes,
    evidenceShapeValid: false,
    candidateShapeValid: false,
  };
}

function projectReviewerRawItem(
  item: unknown,
  sourceBytes: number,
): ProjectedReviewerRawItem {
  if (
    typeof item !== 'object'
    || item === null
    || Array.isArray(item)
    || types.isProxy(item)
  ) {
    return rejectedReviewerRawItem(sourceBytes);
  }
  try {
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      return rejectedReviewerRawItem(sourceBytes);
    }
    const extractionDescriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of Reflect.ownKeys(extractionDescriptors)) {
      if (typeof key !== 'string' || !REVIEWER_RAW_ITEM_KEYS.has(key)) {
        return rejectedReviewerRawItem(sourceBytes);
      }
      const descriptor = extractionDescriptors[key]!;
      if (
        descriptor.enumerable !== true
        || 'get' in descriptor
        || 'set' in descriptor
      ) {
        return rejectedReviewerRawItem(sourceBytes);
      }
    }
    const record: Record<string, unknown> = {};
    const rawExcerpt = extractionDescriptors.rawExcerpt?.value;
    if (typeof rawExcerpt === 'string' && rawExcerpt.length > 0) {
      record.rawExcerpt = rawExcerpt;
    }
    const candidateValue = extractionDescriptors.candidate?.value;
    if (candidateValue === null) {
      return {
        record,
        sourceBytes,
        evidenceShapeValid: false,
        candidateShapeValid: false,
      };
    }
    if (
      typeof candidateValue !== 'object'
      || candidateValue === null
      || Array.isArray(candidateValue)
      || types.isProxy(candidateValue)
    ) {
      return rejectedReviewerRawItem(sourceBytes);
    }
    const candidatePrototype = Object.getPrototypeOf(candidateValue);
    if (candidatePrototype !== Object.prototype && candidatePrototype !== null) {
      return rejectedReviewerRawItem(sourceBytes);
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidateValue);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !REVIEWER_CANDIDATE_KEYS.has(key)) {
        return rejectedReviewerRawItem(sourceBytes);
      }
      const descriptor = descriptors[key]!;
      if (
        descriptor.enumerable !== true
        || 'get' in descriptor
        || 'set' in descriptor
      ) {
        return rejectedReviewerRawItem(sourceBytes);
      }
    }
    let evidenceShapeValid = false;
    let candidateShapeValid = true;
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key]!;
      const value = descriptor.value;
      if (
        value === null
        && [
          'targetFindingId',
          'familyTag',
          'severity',
          'suggestion',
          'relation',
          'title',
          'description',
          'target',
          'rawFindingId',
        ].includes(key)
      ) {
        record[key] = null;
        continue;
      }
      if (key === 'relation') {
        const relation = pickRelation(value);
        if (relation !== undefined) {
          record[key] = relation;
        } else {
          candidateShapeValid = false;
        }
        continue;
      }
      if (key === 'severity') {
        const severity = pickSeverity(value);
        if (severity !== undefined) {
          record[key] = severity;
        } else {
          candidateShapeValid = false;
        }
        continue;
      }
      if (key === 'evidenceRequests') {
        const evidenceRequests = projectEvidenceRequests(value);
        if (evidenceRequests !== undefined) {
          record.evidenceRequests = evidenceRequests;
          evidenceShapeValid = true;
        } else {
          candidateShapeValid = false;
        }
        continue;
      }
      if (key === 'target') {
        const target = projectFindingTarget(value);
        if (target !== undefined) {
          record.target = target;
        } else {
          candidateShapeValid = false;
        }
        continue;
      }
      if (
        typeof value === 'string'
        && (value.length > 0 || REVIEWER_RAW_EMPTY_STRING_KEYS.has(key))
      ) {
        record[key] = value;
      } else {
        candidateShapeValid = false;
      }
    }
    return {
      record,
      sourceBytes,
      evidenceShapeValid,
      candidateShapeValid,
    };
  } catch {
    return rejectedReviewerRawItem(sourceBytes);
  }
}

function measureUntrustedRawItemBytes(item: unknown): number {
  try {
    return Buffer.byteLength(canonicalJson(item), 'utf-8');
  } catch {
    // 安全に直列化できない shape は、projection で小さく見せず必ず
    // reviewer byte envelope を超過させる。
    return Number.MAX_SAFE_INTEGER;
  }
}

function resourceEnvelopeForSnapshot(items: readonly unknown[]): ReviewerRawResourceEnvelope {
  const itemSourceBytes = items.map(measureUntrustedRawItemBytes);
  const separators = Math.max(0, itemSourceBytes.length - 1);
  const payloadBytes = itemSourceBytes.reduce(
    (total, sourceBytes) => Math.min(
      Number.MAX_SAFE_INTEGER,
      total + sourceBytes,
    ),
    0,
  );
  return Object.freeze({
    itemCount: items.length,
    jsonBytes: Math.min(Number.MAX_SAFE_INTEGER, 2 + separators + payloadBytes),
    itemSourceBytes: Object.freeze(itemSourceBytes),
  });
}

function snapshotReviewerRawItems(items: readonly unknown[]): unknown[] {
  if (types.isProxy(items)) {
    throw new TypeError('Reviewer raw findings do not support Proxy arrays');
  }
  const descriptors = Object.getOwnPropertyDescriptors(items) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new TypeError('Reviewer raw findings have an invalid array length');
  }
  if (Reflect.ownKeys(descriptors).length !== lengthDescriptor.value + 1) {
    throw new TypeError('Reviewer raw findings do not support extra array properties');
  }
  const values: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || 'get' in descriptor
      || 'set' in descriptor
    ) {
      throw new TypeError('Reviewer raw findings require a dense data-property array');
    }
    values.push(descriptor.value);
  }
  return values;
}

export function projectReviewerRawFindingItems(
  items: readonly unknown[],
): Record<string, unknown>[] {
  const snapshot = snapshotReviewerRawItems(items);
  const envelope = resourceEnvelopeForSnapshot(snapshot);
  return snapshot.map((item, index) => (
    projectReviewerRawItem(item, envelope.itemSourceBytes[index]!).record
  ));
}

export function projectReviewerRawStructuredOutputWithEnvelope(
  value: unknown,
): ProjectedReviewerRawStructuredOutput {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
  ) {
    throw new TypeError('Reviewer structured output must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Reviewer structured output must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || keys[0] !== 'rawFindings') {
    throw new TypeError('Reviewer structured output must contain only rawFindings');
  }
  const rawFindings = descriptors.rawFindings;
  if (
    rawFindings === undefined
    || rawFindings.enumerable !== true
    || 'get' in rawFindings
    || 'set' in rawFindings
    || !Array.isArray(rawFindings.value)
  ) {
    throw new TypeError('Reviewer structured output rawFindings must be a data-property array');
  }
  const snapshot = snapshotReviewerRawItems(rawFindings.value as unknown[]);
  const resourceEnvelope = resourceEnvelopeForSnapshot(snapshot);
  const requiredCandidateKeys = [
    'rawFindingId',
    'relation',
    'targetFindingId',
    'familyTag',
    'severity',
    'title',
    'description',
    'suggestion',
    'target',
    'evidenceRequests',
  ] as const;
  return {
    structuredOutput: {
      rawFindings: snapshot.map((item, index) => (
        (() => {
          const projected = projectReviewerRawItem(
            item,
            resourceEnvelope.itemSourceBytes[index]!,
          );
          const { rawExcerpt, ...candidate } = projected.record;
          if (typeof rawExcerpt !== 'string') {
            return {};
          }
          const candidateIsComplete = projected.candidateShapeValid
            && projected.evidenceShapeValid
            && requiredCandidateKeys.every((key) => Object.hasOwn(candidate, key));
          return {
            rawExcerpt,
            candidate: candidateIsComplete ? candidate : null,
          };
        })()
      )),
    },
    resourceEnvelope,
  };
}

export function projectReviewerRawStructuredOutput(
  value: unknown,
): Record<string, unknown> {
  return projectReviewerRawStructuredOutputWithEnvelope(value).structuredOutput;
}

/** brand プロパティ（unique symbol）を型レベルで付与する唯一の cast 地点。runtime の同一性は WeakSet/WeakMap 登録が担保する。 */
type UnbrandedCandidate = {
  [K in keyof ReviewerRawFindingCandidate as K extends symbol ? never : K]: ReviewerRawFindingCandidate[K];
};

function registerCandidate(
  candidate: UnbrandedCandidate,
  origin: 'reviewer' | 'stored-ledger' | 'system',
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
  const branded = deepFreezeCanonicalJsonValue(value) as unknown as CoherentCanonicalRawFinding;
  CANONICAL_REGISTRY.add(branded);
  return branded;
}

function registerAmbiguousCanonical(value: UnbrandedAmbiguous): AmbiguousCanonicalRawFinding {
  const branded = deepFreezeCanonicalJsonValue(value) as unknown as AmbiguousCanonicalRawFinding;
  CANONICAL_REGISTRY.add(branded);
  return branded;
}

function findFreeLocalId(usedIds: ReadonlySet<string>, baseId: string): string {
  if (!usedIds.has(baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (usedIds.has(`${baseId}-dup${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-dup${suffix}`;
}

interface DuplicateClaimAllocationKey {
  readonly hash: string;
  readonly normalizedContent: string;
}

function normalizedDuplicateClaimContent(
  record: Record<string, unknown>,
): string {
  const evidenceRequests = projectEvidenceRequests(record.evidenceRequests) ?? [];
  return JSON.stringify([
    'duplicate-raw-finding-id-allocation',
    pickString(record.familyTag) ?? null,
    pickSeverity(record.severity) ?? null,
    pickString(record.title) ?? null,
    pickString(record.description) ?? null,
    pickString(record.suggestion) ?? null,
    pickRelation(record.relation) ?? null,
    pickString(record.targetFindingId) ?? null,
    projectFindingTarget(record.target) ?? null,
    evidenceRequests,
  ]);
}

function duplicateClaimAllocationKey(
  record: Record<string, unknown>,
): DuplicateClaimAllocationKey {
  const normalizedContent = normalizedDuplicateClaimContent(record);
  return {
    hash: hashRawFindingIdAllocationContent(normalizedContent),
    normalizedContent,
  };
}

function compareAllocationKey(
  left: DuplicateClaimAllocationKey,
  right: DuplicateClaimAllocationKey,
): number {
  const hashOrder = compareBinaryStrings(left.hash, right.hash);
  if (hashOrder !== 0) {
    return hashOrder;
  }
  return compareBinaryStrings(left.normalizedContent, right.normalizedContent);
}

function allocateReviewerLocalIds(
  records: readonly Record<string, unknown>[],
  claimedIds: readonly (string | undefined)[],
): string[] {
  const usedIds = new Set(claimedIds.filter((id): id is string => id !== undefined));
  const allocations: string[] = Array.from({ length: records.length });
  const allocationKeys = records.map(duplicateClaimAllocationKey);
  const duplicateGroups = new Map<string, number[]>();
  claimedIds.forEach((claimedId, index) => {
    if (claimedId !== undefined) {
      duplicateGroups.set(claimedId, [...(duplicateGroups.get(claimedId) ?? []), index]);
    }
  });
  for (const claimedId of [...duplicateGroups.keys()].sort(compareBinaryStrings)) {
    const indices = duplicateGroups.get(claimedId)!;
    const ordered = [...indices].sort((left, right) => (
      compareAllocationKey(allocationKeys[left]!, allocationKeys[right]!)
      || left - right
    ));
    ordered.forEach((recordIndex, ordinal) => {
      const localId = ordinal === 0
        ? claimedId
        : findFreeLocalId(usedIds, claimedId);
      allocations[recordIndex] = localId;
      usedIds.add(localId);
    });
  }
  const generatedGroups = new Map<string, number[]>();
  records.forEach((_record, index) => {
    if (claimedIds[index] !== undefined) {
      return;
    }
    const baseId = `item-${allocationKeys[index]!.hash}`;
    generatedGroups.set(baseId, [...(generatedGroups.get(baseId) ?? []), index]);
  });
  for (const baseId of [...generatedGroups.keys()].sort(compareBinaryStrings)) {
    const indices = generatedGroups.get(baseId)!;
    const ordered = [...indices].sort((left, right) => (
      compareAllocationKey(allocationKeys[left]!, allocationKeys[right]!)
      || left - right
    ));
    for (const recordIndex of ordered) {
      const localId = findFreeLocalId(usedIds, baseId);
      allocations[recordIndex] = localId;
      usedIds.add(localId);
    }
  }
  return allocations;
}

/**
 * reviewer structured output の rawFindings 配列（未検証 unknown）を candidate に
 * 落とす。個々の項目がどれほど壊れていても throw しない — 欠損は candidate 上で
 * optional のまま保持し、canonicalization が ambiguity code に変換する。
 */
export interface ReviewerCandidateIntakeRejection {
  intakeId: string;
  reviewerStableKey: string;
  reviewer: string;
  reason: string;
}

export interface ReviewerCandidateIntakeBatch {
  candidates: ReviewerRawFindingCandidate[];
  rejections: ReviewerCandidateIntakeRejection[];
}

export function createReviewerRawFindingCandidates(
  items: readonly unknown[],
  context: ReviewerRawIntakeContext,
  resourceEnvelope?: ReviewerRawResourceEnvelope,
): ReviewerCandidateIntakeBatch {
  const reviewerStableKey = computeReviewerStableKey({
    workflowName: context.workflowName,
    callNamespace: context.callNamespace,
    parentStepName: context.parentStepName,
    reviewerPersonaKey: context.reviewerPersonaKey,
  });
  // reviewer schema は rawFindingId の一意性を強制しない。同一 reviewer が同じ
  // ID を複数返すと namespaced ID も衝突し、機械分類の出力が rawFindingIds
  // 重複の最終検証違反になる（= mechanical フォールバックまで壊す）。intake で
  // 決定的に一意化して下流の一意性を保証する。
  //
  // ただし明示 ID を全件先に予約し、一意な明示 ID は必ず元の文字列のまま保持する。
  // clarification の priorAmbiguityCodesByRawId は素の明示 ID キーで、改名すると
  // 訂正済み raw の taint（ambiguityOrigin）が外れて clean 権限を得てしまう。
  // 内部採番（item-N）と重複明示 ID のサフィックスだけが予約集合を避けて生成される。
  const snapshot = snapshotReviewerRawItems(items);
  if (
    resourceEnvelope !== undefined
    && (
      resourceEnvelope.itemCount !== snapshot.length
      || resourceEnvelope.itemSourceBytes.length !== snapshot.length
    )
  ) {
    throw new Error('Reviewer raw resource envelope does not match the projected item count');
  }
  const measuredEnvelope = resourceEnvelope ?? resourceEnvelopeForSnapshot(snapshot);
  const projectedItems = snapshot.map((item, index) => (
    projectReviewerRawItem(item, measuredEnvelope.itemSourceBytes[index]!)
  ));
  const records = projectedItems.map((item) => item.record);
  const claimedIds = records.map((record) => pickString(record.rawFindingId));
  const localIds = allocateReviewerLocalIds(records, claimedIds);
  const candidates: ReviewerRawFindingCandidate[] = [];
  const rejections: ReviewerCandidateIntakeRejection[] = [];
  records.forEach((record, index) => {
    const claimedId = claimedIds[index];
    const localId = localIds[index]!;
    // reviewerRawFindingId は明示 ID があった場合だけ持つ（未指定の意味論 —
    // clarification 相関に参加しない — を保つ）。
    const reviewerRawFindingId = claimedId !== undefined ? localId : undefined;
    const intakeId = namespacedRawFindingId(context, localId);
    // 構造化出力の strict 様式では該当なしの欄が空文字で埋まるため、空文字は
    // 未指定として扱う（pickString が弾く）。
    const requests = projectEvidenceRequests(record.evidenceRequests) ?? [];
    const rawExcerpt = pickString(record.rawExcerpt);
    const target = projectFindingTarget(record.target);
    if (rawExcerpt === undefined || target === undefined) {
      rejections.push({
        intakeId,
        reviewerStableKey,
        reviewer: context.reviewerStepName,
        reason: rawExcerpt === undefined
          ? 'Normalizer extraction has no non-empty rawExcerpt'
          : 'Normalizer extraction candidate is null or has no canonicalizable target',
      });
      return;
    }
    let sourceBinding: ReviewerRawFindingCandidate['sourceBinding'];
    try {
      sourceBinding = bindCandidateSource(context.reviewReport, rawExcerpt);
    } catch (error) {
      rejections.push({
        intakeId,
        reviewerStableKey,
        reviewer: context.reviewerStepName,
        reason: error instanceof Error ? error.message : 'rawExcerpt source binding failed',
      });
      return;
    }
    const targetIdentityHash = computeTargetIdentityHash(target);
    const claimIdentityHash = computeClaimIdentityHash({
      target,
      familyTag: pickString(record.familyTag) ?? null,
      severity: pickSeverity(record.severity) ?? null,
      title: pickString(record.title) ?? null,
      description: pickString(record.description) ?? null,
      suggestion: pickString(record.suggestion) ?? null,
    });
    const issued = context.issueEvidenceRequests({
      target,
      claimIdentityHash,
      targetFindingId: pickString(record.targetFindingId) ?? null,
      requests,
    });
    const evidence = deduplicateRawEvidence(issued.evidence);
    const candidate = registerCandidate({
      intakeId,
      reviewerStableKey,
      rawExcerpt,
      sourceBinding,
      target,
      targetIdentityHash,
      candidateIdentityHash: computeCandidateIdentityHash({
        claimIdentityHash,
        sourceBinding,
      }),
      issuedEngineProofRecords: issued.engineProofRecords.map((record) => structuredClone(record)),
      evidenceCoverageGaps: [...issued.coverageGaps],
      ...(reviewerRawFindingId !== undefined ? { reviewerRawFindingId } : {}),
      ...(pickString(record.familyTag) !== undefined ? { familyTag: pickString(record.familyTag)! } : {}),
      ...(pickSeverity(record.severity) !== undefined ? { severity: pickSeverity(record.severity)! } : {}),
      ...(pickString(record.title) !== undefined ? { title: pickString(record.title)! } : {}),
      ...(pickString(record.description) !== undefined ? { description: pickString(record.description)! } : {}),
      ...(pickString(record.suggestion) !== undefined ? { suggestion: pickString(record.suggestion)! } : {}),
      ...(pickRelation(record.relation) !== undefined
        ? { relation: pickRelation(record.relation)! }
        : {}),
      ...(pickString(record.targetFindingId) !== undefined ? { targetFindingId: pickString(record.targetFindingId)! } : {}),
      evidence,
      sourceBytes: projectedItems[index]!.sourceBytes,
      reviewer: context.reviewerStepName,
      stepName: context.reviewerStepName,
    }, 'reviewer');
    if (!projectedItems[index]!.evidenceShapeValid) {
      CANDIDATE_INVALID_EVIDENCE_SHAPES.add(candidate);
    }
    candidates.push(candidate);
  });
  return { candidates, rejections };
}

/**
 * 保存済み RawFinding から recovery 用 candidate を作る。
 */
export function candidateFromStoredRawFinding(
  raw: RawFinding,
  reviewerStableKey: string,
): ReviewerRawFindingCandidate {
  if (
    raw.relation !== null
    && raw.relation !== 'new'
    && (
      raw.targetFindingId === null
      || raw.targetPrecondition === undefined
      || raw.targetPrecondition.targetFindingId !== raw.targetFindingId
    )
  ) {
    throw new Error(
      `Stored raw finding "${raw.rawFindingId}" has no valid engine-issued target precondition`,
    );
  }
  const candidate = registerCandidate({
    intakeId: raw.rawFindingId,
    reviewerStableKey,
    reviewerRawFindingId: raw.rawFindingId,
    sourceBinding: raw.sourceBinding,
    target: structuredClone(raw.target),
    targetIdentityHash: raw.targetIdentityHash,
    candidateIdentityHash: raw.candidateIdentityHash,
    issuedEngineProofRecords: [],
    evidenceCoverageGaps: [],
    ...(raw.familyTag !== null ? { familyTag: raw.familyTag } : {}),
    ...(raw.severity !== null ? { severity: raw.severity } : {}),
    ...(raw.title !== null ? { title: raw.title } : {}),
    ...(raw.description !== null ? { description: raw.description } : {}),
    ...(raw.suggestion !== null ? { suggestion: raw.suggestion } : {}),
    ...(raw.relation !== null ? { relation: raw.relation } : {}),
    ...(raw.targetFindingId !== null ? { targetFindingId: raw.targetFindingId } : {}),
    // すでに組み立て済みのネスト形（wire と同じ形）なのでそのまま引き継ぐ。
    evidence: [...raw.evidence],
    sourceBytes: Buffer.byteLength(JSON.stringify(raw), 'utf-8'),
    reviewer: raw.reviewer,
    stepName: raw.stepName,
  }, 'stored-ledger');
  if (raw.targetPrecondition !== undefined) {
    CANDIDATE_TARGET_PRECONDITIONS.set(candidate, raw.targetPrecondition);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// canonical 生成（唯一の関数）
// ---------------------------------------------------------------------------

/** ambiguous 起源 raw の権限格子。エンジンだけが発行する。 */
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
  /** correction 前の ambiguity codes。taint は同一梯子内では消さない。 */
  priorAmbiguityCodes?: readonly RawAmbiguityCode[];
  preserveAmbiguityOrigin?: boolean;
}

export type CanonicalizationResult =
  | { outcome: 'coherent'; canonical: CoherentCanonicalRawFinding }
  | { outcome: 'ambiguous'; canonical: AmbiguousCanonicalRawFinding };

interface OpenFindingIndexes {
  byId: Map<string, FindingLedgerEntry>;
}

function indexLedgerFindings(ledger: FindingLedger): OpenFindingIndexes {
  const byId = new Map<string, FindingLedgerEntry>();
  for (const finding of ledger.findings) {
    byId.set(finding.id, finding);
  }
  return { byId };
}

function buildSafeEvidenceExcerpt(candidate: ReviewerRawFindingCandidate): string {
  const title = candidate.title ?? '(no title)';
  const location = evidenceLocation(candidate.evidence) ?? '(no location)';
  const description = candidate.description !== undefined
    ? normalizeFindingText(candidate.description).slice(0, 200)
    : '(no description)';
  return `${title} @ ${location}: ${description}`.slice(0, 400);
}

/** ambiguity 検出に必要な raw のフィールド（candidate / 未検証 reviewer 出力の両方が満たせる形）。 */
export interface RawAmbiguityFields {
  relation?: RawFindingRelation | null;
  targetFindingId?: string;
  title?: string;
  description?: string;
  severity?: FindingSeverity;
  familyTag?: string;
  evidence?: readonly RawFindingEvidence[];
  /** Prompt display only. Identity and regeneration checks use evidence. */
  location?: string;
}

export interface RawAmbiguityDetection {
  codes: RawAmbiguityCode[];
  /** 'new-collides-open-finding' のとき、衝突した open finding の id。 */
  collidingFindingId?: string;
  collidingFindingTitle?: string;
}

/**
 * ambiguity 検出の唯一の実装。canonicalizeReviewerRawFinding と
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

  // relation は contract の正本。欠損は ambiguity。
  const claimedRelation = fields.relation;
  if (claimedRelation === undefined || claimedRelation === null) {
    codes.push('missing-required-field');
  }
  if (fields.title === undefined || fields.description === undefined
    || fields.severity === undefined || fields.familyTag === undefined) {
    codes.push('missing-required-field');
  }

  // relation と targetFindingId の必須・禁止条件。
  if (claimedRelation === 'new' && fields.targetFindingId !== undefined) {
    codes.push('relation-target-mismatch');
  }
  if (claimedRelation !== undefined && claimedRelation !== null
    && claimedRelation !== 'new' && fields.targetFindingId === undefined) {
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

  return { codes };
}

/**
 * 未検証の reviewer 出力1件から ambiguity 検出・candidate 生成に使うフィールドを
 * 寛容に抜き出す（絶対に throw しない）。
 */
export function extractLenientRawFields(
  item: unknown,
): RawAmbiguityFields & {
  rawFindingId?: string;
  suggestion?: string;
  rawExcerpt?: string;
  evidenceRequests?: readonly FindingEvidenceRequest[];
} {
  // フィールド抽出は resource envelope の計測後にも呼ばれるため、
  // ここでは canonical JSON の byte 計測を繰り返さない。
  const record = projectReviewerRawItem(item, 0).record;
  const evidenceRequests = projectEvidenceRequests(record.evidenceRequests) ?? [];
  return {
    ...(pickString(record.rawExcerpt) !== undefined ? { rawExcerpt: pickString(record.rawExcerpt)! } : {}),
    ...(pickString(record.rawFindingId) !== undefined ? { rawFindingId: pickString(record.rawFindingId)! } : {}),
    ...(pickRelation(record.relation) !== undefined ? { relation: pickRelation(record.relation)! } : {}),
    ...(pickString(record.targetFindingId) !== undefined ? { targetFindingId: pickString(record.targetFindingId)! } : {}),
    ...(pickString(record.title) !== undefined ? { title: pickString(record.title)! } : {}),
    ...(pickString(record.description) !== undefined ? { description: pickString(record.description)! } : {}),
    ...(pickSeverity(record.severity) !== undefined ? { severity: pickSeverity(record.severity)! } : {}),
    ...(pickString(record.familyTag) !== undefined ? { familyTag: pickString(record.familyTag)! } : {}),
    evidenceRequests,
    ...(pickString(record.suggestion) !== undefined ? { suggestion: pickString(record.suggestion)! } : {}),
  };
}

/**
 * 唯一の canonical 生成関数。candidate は必ず coherent または
 * ambiguous のどちらかに着地する — 例外で死ぬ経路は無い。
 */
export function canonicalizeReviewerRawFinding(
  candidate: ReviewerRawFindingCandidate,
  context: RawCanonicalizationContext,
): CanonicalizationResult {
  if (!isReviewerRawFindingCandidate(candidate)) {
    throw new Error('canonicalizeReviewerRawFinding: input did not come from a candidate factory');
  }
  canonicalJson(candidate);
  const origin = CANDIDATE_ORIGINS.get(candidate) ?? 'reviewer';
  const detection = detectRawFindingAmbiguities(candidate, context.ledger);
  const codes: RawAmbiguityCode[] = CANDIDATE_INVALID_EVIDENCE_SHAPES.has(candidate)
    ? [...detection.codes, 'invalid-evidence-shape']
    : detection.codes;
  const collidingFindingId = detection.collidingFindingId;
  const claimedRelation = candidate.relation;
  const storedTargetPrecondition = CANDIDATE_TARGET_PRECONDITIONS.get(candidate);

  const priorCodes = context.priorAmbiguityCodes ?? [];
  const clarificationAttempted = context.clarificationAttempted === true;
  const ambiguityOrigin = codes.length > 0
    || priorCodes.length > 0
    || context.preserveAmbiguityOrigin === true;
  const allCodes = [...new Set([...priorCodes, ...codes])];

  const relationClaimHolds = claimedRelation !== undefined
    && !(claimedRelation === 'new' && candidate.targetFindingId !== undefined)
    && !(claimedRelation !== 'new' && candidate.targetFindingId === undefined);
  const claimedTargetPrecondition = claimedRelation === undefined
    || claimedRelation === 'new'
    || candidate.targetFindingId === undefined
    ? undefined
    : storedTargetPrecondition
      ?? captureFindingMutationPrecondition(context.ledger, candidate.targetFindingId);
  const relation: RawFindingRelation | null = relationClaimHolds
    && (claimedRelation === 'new' || claimedTargetPrecondition !== undefined)
    ? claimedRelation
    : null;
  const targetPrecondition = relation === null || relation === 'new'
    ? undefined
    : claimedTargetPrecondition;
  if (
    storedTargetPrecondition !== undefined
    && candidate.targetFindingId !== undefined
    && storedTargetPrecondition.targetFindingId !== candidate.targetFindingId
  ) {
    throw new Error(
      `Stored raw finding "${candidate.intakeId}" target precondition does not match its target`,
    );
  }

  const claimIdentityHash = computeClaimIdentityHash({
    target: candidate.target,
    familyTag: candidate.familyTag ?? null,
    severity: candidate.severity ?? null,
    title: candidate.title ?? null,
    description: candidate.description ?? null,
    suggestion: candidate.suggestion ?? null,
  });
  const semanticClaimIdentityHash = computeSemanticClaimIdentityHash({
    target: candidate.target,
    title: candidate.title ?? null,
    description: candidate.description ?? null,
  });
  const displayLocation = evidenceLocation(candidate.evidence);
  const lineageKey = computeLineageKey({
    claimIdentityHash,
    ...(candidate.targetFindingId !== undefined ? { targetFindingId: candidate.targetFindingId } : {}),
    ...(collidingFindingId !== undefined ? { collidingFindingId } : {}),
  });
  const evidenceSetHash = computeRawEvidenceHash({ evidence: candidate.evidence });

  const base = {
    rawFindingId: candidate.intakeId,
    reviewerStableKey: candidate.reviewerStableKey,
    lineageKey,
    claimIdentityHash,
    semanticClaimIdentityHash,
    target: structuredClone(candidate.target),
    targetIdentityHash: candidate.targetIdentityHash,
    candidateIdentityHash: candidate.candidateIdentityHash,
    sourceBinding: { ...candidate.sourceBinding },
    issuedEngineProofRecords: candidate.issuedEngineProofRecords.map((record) => structuredClone(record)),
    evidenceCoverageGaps: [...candidate.evidenceCoverageGaps],
    evidenceSetHash,
    relation,
    reviewer: candidate.reviewer,
    stepName: candidate.stepName,
    ...(targetPrecondition !== undefined ? { targetPrecondition: { ...targetPrecondition } } : {}),
    provenance: {
      origin,
      ambiguityOrigin,
      clarificationAttempted,
      ambiguityCodes: [...allCodes],
    },
    // typed evidence protocol(review-integrity protocol)。coherent/ambiguous どちらの raw も
    // 持ちうる(ambiguity は relation/target の構造的矛盾であり、evidence の有無とは
    // 直交する。claim identity と evidence set のハッシュは別ドメインで保持する。
    evidence: candidate.evidence.map((item) => ({ ...item })),
  };

  // 形式が完全（codes 空）なら coherent。ただし taint（priorCodes）は保持する:
  // correction で relation が整った raw は形式上 coherent だが ambiguityOrigin は
  // true のままで、downstream の権限判定は provenance を見る。
  if (codes.length === 0
    && relation !== null
    && candidate.title !== undefined && candidate.description !== undefined
    && candidate.severity !== undefined && candidate.familyTag !== undefined) {
    const canonical = registerCoherentCanonical({
      ...base,
      coherence: 'coherent',
      relation,
      familyTag: candidate.familyTag,
      severity: candidate.severity,
      title: candidate.title,
      description: candidate.description,
      ...(displayLocation !== undefined ? { location: displayLocation } : {}),
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
    ...(displayLocation !== undefined ? { location: displayLocation } : {}),
    ...(candidate.suggestion !== undefined ? { suggestion: candidate.suggestion } : {}),
  });
  return { outcome: 'ambiguous', canonical };
}

// ---------------------------------------------------------------------------
// 台帳（wire 形）への写像
// ---------------------------------------------------------------------------

/**
 * canonical を ledger の RawFinding wire 形へ落とす。ambiguous で必須文字列が
 * 欠損フィールドは null のまま監査保存し、意味値を補完しない。
 * relation は canonical の値を unknown を含めてそのまま保存する。
 */
export function toLedgerRawFinding(canonical: CanonicalRawFinding): RawFinding {
  assertCanonicalRawFinding(canonical, 'toLedgerRawFinding');
  // description は本文のまま保つ（注記を混ぜない）。ambiguity code や relation
  // の unknown 化は canonical.provenance / 検証レポート / provisional.reason
  // 側にあり、description を汚すと provisional entry と後続の
  // clean raw の claimIdentityHash 照合が壊れ、確定・
  // 解消（evidence CAS requirement の決定的照合）が永久に成立しなくなる。
  const title = canonical.title ?? null;
  const description = canonical.description ?? null;
  return {
    rawFindingId: canonical.rawFindingId,
    stepName: canonical.stepName,
    reviewer: canonical.reviewer,
    familyTag: canonical.familyTag ?? null,
    severity: canonical.severity ?? null,
    title,
    description,
    suggestion: canonical.suggestion ?? null,
    target: structuredClone(canonical.target),
    targetIdentityHash: canonical.targetIdentityHash,
    claimIdentityHash: canonical.claimIdentityHash,
    semanticClaimIdentityHash: canonical.semanticClaimIdentityHash,
    candidateIdentityHash: canonical.candidateIdentityHash,
    sourceBinding: { ...canonical.sourceBinding },
    relation: canonical.relation,
    targetFindingId: canonical.relation !== 'new' && canonical.targetFindingId !== undefined
      ? canonical.targetFindingId
      : null,
    ...(canonical.targetPrecondition !== undefined
      ? { targetPrecondition: canonical.targetPrecondition }
      : {}),
    evidence: canonical.evidence.map((item) => ({ ...item })),
  };
}

export function canonicalRawIntegrityDigestOf(
  canonical: CanonicalRawFinding,
): string {
  assertCanonicalRawFinding(canonical, 'canonicalRawIntegrityDigestOf');
  return computeCanonicalRawIntegrityDigest({
    canonicalWire: toLedgerRawFinding(canonical),
    provenance: canonical.provenance,
    reviewerStableKey: canonical.reviewerStableKey,
    lineageKey: canonical.lineageKey,
    claimIdentityHash: canonical.claimIdentityHash,
  });
}
