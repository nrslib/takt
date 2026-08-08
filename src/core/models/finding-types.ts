import type {
  FindingContractLedgerRegistries,
  InterpretationRecoveryOriginSettlement,
} from './finding-contract-types.js';
import type { ResolvedFacetContent } from './workflow-types.js';

export * from './finding-contract-types.js';

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
// 'invalidated': the finding's premise does not hold (deterministically verified:
// its location does not exist / is out of range). Distinct from 'waived' (the
// finding is valid but won't be fixed) — critical findings can never be waived,
// but CAN be invalidated, because invalidation says the finding was never real.
// 'superseded': the finding was merged into a canonical duplicate (duplicateDecisions).
// 'dismissed': a provisional finding's claim was dismissed by verified terminal adjudication.
// All are terminal, additive statuses.
export const FINDING_STATUSES = ['open', 'resolved', 'waived', 'invalidated', 'superseded', 'dismissed'] as const;
export const FINDING_LIFECYCLES = ['new', 'persists', 'resolved', 'reopened', 'waived', 'invalidated', 'superseded', 'dismissed'] as const;
export const FINDING_CONFLICT_STATUSES = ['active', 'resolved'] as const;

export type FindingSeverity = typeof FINDING_SEVERITIES[number];
export type FindingStatus = typeof FINDING_STATUSES[number];
export type FindingLifecycle = typeof FINDING_LIFECYCLES[number];
export type FindingConflictStatus = typeof FINDING_CONFLICT_STATUSES[number];

export const FINDING_LIFECYCLE_ENTITY_KINDS = ['finding', 'conflict'] as const;
export const FINDING_LIFECYCLE_OPERATIONS = [
  'create_finding',
  'persist_finding',
  'resolve_finding',
  'reopen_finding',
  'waive_finding',
  'invalidate_finding',
  'supersede_findings',
  'dismiss_finding',
  'record_dispute',
  'update_provisional',
  'promote_provisional',
  'record_rejected_observation',
  'record_recovery_attempt',
  'create_conflict',
  'observe_conflict',
  'resolve_conflict',
  'apply_conflict_adjudication',
  'apply_resolution_renotification',
  'attach_raw_to_provisional',
  'reactivate_conflict',
] as const;

export type FindingLifecycleEntityKind =
  typeof FINDING_LIFECYCLE_ENTITY_KINDS[number];
export type FindingLifecycleOperation =
  typeof FINDING_LIFECYCLE_OPERATIONS[number];

export const FINDING_REJECTED_OBSERVATION_CODES = [
  'evidence_admission_failed',
  'dismissed_same_round',
] as const;
export type FindingRejectedObservationCode =
  typeof FINDING_REJECTED_OBSERVATION_CODES[number];

export interface FindingLifecycleEntityHead {
  entityKind: FindingLifecycleEntityKind;
  entityId: string;
  revision: number;
  eventId: string;
  projectionDigest: string;
}

export interface FindingLifecycleMutationTarget {
  entityKind: FindingLifecycleEntityKind;
  entityId: string;
  expectedHead: FindingLifecycleEntityHead | null;
}

export type FindingProvisionalClaimBindingAuthorizationReference =
  | {
      authorizationId: string;
      kind: 'new_provisional_bundle';
      bindingDecisionId: string;
      creationRequestKey: string;
      expectedHead: null;
      sourceRawFindingIds: string[];
    }
  | {
      authorizationId: string;
      kind: 'pre_admission_attach_existing';
      bindingDecisionId: string;
      findingId: string;
      expectedTargetHead: {
        revision: number;
        projectionDigest: string;
      };
      expectedProvisionalKind: 'raw-meaning-ambiguous';
      expectedStableKey: string;
      expectedLineageKey: string;
      sourceRawFindingIds: string[];
    };

export class FindingProvisionalClaimBindingAuthorization<
  Authorization extends FindingProvisionalClaimBindingAuthorizationReference =
    FindingProvisionalClaimBindingAuthorizationReference,
> {
  readonly #reference: Readonly<Authorization>;

  constructor(reference: Readonly<Authorization>) {
    this.#reference = reference;
  }

  get reference(): Readonly<Authorization> {
    return this.#reference;
  }
}

export type FindingEvidenceContributionOrigin =
  | { kind: 'external' }
  | {
      kind: 'interpretation_case';
      caseId: string;
    };

export interface FindingEvidenceBinding {
  bindingId: string;
  evidenceId: string;
  claimIdentityHash: string | null;
  sourceRawFindingId: string | null;
  sourceRawIntegrityDigest: string | null;
  contributionOrigin: FindingEvidenceContributionOrigin;
  operation: FindingLifecycleOperation;
  target: FindingLifecycleMutationTarget;
}

export interface FindingAnchorAdjudication {
  rawFindingId: string;
  rawDecision: RawDecisionKind;
  findingId: string | null;
  decision: FindingAnchorRelevanceDecision;
  rationale: string;
  managerOutputBinding: string;
}

export type FindingAnchorAuthorityAdjudication = Omit<
  FindingAnchorAdjudication,
  'rawDecision' | 'findingId' | 'rationale'
>;

export type FindingLifecycleAuthority =
  | { kind: 'verified_evidence' }
  | {
      kind: 'engine_policy';
      decisionKind: 'waive' | 'dispute' | 'semantic_duplicate';
      decisionDigest: string;
    }
  | {
      kind: 'engine_policy';
      decisionKind: 'anchor_relevance';
      decisionDigest: string;
      anchorAdjudications: FindingAnchorAuthorityAdjudication[];
    }
  | {
      kind: 'verified_conflict_adjudication';
      conflictId: string;
      conflictSnapshotId: string;
      attemptId: string;
      verificationDigest: string;
      proofRecordIds: string[];
    }
  | {
      kind: 'verified_terminal_adjudication';
      episodeId: string;
      attemptId: string;
      verificationDigest: string;
      proofRecordIds: string[];
      scopeBindingIds: string[];
    }
  | {
      kind: 'interpretation_unreserved_landing';
      roundIdentity: string;
      budgetScopeId: string;
      reason:
        | 'manager-budget-exhausted'
        | 'manager-input-overflow'
        | 'manager-output-discarded'
        | 'interpretation-interrupted';
      rawFindingIds: string[];
      rawCanonicalSnapshotIds: string[];
    }
  | {
      kind: 'interpretation_case_rejection';
      caseSnapshotId: string;
      attemptId: string;
      classification: 'decision_rejected_stale' | 'decision_rejected_raw_invalid';
      rawFindingIds: string[];
      staleCauseDigests: string[];
    }
  | {
      kind: 'system';
      action:
        | 'record_recovery_attempt'
        | 'settle_action_recovery';
    }
  | {
      kind: 'rejected_observation';
      rawFindingId: string;
      rawIntegrityDigest: string;
      rejectionCode: FindingRejectedObservationCode;
    }
  | VerifiedRawProvisionalIdentityAuthority
  | ConflictReactivationAuthority;

export interface VerifiedRawProvisionalIdentityAuthority {
  kind: 'verified_raw_provisional_identity';
  rawFindingId: string;
  rawCanonicalSnapshotId: string;
  rawPayloadDigest: string;
  rawClaimSnapshotDigest: string;
  targetFindingId: string;
  expectedTargetHead: FindingLifecycleEntityHead;
  targetClaimSnapshotDigest: string;
  proofRecordId: string;
  lifecycleEvidenceBindingId: string;
  verificationDigest: string;
}

export interface ConflictReactivationRawClaim {
  rawFindingId: string;
  rawCanonicalSnapshotId: string;
  rawPayloadDigest: string;
  claimSnapshotDigest: string;
  rawClaimLandingId: string;
  holdingAllocationId: string;
  holdingFindingId: string;
}

export interface ConflictReactivationAuthority {
  kind: 'conflict_reactivation';
  conflictId: string;
  expectedConflictHead: FindingLifecycleEntityHead;
  newRawClaims: import('./finding-contract-types.js').NonEmptyArray<ConflictReactivationRawClaim>;
  reactivationDigest: string;
    };

export type FindingLifecycleReservationContext = { kind: 'transaction' };

export interface FindingLifecycleReservation {
  reservationId: string;
  mutationId: string;
  operation: FindingLifecycleOperation;
  targets: FindingLifecycleMutationTarget[];
  evidenceBindingIds: string[];
  authority: FindingLifecycleAuthority;
  context: FindingLifecycleReservationContext;
  reservedAt: FindingObservation;
}

export interface FindingLifecycleTransition {
  before: FindingLifecycleEntityHead | null;
  after: FindingLifecycleEntityHead;
}

export type FindingLifecycleOutcome = { kind: 'projection_applied' };

export interface FindingLifecycleEvent {
  eventId: string;
  mutationId: string;
  reservationId: string;
  operation: FindingLifecycleOperation;
  transitions: FindingLifecycleTransition[];
  evidenceBindingIds: string[];
  outcome: FindingLifecycleOutcome;
  resultDigest: string;
  occurredAt: FindingObservation;
}

export interface FindingContractManagerConfig {
  persona: string;
  personaPath?: string;
  personaDisplayName?: string;
  providerRoutingPersonaKey?: string;
  instruction: string;
  outputContract: string;
  policyContents?: readonly ResolvedFacetContent[];
  knowledgeContents?: readonly ResolvedFacetContent[];
}

/**
 * The persona and optional guidance used by engine-synthesized conflict and
 * terminal adjudication steps. The loader resolves explicit configuration
 * eagerly; omitted configuration preserves the supervisor derivation used by
 * existing workflows. provider/model are not workflow-configurable: the
 * `terminal-adjudicator` seat in runtime.yaml names them, and an unassigned seat
 * falls back to the ordinary resolution.
 */
export interface FindingContractAdjudicatorConfig {
  persona: string;
  personaPath?: string;
  personaDisplayName?: string;
  providerRoutingPersonaKey?: string;
  instruction?: string;
}

/**
 * 格上げ再レビューの reviewer 識別子。publication identity の reviewer キーであり、
 * restatement request が owner への言い直しか格上げかを見分ける唯一の判別子。
 * ユーザー設定ではなくエンジン内部の固定値で、実 step 名としては予約する。
 */
export const FINDING_ESCALATION_REVIEWER_ROUTING_KEY = 'escalation-reviewer';

/**
 * 有限停止予算の
 * per-workflow 設定。fixpoint 判定だけでは、レビュアーが毎ラウンド
 * 別の架空 provisional を1件でも生成し続けると provisional 集合が毎回変わり
 * fixpoint が永久に成立しない。ここは「モデル挙動に依存しない」
 * 停止条件を追加する — 累積ラウンド数（と任意で経過時間）が上限を超えたら、
 * fixpoint 未成立でもワークフローが有限停止を判断できるようにする。
 *
 * 両フィールドとも YAML では省略可能。maxRounds の省略には stop-budget.ts の
 * DEFAULT_STOP_BUDGET（resolveStopBudgetLimits）が既定値を補うため、
 * finding_contract.stop_budget を一切書かないワークフローでも有限ラウンドで
 * 停止する（無制限を許さない、という設計要請）。maxMinutes に既定値は無く、
 * 省略時は時間上限なし — 明示設定した場合だけ壁時計上限として働く。
 */
export interface FindingContractStopBudgetConfig {
  maxRounds?: number;
  maxMinutes?: number;
}

/**
 * review-integrity 予算（review-integrity requirement）の per-workflow 設定。二系統
 * 台帳（review-integrity protocol）で全指摘が reviewer anomaly に隔離された run は product gate
 * が空になり「即 COMPLETE」で実質レビューされずに通り得た。これを防ぐため、
 * 未昇格 anomaly が残る限り COMPLETE を許さず再レビューへ送る。その再レビューの
 * 回数上限がこれ — 有限回で正しい引用による promote も anomaly 解消もできなければ
 * ワークフローが有限停止を判断できるようにする。省略時は
 * review-integrity.ts の DEFAULT_REVIEW_INTEGRITY_BUDGET が補う。
 */
export interface FindingContractReviewBudgetConfig {
  maxReviewRounds?: number;
}

export interface FindingContractConfig {
  manager: FindingContractManagerConfig;
  /** Present when the supervisor persona was resolved for the finding-conflict-adjudication synthetic step. */
  adjudicator?: FindingContractAdjudicatorConfig;
  /** Optional per-workflow override of the bounded stop budget; see FindingContractStopBudgetConfig. */
  stopBudget?: FindingContractStopBudgetConfig;
  /** Optional per-workflow override of the review-integrity re-review budget; see FindingContractReviewBudgetConfig. */
  reviewBudget?: FindingContractReviewBudgetConfig;
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
 * raw finding の意味矛盾を保持する provisional 種別。provisional は新しい
 * status/severity/lifecycle ではなく、status=open の finding に付く optional
 * メタデータ。provisional が1件でも open なら final gate は閉じる
 * （エンジン最終不変条件 + findings.provisional.count ルート）。
 */
export const FINDING_PROVISIONAL_KINDS = [
  'raw-meaning-ambiguous',
  'reviewer-output-overflow',
  'manager-budget-exhausted',
  'manager-input-overflow',
  'interpretation-interrupted',
  'stale-precondition',
  /**
   * manager 出力全体が最終不変条件検証で破棄されたラウンドの残余 raw。
   * 主張が曖昧だったわけではない（raw-meaning-ambiguous とは別物）ため
   * interpretation ladder の対象にならない。出口は engine 主導の再裁定
   * （RawAdjudicationRecovery）と、その枯渇後の fail-fast 停止。
   */
  'manager-output-discarded',
  /**
   * 裁定プロセスが substantive outcome へ到達しなかった raw の保持
   * （decision の却下 / unsupported 裁定 / decision 欠落 / 保存時 stale /
   * deterministic proof の stale）。主張が曖昧だったわけではないため
   * interpretation ladder の対象にならない。出口は engine 主導の再裁定
   * （RawAdjudicationRecovery: 保存済み source raw を fresh ledger に対して
   * 再裁定）と、attempt 枯渇後の管轄裁定（dismiss 候補化）。
   */
  'raw-adjudication-unresolved',
  'recovery-origin-stale',
] as const;
export type FindingProvisionalKind = typeof FINDING_PROVISIONAL_KINDS[number];

/** substantive claim を保持し、clean lifecycle evidence で終端できる provisional。 */
export const CLAIM_BEARING_PROVISIONAL_KINDS = [
  'raw-meaning-ambiguous',
  'raw-adjudication-unresolved',
  'recovery-origin-stale',
] as const satisfies readonly FindingProvisionalKind[];

/**
 * manager の dismissDecisions が却下してよい provisional 種別の静的な下限。
 * 実際の候補判定は terminal-adjudication-candidates.ts の fresh snapshot 導出が
 * 正本 — kind だけでなく「その provisional に未完了の解釈処理が残っているか」
 * を見る。処理中は候補にせず、終端候補だけを内容の管轄裁定へ回す。
 * overflow / budget / interrupted / stale 系は「処理失敗の証跡」であり、
 * manager が消すと final gate の迂回路になるため候補にしない。
 */
export const DISMISSABLE_PROVISIONAL_KINDS = [
  ...CLAIM_BEARING_PROVISIONAL_KINDS,
] as const satisfies readonly FindingProvisionalKind[];

/**
 * verified terminal adjudication が発行できる dismiss 裁定の根拠分類。
 */
export const FINDING_DISMISSAL_BASES = [
  'outside_contract_jurisdiction',
  'outside_task_scope',
  'false_positive',
  'overreach',
  'no_issue_after_verification',
] as const;
export type FindingDismissalBasis = typeof FINDING_DISMISSAL_BASES[number];
export const SEMANTIC_FINDING_DISMISSAL_BASES = [
  'outside_contract_jurisdiction',
  'outside_task_scope',
  'false_positive',
  'overreach',
  'no_issue_after_verification',
] as const satisfies readonly FindingDismissalBasis[];

export const FINDING_MANAGER_AUTHORITIES = [
  'standard',
  'terminal_adjudication',
] as const;
export type FindingManagerAuthority =
  typeof FINDING_MANAGER_AUTHORITIES[number];

/** manager の dismiss 裁定の監査記録。黙って消さない — 根拠と授権を finding に残す。 */
export interface FindingDismissalRecord {
  basis: FindingDismissalBasis;
  reason: string;
  evidence?: string;
  taskQuote?: string;
  workflowTaskDigest?: string;
  adjudicationTaskId?: string;
  authority: FindingManagerAuthority;
  decidedAt: FindingObservation;
}

export interface FindingActionRecoveryAttempt {
  attempt: number;
  reason: string;
  at: FindingObservation;
}

export type FindingActionProposal =
  | { action: 'invalidate'; findingId: string; evidence: string }
  | { action: 'waive'; findingId: string; reason: string; evidence: string }
  | {
      action: 'duplicate';
      canonicalFindingId: string;
      duplicateFindingIds: string[];
      evidence: string;
    };

export type FindingActionRecovery = FindingActionProposal & {
  targetPreconditions: FindingMutationPrecondition[];
};

export interface FindingProvisionalMetadata {
  kind: FindingProvisionalKind;
  /** 決定的な再発同定キー（sha256(reviewerStableKey, lineageKey, kind)）。行番号・runId・タイムスタンプ・LLM 説明文は入れない。 */
  stableKey: string;
  lineageKey: string;
  sourceRawFindingIds: string[];
  reason: string;
  firstObservedAt: FindingObservation;
  lastObservedAt: FindingObservation;
  gateEffect: 'block';
  actionRecovery?: FindingActionRecovery;
  actionRecoveryAttempts?: FindingActionRecoveryAttempt[];
  recoveryReviewerStableKey?: string;
  /** この provisional が最初に観測された manager ラウンド序数（stop budget の roundsCompleted + 1）。 */
  firstObservedRound: number;
}

export interface FindingLedgerEntry {
  id: string;
  status: FindingStatus;
  lifecycle: FindingLifecycle;
  /**
   * raw 由来 provisional は回復時の targetIdentity 照合用に target を保持できる。
   * provisional metadata が残る限り、これは product lifecycle authority ではない。
   */
  target: FindingTarget | null;
  targetIdentityHash: string | null;
  claimIdentityHash: string | null;
  semanticClaimIdentityHash: string | null;
  severity: FindingSeverity | null;
  title: string | null;
  /** この finding を裏づける検証済み証拠。実体は ledger.evidenceRecords に追記される。 */
  evidenceIds: string[];
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
  /** 後続の検証済み証拠で reopen された後も、過去の裁定根拠として保持する。 */
  dismissal?: FindingDismissalRecord;
  /** 楽観的前提条件（CAS）の版数。エントリを変更するたびに +1。 */
  revision: number;
  provisional?: FindingProvisionalMetadata;
  /**
   * 証跡不成立で証拠としては不採用になった再観測の履歴。
   * location admission に落ちた persists が「実在する open target」を指す場合、
   * 独立 provisional を作らず（target が既に gate を塞いでいるため）ここへ
   * 監査添付する。canonical evidence / status には一切影響しない
   * （evidence hash の入力にも含めないため再開口しない）。
   */
  rejectedObservations?: Array<{
    rawFindingId: string;
    reason: string;
    observedAt: FindingObservation;
  }>;
}

export type ProductFindingEntry = FindingLedgerEntry & {
  target: FindingTarget;
  targetIdentityHash: string;
  claimIdentityHash: string;
  semanticClaimIdentityHash: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  provisional?: undefined;
};

export type ProvisionalFindingEntry = FindingLedgerEntry & {
  provisional: FindingProvisionalMetadata;
};

export type FindingRecord = FindingLedgerEntry;

/**
 * provisional fixpoint 判定用のラウンド跨ぎの意味的スナップショット。
 * 要素は全てソート済み・重複排除済みの文字列配列で、単純な配列等価比較で
 * ラウンド間の「変化なし」を判定できる（fixpoint.ts 参照）。
 */
export interface FindingLedgerFixpointSnapshot {
  /** recovery の前進を「変化なし」と誤判定して早期停止しないため、attempt の進行もキーへ含める。 */
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
 * 有限停止予算の
 * ラウンド跨ぎ累積状態。fixpoint が「変化が無いこと」を判定するのに対し、
 * こちらは「消費した量」を追跡する — provisional 集合が毎ラウンド変化し
 * 続けて fixpoint が決して成立しない場合でも、有限ラウンド（または経過時間）で
 * ワークフローを有限停止させるための最終防波堤。
 */
export interface FindingLedgerStopBudgetState {
  /**
   * この台帳に適用済みの findings-manager ラウンドの一意マーカー集合（重複排除・
   * ソート済み）。ラウンド数（roundsCompleted）はこの集合の要素数から導出する —
   * crash/replay で同一 identity のラウンドが再適用されても、Set への追加が no-op に
   * なるため二重計上しない（永続した適用済み集合へ冪等に追記する）。集合は
   * 追記専用なので
   * 巻き戻りもしない。マーカーは (runId, callNamespace, parentStepName,
   * stepIteration) から作る run 内一意の値であり、進捗（resolved の増加等）では
   * 変化しないため、予算は単調累積のみとなる。
   *
   * 注意: 実 `takt resume` は stepIterations を継続する一方、run slug（= runId）を
   * 採り直す。したがって resume 後の reviewers 再走はマーカーが変わり「新しい
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

/**
 * review-integrity 予算（review-integrity requirement）のラウンド跨ぎ累積状態。
 * 未昇格 reviewer anomaly が残る限り product gate とは別の review-integrity gate が
 * COMPLETE を拒否し再レビューへ送る — その再レビュー回数の消費を stop budget と
 * 同じ round-marker 方式（適用済みマーカー集合。crash/replay 冪等）で追跡する。
 * roundMarkers は「未昇格 anomaly が残ったまま完了した findings-manager
 * ラウンド」の一意マーカー集合で、上限（DEFAULT_REVIEW_INTEGRITY_BUDGET または
 * finding_contract.review_budget）に達したら exhausted=true になり、builtin は
 * 再レビューではなく要件を維持した再計画へルーティングする。
 */
export interface FindingLedgerReviewIntegrityState {
  roundMarkers: string[];
  firstRoundAt: string;
  exhausted: boolean;
}

export interface FindingLedger extends FindingContractLedgerRegistries {
  workflowName: string;
  nextId: number;
  updatedAt: string;
  findings: FindingLedgerEntry[];
  /** 検証済み証拠の追記専用レジストリ。finding は evidenceIds で参照する。 */
  evidenceRecords: FindingEvidenceRecord[];
  evidenceBindings: FindingEvidenceBinding[];
  lifecycleReservations: FindingLifecycleReservation[];
  lifecycleEvents: FindingLifecycleEvent[];
  rawFindings: RawFinding[];
  conflicts: FindingLedgerConflict[];
  /**
   * provisional fixpoint に対する再計画または有限停止の判定に使う直近の
   * findings-manager ラウンド終了時点の比較スナップショットと fixpoint 到達
   * 判定。ledger 自体が run を跨いで永続化されるため、resume や再走行を
   * またいだラウンド比較もここだけで完結する（engine 内メモリの
   * LoopDetector/CycleDetector は resume で再構築され使えない）。
   */
  fixpoint?: FindingLedgerFixpointState;
  /**
   * 有限停止予算:
   * 累積ラウンド数と（設定されていれば）経過時間の消費状況。fixpoint と同様に
   * ledger 自体が run/resume を跨いで永続化されるため、resume を跨いだ累積も
   * ここだけで完結する。
   */
  stopBudget?: FindingLedgerStopBudgetState;
  /**
   * 二系統台帳(review-integrity protocol)の review-integrity 側。product finding
   * (findings 配列)とは別の、監査専用・非 gate-blocking の隔離先。
   * verbatimExcerpt 機械照合が「引用不一致」または「対象版が変化(stale)」と
   * 判定した観測がここへ着地し、product gate(COMPLETE 判定)には一切影響しない。
   */
  reviewerAnomalies?: ReviewerAnomalyEntry[];
  /**
   * review-integrity 予算（review-integrity requirement）の消費状況。未昇格 reviewer
   * anomaly が残ったまま完了した findings-manager ラウンド数を stop budget と
   * 同じ round-marker 方式で追跡する。fixpoint/stopBudget と同様に ledger 自体が
   * run/resume を跨いで永続化されるため、resume を跨いだ累積もここだけで完結する。
   */
  reviewIntegrity?: FindingLedgerReviewIntegrityState;
  /**
   * report 公開を要する manager round の唯一の再開状態。round の completed
   * projection は report 公開成功まで top-level へ露出しない。
   */
  pendingManagerCommit?: FindingManagerPendingCommit;
}

// ---------------------------------------------------------------------------
// 二層スキーマ（candidate / canonical）・capability・CAS・WAL 型
// ---------------------------------------------------------------------------

/**
 * canonicalizeReviewerRawFinding が candidate に付ける ambiguity code。
 * code の有無が taint（ambiguityOrigin）を決める。
 */
export const RAW_AMBIGUITY_CODES = [
  /** relation と targetFindingId の必須・禁止条件が矛盾する。 */
  'relation-target-mismatch',
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
  /** new だが既存 open finding と意味衝突し、完全同一性は証明できない。 */
  'new-collides-open-finding',
  /** 必須文字列（title/description/severity 等）が欠損しているが provisional として監査できる。 */
  'missing-required-field',
  /** reviewer が typed evidence protocol に一致しない evidence を返した。 */
  'invalid-evidence-shape',
] as const;
export type RawAmbiguityCode = typeof RAW_AMBIGUITY_CODES[number];

/**
 * review-integrity evidence の種別。検証不能な自由文 claim は受理しない。
 */
export const RAW_FINDING_EVIDENCE_KINDS = ['file_quote', 'engine_proof'] as const;
export type RawFindingEvidenceKind = typeof RAW_FINDING_EVIDENCE_KINDS[number];

/**
 * finding が主張する対象の閉じた union。claim の種類を別フィールドへ重複保持せず、
 * kind が対象と検証方式の唯一の識別子になる。
 */
export type FindingTarget =
  | {
      /**
       * Reviewer が具体的な code / structure / absence target を示さなかった
       * review-scope 全体の主張。エンジンだけが target:null から生成し、
       * typed evidence による clean 昇格は許可しない。
       */
      kind: 'review_scope';
    }
  | {
      kind: 'code';
      /** バイナリ順にソートし、重複を除いた review scope 内の相対パス。 */
      paths: string[];
    }
  | {
      kind: 'structure';
      scope: {
        kind: 'review_scope';
        /** バイナリ順にソートし、重複を除いた明示 root。 */
        roots: string[];
      };
      /** 存在を検証する明示 manifest target。 */
      manifestTargets: string[];
    }
  | {
      kind: 'absence';
      predicate:
        | {
            kind: 'path_state';
            path: string;
            expected: 'absent';
          }
        | {
            kind: 'exact_literal_search';
            /** バイナリ順にソートし、重複を除いた明示 root。 */
            roots: string[];
            literal: string;
            textDomain: 'utf8';
          };
    };

/** review report 本文内の一意な完全一致をエンジンが確定した source binding。 */
export interface CandidateSourceBinding {
  reportDigest: string;
  startByte: number;
  endByte: number;
  excerptDigest: string;
}

/** claimIdentityHash に含める exact claim payload。 */
export interface FindingClaimPayload {
  familyTag: string | null;
  severity: FindingSeverity | null;
  title: string | null;
  description: string | null;
  suggestion: string | null;
}

/** normalizer の唯一の出力 payload。repo 観測値や engine 発行 ID を含まない。 */
export interface NormalizedFindingCandidatePayload {
  rawFindingId: string | null;
  familyTag: string | null;
  severity: FindingSeverity | null;
  title: string | null;
  description: string | null;
  suggestion: string | null;
  relation: RawFindingRelation | null;
  targetFindingIds: string[];
  target: FindingTarget | null;
  evidenceRequests: FindingEvidenceRequest[];
}

export interface NormalizedFindingExtraction {
  rawExcerpt: string;
  candidate: NormalizedFindingCandidatePayload | null;
}

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
  readonly rawExcerpt?: string;
  readonly reassertsReviewerAnomalyId?: string;
  readonly sourceBinding: CandidateSourceBinding;
  readonly target: FindingTarget;
  readonly targetIdentityHash: string;
  readonly candidateIdentityHash: string;
  readonly issuedEngineProofRecords: readonly EngineProofRecord[];
  readonly evidenceCoverageGaps: readonly string[];
  readonly evidenceQuoteFailureReasons?: readonly string[];

  readonly reviewerRawFindingId?: string;
  /** atomization・内部一意化前に reviewer が明示した相関 ID。 */
  readonly sourceReviewerRawFindingId?: string;
  readonly familyTag?: string;
  readonly severity?: FindingSeverity;
  readonly title?: string;
  readonly description?: string;
  readonly suggestion?: string;

  readonly relation?: RawFindingRelation;
  readonly targetFindingId?: string;

  /**
   * typed evidence protocol。provider-facing でも nested union の配列であり、
   * candidate は検証済みの構造だけを保持する。
   */
  readonly evidence: readonly RawFindingEvidence[];

  readonly sourceBytes: number;

  /** reviewer / step の帰属（台帳の RawFinding 形へ戻すために保持）。 */
  readonly reviewer: string;
  readonly stepName: string;
}

export type CanonicalRawFinding =
  | CoherentCanonicalRawFinding
  | AmbiguousCanonicalRawFinding;

export interface CanonicalRawFindingProvenance {
  readonly origin: 'reviewer' | 'stored-ledger' | 'system';
  readonly ambiguityOrigin: boolean;
  readonly clarificationAttempted: boolean;
  readonly ambiguityCodes: readonly RawAmbiguityCode[];
}

interface CanonicalRawFindingBase {
  readonly [canonicalBrand]: true;
  readonly rawFindingId: string;
  readonly reviewerStableKey: string;
  readonly lineageKey: string;
  readonly claimIdentityHash: string;
  readonly semanticClaimIdentityHash: string;
  readonly target: FindingTarget;
  readonly targetIdentityHash: string;
  readonly candidateIdentityHash: string;
  readonly rawExcerpt?: string;
  readonly reassertsReviewerAnomalyId?: string;
  readonly sourceBinding: CandidateSourceBinding;
  readonly issuedEngineProofRecords: readonly EngineProofRecord[];
  readonly evidenceCoverageGaps: readonly string[];
  readonly evidenceQuoteFailureReasons?: readonly string[];
  readonly evidenceSetHash: string;

  readonly relation: RawFindingRelation | null;
  readonly reviewer: string;
  readonly stepName: string;
  readonly targetPrecondition?: FindingMutationPrecondition;

  readonly provenance: CanonicalRawFindingProvenance;

  /**
   * typed evidence protocol。claim と独立した nested union の配列。
   */
  readonly evidence: readonly RawFindingEvidence[];
}

export interface CoherentCanonicalRawFinding extends CanonicalRawFindingBase {
  readonly coherence: 'coherent';
  readonly relation: RawFindingRelation;
  readonly familyTag?: string;
  readonly severity?: FindingSeverity;
  readonly title?: string;
  readonly description?: string;
  readonly location?: string;
  readonly suggestion?: string;
  readonly targetFindingId?: string;
}

export interface AmbiguousCanonicalRawFinding extends CanonicalRawFindingBase {
  readonly coherence: 'ambiguous';
  /** provisional/manager prompt に安全に載せられる有界の抜粋（本文全文は載せない）。 */
  readonly safeEvidenceExcerpt: string;
  readonly targetFindingId?: string;
  /** エンジンが発行する権限格子。LLM の出力からは受け取らない。 */
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
 * ambiguous raw に許される唯一の same 経路。manager の文章判断
 * ではなく、エンジンが正規化フィールドの完全一致 + target open + revision 一致を
 * 確認して発行する。発行はエンジン（raw-capabilities.ts）だけが行う。
 */
export interface DeterministicSameProof {
  readonly [sameProofBrand]: true;
  readonly proofId: string;
  readonly rawFindingId: string;
  readonly targetFindingId: string;
  readonly targetRevision: number;
  readonly targetIdentityHash: string;
  readonly identityHash: string;
  readonly algorithmVersion: 1;
}

/**
 * manager が ambiguous raw に対して返せる「提案」。台帳操作そのものではない。
 * 権限はエンジン発行の capability（AmbiguousRawCapabilities / SameProof）だけ
 * から決まる。
 */
export const INTERPRETATION_POLICY_CLASSES = [
  'general',
  'confirmation',
  'provisional_only',
] as const;
export type InterpretationPolicyClass = typeof INTERPRETATION_POLICY_CLASSES[number];

/** Provider decision for a whole interpretation case. Raw identity is engine-owned. */
export type InterpretationDecision =
  | { kind: 'create_independent' }
  | { kind: 'open_conflict'; targetFindingId: string }
  | { kind: 'provisional'; reason: string };

export interface SemanticDecisionCapabilitiesV1 {
  mayCreateIndependentFinding: boolean;
  mayOpenConflict: boolean;
  mayCreateProvisional: boolean;
}

export interface TargetSemanticHeadV1 {
  targetFindingId: string;
  status: FindingStatus;
  lifecycle: FindingLifecycle;
  target: FindingTarget | null;
  targetIdentityHash: string | null;
  claimIdentityHash: string | null;
  semanticClaimIdentityHash: string | null;
  severity: FindingSeverity | null;
  title: string | null;
  description: string | null;
  suggestion: string | null;
  evidenceContentDigest: string;
}

/** The exact semantic object shown to the provider and hashed for reuse. */
export interface SemanticDecisionContextV1 {
  version: 1;
  claim: {
    familyTag: string | null;
    severity: FindingSeverity | null;
    title: string | null;
    description: string | null;
    suggestion: string | null;
    relation: RawFindingRelation | null;
    targetFindingId: string | null;
    target: FindingTarget;
    targetIdentityHash: string;
    claimIdentityHash: string;
    semanticClaimIdentityHash: string;
    evidenceContentDigest: string;
  };
  ambiguityCodes: RawAmbiguityCode[];
  policyClass: InterpretationPolicyClass;
  capabilities: SemanticDecisionCapabilitiesV1;
  candidateTargets: TargetSemanticHeadV1[];
}

export interface InterpretationAttemptFence {
  attemptId: string;
  caseId: string;
  semanticProjectionDigest: string;
  rawFindingIds: string[];
}

/** Engine-issued ownership receipt for one begin/complete batch. */
export interface InterpretationBatchReceipt {
  batchId: string;
  fences: InterpretationAttemptFence[];
}

export interface InterpretationCaseMember {
  rawFindingId: string;
  canonicalIntegrityDigest: string;
  proofBinding?: DeterministicSameProof;
}

interface InterpretationCaseBase {
  caseId: string;
  lineageKey: string;
  policyClass: InterpretationPolicyClass;
  semanticProjectionDigest: string;
  members: InterpretationCaseMember[];
}

export type InterpretationCase =
  | InterpretationCaseBase & {
      kind: 'provider_case';
      decisionContext: SemanticDecisionContextV1;
    }
  | InterpretationCaseBase & {
      kind: 'case_provisional';
      decisionContext: null;
      reason: string;
    };

/**
 * 楽観的前提条件（CAS）。confirmation を機械処理または prompt へ
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

// raw finding と台帳の関係を表す現行契約。新規観測、継続、解消確認、再発を
// 明示し、targetFindingId の要否を一意に決める。
export const RAW_FINDING_RELATIONS = ['new', 'persists', 'resolution_confirmation', 'reopened'] as const;
export type RawFindingRelation = typeof RAW_FINDING_RELATIONS[number];

export interface FindingManagerValidationAttemptReport {
  attempt: number;
  managerOutput: unknown;
  validationErrors: string[];
}

export interface RawAdmissionRejectionReport {
  rawFindingId: string;
  location: string;
  reason: string;
}

export interface UnsupportedRawFindingReport {
  rawFindingId: string;
  targetFindingId: string;
  evidence: string;
}

export interface ReviewerOutputOverflowReport {
  reviewer: string;
  reason: string;
  emittedAtomizedRawFindingCount: number;
  admittedAtomizedRawFindingCount: number;
  overflowAtomizedRawFindingCount: number;
}

export interface RawNormalizationAuditRecord {
  rawFindingId: string;
  reviewer: string;
  claimedRelation?: string;
  claimedTargetFindingId?: string;
  normalizedRelation: RawFindingRelation | null;
  wireTargetFindingId?: string;
  ambiguityCodes: string[];
  normalizations: Array<
    | 'relation-normalized'
    | 'target-dropped-from-wire'
    | 'required-fields-missing'
  >;
}

export interface ProvisionalLandingReport {
  kind: string;
  stableKey: string;
  reason: string;
  sourceRawFindingIds: string[];
}

export interface ReviewerAnomalyLandingReport {
  kind: string;
  stableKey: string;
  reason: string;
  sourceRawFindingIds: string[];
  sourceIntakeIds: string[];
}

export interface InterpretationStatsReport {
  ambiguousRawCount: number;
  managerCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  reusedCompletedDecisions: number;
  interruptedInterpretations: number;
  budgetExhaustedLineages: number;
}

export interface FindingManagerValidationReport {
  version: 1;
  runId: string;
  stepName: string;
  retryCount: number;
  ledgerUpdated: boolean;
  finalErrors: string[];
  attempts: FindingManagerValidationAttemptReport[];
  rawAdmissionRejections?: RawAdmissionRejectionReport[];
  unsupportedRawFindings?: UnsupportedRawFindingReport[];
  reviewerOutputOverflows?: ReviewerOutputOverflowReport[];
  provisionalLandings?: ProvisionalLandingReport[];
  reviewerAnomalyLandings?: ReviewerAnomalyLandingReport[];
  rawNormalizations?: RawNormalizationAuditRecord[];
  interpretationStats?: InterpretationStatsReport;
  relationClarifications?: Array<{ reviewer: string; flaggedRawFindingIds: string[] }>;
  interpretationRecoverySettlements?: InterpretationRecoveryOriginSettlement[];
  managerTaskAudits?: FindingManagerTaskAudit[];
}

export type FindingManagerTaskKind =
  | 'raw'
  | 'entity_binding'
  | 'finding_control'
  | 'dispute'
  | 'conflict'
  | 'invalidate'
  | 'duplicate'
  | 'dismiss'
  | 'reviewer_anomaly';

/** Provider task の非権威監査。台帳変更権限や lifecycle head の正本には使わない。 */
export type FindingManagerTaskAudit =
  | {
      taskId: string;
      taskKind: FindingManagerTaskKind;
      ownedIds: string[];
      status: 'succeeded';
      inputBytes: number;
      output: unknown;
    }
  | {
      taskId: string;
      taskKind: FindingManagerTaskKind;
      ownedIds: string[];
      status: 'failed' | 'input_overflow';
      inputBytes: number | null;
      reason: string;
    };

export interface FindingManagerCommitProjection extends FindingContractLedgerRegistries {
  nextId: number;
  updatedAt: string;
  findings: FindingLedgerEntry[];
  evidenceRecords: FindingEvidenceRecord[];
  evidenceBindings: FindingEvidenceBinding[];
  lifecycleReservations: FindingLifecycleReservation[];
  lifecycleEvents: FindingLifecycleEvent[];
  rawFindings: RawFinding[];
  conflicts: FindingLedgerConflict[];
  fixpoint?: FindingLedgerFixpointState;
  stopBudget?: FindingLedgerStopBudgetState;
  reviewerAnomalies?: ReviewerAnomalyEntry[];
  reviewIntegrity?: FindingLedgerReviewIntegrityState;
}

export interface FindingManagerReportPublication {
  publicationId: string;
  domainId: string;
  originRunId: string;
  destinationRunId: string;
  fileName: string;
  contentSha256: string;
  report: FindingManagerValidationReport;
}

export interface FindingManagerPendingCommit {
  roundMarker: string;
  publication: FindingManagerReportPublication;
  completed: FindingManagerCommitProjection;
}

// ---------------------------------------------------------------------------
// typed evidence protocol（review-integrity protocol: admission control 強化）
// ---------------------------------------------------------------------------

/**
 * code-backed な claim（欠陥がこの箇所に実在すると主張する finding）の証拠。
 * エンジンが決定的に機械照合できる唯一の evidence 種別 — path/startLine/endLine
 * が指す現在のファイル内容と verbatimExcerpt が完全一致するかを
 * admission-validation.ts が検証する。snapshotId は reviewer request を受けた
 * エンジンが immutable review scope snapshot へ束縛する。reviewer / normalizer
 * は snapshotId を出力できない。
 */
export interface FileQuoteEvidence {
  kind: 'file_quote';
  path: string;
  startLine: number;
  endLine: number;
  verbatimExcerpt: string;
  /** evidence issuer が束縛した review scope snapshot の識別子。 */
  snapshotId: string;
}

/** engine が発行した proof registry レコードへの参照。 */
export interface EngineProofEvidence {
  kind: 'engine_proof';
  proofId: string;
}

/** reviewer が提示できる証拠の閉じた union。 */
export type RawFindingEvidence = FileQuoteEvidence | EngineProofEvidence;

/** normalizer が抽出できる file quote request。snapshot は engine が束縛する。 */
export interface FileQuoteEvidenceRequest {
  kind: 'file_quote';
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * normalizer が抽出できる engine proof request。proofId・snapshot・run・観測結果を
 * 含まず、真偽判定は proof issuer だけが行う。
 */
export type EngineProofEvidenceRequest =
  | {
      kind: 'engine_proof';
      subject: {
        kind: 'repository_manifest';
      };
    }
  | {
      kind: 'engine_proof';
      subject: {
        kind: 'repository_query';
      };
    }
  | {
      kind: 'engine_proof';
      subject: {
        kind: 'authoritative_quote';
        source: 'task' | 'public_declaration';
        declarationId: string;
        verbatimExcerpt: string;
      };
    };

export type FindingEvidenceRequest =
  | FileQuoteEvidenceRequest
  | EngineProofEvidenceRequest;

export interface VerifiedFileQuoteEvidenceRecord extends FileQuoteEvidence {
  evidenceId: string;
  claimIdentityHash: string;
  fileHash: string;
}

export type EngineProofSubject =
  | {
      kind: 'repository_manifest';
      scope: {
        kind: 'review_scope';
        roots: string[];
      };
      manifestTargets: string[];
      observedTargets: string[];
    }
  | {
      kind: 'repository_query';
      predicate:
        | {
            kind: 'path_state';
            path: string;
            expected: 'absent';
          }
        | {
            kind: 'exact_literal_search';
            roots: string[];
            literal: string;
            textDomain: 'utf8';
          };
      result: 'absent' | 'zero_matches';
      coverage: 'complete';
    }
  | {
      kind: 'authoritative_quote';
      source: 'task' | 'public_declaration';
      declarationId: string;
      verbatimExcerpt: string;
    }
  | {
      kind: 'finding_provisional_isolation';
      findingId: string;
      provisionalKind: FindingProvisionalKind;
      stableKey: string;
      claimBindingAuthorizationReferences:
        FindingProvisionalClaimBindingAuthorizationReference[];
    }
  | {
      kind: 'finding_target_invalid';
      findingId: string;
      reason: string;
    }
  | {
      kind: 'finding_claim_sets_equal';
      findingIds: string[];
      semanticClaimIdentityHashes: string[];
    }
  | {
      kind: 'finding_provisional_product_transition';
      operation: 'promote_provisional' | 'reopen_finding';
      findingId: string;
      provisionalStableKey: string;
      provisionalLineageKey: string;
      targetIdentityHash: string;
      sourceRawFindings: Array<{
        rawFindingId: string;
        integrityDigest: string;
      }>;
      expectedProductRawFindingIds: string[];
      transitionPreconditionDigest: string;
      expectedIntermediateHead: {
        revision: number;
        projectionDigest: string;
      };
      materializedProductClaimDigest: string;
    }
  | {
      kind: 'finding_claim_identical';
      adjudicationKind: 'conflict' | 'terminal';
      subjectIds: string[];
      findingIds: string[];
      expectedHeads: FindingLifecycleEntityHead[];
      claimSnapshotDigests: string[];
      rawClaimRefIds: string[];
      exactClaimIdentityDigest: string;
    }
  | {
      kind: 'raw_provisional_claim_identical';
      rawFindingId: string;
      rawCanonicalSnapshotId: string;
      rawPayloadDigest: string;
      rawClaimSnapshotDigest: string;
      targetFindingId: string;
      targetExpectedHead: FindingLifecycleEntityHead;
      targetClaimSnapshotDigest: string;
      targetIdentityHash: string;
      claimIdentityHash: string;
      semanticClaimIdentityHash: string;
      sourceEvidenceBindingIds: string[];
      exactClaimIdentityDigest: string;
    }
  | {
      kind: 'finding_claim_supported_after_verification';
      adjudicationKind: 'conflict' | 'terminal';
      subjectId: string;
      findingId: string;
      expectedHead: FindingLifecycleEntityHead;
      rawClaimRefIds: string[];
      productProjectionDigest: string;
    }
  | {
      kind: 'finding_no_issue_after_verification' | 'finding_claim_refuted';
      adjudicationKind: 'conflict' | 'terminal';
      subjectId: string;
      findingId: string;
      expectedHead: FindingLifecycleEntityHead;
      claimSnapshotDigest: string;
      rawClaimRefIds: string[];
    };

interface EngineProofRecordBase {
  evidenceId: string;
  proofId: string;
  kind: 'engine_proof';
  verifierId: string;
  verifierVersion: string;
  workflowName: string;
  runId: string;
  scopeIdentity: string;
  snapshotId: string;
  targetFindingId: string | null;
  dependencyDigests: string[];
  resultDigest: string;
  issuedAt: string;
}

export type ClaimEvidenceSubject = Extract<
  EngineProofSubject,
  { kind: 'repository_manifest' | 'repository_query' | 'authoritative_quote' }
>;

export type LifecycleAuthoritySubject = Exclude<
  EngineProofSubject,
  ClaimEvidenceSubject
>;

export type EngineProofRecord = EngineProofRecordBase & (
  | {
      purpose: 'claim_evidence';
      claimIdentityHash: string;
      subject: ClaimEvidenceSubject;
    }
  | {
      purpose: 'lifecycle_authority';
      claimIdentityHash: string | null;
      subject: LifecycleAuthoritySubject;
    }
);

export type FindingEvidenceRecord =
  | VerifiedFileQuoteEvidenceRecord
  | EngineProofRecord;

export interface RawFinding {
  rawFindingId: string;
  stepName: string;
  reviewer: string;
  familyTag: string | null;
  severity: FindingSeverity | null;
  title: string | null;
  description: string | null;
  suggestion: string | null;
  /** claim 対象の正本。 */
  target: FindingTarget;
  /** target だけの content address。 */
  targetIdentityHash: string;
  /** target + exact claim payload の content address。 */
  claimIdentityHash: string;
  /** target + title + description の重複・同一欠陥判定用 content address。 */
  semanticClaimIdentityHash: string;
  /** claim identity と source binding を束縛する candidate content address。 */
  candidateIdentityHash: string;
  /** dedicated restatement request への reviewer の任意 echo。product identity には含めない。 */
  reassertsReviewerAnomalyId?: string;
  /** report 本文へ source-bound された元の claim excerpt。再提示と監査に使う。 */
  rawExcerpt?: string;
  /** review report 本文へ束縛された候補の出典。 */
  sourceBinding: CandidateSourceBinding;
  /** This raw finding's relationship to the ledger. */
  relation: RawFindingRelation | null;
  /** Ledger finding id this entry references (required for persists/reopened/resolution_confirmation; forbidden for new). */
  targetFindingId: string | null;
  /** Engine-issued snapshot of the referenced target. Reviewer input cannot set this field. */
  targetPrecondition?: FindingMutationPrecondition;
  /**
   * 証拠契約(review-integrity protocol)。欠損は「evidence なし」として扱う。
   */
  evidence: RawFindingEvidence[];
}

// ---------------------------------------------------------------------------
// reviewer anomaly（review-integrity protocol: 二系統台帳の review-integrity 側）
// ---------------------------------------------------------------------------

export const REVIEWER_ANOMALY_KINDS = [
  'intake-contract-incomplete',
  /**
   * typed evidence record の shape または content address が壊れており、
   * 主張の真偽を検証する前提となる engine protocol が成立していない。
   */
  'protocol-anomaly',
  /**
   * file_quote claim が機械照合(admission-validation.ts
   * の verifyFileQuoteEvidence)に落ちた — path が存在しない/範囲外/
   * verbatimExcerpt が現在のファイル内容と一致しない、または location 付き
   * claim なのに評価可能な evidence が一切無い(欠損は無条件で不採用側)。
   * 「引用が不成立」であって「欠陥が虚偽」ではない — 安全側の分類名。
   */
  'quote-mismatch',
  /**
   * 検証時に再計算した review scope snapshot が、reviewer が echo した
   * snapshotId と食い違った — レビュー後に対象が変化したため、幻覚か正当な
   * 再観測かを判定不能。再取得(次ラウンドの再レビュー)対象として隔離する。
   */
  'stale-snapshot',
  /**
   * lifecycle supplement の証拠が coverage gap や evidence matrix 不足などで
   * admission を完了できなかった。file quote の不一致とは区別する。
   */
  'lifecycle-admission-failure',
  /**
   * レビュアーが非承認判定を出したのに、その publication が構造化 claim を
   * 1件も含んでいない。報告本文の主張が台帳へ一切届かないため、判定だけが
   * 黙って捨てられる。「主張が虚偽」ではなく「主張が機械可読な形で提出されて
   * いない」という事実だけを記録する。
   */
  'verdict-claims-mismatch',
] as const;
export type ReviewerAnomalyKind = typeof REVIEWER_ANOMALY_KINDS[number];

export const INTAKE_CONTRACT_ANOMALY_REASON_CODES = [
  /**
   * 観測の実質（何が壊れているかの本文・どこで壊れているかの対象）が欠けている。
   *
   * 分類事務（severity / title / familyTag / relation）は要件から外れている —
   * レビュアーは観察専任で、分類は正規化係が claim 内容から付与し、同一性と
   * lifecycle relation は台帳を見る manager が裁定するため。分類の書き忘れが
   * intake 失敗になる経路はこの契約には無い。
   */
  'product-identity-incomplete',
  'claim-evidence-missing',
  'normalizer-extraction-loss',
] as const;
export type IntakeContractAnomalyReasonCode = typeof INTAKE_CONTRACT_ANOMALY_REASON_CODES[number];

/**
 * intake 契約が要求するのは観察の実質だけ。分類事務（severity / title /
 * familyTag / relation）はレビュアーの義務ではないので要件に含めない。
 */
export const INTAKE_CONTRACT_MISSING_REQUIREMENTS = [
  'description',
  'target',
  'claimEvidence',
] as const;
export type IntakeContractMissingRequirement = typeof INTAKE_CONTRACT_MISSING_REQUIREMENTS[number];

export const INTAKE_CONTRACT_CLASSIFICATION_AUTHORITY_ID =
  'system/intake_observation_classification_v1' as const;

export interface IntakeContractTerminalDisposition {
  kind:
    | 'restatement_exhausted_claim_bearing'
    | 'protocol_noise_rejected_after_presentation'
    /**
     * 言い直しで再現を要求できる claim 本文を、記録された観測から一切選べない。
     * request を作っても「見せた文をそのまま写しても受理されない」ものにしかならず、
     * 提示を重ねても決着しない。提示を1回も行わずにその場で終端する唯一の kind。
     *
     * workflowOutcome は observationClass に従う — claim-bearing は
     * `review_integrity_unresolved`（主張はあったのに機械可読な形で残らなかった
     * 事実を可視的失敗として扱う）、protocol-noise は
     * `non_claim_observation_rejected`。
     */
    | 'undemandable_claim_atom';
  workflowOutcome:
    | 'review_integrity_unresolved'
    | 'non_claim_observation_rejected';
  decidedAt: FindingObservation;
  /** 終端の根拠になった提示 publication。提示を伴わない終端では持たない。 */
  terminalPublicationId?: string;
  reason: string;
}

export interface IntakeContractDefect {
  observationClass: 'claim-bearing' | 'protocol-noise';
  classificationAuthorityId: typeof INTAKE_CONTRACT_CLASSIFICATION_AUTHORITY_ID;
  reasonCodes: IntakeContractAnomalyReasonCode[];
  missingRequirements: IntakeContractMissingRequirement[];
  presentationOwnerReviewer: string;
  presentationLimit: number;
  terminalDisposition?: IntakeContractTerminalDisposition;
}

/**
 * anomaly が参照した既存 finding の終端(検証済み解消 / terminal adjudication に
 * よる却下)による決着。product finding 側の lifecycle event を根拠に持つ。
 */
export interface ReviewerAnomalyTargetSettlement {
  kind:
    | 'target_resolved_by_verified_evidence'
    | 'target_dismissed_by_terminal_adjudication';
  findingId: string;
  lifecycleEventId: string;
}

/**
 * 同じレビュアー枠の次の完全なレビューが台帳へ登録されたことによる決着
 * (implicit withdrawal)。product finding を根拠に持たない — 「そのレビュアーは
 * 次のレビューでこの観測を再提示しなかった」という機械判定可能な事実だけが根拠。
 *
 * 明示的な言い直し(RA-ID を echo した restatement)が成立した場合は
 * promotedFindingId 側で決着するため、この settlement は付かない。
 */
export interface ReviewerAnomalyReviewWithdrawalSettlement {
  kind: 'withdrawn_by_subsequent_review';
  /**
   * 決着の根拠になった後続レビューの全件。取り下げは「その anomaly の観測者
   * 全員が後続レビューを登録した」ときにだけ成立するため、記録も観測者全員分を
   * 持つ(非空、`(reviewer, publicationId)` で binary 順ソート済み・重複なし)。
   * 監査時に reviewer 集合を anomaly.reviewers と突き合わせるだけで根拠の
   * 網羅性を検証できる。
   *
   * 1レビュアー枠が同一ラウンドに複数の publication を登録することがある
   * — 格上げ再レビューは owner ごとに1呼び出しへ分かれるが reviewer キーは
   * 固定の 'escalation-reviewer' なので、owner が2人いれば同じ reviewer キーで
   * 2件の publication が成立する。したがって reviewer は重複し得る。重複を
   * 潰して1件だけ残すと、監査記録がどの publication で決着したのかを
   * 再構成できなくなる。
   */
  supersedingPublications: readonly {
    /** 後続レビューを登録したレビュアー(= anomaly.reviewers の要素)。 */
    reviewer: string;
    /** そのレビュアーの後続レビュー publication id。 */
    publicationId: string;
  }[];
  decidedAt: FindingObservation;
}

/**
 * 終端処分済み(restatement_exhausted_claim_bearing / undemandable_claim_atom)の
 * claim-bearing anomaly を、terminal adjudication 権限を持つ裁定が却下したことによる
 * 決着。
 *
 * 言い直しラダーを使い切った claim-bearing の観測は、可視的失敗が既定であって
 * 自動では決着しない。救済はこの裁定だけで、根拠は機械検証可能な2つの逐語引用に
 * 限る:
 *   - taskQuote: workflow task の byte-exact 部分文字列。「この主張は今回の task の
 *     範囲外である」という判断の根拠。product finding の outside_task_scope 却下と
 *     同じ流儀で、後から workflowTaskDigest によって束縛を再検証できる。
 *   - claimQuote: anomaly が記録した claim 本文の byte-exact 部分文字列。裁定が
 *     実在の主張を読んだ証跡。台帳だけで再検証できる。
 *
 * adjudicationTaskId は権限の出所になった control task。engine が
 * managerAuthority === 'terminal_adjudication' のときにしか発行しないため、
 * 設定だけでこの決着へ到達する経路は無い。
 */
export interface ReviewerAnomalyAdjudicationSettlement {
  kind: 'dismissed_by_terminal_adjudication';
  basis: 'outside_task_scope';
  taskQuote: string;
  workflowTaskDigest: string;
  claimQuote: string;
  adjudicationTaskId: string;
  reason: string;
  decidedAt: FindingObservation;
}

export type ReviewerAnomalySettlement =
  | ReviewerAnomalyTargetSettlement
  | ReviewerAnomalyReviewWithdrawalSettlement
  | ReviewerAnomalyAdjudicationSettlement;

/**
 * 二系統台帳(review-integrity protocol)の review-integrity レコード。product finding
 * (FindingLedgerEntry)とは別の型 — status/lifecycle/revision/waivers を持たず、
 * product finding の invalidated/resolved/waived 状態を持たない。安全不変条件
 * 安全不変条件:
 *   - invalidated/resolved/waived として扱わない(この型にそもそもその状態がない)
 *   - 既存 finding の状態・revision・evidence hash を変更しない(別配列)
 *   - coder/fix ステップへは送らない(findings.open.items に一切現れない)
 *   - 「引用が違うので問題は存在しない」と記録しない(reason は不成立の説明のみ)
 *   - 後続ラウンドで一致する証跡が出れば promotedFindingId 経由で
 *     product finding 側への昇格を追跡できる(このレコード自体は削除・改変しない
 *     — 観測消去の禁止)
 */
export interface ReviewerAnomalyEntry {
  id: string;
  kind: ReviewerAnomalyKind;
  /** 決定的な再発同定キー。未決着 episode の upsert と決着後の再観測判定に使う。 */
  stableKey: string;
  lineageKey: string;
  /** 実在して台帳へ保存された raw finding のみを参照する。 */
  sourceRawFindingIds: string[];
  /** raw finding を生成できなかった reviewer extraction の intake 識別子。 */
  sourceIntakeIds: string[];
  reviewers: string[];
  title: string;
  /** reviewer が主張した location(監査目的でそのまま保持。証拠としては採用されていない)。 */
  claimedLocation?: string;
  /** reviewer が主張した verbatimExcerpt(監査目的。文字数上限で切り詰める場合がある)。 */
  claimedExcerpt?: string;
  /** 機械照合が不成立と判定した理由(決定的な事実の記述。欠陥の真偽には言及しない)。 */
  mismatchReason: string;
  intakeContract?: IntakeContractDefect;
  firstObserved: FindingObservation;
  lastObserved: FindingObservation;
  /** この episode で観測された回数(upsert のたびに +1)。 */
  occurrences: number;
  /**
   * 後続ラウンドの claim correspondence と検証済み evidence で product finding へ
   * 昇格した場合の参照先。設定後もこのレコード自体は削除・改変しない(観測消去の禁止)。
   */
  promotedFindingId?: string;
  /** 言い直し枯渇直前の evidence-search で引用を補修して昇格した場合の帰属。 */
  promotionOrigin?: 'evidence-search';
  /**
   * anomaly の決着記録。参照先 finding の終端によるもの(target settlement)と、
   * 同じレビュアー枠の次の完全なレビュー登録によるもの(implicit withdrawal)がある。
   * product finding への昇格とは別の決着なので promotedFindingId と混同しない。
   * レコード自体は削除しない — 決着後も監査履歴として残る。
   */
  settlement?: ReviewerAnomalySettlement;
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

/** Applied only to open provisional findings whose kind is in DISMISSABLE_PROVISIONAL_KINDS and that the engine offered as candidates. The LLM's reason alone never dismisses a finding outside the candidate set. */
export interface FindingManagerDismissedFinding {
  findingId: string;
  basis: FindingDismissalBasis;
  reason: string;
  evidence?: string;
  taskQuote?: string;
  workflowTaskDigest?: string;
  adjudicationTaskId?: string;
  authority: FindingManagerAuthority;
}

/** Merges duplicateFindingIds into canonicalFindingId (rawFindingIds/reviewers/disputes) and marks the duplicates 'superseded'. Never used to resolve or waive — "superseded" and "fixed" are different claims. */
export interface FindingManagerDuplicateDecision {
  canonicalFindingId: string;
  duplicateFindingIds: string[];
  evidence: string;
}

// 'finding_valid': the reviewer's finding is
// legitimate and still stands; with a non-empty actionableFix the conflict is
// resolved in the reviewer's favor and the workflow routes to the fix path
// (finding stays open); with an empty actionableFix it is treated exactly like
// 'undetermined'. 'finding_stale': the finding no longer applies (already fixed /
// no longer true) — engine moves it to resolved. 'evidence_invalid': the
// finding's own premise does not hold — engine moves it to invalidated.
// 'undetermined': the adjudicator could not decide; never opens the gate.
// See adjudication-apply.ts's FindingConflictAdjudicationDisposition.
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
  revision: number;
}

export interface FindingManagerOutput {
  anchorAdjudications: FindingAnchorAdjudication[];
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
  dismissedFindings: FindingManagerDismissedFinding[];
}

// FindingManagerOutput（上記）は台帳適用前の内部表現として使い、LLM には直接
// 組み立てさせない。全アクション配列を一貫した不変条件の下で生成する責務は
// コード側に置く。LLM には
// raw finding 1件・disputed finding 1件・conflict 1件ごとの「判断」だけを返させ、
// アクション配列への組み立てと不変条件の強制はコード（decision-assembly.ts）が担う。
// 'unsupported': the raw finding explicitly referenced an existing finding
// (targetFindingId set, relation persists/reopened) but its own claim doesn't
// hold up (e.g. self-contradicting evidence). Distinct from 'new' — an
// unsupported re-report must NOT fall back to creating a fresh finding (that
// would launder a false re-report into a real one), and distinct from 'same' —
// nothing about the target changes. Recorded for audit only.
export const RAW_DECISION_KINDS = ['same', 'new', 'resolved', 'reopened', 'conflict', 'unsupported'] as const;
export type RawDecisionKind = typeof RAW_DECISION_KINDS[number];
export type FindingAnchorRelevanceDecision =
  | 'relevant'
  | 'not_relevant'
  | 'not_applicable';

export const DISPUTE_DECISION_KINDS = ['waive', 'note'] as const;
export type DisputeDecisionKind = typeof DISPUTE_DECISION_KINDS[number];

export const CONFLICT_DECISION_KINDS = ['resolve', 'keep'] as const;
export type ConflictDecisionKind = typeof CONFLICT_DECISION_KINDS[number];

export interface FindingManagerRawDecision {
  rawFindingId: string;
  decision: RawDecisionKind;
  /**
   * absence target では authoritative quote が元の義務を支えるかを manager が
   * 明示裁定する。その他の target は not_applicable。
   */
  anchorRelevance: FindingAnchorRelevanceDecision;
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

/**
 * Proposal to dismiss an open provisional finding whose claim the manager
 * adjudicates as out of the contract's jurisdiction or permanently unverifiable.
 * The manager may only choose from the candidate finding ids the engine
 * offered (open provisional entries whose kind is in
 * DISMISSABLE_PROVISIONAL_KINDS — see computeDismissCandidates).
 */
export interface FindingManagerDismissDecision {
  findingId: string;
  basis: FindingDismissalBasis;
  reason: string;
  evidence?: string;
  taskQuote?: string;
  workflowTaskDigest?: string;
  adjudicationTaskId?: string;
}

/** LLM が返す「判断だけ」の出力。組み立て・不変条件の強制は decision-assembly.ts が行う。 */
export interface FindingManagerDecisions {
  rawDecisions: FindingManagerRawDecision[];
  disputeDecisions: FindingManagerDisputeDecision[];
  conflictDecisions: FindingManagerConflictDecision[];
  invalidateDecisions: FindingManagerInvalidateDecision[];
  duplicateDecisions: FindingManagerDuplicateDecision[];
  dismissDecisions: FindingManagerDismissDecision[];
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
      severity: FindingSeverity | null;
      title: string | null;
      locations: string[];
      description: string | undefined;
      suggestion: string | undefined;
      reviewers: string[];
      familyTags: string[];
      unknownRawFindingIds: string[];
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
   * count > 0 での COMPLETE 遷移を最終不変条件として拒否する。
   */
  provisional: {
    count: number;
    dismissEligible: {
      count: number;
    };
    /**
     * 直前の findings-manager ラウンドが、その前のラウンドから
     * 意味的な変化（provisional 集合・substantive finding の status・未裁定
     * conflict のいずれも）が無い fixpoint に達したかどうか。builtin workflow は
     * これを見て再計画または ABORT へルーティングする
     * （raw finding 解釈ラダーの収束性対策）。
     */
    fixpoint: boolean;
    items: Array<{ id: string; kind: string; reason: string }>;
  };
  /**
   * 有限停止予算の
   * 消費状況。provisional バケットとは独立: fixpoint が「provisional 集合の
   * 意味的な安定」を見るのに対し、こちらは findings-manager の完了ラウンド数
   * （と任意の経過時間）そのものを見る — provisional が churn し続けて
   * fixpoint に到達しない場合でも、有限ラウンドで停止することをモデル挙動に
   * 依存せず保証する最終防波堤。builtin workflow は fixpoint ルールの直後・
   * replan フォールバックの直前でこれを見て再計画へルーティングする
   * （優先順位: COMPLETE > fixpoint > budgetExhausted > replan）。
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
  /**
   * Audit-only visibility for the review-integrity side of the ledger.
   * Counts reviewer-anomaly entries (unverifiable location/evidence claims —
   * quote-mismatch or stale-snapshot) that have not yet been promoted to a
   * product finding. Never part of the blocking set: this bucket lives in a
   * separate ledger array (reviewerAnomalies) from `findings`, so it cannot
   * affect `open.count` / `provisional.count` / the COMPLETE gate by
   * construction. Workflow rules may still read it for reporting/audit.
   */
  reviewerAnomalies: {
    count: number;
    requiresGuaranteedPresentationCount: number;
    restatementReadyCount: number;
    claimBearingTerminalCount: number;
    protocolNoiseRejectedCount: number;
    /**
     * review-integrity 予算（review-integrity requirement）が尽きたか。未昇格 anomaly が
     * 残る限り product gate とは別に COMPLETE を拒否し再レビューへ送るが、有限回で
     * 補完（正しい引用による promote / anomaly 解消）できなければ true になり、
     * builtin は再レビューではなく要件を維持した再計画へルーティングする。
     * その反復の有限停止は loop monitor が担う。
     */
    budgetExhausted: boolean;
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
