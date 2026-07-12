import type { ProviderType } from '../../shared/types/provider.js';

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
// 'invalidated': the finding's premise does not hold (deterministically verified:
// its location does not exist / is out of range). Distinct from 'waived' (the
// finding is valid but won't be fixed) — critical findings can never be waived,
// but CAN be invalidated, because invalidation says the finding was never real.
// 'superseded': the finding was merged into a canonical duplicate (duplicateDecisions).
// Both are terminal, additive statuses: existing v1 ledgers need no migration
// because a ledger that never produces these values is unaffected.
export const FINDING_STATUSES = ['open', 'resolved', 'waived', 'invalidated', 'superseded'] as const;
export const FINDING_LIFECYCLES = ['new', 'persists', 'resolved', 'reopened', 'waived', 'invalidated', 'superseded'] as const;
export const FINDING_CONFLICT_STATUSES = ['active', 'resolved'] as const;

export type FindingSeverity = typeof FINDING_SEVERITIES[number];
export type FindingStatus = typeof FINDING_STATUSES[number];
export type FindingLifecycle = typeof FINDING_LIFECYCLES[number];
export type FindingConflictStatus = typeof FINDING_CONFLICT_STATUSES[number];

export interface FindingContractManagerConfig {
  persona: string;
  personaPath?: string;
  personaDisplayName?: string;
  providerRoutingPersonaKey?: string;
  instruction: string;
  outputContract: string;
  provider?: ProviderType;
  model?: string;
}

/**
 * The persona the engine-synthesized finding-conflict-adjudication step runs
 * as (Phase B). Fixed to the "supervisor" facet by design — not user-selectable
 * like finding_contract.manager — but the loader must still resolve the facet
 * to a real file so its body reaches the system prompt (workflowParser
 * resolves it whenever the workflow wires `next: finding-conflict-adjudication`
 * and fails fast when the persona cannot be found).
 */
export interface FindingContractAdjudicatorConfig {
  persona: string;
  personaPath?: string;
  personaDisplayName?: string;
  providerRoutingPersonaKey?: string;
}

/**
 * 有限停止予算（bounded stop budget; codex 裁定・対策バッチ B1 の拡張）の
 * per-workflow 設定。B1 の fixpoint 判定だけでは、レビュアーが毎ラウンド
 * 別の架空 provisional を1件でも生成し続けると provisional 集合が毎回変わり
 * fixpoint が永久に成立しない（v3-r4 実測）。ここは「モデル挙動に依存しない」
 * 停止条件を追加する — 累積ラウンド数（と任意で経過時間）が上限を超えたら、
 * fixpoint 未成立でも NEEDS_ADJUDICATION へ収束させる。
 *
 * 両フィールドとも YAML では省略可能。省略されたフィールドには
 * stop-budget.ts の DEFAULT_STOP_BUDGET が適用される（resolveStopBudgetLimits）
 * ため、finding_contract.stop_budget を一切書かないワークフローでも既定値で
 * 有限に停止する（無制限を許さない、という設計要請）。
 */
export interface FindingContractStopBudgetConfig {
  maxRounds?: number;
  maxMinutes?: number;
}

export interface FindingContractConfig {
  ledgerPath: string;
  rawFindingsPath: string;
  manager: FindingContractManagerConfig;
  /** Present when the supervisor persona was resolved for the finding-conflict-adjudication synthetic step. */
  adjudicator?: FindingContractAdjudicatorConfig;
  /** Optional per-workflow override of the bounded stop budget; see FindingContractStopBudgetConfig. */
  stopBudget?: FindingContractStopBudgetConfig;
}

export interface FindingObservation {
  runId: string;
  stepName: string;
  timestamp: string;
}

/** A manager-adjudicated exemption: the finding is valid but cannot be fixed. */
export interface FindingWaiverRecord {
  reason: string;
  evidence: string;
  decidedAt: FindingObservation;
}

/** A recorded objection that the manager did NOT accept; the finding stays open. */
export interface FindingDisputeRecord {
  reason: string;
  evidence: string;
  recordedAt: FindingObservation;
}

/**
 * v2 梯子設計（raw finding 意味矛盾）の provisional 種別。provisional は新しい
 * status/severity/lifecycle ではなく、status=open の finding に付く optional
 * メタデータ（設計書 §7）。provisional が1件でも open なら final gate は閉じる
 * （エンジン最終不変条件 + findings.provisional.count ルート）。
 */
export const FINDING_PROVISIONAL_KINDS = [
  'raw-meaning-ambiguous',
  'reviewer-output-overflow',
  'manager-budget-exhausted',
  'interpretation-interrupted',
  'stale-precondition',
  /**
   * clean raw の location 証拠が決定的検証（admission-validation.ts）に落ちた。
   * 決定的に証明できるのは「location 証拠の不成立」だけで欠陥の虚偽は証明でき
   * ないため、観測を drop せず gate-blocking で保持する（codex B3）。
   */
  'invalid-location-evidence',
] as const;
export type FindingProvisionalKind = typeof FINDING_PROVISIONAL_KINDS[number];

export interface FindingProvisionalMetadata {
  kind: FindingProvisionalKind;
  /** 決定的な再発同定キー（sha256(reviewerStableKey, lineageKey, kind, policyVersion)）。行番号・runId・タイムスタンプ・LLM 説明文は入れない（攻撃5対策）。 */
  stableKey: string;
  lineageKey: string;
  sourceRawFindingIds: string[];
  reason: string;
  firstObservedAt: FindingObservation;
  lastObservedAt: FindingObservation;
  /** この lineage に対する自動 manager 解釈の消費 epoch 数。上限は raw-finding-limits.ts の MAX_INTERPRETATION_EPOCHS_PER_LINEAGE。 */
  interpretationEpochs: number;
  gateEffect: 'block';
}

export interface FindingLedgerEntry {
  id: string;
  status: FindingStatus;
  lifecycle: FindingLifecycle;
  severity: FindingSeverity;
  title: string;
  location?: string;
  description?: string;
  suggestion?: string;
  reviewers: string[];
  rawFindingIds: string[];
  firstSeen: FindingObservation;
  lastSeen: FindingObservation;
  resolvedAt?: string;
  resolvedEvidence?: string;
  reopenedEvidence?: string;
  /** Waiver history, newest last. Kept across reopens for audit. */
  waivers?: FindingWaiverRecord[];
  /** Rejected or pending objections, newest last. Kept for audit. */
  disputes?: FindingDisputeRecord[];
  /** Set when status/lifecycle becomes 'invalidated' (engine-verified: location does not exist / out of range). */
  invalidatedAt?: string;
  invalidatedEvidence?: string;
  /** Set when status/lifecycle becomes 'superseded' by a duplicateDecisions merge. */
  supersededByFindingId?: string;
  /**
   * 楽観的前提条件（CAS）の版数。エントリを変更するたびに +1。省略時（既存 v1
   * ledger）は 1 とみなす（finding-preconditions.ts の findingRevision 参照）。
   * optional なので既存 ledger は migration なしで読める。
   */
  revision?: number;
  /** 意味を確定できなかった観測の gate-blocking メタデータ。設計書 §7。 */
  provisional?: FindingProvisionalMetadata;
  /**
   * 証跡不成立で証拠としては不採用になった再観測の履歴（対策バッチ A-3）。
   * location admission に落ちた persists が「実在する open target」を指す場合、
   * 独立 provisional を作らず（target が既に gate を塞いでいるため）ここへ
   * 監査添付する。canonical evidence / revision / status には一切影響しない
   * （evidence hash の入力にも含めない — 攻撃4の再開口禁止）。
   */
  rejectedObservations?: Array<{
    rawFindingId: string;
    reason: string;
    observedAt: FindingObservation;
  }>;
}

export type FindingRecord = FindingLedgerEntry;

/**
 * ラウンド跨ぎの意味的スナップショット（対策バッチ B1: provisional fixpoint 判定）。
 * 要素は全てソート済み・重複排除済みの文字列配列で、単純な配列等価比較で
 * ラウンド間の「変化なし」を判定できる（fixpoint.ts 参照）。
 */
export interface FindingLedgerFixpointSnapshot {
  /** open provisional の意味的同一性キー（stableKey）集合。 */
  provisionalKeys: string[];
  /** provisional でない finding（あらゆる status）の "id:status" 集合。 */
  substantiveEntries: string[];
  /** 未裁定 active conflict の "id:evidenceHash" 集合。 */
  unadjudicatedConflictEntries: string[];
}

export interface FindingLedgerFixpointState {
  /** 直近ラウンド終了時点のスナップショット（次ラウンドの比較対象）。 */
  snapshot: FindingLedgerFixpointSnapshot;
  /**
   * 直前ラウンドの snapshot と完全一致し、かつ open provisional が1件以上ある
   * 場合のみ true。ラウンド1（前回スナップショットが無い）は常に false
   * （初回は必ず plan へ差し戻す、という設計上の要請）。
   */
  reached: boolean;
}

/**
 * 有限停止予算（bounded stop budget; codex 裁定・対策バッチ B1 の拡張）の
 * ラウンド跨ぎ累積状態。fixpoint が「変化が無いこと」を判定するのに対し、
 * こちらは「消費した量」を追跡する — provisional 集合が毎ラウンド変化し
 * 続けて fixpoint が決して成立しない場合でも、有限ラウンド（または経過時間）で
 * NEEDS_ADJUDICATION へ収束させるための最終防波堤。
 */
export interface FindingLedgerStopBudgetState {
  /**
   * この台帳に適用済みの findings-manager ラウンドの一意マーカー集合（重複排除・
   * ソート済み）。ラウンド数（roundsCompleted）はこの集合の要素数から導出する —
   * crash/replay で同一 identity のラウンドが再適用されても、Set への追加が no-op に
   * なるため二重計上しない（interpretation-wal.ts の ledger_applied 集合と同じ
   * 「台帳に永続した適用済み集合へ冪等に追記する」思想）。集合は追記専用なので
   * 巻き戻りもしない。マーカーは (runId, callNamespace, parentStepName,
   * stepIteration) から作る run 内一意の値であり、進捗（resolved の増加等）では
   * 変化しない — 予算は単調累積のみ（codex: 進捗を churn の停止条件と誤認させない）。
   *
   * 注意: 実 `takt resume` は run slug（= runId）を採り直し stepIterations を
   * リセットするため、resume 後の reviewers 再走はマーカーが変わり「新しい
   * ラウンド」として1回だけ計上される。これは意図した挙動で、resume ごとに
   * 実際にレビューが再実行される（＝実作業が発生する）以上、liveness 予算は
   * それを1ラウンドとして数えるのが安全側（無料の再レビュー枠を作らない）。
   * このマーカーが冪等に潰すのは「同一 invocation の台帳への再適用」（同一
   * runId/stepName/stepIteration が二度コミットされる crash/replay）である。
   */
  roundMarkers: string[];
  /**
   * この台帳の最初の findings-manager ラウンドの ISO タイムスタンプ。一度
   * 設定されたら以降のラウンドで上書きしない（時間予算の起点を固定する）。
   */
  firstRoundAt: string;
  /**
   * roundMarkers.length が設定上限（既定値は stop-budget.ts の
   * DEFAULT_STOP_BUDGET）に達したか、または firstRoundAt からの経過時間が
   * 時間予算の上限に達したら true。毎ラウンド、その時点の設定値に対して
   * 計算し直して永続化する（fixpoint.reached と同じパターン）ため、
   * context.ts は finding_contract の設定を知らなくてもこの結果だけで
   * 判定できる。
   */
  exhausted: boolean;
}

export interface FindingLedger {
  version: 1;
  workflowName: string;
  nextId: number;
  updatedAt: string;
  findings: FindingLedgerEntry[];
  rawFindings: RawFinding[];
  conflicts: FindingLedgerConflict[];
  /**
   * 解釈 WAL（write-ahead log、設計書 §9）。ambiguous raw への manager 解釈を
   * 冪等化する。optional なので既存 v1 ledger は migration なしで読める。
   */
  interpretations?: FindingInterpretationRecord[];
  /**
   * 対策バッチ B1（provisional fixpoint → NEEDS_ADJUDICATION）: 直近の
   * findings-manager ラウンド終了時点の比較スナップショットと fixpoint 到達
   * 判定。ledger 自体が run を跨いで永続化されるため、resume や再走行を
   * またいだラウンド比較もここだけで完結する（engine 内メモリの
   * LoopDetector/CycleDetector は resume で再構築され使えない）。optional
   * なので既存 v1 ledger は migration なしで読める。
   */
  fixpoint?: FindingLedgerFixpointState;
  /**
   * 有限停止予算（bounded stop budget; codex 裁定・対策バッチ B1 の拡張）:
   * 累積ラウンド数と（設定されていれば）経過時間の消費状況。fixpoint と同様に
   * ledger 自体が run/resume を跨いで永続化されるため、resume を跨いだ累積も
   * ここだけで完結する。optional なので既存 v1 ledger は migration なしで読める。
   */
  stopBudget?: FindingLedgerStopBudgetState;
}

// ---------------------------------------------------------------------------
// v2 梯子設計: 二層スキーマ（candidate / canonical）・capability・CAS・WAL 型
// ---------------------------------------------------------------------------

/**
 * canonicalizeReviewerRawFinding が candidate に付ける ambiguity code。
 * 設計書 §3 の列挙に対応する。code の有無が taint（ambiguityOrigin）を決める。
 */
export const RAW_AMBIGUITY_CODES = [
  /** relation と targetFindingId の必須・禁止条件が矛盾する。 */
  'relation-target-mismatch',
  /** legacy kind と relation が矛盾する（v3-r3 gemma の実測パターン）。 */
  'kind-relation-conflict',
  /** persists が未知の target を指す。 */
  'persists-target-unknown',
  /** persists が open でない target を指す。 */
  'persists-target-not-open',
  /** reopened が open な target を指す。 */
  'reopened-target-open',
  /** reopened が未知の target を指す。 */
  'reopened-target-unknown',
  /** resolution_confirmation が未知の target を指す。 */
  'confirmation-target-unknown',
  /** resolution_confirmation が open でない target を指す。 */
  'confirmation-target-not-open',
  /** new だが既存 open finding と path/title が衝突し、完全同一性は証明できない。 */
  'new-collides-open-finding',
  /** 必須文字列（title/description/severity 等）が欠損しているが provisional として監査できる。 */
  'missing-required-field',
] as const;
export type RawAmbiguityCode = typeof RAW_AMBIGUITY_CODES[number];

declare const candidateBrand: unique symbol;
declare const canonicalBrand: unique symbol;
declare const sameProofBrand: unique symbol;

/**
 * Reviewer structured output を寛容に parse した「昇格前」の raw。nominal brand
 * により CanonicalRawFinding とは代入不能。生成は raw-canonicalization.ts の
 * candidate factory だけが行い、受理するのは canonical 生成関数
 * （canonicalizeReviewerRawFinding）だけ。downstream（機械分類・manager prompt・
 * reconciler・store）へは渡せない。
 */
export interface ReviewerRawFindingCandidate {
  readonly [candidateBrand]: true;
  /** intake 内での一意 ID（正規化済み rawFindingId、または欠損時のエンジン採番）。 */
  readonly intakeId: string;
  readonly reviewerStableKey: string;

  readonly reviewerRawFindingId?: string;
  readonly familyTag?: string;
  readonly severity?: FindingSeverity;
  readonly title?: string;
  readonly location?: string;
  readonly description?: string;
  readonly suggestion?: string;

  readonly relation?: RawFindingRelation;
  readonly targetFindingId?: string;

  /** legacy 入力の検証専用。新規 reviewer contract では出力させない。 */
  readonly legacyKind?: RawFindingKind;

  readonly sourceBytes: number;

  /** reviewer / step の帰属（台帳の RawFinding 形へ戻すために保持）。 */
  readonly reviewer: string;
  readonly stepName: string;
}

export type CanonicalRawFinding =
  | CoherentCanonicalRawFinding
  | AmbiguousCanonicalRawFinding;

export interface CanonicalRawFindingProvenance {
  readonly origin: 'reviewer' | 'legacy-ledger' | 'system';
  readonly ambiguityOrigin: boolean;
  readonly clarificationAttempted: boolean;
  readonly ambiguityCodes: readonly RawAmbiguityCode[];
}

interface CanonicalRawFindingBase {
  readonly [canonicalBrand]: true;
  readonly rawFindingId: string;
  readonly reviewerStableKey: string;
  readonly lineageKey: string;
  readonly evidenceHash: string;

  readonly relation: RawFindingRelation;
  readonly kind: RawFindingKind;

  readonly reviewer: string;
  readonly stepName: string;

  readonly provenance: CanonicalRawFindingProvenance;
}

export interface CoherentCanonicalRawFinding extends CanonicalRawFindingBase {
  readonly coherence: 'coherent';
  readonly familyTag: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly description: string;
  readonly location?: string;
  readonly suggestion?: string;
  readonly targetFindingId?: string;
}

export interface AmbiguousCanonicalRawFinding extends CanonicalRawFindingBase {
  readonly coherence: 'ambiguous';
  /** provisional/manager prompt に安全に載せられる有界の抜粋（本文全文は載せない）。 */
  readonly safeEvidenceExcerpt: string;
  readonly targetFindingId?: string;
  /** エンジンが発行する権限格子。LLM の出力からは受け取らない（設計書 §4）。 */
  readonly capabilities: AmbiguousRawCapabilities;
  /** provisional 化・manager prompt 用に保持する元 raw のフィールド（欠損あり得る）。 */
  readonly familyTag?: string;
  readonly severity?: FindingSeverity;
  readonly title?: string;
  readonly description?: string;
  readonly location?: string;
  readonly suggestion?: string;
}

/** ambiguous 起源 raw の権限。全フィールドがリテラル型で、緩和はコンパイルエラー。 */
export interface AmbiguousRawCapabilities {
  readonly mayCreateIndependentFinding: true;
  readonly mayOpenConflict: true;
  readonly mayCreateProvisional: true;

  readonly mayResolve: false;
  readonly mayWaive: false;
  readonly mayInvalidate: false;
  readonly maySupersede: false;
  readonly mayReopenTarget: false;
  readonly mayNonDeterministicallyMatch: false;
}

/**
 * ambiguous raw に許される唯一の same 経路（設計書 §4.2）。manager の文章判断
 * ではなく、エンジンが正規化フィールドの完全一致 + target open + revision 一致を
 * 確認して発行する。発行はエンジン（raw-capabilities.ts）だけが行う。
 */
export interface DeterministicSameProof {
  readonly [sameProofBrand]: true;
  readonly proofId: string;
  readonly rawFindingId: string;
  readonly targetFindingId: string;
  readonly targetRevision: number;
  readonly identityHash: string;
  readonly algorithmVersion: 1;
}

/**
 * manager が ambiguous raw に対して返せる「提案」。台帳操作そのものではない。
 * 権限はエンジン発行の capability（AmbiguousRawCapabilities / SameProof）だけ
 * から決まる（設計書 §4.1）。
 */
export const AMBIGUOUS_INTERPRETATION_DECISIONS = [
  'create_independent',
  'same_with_proof',
  'open_conflict',
  'provisional',
] as const;
export type AmbiguousInterpretationDecision = typeof AMBIGUOUS_INTERPRETATION_DECISIONS[number];

export type AmbiguousInterpretation =
  | { decision: 'create_independent'; rawFindingId: string }
  | { decision: 'same_with_proof'; rawFindingId: string; proofId: string }
  | { decision: 'open_conflict'; rawFindingId: string; targetFindingId: string }
  | { decision: 'provisional'; rawFindingId: string; reason: string };

/**
 * 楽観的前提条件（CAS、設計書 §6）。confirmation を機械処理または prompt へ
 * 載せた時点の target のスナップショット。保存時の排他区間で再検証する。
 * ambiguous 起源だけでなく全 confirmation（および reopen/invalidate/supersede）
 * に適用する。
 */
export interface FindingMutationPrecondition {
  targetFindingId: string;
  targetRevision: number;
  targetStatus: FindingStatus;
  targetEvidenceHash: string;
}

export interface ConfirmationProposal {
  rawFindingId: string;
  precondition: FindingMutationPrecondition;
}

/** 解釈 WAL の段階（設計書 §9）。 */
export const INTERPRETATION_STAGES = [
  'interpretation_started',
  'interpretation_completed',
  'ledger_applied',
] as const;
export type InterpretationStage = typeof INTERPRETATION_STAGES[number];

export const INTERPRETATION_APPLICATION_RESULTS = [
  'created',
  'matched_with_proof',
  'conflict_created',
  'provisional_created',
  'provisional_updated',
  'stale_precondition',
] as const;
export type InterpretationApplicationResult = typeof INTERPRETATION_APPLICATION_RESULTS[number];

export interface FindingInterpretationRecord {
  /** sha256(reviewerStableKey, lineageKey, candidateEvidenceHash, policyVersion)。 */
  interpretationKey: string;
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
  policyVersion: 2;

  stage: InterpretationStage;
  startedAt: FindingObservation;

  promptPreconditions: FindingMutationPrecondition[];

  completedAt?: FindingObservation;
  /** schema・capability 検証済みの manager 提案。resume 時はこれを再利用し再問い合わせしない。 */
  validatedDecision?: AmbiguousInterpretation;

  appliedAt?: FindingObservation;
  applicationResult?: InterpretationApplicationResult;
}

export const RAW_FINDING_KINDS = ['issue', 'resolution_confirmation'] as const;
export type RawFindingKind = typeof RAW_FINDING_KINDS[number];

// relation is the successor of `kind`: it states the raw finding's relationship
// to the ledger, not just whether it's an issue observation. 'new' replaces
// kind=issue with no target; 'persists' and 'reopened' are issue-kind raws that
// explicitly reference an existing finding (previously indistinguishable from a
// fresh 'new' issue except by mechanical familyTag+location matching, which the
// convergence design removes as an identity signal). 'resolution_confirmation'
// mirrors kind=resolution_confirmation. `kind` is retained for backward
// compatibility (see deriveRawFindingRelation in finding-schemas.ts) but
// `relation` is authoritative wherever both are present.
export const RAW_FINDING_RELATIONS = ['new', 'persists', 'resolution_confirmation', 'reopened'] as const;
export type RawFindingRelation = typeof RAW_FINDING_RELATIONS[number];

export interface RawFinding {
  rawFindingId: string;
  stepName: string;
  reviewer: string;
  familyTag: string;
  severity: FindingSeverity;
  title: string;
  location?: string;
  description: string;
  suggestion?: string;
  /** Omitted means 'issue' (backward compatible with pre-existing ledgers). */
  kind?: RawFindingKind;
  /**
   * This raw finding's relationship to the ledger. Always present after schema
   * parsing (deriveRawFindingRelation derives it from `kind` for pre-existing
   * data); optional on the wire type only because reviewers producing the v1
   * raw findings JSON schema predate this field.
   */
  relation?: RawFindingRelation;
  /** Ledger finding id this entry references (required for persists/reopened/resolution_confirmation; forbidden for new). */
  targetFindingId?: string;
}

export interface FindingManagerMatch {
  findingId: string;
  rawFindingIds: string[];
  evidence?: string;
}

export interface FindingManagerNewFinding {
  rawFindingIds: string[];
  title: string;
  severity: FindingSeverity;
}

export interface FindingManagerResolvedFinding {
  findingId: string;
  rawFindingIds: string[];
  evidence: string;
}

export interface FindingManagerReopenedFinding {
  findingId: string;
  rawFindingIds: string[];
  evidence: string;
}

export interface FindingManagerConflict {
  findingIds: string[];
  rawFindingIds: string[];
  description: string;
}

export interface FindingManagerResolvedConflict {
  conflictId: string;
  evidence: string;
}

export interface FindingManagerWaivedFinding {
  findingId: string;
  reason: string;
  evidence: string;
}

export interface FindingManagerDisputeNote {
  findingId: string;
  reason: string;
  evidence: string;
}

/** Applied only after the engine deterministically re-verifies the finding's own location (see admission-validation.ts). The LLM's evidence alone never invalidates. */
export interface FindingManagerInvalidatedFinding {
  findingId: string;
  evidence: string;
}

/** Merges duplicateFindingIds into canonicalFindingId (rawFindingIds/reviewers/disputes) and marks the duplicates 'superseded'. Never used to resolve or waive — "superseded" and "fixed" are different claims. */
export interface FindingManagerDuplicateDecision {
  canonicalFindingId: string;
  duplicateFindingIds: string[];
  evidence: string;
}

// Phase B (conflict adjudication). 'finding_valid': the reviewer's finding is
// legitimate and still stands; with a non-empty actionableFix the conflict is
// resolved in the reviewer's favor and the workflow routes to the fix path
// (finding stays open); with an empty actionableFix it is treated exactly like
// 'undetermined'. 'finding_stale': the finding no longer applies (already fixed /
// no longer true) — engine moves it to resolved. 'evidence_invalid': the
// finding's own premise does not hold — engine moves it to invalidated.
// 'undetermined': the adjudicator could not decide; never opens the gate.
// See adjudication-apply.ts's FindingConflictAdjudicationDisposition.
export const FINDING_CONFLICT_ADJUDICATION_OUTCOMES = ['finding_valid', 'finding_stale', 'evidence_invalid', 'undetermined'] as const;
export type FindingConflictAdjudicationOutcome = typeof FINDING_CONFLICT_ADJUDICATION_OUTCOMES[number];

// The finding-side effect of an adjudication outcome. Fixed 1:1 mapping from
// outcome, enforced by the engine (adjudication-apply.ts) — never trusted from
// the LLM's own findingTransition value alone; the engine derives it from
// outcome and rejects output where the two disagree.
export const FINDING_CONFLICT_ADJUDICATION_TRANSITIONS = ['keep_open', 'resolved', 'invalidated'] as const;
export type FindingConflictAdjudicationTransition = typeof FINDING_CONFLICT_ADJUDICATION_TRANSITIONS[number];

/** Structured output of the finding-conflict-adjudication synthetic step (one conflict per call). */
export interface FindingConflictAdjudicationOutput {
  conflictId: string;
  outcome: FindingConflictAdjudicationOutcome;
  findingTransition: FindingConflictAdjudicationTransition;
  evidence: string[];
  actionableFix: string;
}

/**
 * One completed adjudication recorded on a conflict, keyed by evidenceHash (see
 * adjudication-evidence.ts). The "1回制限" rule: a conflict is never adjudicated
 * twice against the same evidence — eligibility requires the current hash to be
 * absent from EVERY past record (and every started attempt, see
 * FindingConflictAdjudicationAttempt), not just the latest one, so evidence
 * that reverts to a previously-adjudicated state cannot be re-adjudicated.
 * New raw finding content or new disputes change the hash and re-open
 * eligibility.
 */
export interface FindingConflictAdjudicationRecord {
  evidenceHash: string;
  outcome: FindingConflictAdjudicationOutcome;
  findingTransition: FindingConflictAdjudicationTransition;
  evidence: string[];
  actionableFix: string;
  decidedAt: FindingObservation;
}

/**
 * A started adjudication attempt, recorded BEFORE the adjudicator LLM is
 * invoked. If the run is interrupted (or the result is discarded because the
 * evidence changed mid-flight), the attempt stays on the ledger, so a resumed
 * run (a DIFFERENT runId) cannot re-adjudicate the same evidence — it falls
 * through to the workflow's ABORT rule instead. Within the SAME run
 * (startedAt.runId matches), a pending attempt — one whose evidenceHash has no
 * completed adjudication record — is a reusable reservation: a rate-limit
 * fallback re-execution of the step may retry the LLM call without recording
 * a second attempt (codex R2).
 */
export interface FindingConflictAdjudicationAttempt {
  evidenceHash: string;
  startedAt: FindingObservation;
  /**
   * Name of the step the workflow advanced from into the adjudication step
   * when this attempt started. Durable record of the return-to-origin target
   * (codex R1): a resume that starts directly at the adjudication step has no
   * WorkflowState.previousStep, and guessing among multiple wiring steps
   * (reviewers vs final-gate) would misroute.
   */
  originStep?: string;
}

export interface FindingLedgerConflict {
  id: string;
  status: FindingConflictStatus;
  findingIds: string[];
  rawFindingIds: string[];
  description: string;
  firstSeen: FindingObservation;
  lastSeen: FindingObservation;
  resolvedAt?: string;
  resolvedEvidence?: string;
  /** Completed finding-conflict-adjudication decisions against this conflict, newest last. */
  adjudications?: FindingConflictAdjudicationRecord[];
  /** Started (possibly interrupted or discarded) adjudication attempts, newest last. Recorded before the LLM call — see FindingConflictAdjudicationAttempt. */
  adjudicationAttempts?: FindingConflictAdjudicationAttempt[];
}

export interface FindingManagerOutput {
  matches: FindingManagerMatch[];
  newFindings: FindingManagerNewFinding[];
  resolvedFindings: FindingManagerResolvedFinding[];
  reopenedFindings: FindingManagerReopenedFinding[];
  conflicts: FindingManagerConflict[];
  resolvedConflicts: FindingManagerResolvedConflict[];
  waivedFindings: FindingManagerWaivedFinding[];
  disputeNotes: FindingManagerDisputeNote[];
  invalidatedFindings: FindingManagerInvalidatedFinding[];
  duplicateFindings: FindingManagerDuplicateDecision[];
}

// FindingManagerOutput（上記）は台帳の内部表現として残すが、LLM に直接組み立てさせる
// のはやめる。8配列すべてを一貫した不変条件を守りながら自力で組み立てさせると、
// gpt-5.5 のような十分に強いモデルでも検証に落ちる（takt-bench v2 で実測: 7 走行全滅、
// "not open" / "familyTag mismatch" / "conflict is not active" 等）。LLM には
// raw finding 1件・disputed finding 1件・conflict 1件ごとの「判断」だけを返させ、
// 8配列への組み立てと不変条件の強制はコード（decision-assembly.ts）が担う。
// 'unsupported': the raw finding explicitly referenced an existing finding
// (targetFindingId set, relation persists/reopened) but its own claim doesn't
// hold up (e.g. self-contradicting evidence). Distinct from 'new' — an
// unsupported re-report must NOT fall back to creating a fresh finding (that
// would launder a false re-report into a real one), and distinct from 'same' —
// nothing about the target changes. Recorded for audit only.
export const RAW_DECISION_KINDS = ['same', 'new', 'resolved', 'reopened', 'conflict', 'unsupported'] as const;
export type RawDecisionKind = typeof RAW_DECISION_KINDS[number];

export const DISPUTE_DECISION_KINDS = ['waive', 'note'] as const;
export type DisputeDecisionKind = typeof DISPUTE_DECISION_KINDS[number];

export const CONFLICT_DECISION_KINDS = ['resolve', 'keep'] as const;
export type ConflictDecisionKind = typeof CONFLICT_DECISION_KINDS[number];

export interface FindingManagerRawDecision {
  rawFindingId: string;
  decision: RawDecisionKind;
  /** Ledger finding id. Required for same/resolved/reopened/conflict; absent for new. */
  findingId?: string;
  evidence: string;
}

export interface FindingManagerDisputeDecision {
  findingId: string;
  decision: DisputeDecisionKind;
  reason: string;
  evidence: string;
}

export interface FindingManagerConflictDecision {
  conflictId: string;
  decision: ConflictDecisionKind;
  evidence: string;
}

/**
 * Proposal to invalidate an existing open finding. The manager may only choose
 * from the candidate finding ids the engine already flagged (their location
 * failed a deterministic check against the reviewed code before the manager was
 * even invoked — see manager-runner.ts's invalidLocationCandidateFindingIds).
 * The manager's evidence explains why it agrees; it does not grant new
 * authority to invalidate findings outside that candidate set.
 */
export interface FindingManagerInvalidateDecision {
  findingId: string;
  evidence: string;
}

/** LLM が返す「判断だけ」の出力。組み立て・不変条件の強制は decision-assembly.ts が行う。 */
export interface FindingManagerDecisions {
  rawDecisions: FindingManagerRawDecision[];
  disputeDecisions: FindingManagerDisputeDecision[];
  conflictDecisions: FindingManagerConflictDecision[];
  invalidateDecisions: FindingManagerInvalidateDecision[];
  duplicateDecisions: FindingManagerDuplicateDecision[];
}

export interface FindingReconcileContext {
  workflowName: string;
  stepName: string;
  runId: string;
  timestamp: string;
}

export interface FindingsRuleContext {
  open: {
    count: number;
    bySeverity: Record<FindingSeverity, number>;
    items: Array<{
      id: string;
      severity: FindingSeverity;
      title: string;
      location?: string;
      description?: string;
      suggestion?: string;
      reviewers: string[];
    }>;
  };
  resolved: {
    count: number;
  };
  waived: {
    count: number;
  };
  /**
   * open findings のうち provisional メタデータ（意味を確定できなかった観測）を
   * 持つもの。open.count にも含まれる（provisional は status=open のため安全側）。
   * builtin workflow はこの count を見て need_replan へルーティングし、エンジンは
   * count > 0 での COMPLETE 遷移を最終不変条件として拒否する（設計書 §7）。
   */
  provisional: {
    count: number;
    /**
     * 対策バッチ B1: 直前の findings-manager ラウンドが、その前のラウンドから
     * 意味的な変化（provisional 集合・substantive finding の status・未裁定
     * conflict のいずれも）が無い fixpoint に達したかどうか。builtin workflow は
     * これを見て NEEDS_ADJUDICATION（要人手裁定の終端状態）へルーティングする
     * （raw finding 梯子設計 v2 の収束性対策）。
     */
    fixpoint: boolean;
    items: Array<{ id: string; kind: string; reason: string }>;
  };
  /**
   * 有限停止予算（bounded stop budget; codex 裁定・対策バッチ B1 の拡張）の
   * 消費状況。provisional バケットとは独立: fixpoint が「provisional 集合の
   * 意味的な安定」を見るのに対し、こちらは findings-manager の完了ラウンド数
   * （と任意の経過時間）そのものを見る — provisional が churn し続けて
   * fixpoint に到達しない場合でも、有限ラウンドで停止することをモデル挙動に
   * 依存せず保証する最終防波堤。builtin workflow は fixpoint ルールの直後・
   * plan フォールバックの直前でこれを見て NEEDS_ADJUDICATION へルーティングする
   * （優先順位: COMPLETE > fixpoint > budgetExhausted > plan）。
   */
  rounds: {
    budgetExhausted: boolean;
  };
  /** Audit-only visibility: engine-verified "premise does not hold" findings. Not part of the blocking set; gate conditions stay on open/conflicts. */
  invalidated: {
    count: number;
  };
  /** Audit-only visibility: findings merged into a canonical duplicate. Not part of the blocking set. */
  superseded: {
    count: number;
  };
  conflicts: {
    count: number;
      items: Array<{
      id: string;
      status: FindingConflictStatus;
      findingIds: string[];
      rawFindingIds: string[];
      description: string;
    }>;
    /**
     * Active conflicts whose current evidence (referenced raw findings + the
     * disputes recorded on their findings) has never been adjudicated, or has
     * changed since the last adjudication attempt. Workflow rules route here
     * (rather than straight to ABORT) so a fresh conflict gets one shot at
     * finding-conflict-adjudication; see adjudication-evidence.ts.
     */
    unadjudicated: {
      count: number;
    };
  };
}
