import { z } from 'zod/v4';
import { PROVIDER_TYPES } from '../../shared/types/provider.js';
import { normalizeRfc3339Timestamp } from './rfc3339.js';
import type {
  FindingConflictAdjudicationOutput,
  FindingLedger,
  FindingManagerDecisions,
  FindingManagerOutput,
  RawFinding,
  RawFindingRelation,
} from './finding-types.js';
import type { AmbiguousInterpretation, RawFindingKind } from './finding-types.js';
import {
  AMBIGUOUS_INTERPRETATION_DECISIONS,
  RAW_FINDING_KINDS,
  RAW_FINDING_RELATIONS,
  CONFLICT_DECISION_KINDS,
  DISPUTE_DECISION_KINDS,
  FINDING_CONFLICT_ADJUDICATION_OUTCOMES,
  FINDING_CONFLICT_ADJUDICATION_TRANSITIONS,
  FINDING_CONFLICT_STATUSES,
  FINDING_LIFECYCLES,
  FINDING_PROVISIONAL_KINDS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  INTERPRETATION_APPLICATION_RESULTS,
  INTERPRETATION_STAGES,
  RAW_DECISION_KINDS,
  RAW_FINDING_EVIDENCE_KINDS,
  REVIEWER_ANOMALY_KINDS,
} from './finding-types.js';

const nonEmptyString = z.string().min(1);

export const Rfc3339TimestampSchema = z.string().min(1).transform((timestamp, ctx) => {
  try {
    return normalizeRfc3339Timestamp(timestamp);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Expected a valid RFC 3339 timestamp',
    });
    return z.NEVER;
  }
});

export const FindingContractManagerConfigRawSchema = z.object({
  persona: nonEmptyString,
  instruction: nonEmptyString,
  output_contract: nonEmptyString,
  provider: z.enum(PROVIDER_TYPES).optional(),
  model: nonEmptyString.optional(),
}).strict();

/** 有限停止予算。両方省略可 — max_rounds は省略時に既定値 40、max_minutes は省略時は時間上限なし（opt-in）。 */
export const FindingContractStopBudgetRawSchema = z.object({
  max_rounds: z.number().int().positive().optional(),
  max_minutes: z.number().int().positive().optional(),
}).strict();

/** review-integrity 予算（review-integrity requirement）。省略可 — 省略時は review-integrity.ts の DEFAULT_REVIEW_INTEGRITY_BUDGET が補う。 */
export const FindingContractReviewBudgetRawSchema = z.object({
  max_review_rounds: z.number().int().positive().optional(),
}).strict();

export const FindingContractConfigRawSchema = z.object({
  ledger_path: nonEmptyString,
  raw_findings_path: nonEmptyString,
  manager: FindingContractManagerConfigRawSchema,
  stop_budget: FindingContractStopBudgetRawSchema.optional(),
  review_budget: FindingContractReviewBudgetRawSchema.optional(),
}).strict();

export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export const FindingStatusSchema = z.enum(FINDING_STATUSES);
export const FindingLifecycleSchema = z.enum(FINDING_LIFECYCLES);

export const FindingObservationSchema = z.object({
  runId: nonEmptyString,
  stepName: nonEmptyString,
  timestamp: Rfc3339TimestampSchema,
}).strict();

// ---------------------------------------------------------------------------
// typed evidence protocol（review-integrity protocol: admission control 強化）
// ---------------------------------------------------------------------------

export const SourceQuoteEvidenceSchema = z.object({
  kind: z.literal('source_quote'),
  path: nonEmptyString,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  verbatimExcerpt: nonEmptyString,
  snapshotId: nonEmptyString,
}).strict();

export const LocationlessEvidenceSchema = z.object({
  kind: z.literal('locationless'),
  explanation: nonEmptyString,
}).strict();

/** RawFinding.evidence の discriminated union。台帳保存形（組み立て済みネスト）を検証する — provider-facing の flat wire とは別（RawFindingsOutputJsonSchema 参照）。 */
export const RawFindingEvidenceSchema = z.discriminatedUnion('kind', [
  SourceQuoteEvidenceSchema,
  LocationlessEvidenceSchema,
]);

export const ReviewerAnomalyEntrySchema = z.object({
  id: nonEmptyString,
  kind: z.enum(REVIEWER_ANOMALY_KINDS),
  stableKey: nonEmptyString,
  lineageKey: nonEmptyString,
  sourceRawFindingIds: z.array(nonEmptyString),
  reviewers: z.array(nonEmptyString),
  title: nonEmptyString,
  claimedLocation: nonEmptyString.optional(),
  claimedExcerpt: nonEmptyString.optional(),
  mismatchReason: nonEmptyString,
  firstObserved: FindingObservationSchema,
  lastObserved: FindingObservationSchema,
  occurrences: z.number().int().positive(),
  promotedFindingId: nonEmptyString.optional(),
}).strict();

/** provisional メタデータ。ledger v1 の optional field なので後方互換。 */
export const FindingProvisionalMetadataSchema = z.object({
  kind: z.enum(FINDING_PROVISIONAL_KINDS),
  stableKey: nonEmptyString,
  lineageKey: nonEmptyString,
  sourceRawFindingIds: z.array(nonEmptyString),
  reason: nonEmptyString,
  firstObservedAt: FindingObservationSchema,
  lastObservedAt: FindingObservationSchema,
  interpretationEpochs: z.number().int().min(0),
  gateEffect: z.literal('block'),
}).strict();

export const FindingLedgerEntrySchema = z.object({
  id: nonEmptyString,
  status: FindingStatusSchema,
  lifecycle: FindingLifecycleSchema,
  severity: FindingSeveritySchema,
  title: nonEmptyString,
  location: nonEmptyString.optional(),
  description: nonEmptyString.optional(),
  suggestion: nonEmptyString.optional(),
  reviewers: z.array(nonEmptyString),
  rawFindingIds: z.array(nonEmptyString),
  firstSeen: FindingObservationSchema,
  lastSeen: FindingObservationSchema,
  resolvedAt: Rfc3339TimestampSchema.optional(),
  resolvedEvidence: nonEmptyString.optional(),
  reopenedEvidence: nonEmptyString.optional(),
  waivers: z.array(z.object({
    reason: nonEmptyString,
    evidence: nonEmptyString,
    decidedAt: FindingObservationSchema,
  }).strict()).optional(),
  disputes: z.array(z.object({
    reason: nonEmptyString,
    evidence: nonEmptyString,
    recordedAt: FindingObservationSchema,
  }).strict()).optional(),
  invalidatedAt: Rfc3339TimestampSchema.optional(),
  invalidatedEvidence: nonEmptyString.optional(),
  supersededByFindingId: nonEmptyString.optional(),
  revision: z.number().int().positive().optional(),
  provisional: FindingProvisionalMetadataSchema.optional(),
  rejectedObservations: z.array(z.object({
    rawFindingId: nonEmptyString,
    reason: nonEmptyString,
    observedAt: FindingObservationSchema,
  }).strict()).optional(),
}).strict();

/**
 * relation → kind の唯一の機械導出。`kind` は入力上の判断項目に
 * しない: canonical 側では relation と kind を必須にし、必ずこの関数の結果と
 * 一致させる。逆方向（kind → relation の推測）は legacy adapter
 * （deriveRawFindingRelation 経由）だけに許される。
 */
export function kindForRelation(relation: RawFindingRelation): RawFindingKind {
  return relation === 'resolution_confirmation' ? 'resolution_confirmation' : 'issue';
}

/**
 * Derives the authoritative `relation` from a parsed raw finding whose `relation`
 * field may be absent (pre-existing data, or a schema predating this field).
 * Backward compatibility rule: relation undefined + kind 'resolution_confirmation'
 * -> 'resolution_confirmation'; relation undefined + kind 'issue'/undefined with
 * targetFindingId set -> 'persists' (this is how pre-relation ledgers recorded
 * a re-report against an existing finding); relation undefined + kind
 * 'issue'/undefined with no targetFindingId -> 'new'.
 *
 * This is the single authoritative derivation: schema parsing uses it here, and
 * effectiveRawFindingRelation (core/workflow/findings/mechanical-classification.ts)
 * delegates to it for hand-built raws that never went through the schema.
 */
export function deriveRawFindingRelation(
  kind: RawFinding['kind'],
  relation: RawFindingRelation | undefined,
  targetFindingId: string | undefined,
): RawFindingRelation {
  if (relation !== undefined) {
    return relation;
  }
  if (kind === 'resolution_confirmation') {
    return 'resolution_confirmation';
  }
  return targetFindingId !== undefined ? 'persists' : 'new';
}

interface RawFindingRelationFields {
  kind?: RawFinding['kind'];
  relation?: RawFindingRelation;
  targetFindingId?: string;
}

/**
 * Derives `relation` and validates the invariants from the feature spec in one
 * pass: relation=new forbids targetFindingId; every other relation requires it;
 * kind and relation must agree where both are present (kept for the transition
 * period — relation is authoritative, kind is retained for callers that have not
 * migrated). Shared by RawFindingSchema and ReviewerRawFindingSchema so the two
 * wire shapes (manager-facing vs. reviewer-facing) can't drift.
 */
function resolveRawFindingRelation<T extends RawFindingRelationFields>(
  value: T,
  ctx: z.RefinementCtx,
): T & { relation: RawFindingRelation } {
  const relation = deriveRawFindingRelation(value.kind, value.relation, value.targetFindingId);
  if (relation === 'new' && value.targetFindingId !== undefined) {
    ctx.addIssue({ code: 'custom', message: '"new" raw findings must not set targetFindingId', path: ['targetFindingId'] });
  }
  if (relation !== 'new' && value.targetFindingId === undefined) {
    ctx.addIssue({ code: 'custom', message: `"${relation}" raw findings require targetFindingId`, path: ['targetFindingId'] });
  }
  if (value.kind !== undefined) {
    const kindImpliesConfirmation = value.kind === 'resolution_confirmation';
    const relationIsConfirmation = relation === 'resolution_confirmation';
    if (kindImpliesConfirmation !== relationIsConfirmation) {
      ctx.addIssue({
        code: 'custom',
        message: `kind "${value.kind}" is inconsistent with relation "${relation}"`,
        path: ['relation'],
      });
    }
  }
  return { ...value, relation };
}

const RawFindingFieldsSchema = z.object({
  rawFindingId: nonEmptyString,
  stepName: nonEmptyString,
  reviewer: nonEmptyString,
  familyTag: nonEmptyString,
  severity: FindingSeveritySchema,
  title: nonEmptyString,
  // 構造化出力の strict 様式では全プロパティが required になるため、
  // 該当なしの欄は空文字で埋められる。空文字は未指定として扱う。
  location: z.string().optional().transform((value) => (value ? value : undefined)),
  description: nonEmptyString,
  suggestion: z.string().optional().transform((value) => (value ? value : undefined)),
  kind: z.enum(RAW_FINDING_KINDS).optional(),
  relation: z.enum(RAW_FINDING_RELATIONS).optional(),
  targetFindingId: nonEmptyString.optional(),
  // typed evidence protocol（review-integrity protocol）。既存 v1 台帳の raw finding には
  // 無いため optional — 欠損は「evidence なし」として扱う（migration 不要）。
  evidence: RawFindingEvidenceSchema.optional(),
}).strict();

export const RawFindingSchema = RawFindingFieldsSchema.transform(resolveRawFindingRelation);

const ReviewerRawFindingFieldsSchema = z.object({
  rawFindingId: nonEmptyString,
  familyTag: nonEmptyString,
  severity: FindingSeveritySchema,
  title: nonEmptyString,
  // 構造化出力の strict 様式では全プロパティが required になるため、
  // 該当なしの欄は空文字で埋められる。空文字は未指定として扱う。
  location: z.string().optional().transform((value) => (value ? value : undefined)),
  description: nonEmptyString,
  suggestion: z.string().optional().transform((value) => (value ? value : undefined)),
  kind: z.enum(RAW_FINDING_KINDS).optional(),
  relation: z.enum(RAW_FINDING_RELATIONS).optional(),
  // 構造化出力の strict 様式では全プロパティが required になるため、
  // issue 行は空文字で埋める。空文字は未指定として扱う。
  targetFindingId: z.string().optional().transform((value) => (value ? value : undefined)),
  evidence: RawFindingEvidenceSchema.optional(),
}).strict();

export const ReviewerRawFindingSchema = ReviewerRawFindingFieldsSchema.transform(resolveRawFindingRelation);

export const FindingConflictAdjudicationOutcomeSchema = z.enum(FINDING_CONFLICT_ADJUDICATION_OUTCOMES);
export const FindingConflictAdjudicationTransitionSchema = z.enum(FINDING_CONFLICT_ADJUDICATION_TRANSITIONS);

export const FindingConflictAdjudicationRecordSchema = z.object({
  evidenceHash: nonEmptyString,
  outcome: FindingConflictAdjudicationOutcomeSchema,
  findingTransition: FindingConflictAdjudicationTransitionSchema,
  evidence: z.array(nonEmptyString),
  actionableFix: z.string(),
  decidedAt: FindingObservationSchema,
}).strict();

export const FindingConflictAdjudicationAttemptSchema = z.object({
  evidenceHash: nonEmptyString,
  reservationToken: nonEmptyString,
  startedAt: FindingObservationSchema,
  originStep: nonEmptyString.optional(),
}).strict();

export const FindingLedgerConflictSchema = z.object({
  id: nonEmptyString,
  status: z.enum(FINDING_CONFLICT_STATUSES),
  findingIds: z.array(nonEmptyString),
  rawFindingIds: z.array(nonEmptyString),
  description: nonEmptyString,
  firstSeen: FindingObservationSchema,
  lastSeen: FindingObservationSchema,
  resolvedAt: Rfc3339TimestampSchema.optional(),
  resolvedEvidence: nonEmptyString.optional(),
  adjudications: z.array(FindingConflictAdjudicationRecordSchema).optional(),
  adjudicationAttempts: z.array(FindingConflictAdjudicationAttemptSchema).optional(),
}).strict();

/** 楽観的前提条件（CAS）。 */
export const FindingMutationPreconditionSchema = z.object({
  targetFindingId: nonEmptyString,
  targetRevision: z.number().int().positive(),
  targetStatus: FindingStatusSchema,
  targetEvidenceHash: nonEmptyString,
}).strict();

/**
 * manager が ambiguous raw に返す「提案」。台帳操作そのものでは
 * ない。decision ごとの必須フィールドは AmbiguousInterpretationSchema の
 * superRefine と raw-capabilities.ts の runtime 検証の両方で強制する。
 */
export const AmbiguousInterpretationSchema = z.object({
  decision: z.enum(AMBIGUOUS_INTERPRETATION_DECISIONS),
  rawFindingId: nonEmptyString,
  // strict 様式の構造化出力では全プロパティ required になるため、該当なしは
  // 空文字で埋めさせて未指定として扱う。
  proofId: z.string().optional().transform((value) => (value ? value : undefined)),
  targetFindingId: z.string().optional().transform((value) => (value ? value : undefined)),
  reason: z.string().optional().transform((value) => (value ? value : undefined)),
}).strict();

export type ParsedAmbiguousInterpretation = z.infer<typeof AmbiguousInterpretationSchema>;

/**
 * parse 済み提案を判別可能な AmbiguousInterpretation へ正規化する。decision ごとの
 * 必須フィールド欠損は undefined を返す（呼び出し元が提案不正 → provisional へ
 * 落とす。例外にしない: manager の壊れた応答で run を殺さない）。
 */
export function toAmbiguousInterpretation(parsed: {
  decision: ParsedAmbiguousInterpretation['decision'];
  rawFindingId: string;
  proofId?: string | undefined;
  targetFindingId?: string | undefined;
  reason?: string | undefined;
}): AmbiguousInterpretation | undefined {
  switch (parsed.decision) {
    case 'create_independent':
      return { decision: 'create_independent', rawFindingId: parsed.rawFindingId };
    case 'same_with_proof':
      return parsed.proofId !== undefined
        ? { decision: 'same_with_proof', rawFindingId: parsed.rawFindingId, proofId: parsed.proofId }
        : undefined;
    case 'open_conflict':
      return parsed.targetFindingId !== undefined
        ? { decision: 'open_conflict', rawFindingId: parsed.rawFindingId, targetFindingId: parsed.targetFindingId }
        : undefined;
    case 'provisional':
      return parsed.reason !== undefined
        ? { decision: 'provisional', rawFindingId: parsed.rawFindingId, reason: parsed.reason }
        : undefined;
  }
}

/** WAL に保存する検証済み提案。判別型を復元できる形で保存する。 */
const StoredAmbiguousInterpretationSchema = z.object({
  decision: z.enum(AMBIGUOUS_INTERPRETATION_DECISIONS),
  rawFindingId: nonEmptyString,
  proofId: nonEmptyString.optional(),
  targetFindingId: nonEmptyString.optional(),
  reason: nonEmptyString.optional(),
}).strict().transform((value, ctx): AmbiguousInterpretation => {
  const interpretation = toAmbiguousInterpretation(value);
  if (interpretation === undefined) {
    ctx.addIssue({ code: 'custom', message: `stored interpretation decision "${value.decision}" is missing its required field` });
    return z.NEVER;
  }
  return interpretation;
});

export const FindingInterpretationRecordSchema = z.object({
  interpretationKey: nonEmptyString,
  reviewerStableKey: nonEmptyString,
  lineageKey: nonEmptyString,
  candidateEvidenceHash: nonEmptyString,
  policyVersion: z.literal(2),
  stage: z.enum(INTERPRETATION_STAGES),
  startedAt: FindingObservationSchema,
  promptPreconditions: z.array(FindingMutationPreconditionSchema),
  completedAt: FindingObservationSchema.optional(),
  validatedDecision: StoredAmbiguousInterpretationSchema.optional(),
  appliedAt: FindingObservationSchema.optional(),
  applicationResult: z.enum(INTERPRETATION_APPLICATION_RESULTS).optional(),
}).strict();

/** ラウンド跨ぎの fixpoint 比較スナップショット。 */
export const FindingLedgerFixpointSnapshotSchema = z.object({
  provisionalKeys: z.array(nonEmptyString),
  substantiveEntries: z.array(nonEmptyString),
  unadjudicatedConflictEntries: z.array(nonEmptyString),
}).strict();

export const FindingLedgerFixpointStateSchema = z.object({
  snapshot: FindingLedgerFixpointSnapshotSchema,
  reached: z.boolean(),
}).strict();

/** 有限停止予算のラウンド跨ぎ累積状態。roundsCompleted は roundMarkers.length から導出する（冪等な適用済み集合）。 */
export const FindingLedgerStopBudgetStateSchema = z.object({
  roundMarkers: z.array(nonEmptyString),
  firstRoundAt: Rfc3339TimestampSchema,
  exhausted: z.boolean(),
}).strict();

/** review-integrity 予算（review-integrity requirement）のラウンド跨ぎ累積状態。stopBudget と同形。 */
export const FindingLedgerReviewIntegrityStateSchema = z.object({
  roundMarkers: z.array(nonEmptyString),
  firstRoundAt: Rfc3339TimestampSchema,
  exhausted: z.boolean(),
}).strict();

export const FindingLedgerSchema = z.object({
  version: z.literal(1),
  workflowName: nonEmptyString,
  nextId: z.number().int().positive(),
  updatedAt: Rfc3339TimestampSchema,
  findings: z.array(FindingLedgerEntrySchema),
  rawFindings: z.array(RawFindingSchema),
  conflicts: z.array(FindingLedgerConflictSchema),
  interpretations: z.array(FindingInterpretationRecordSchema).optional(),
  fixpoint: FindingLedgerFixpointStateSchema.optional(),
  stopBudget: FindingLedgerStopBudgetStateSchema.optional(),
  // 二系統台帳（review-integrity protocol）の review-integrity 側。optional なので既存
  // v1 ledger は migration なしで読める。
  reviewerAnomalies: z.array(ReviewerAnomalyEntrySchema).optional(),
  // review-integrity 予算（review-integrity requirement）。optional。
  reviewIntegrity: FindingLedgerReviewIntegrityStateSchema.optional(),
}).strict();

function migrateLegacyAdjudicationAttempts(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const ledger = value as Record<string, unknown>;
  if (ledger['version'] !== 1 || !Array.isArray(ledger['conflicts'])) {
    return value;
  }
  return {
    ...ledger,
    conflicts: ledger['conflicts'].map((candidate, conflictIndex) => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return candidate;
      }
      const conflict = candidate as Record<string, unknown>;
      if (!Array.isArray(conflict['adjudicationAttempts'])) {
        return candidate;
      }
      return {
        ...conflict,
        adjudicationAttempts: conflict['adjudicationAttempts'].map((attempt, attemptIndex) => {
          if (
            attempt === null
            || typeof attempt !== 'object'
            || Array.isArray(attempt)
            || 'reservationToken' in attempt
          ) {
            return attempt;
          }
          return {
            ...attempt,
            reservationToken: `legacy-v1:${conflictIndex}:${attemptIndex}:${String(conflict['id'])}`,
          };
        }),
      };
    }),
  };
}

/**
 * findings-manager の ambiguous 解釈フェーズが返す structured output の JSON
 * schema。提案（proposal）だけを返させる — 台帳操作の8配列は返させない。
 */
export const AmbiguousInterpretationsOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['interpretations'],
  properties: {
    interpretations: {
      type: 'array',
      description: 'Exactly one interpretation per ambiguous raw finding listed in the prompt. These are PROPOSALS: the engine holds all authority and rejects anything outside your granted capabilities.',
      // 構造的なハード上限（synthetic-step requirement）: 出力サイズは schema レベルで有界化する。
      // batch は最大16件（MANAGER_INTERPRETATION_LIMITS.maxAmbiguousCandidatesPerBatch）、
      // 各フィールドは固定長。chars/4 のトークン概算は計測・ログ用であって
      // ハード上限ではない（native structured output provider は生成自体が
      // この schema で拘束される）。
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'rawFindingId', 'proofId', 'targetFindingId', 'reason'],
        properties: {
          decision: {
            enum: AMBIGUOUS_INTERPRETATION_DECISIONS,
            description: 'create_independent = the observation is a real, independent problem; a NEW open finding is created (existing findings are never touched). same_with_proof = you assert it is identical to an existing open finding AND the prompt gave you an engine-issued proofId for that pair; echo that proofId. open_conflict = it relates to an existing finding but you cannot determine identity; an active conflict is recorded against that finding (the finding is not closed). provisional = you cannot determine the meaning; the observation is kept as a gate-blocking provisional finding.',
          },
          rawFindingId: { type: 'string', minLength: 1, maxLength: 512 },
          proofId: {
            type: 'string',
            maxLength: 128,
            description: 'Required for same_with_proof: an engine-issued proof id from the prompt. Empty string otherwise. You cannot mint proof ids yourself.',
          },
          targetFindingId: {
            type: 'string',
            maxLength: 128,
            description: 'Required for open_conflict: the existing finding id the observation conflicts with. Empty string otherwise.',
          },
          reason: {
            type: 'string',
            maxLength: 2048,
            description: 'Required for provisional: why the meaning cannot be determined. Empty string otherwise.',
          },
        },
      },
    },
  },
} as const;

export function parseAmbiguousInterpretations(value: unknown): ParsedAmbiguousInterpretation[] {
  const parsed = z.object({ interpretations: z.array(AmbiguousInterpretationSchema) }).strict().parse(value);
  return parsed.interpretations;
}

export const FindingManagerOutputSchema = z.object({
  matches: z.array(z.object({
    findingId: nonEmptyString,
    rawFindingIds: z.array(nonEmptyString),
    evidence: nonEmptyString.nullable().optional().transform((value) => value ?? undefined),
  }).strict()),
  newFindings: z.array(z.object({
    rawFindingIds: z.array(nonEmptyString),
    title: nonEmptyString,
    severity: FindingSeveritySchema,
  }).strict()),
  resolvedFindings: z.array(z.object({
    findingId: nonEmptyString,
    rawFindingIds: z.array(nonEmptyString),
    evidence: nonEmptyString,
  }).strict()),
  reopenedFindings: z.array(z.object({
    findingId: nonEmptyString,
    rawFindingIds: z.array(nonEmptyString),
    evidence: nonEmptyString,
  }).strict()),
  conflicts: z.array(z.object({
    findingIds: z.array(nonEmptyString).optional().default([]),
    rawFindingIds: z.array(nonEmptyString),
    description: nonEmptyString,
  }).strict()),
  resolvedConflicts: z.array(z.object({
    conflictId: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()),
  waivedFindings: z.array(z.object({
    findingId: nonEmptyString,
    reason: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()).optional().default([]),
  disputeNotes: z.array(z.object({
    findingId: nonEmptyString,
    reason: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()).optional().default([]),
  // 追加的（既存台帳 v1 の内部表現に対して後方互換）。既存呼び出しはこの2配列を
  // 渡さないことがあるため default([]) で補う。
  invalidatedFindings: z.array(z.object({
    findingId: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()).optional().default([]),
  duplicateFindings: z.array(z.object({
    canonicalFindingId: nonEmptyString,
    // 決定スキーマ側（FindingManagerDuplicateDecisionSchema）と対称に空配列を
    // 拒否する。duplicate を1件も持たないエントリは「何も統合しない統合」で、
    // canonical だけが transitionedFindingIds に載る等の副作用だけが残る。
    duplicateFindingIds: z.array(nonEmptyString).min(1),
    evidence: nonEmptyString,
  }).strict()).optional().default([]),
}).strict();

// LLM に返させるのは判断だけ。8配列への組み立てと不変条件の強制は
// decision-assembly.ts（コード側）が行う。findingId は same/resolved/reopened/
// conflict でのみ必須なため、strict 様式の制約上は required に含めつつ、
// 該当なし（new/unsupported）は空文字で埋めさせて未指定として扱う。
export const FindingManagerRawDecisionSchema = z.object({
  rawFindingId: nonEmptyString,
  decision: z.enum(RAW_DECISION_KINDS),
  findingId: z.string().optional().transform((value) => (value ? value : undefined)),
  evidence: nonEmptyString,
}).strict();

export const FindingManagerDisputeDecisionSchema = z.object({
  findingId: nonEmptyString,
  decision: z.enum(DISPUTE_DECISION_KINDS),
  reason: nonEmptyString,
  evidence: nonEmptyString,
}).strict();

export const FindingManagerConflictDecisionSchema = z.object({
  conflictId: nonEmptyString,
  decision: z.enum(CONFLICT_DECISION_KINDS),
  evidence: nonEmptyString,
}).strict();

/** Candidate eligibility (which findingId values may appear here) is enforced by decision-assembly.ts, not by this schema — see FindingManagerInvalidateDecision. */
export const FindingManagerInvalidateDecisionSchema = z.object({
  findingId: nonEmptyString,
  evidence: nonEmptyString,
}).strict();

export const FindingManagerDuplicateDecisionSchema = z.object({
  canonicalFindingId: nonEmptyString,
  duplicateFindingIds: z.array(nonEmptyString).min(1),
  evidence: nonEmptyString,
}).strict();

export const FindingManagerDecisionsSchema = z.object({
  rawDecisions: z.array(FindingManagerRawDecisionSchema),
  disputeDecisions: z.array(FindingManagerDisputeDecisionSchema),
  conflictDecisions: z.array(FindingManagerConflictDecisionSchema),
  invalidateDecisions: z.array(FindingManagerInvalidateDecisionSchema).optional().default([]),
  duplicateDecisions: z.array(FindingManagerDuplicateDecisionSchema).optional().default([]),
}).strict();

export const FindingManagerOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['matches', 'newFindings', 'resolvedFindings', 'reopenedFindings', 'conflicts', 'resolvedConflicts', 'waivedFindings', 'disputeNotes', 'invalidatedFindings', 'duplicateFindings'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'rawFindingIds', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          evidence: { type: ['string', 'null'], minLength: 1 },
        },
      },
    },
    newFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawFindingIds', 'title', 'severity'],
        properties: {
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          title: { type: 'string', minLength: 1 },
          severity: { enum: FINDING_SEVERITIES },
        },
      },
    },
    resolvedFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'rawFindingIds', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    reopenedFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'rawFindingIds', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingIds', 'rawFindingIds', 'description'],
        properties: {
          findingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          description: { type: 'string', minLength: 1 },
        },
      },
    },
    resolvedConflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['conflictId', 'evidence'],
        properties: {
          conflictId: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    waivedFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'reason', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    disputeNotes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'reason', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    invalidatedFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    duplicateFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['canonicalFindingId', 'duplicateFindingIds', 'evidence'],
        properties: {
          canonicalFindingId: { type: 'string', minLength: 1 },
          duplicateFindingIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

/**
 * findings-manager が実際に返す structured output。FindingManagerOutputJsonSchema
 * （8配列を自力で組み立てる旧形式、台帳の内部表現として残置）とは異なり、
 * raw finding 1件・disputed finding 1件・conflict 1件ごとの「判断」だけを問う。
 * 組み立てと不変条件の強制は decision-assembly.ts が行うため、弱いモデルでも
 * 出力すべき形が単純になる。
 */
export const FindingManagerDecisionsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rawDecisions', 'disputeDecisions', 'conflictDecisions', 'invalidateDecisions', 'duplicateDecisions'],
  properties: {
    rawDecisions: {
      type: 'array',
      description: 'Exactly one decision per residual raw finding listed in the prompt.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawFindingId', 'decision', 'findingId', 'evidence'],
        properties: {
          rawFindingId: { type: 'string', minLength: 1 },
          decision: {
            enum: RAW_DECISION_KINDS,
            description: 'same = matches an existing open finding (familyTag and line-number differences alone are not disqualifying; judge by failure mode, trigger, impact, and required fix). new = no related finding exists yet. resolved = confirms an existing open finding is fixed. reopened = a previously resolved/waived finding reappeared. conflict = contradicts an existing finding. unsupported = the raw finding explicitly referenced an existing finding (targetFindingId) as persists/reopened but the reference does not hold up; do not fall back to new.',
          },
          findingId: {
            type: 'string',
            description: 'Ledger finding id. Required for same/resolved/reopened/conflict. Empty string for new/unsupported.',
          },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    disputeDecisions: {
      type: 'array',
      description: 'One decision per finding id claimed in the "Disputed Findings" heading of the prior step response. Empty if there is no such heading.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'decision', 'reason', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          decision: {
            enum: DISPUTE_DECISION_KINDS,
            description: 'waive = approve the dispute and remove the finding from the blocking set. note = reject the dispute and keep the finding open.',
          },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    conflictDecisions: {
      type: 'array',
      description: 'One decision per active conflict in the previous ledger. Empty if there is no active conflict.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['conflictId', 'decision', 'evidence'],
        properties: {
          conflictId: { type: 'string', minLength: 1 },
          decision: {
            enum: CONFLICT_DECISION_KINDS,
            description: 'resolve = the conflict is adjudicated. keep = the conflict is still unresolved.',
          },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    invalidateDecisions: {
      type: 'array',
      description: 'One optional decision per finding id listed as an invalidation candidate in the prompt (the engine already deterministically verified its location fails). Leave empty when there are no candidates or you disagree with all of them. You cannot invalidate a finding that is not in the candidate list.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    duplicateDecisions: {
      type: 'array',
      description: 'Merge open findings that are the same underlying problem (same failure mode, trigger, impact, and fix) into one canonical finding. Leave empty when there are no duplicates among the open findings shown.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['canonicalFindingId', 'duplicateFindingIds', 'evidence'],
        properties: {
          canonicalFindingId: { type: 'string', minLength: 1 },
          duplicateFindingIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

// LLM が返す一次出力。outcome と findingTransition の整合はスキーマでは強制しない
// （enum ペアの相互制約は JSON Schema / zod の素朴な組み合わせでは表現できない）。
// 整合の検証（不一致は reject して例外）と、outcome + actionableFix からの
// disposition 導出は adjudication-apply.ts の責務（"決定可能なものはコードで
// 処理し LLM には判断だけ残す" という Finding Contract 全体の設計方針に合わせる）。
export const FindingConflictAdjudicationOutputSchema = z.object({
  conflictId: nonEmptyString,
  outcome: FindingConflictAdjudicationOutcomeSchema,
  findingTransition: FindingConflictAdjudicationTransitionSchema,
  evidence: z.array(nonEmptyString).min(1),
  actionableFix: z.string(),
}).strict();

export const FindingConflictAdjudicationOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['conflictId', 'outcome', 'findingTransition', 'evidence', 'actionableFix'],
  properties: {
    conflictId: {
      type: 'string',
      minLength: 1,
      description: 'The conflict id given to you in the prompt. Echo it back unchanged.',
    },
    outcome: {
      enum: FINDING_CONFLICT_ADJUDICATION_OUTCOMES,
      description: 'finding_valid = the reviewer finding is legitimate and still stands; state the concrete coder fix in actionableFix so the workflow can route to the fix step (a finding_valid with an empty actionableFix is treated as undetermined). finding_stale = the finding no longer applies (already fixed, or the code it describes no longer exists). evidence_invalid = the finding\'s own premise does not hold (it was never a real problem). undetermined = you could not reach a conclusion from the evidence available.',
    },
    findingTransition: {
      enum: FINDING_CONFLICT_ADJUDICATION_TRANSITIONS,
      description: 'The finding-side effect that matches your outcome: finding_valid -> keep_open (the finding stays open for the coder to fix), finding_stale -> resolved, evidence_invalid -> invalidated, undetermined -> keep_open. The engine rejects output where this does not match outcome.',
    },
    evidence: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      description: 'Concrete evidence for your outcome. For findingTransition "resolved", include at least one file:line citation the engine can verify against the current code.',
    },
    actionableFix: {
      type: 'string',
      description: 'For finding_valid: the concrete code change the coder must make (REQUIRED, non-empty — leaving it empty downgrades your verdict to undetermined and blocks the run). Empty string for every other outcome.',
    },
  },
} as const;

export function parseFindingConflictAdjudicationOutput(value: unknown): FindingConflictAdjudicationOutput {
  return FindingConflictAdjudicationOutputSchema.parse(value);
}

// NOTE (review-integrity requirement): native structured output は「全 properties が
// required」の strict 様式を要求するため、evidenceKind:'locationless' の raw でも
// location/verbatimExcerpt/snapshotId フィールド自体は存在させねばならず、この
// schema はそれらに空文字を許す（type:'string' のまま minLength を課さない）。
// つまり「空文字の source_quote」を schema だけでは弾けない。その意味的検証は
// admission 層が担う: manager-runner.ts の classifyLocationEvidence が、evidence
// として成立しない（空の verbatimExcerpt/snapshotId、空/N-A location の source_quote、
// 検証済み証跡の無い resolution_confirmation）raw を admit せず reviewer anomaly へ
// 隔離する（raw-canonicalization.ts の resolveRawFindingEvidence が空フィールドを
// undefined に落とし、admission が未検証扱いにする）。schema の寛容さは admission で
// backstop されている。
export const RawFindingsOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rawFindings'],
  properties: {
    rawFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawFindingId', 'relation', 'targetFindingId', 'familyTag', 'severity', 'title', 'location', 'evidenceKind', 'verbatimExcerpt', 'snapshotId', 'description', 'suggestion'],
        properties: {
          rawFindingId: { type: 'string', minLength: 1 },
          // relation が正本。legacy の `kind` はこの
          // provider-facing schema には存在しない（OpenAI/Codex 系の native
          // structured output は全 properties required の strict 様式を要求する
          // ため optional プロパティを置けない。native 経路は schema が生成を
          // 拘束するのでそもそも kind を出せず、寛容化は不要）。kind 併記を
          // 受理する寛容版は post-hoc 検証専用の
          // RawFindingsOutputValidationJsonSchema（下記）にある。
          relation: {
            enum: RAW_FINDING_RELATIONS,
            description: 'This finding\'s relationship to the ledger. new = a fresh observation with no target (targetFindingId must be empty). persists = you still observe an existing open finding (targetFindingId required). reopened = a previously resolved/waived finding reappeared (targetFindingId required). resolution_confirmation = you verified an open finding is fixed (targetFindingId required).',
          },
          targetFindingId: {
            type: 'string',
            description: 'Ledger finding id this entry refers to. Required for persists/reopened/resolution_confirmation. Empty string for new.',
          },
          familyTag: {
            type: 'string',
            minLength: 1,
            description: 'Structured form of the Observed Findings family_tag value. A classification/search hint only — it is not used to determine whether two findings are the same issue.',
          },
          severity: { enum: FINDING_SEVERITIES },
          title: { type: 'string', minLength: 1 },
          location: {
            type: 'string',
            description: 'file:line or file:startLine-endLine evidence. Empty string only when evidenceKind is locationless (a claim that something is ABSENT, e.g. a missing file or missing wiring — there is no single site to cite).',
          },
          evidenceKind: {
            enum: RAW_FINDING_EVIDENCE_KINDS,
            description: 'source_quote = you are citing code that exists at `location` and verbatimExcerpt must be the EXACT text of those lines, copied character-for-character from the file you read (not retyped from memory, not paraphrased). locationless = your claim is that something is ABSENT (a file that should exist but does not, a handler that was never wired up) — leave location, verbatimExcerpt, and snapshotId empty; you cannot quote something that is not there.',
          },
          verbatimExcerpt: {
            type: 'string',
            description: 'Required (non-empty) when evidenceKind is source_quote: the EXACT source text at location, copied verbatim from the file — the engine byte-compares it against the current file content and rejects any mismatch, so do not summarize, translate, or reformat it. Empty string when evidenceKind is locationless.',
          },
          snapshotId: {
            type: 'string',
            description: 'Required (non-empty) when evidenceKind is source_quote: copy the exact "Current review snapshot" value given to you elsewhere in this prompt, unchanged. Empty string when evidenceKind is locationless.',
          },
          description: { type: 'string', minLength: 1 },
          suggestion: {
            type: 'string',
            description: 'Fix direction. Empty string when not applicable (e.g. resolution confirmations).',
          },
        },
      },
    },
  },
} as const;

/**
 * post-hoc 検証専用の寛容版 raw findings schema（review-integrity requirement対応）。
 *
 * RawFindingsOutputJsonSchema（provider-facing、strict 様式）と役割を分離する:
 * - provider へ渡すのは strict 版のみ（native structured output は全 properties
 *   required を要求し、optional の kind を含む schema は生成前に拒否される）。
 * - schema が生成を拘束しない formless/劣化経路（opencode+ollama 等）の出力は
 *   こちらで検証する。弱いモデルは訂正1回でも legacy `kind` 併記をやめない
 *   ため、kind を optional で受理し、意味の検証
 *   （kind/relation 矛盾 → 正規化・claimedKind 監査・ambiguity taint）は intake
 *   の canonicalization に委ねる。
 * - typed evidence protocol（review-integrity protocol）の evidenceKind/verbatimExcerpt/
 *   snapshotId も同じ理由で required から外す。schema が生成を拘束できない
 *   経路のモデルがこれらを省略しても、structured output 全体を無効にしては
 *   ならない — 欠損は intake の canonicalization が「evidence なし」として
 *   寛容に扱い、location 付き claim なら reviewer anomaly へ隔離する
 *   （manager-runner.ts）。ここで丸ごと reject すると、台帳へすら届かず
 *   その安全な縮退経路自体が機能しない。
 */
const LENIENT_RAW_FINDING_EVIDENCE_FIELDS = ['evidenceKind', 'verbatimExcerpt', 'snapshotId'] as const;

export const RawFindingsOutputValidationJsonSchema = {
  ...RawFindingsOutputJsonSchema,
  properties: {
    rawFindings: {
      ...RawFindingsOutputJsonSchema.properties.rawFindings,
      items: {
        ...RawFindingsOutputJsonSchema.properties.rawFindings.items,
        required: RawFindingsOutputJsonSchema.properties.rawFindings.items.required.filter(
          (key: string) => !(LENIENT_RAW_FINDING_EVIDENCE_FIELDS as readonly string[]).includes(key),
        ),
        properties: {
          ...RawFindingsOutputJsonSchema.properties.rawFindings.items.properties,
          kind: {
            enum: RAW_FINDING_KINDS,
            description: 'Legacy field; do not emit. relation is authoritative. If present, it is checked for consistency with relation.',
          },
        },
      },
    },
  },
} as const;

export function parseFindingLedger(value: unknown): FindingLedger {
  return FindingLedgerSchema.parse(migrateLegacyAdjudicationAttempts(value));
}

export function parseRawFindings(value: unknown): RawFinding[] {
  return z.array(RawFindingSchema).parse(value);
}

export function parseReviewerRawFindings(value: unknown): Array<z.infer<typeof ReviewerRawFindingSchema>> {
  return z.array(ReviewerRawFindingSchema).parse(value);
}

export function parseFindingManagerOutput(value: unknown): FindingManagerOutput {
  return FindingManagerOutputSchema.parse(value);
}

export function parseFindingManagerDecisions(value: unknown): FindingManagerDecisions {
  return FindingManagerDecisionsSchema.parse(value);
}
