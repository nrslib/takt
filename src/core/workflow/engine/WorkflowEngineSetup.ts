import { existsSync, mkdirSync } from 'node:fs';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import { createLogger } from '../../../shared/utils/index.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  AgentResponse,
  AgentWorkflowStep,
  FindingContractConfig,
  WorkflowConfig,
  WorkflowMaxSteps,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import type { FindingManagerAuthority } from '../../models/finding-types.js';
import { prepareRuntimeEnvironment } from '../../runtime/runtime-environment.js';
import type { RunPaths } from '../run/run-paths.js';
import type {
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
  WorkflowStepFailureSummary,
} from '../types.js';
import { createRunFailure } from '../run/run-failure.js';
import { ArpeggioRunner } from './ArpeggioRunner.js';
import { LoopMonitorJudgeRunner } from './LoopMonitorJudgeRunner.js';
import { OptionsBuilder } from './OptionsBuilder.js';
import { ParallelRunner } from './ParallelRunner.js';
import { DynamicParallelSelectorCoordinator } from '../dynamic-parallel/selector-coordinator.js';
import { DynamicFacetSelectorCoordinator } from '../dynamic-facets/dynamicFacetSelectorCoordinator.js';
import { DynamicFacetSelectionStore } from '../dynamic-facets/dynamicFacetSelectionStore.js';
import { recordAgentUsageEvent } from './agent-usage-event.js';
import { StepExecutor } from './StepExecutor.js';
import { SystemStepExecutor } from './SystemStepExecutor.js';
import { TeamLeaderRunner } from './TeamLeaderRunner.js';
import { createWorkflowPhaseRelay } from './WorkflowEnginePhaseRelay.js';
import { WorkflowCallRunner } from './WorkflowCallRunner.js';
import { getWorkflowReference } from '../workflow-reference.js';
import type { WorkflowCallChildEngine } from '../types.js';
import type { StructuredOutputNormalizerRegistry } from './structured-output-normalizer.js';
import { runQualityGates } from '../quality-gates/qualityGateRunner.js';
import type { FindingLedgerStore } from '../findings/store.js';
import {
  ledgerHasDismissedFindings,
  ledgerHasOpenFindings,
  ledgerHasWaivedFindings,
  renderFindingLedgerInstructionSummary,
  renderFindingLedgerReportSummary,
} from '../findings/context.js';
import { renderLoopMonitorFindingsSummary } from '../findings/loop-monitor-summary.js';
import {
  captureReviewScopeProofSnapshot,
  computeReviewScopeSnapshotId,
  type ReviewScopeProofSnapshot,
} from '../findings/snapshot.js';
import { createTaskReviewScopeResolver } from '../review-scope.js';
import {
  computeRestatementRequestId,
  createFindingReviewPresentationContextV2,
  listFindingReviewPublications,
  type RestatementRequestV1,
} from '../findings/review-publication.js';
import { RAW_FINDING_LIMITS } from '../findings/raw-finding-limits.js';
import {
  resolveRestatementPresentationPhase,
  type RestatementPresentationPhase,
} from '../findings/restatement-presentation-phase.js';
import type { FindingRestatementSlotOwnerContexts } from '../findings/restatement-slot-runner.js';
import {
  buildFindingEvidenceSearchRequest,
  type FindingEvidenceSearchRequest,
} from '../findings/evidence-search.js';
import { resolveFindingEscalationTarget } from '../findings/restatement-slot-step.js';
import {
  isOutstandingReviewerAnomaly,
  selectRestatementSourceClaimAtom,
} from '../findings/reviewer-anomalies.js';
import {
  isConcludedReviewerAnomaly,
} from '../../models/finding-reviewer-anomaly-settlement-policy.js';
import type { FindingTarget } from '../../models/finding-types.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../../models/finding-types.js';
import type {
  FindingContractInstructionContext,
} from '../instruction/instruction-context.js';
import { requireWorkflowResumeStackSnapshot } from '../run/resume-point.js';
import {
  createReviewReportDiscoveryContext,
  resolveWorkflowStepReportNamesWithDiagnostics,
} from '../review-report-discovery.js';
import { DynamicParallelSelectionStore } from '../dynamic-parallel/selection-store.js';
import {
  restoreWorkflowCallInvocationEvidence,
  snapshotWorkflowCallInvocationEvidence,
  type WorkflowCallInvocationEvidence,
} from '../workflow-call-invocation-index.js';
import { SelectorInputReader } from '../dynamic-parallel/selector-input-reader.js';
import { restoreWorkflowStepParticipationIndex } from '../workflow-step-participation-index.js';
import { CompanionReviewAuthority } from '../companion/review-state-store.js';

const log = createLogger('workflow-engine');

export class FindingReviewCapacityError extends Error {
  readonly failure: WorkflowStepFailureSummary;

  constructor(input: {
    stepName: string;
    anomalyIds: readonly string[];
    classificationAuthorityIds: readonly string[];
    requiredInvocations: number;
    remainingCapacity: number;
  }) {
    const unpresentedIds = [...input.anomalyIds].sort(compareBinaryStrings);
    const reason = `Finding review presentation capacity is insufficient: ${input.requiredInvocations} invocation(s) required, ${input.remainingCapacity} remaining`;
    super(reason);
    this.name = 'FindingReviewCapacityError';
    this.failure = createRunFailure({
      kind: 'review_integrity_unresolved',
      step: input.stepName,
      reason,
      error: reason,
      details: {
        reviewIntegrity: {
          code: 'review_integrity_unresolved_unpresented',
          anomalyIds: unpresentedIds,
          unpresentedIds,
          classificationAuthorityIds: [...input.classificationAuthorityIds].sort(compareBinaryStrings),
          publicationIds: [],
        },
      },
    });
  }
}

interface WorkflowEngineSetupParams {
  config: WorkflowConfig;
  state: WorkflowState;
  task: string;
  projectCwd: string;
  getCwd: () => string;
  getReportDir: () => string;
  getRunPaths: () => RunPaths;
  getMaxSteps: () => WorkflowMaxSteps;
  options: WorkflowEngineOptions & { structuredOutputNormalizers: StructuredOutputNormalizerRegistry };
  structuredCaller: StructuredCaller;
  sharedRuntime: WorkflowSharedRuntimeState;
  resumeStackPrefix: readonly WorkflowResumePointEntry[];
  getCurrentWorkflowStack: () => WorkflowResumePointEntry[] | undefined;
  runPaths: RunPaths;
  updateMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
  claimStepOccurrence: (
    step: WorkflowStep,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => number;
  consumeWorkflowCallContinuation: (
    step: WorkflowStep,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => WorkflowResumePointEntry | undefined;
  setActiveResumePoint: (
    step: WorkflowStep,
    iteration: number,
    occurrence: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => void;
  persistDynamicParallelSelection: (
    step: WorkflowStep,
    iteration: number,
    identity: string,
    selection: import('../../models/types.js').DynamicParallelSelectionSnapshot,
  ) => Promise<void>;
  persistDynamicFacetSelection: (
    step: WorkflowStep,
    iteration: number,
    identity: string,
    selection: import('../../models/types.js').DynamicFacetSelectionSnapshot,
  ) => Promise<void>;
  refreshFindingsState: () => void;
  /** 自前 or workflow_call 親から継承した、この engine で有効な Finding Contract。 */
  findingContract?: FindingContractConfig;
  findingManagerAuthority: FindingManagerAuthority;
  findingLedgerStore?: FindingLedgerStore;
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  resolveNextStepFromDone: (step: WorkflowStep, response: AgentResponse) => string;
  resetCycleDetector: () => void;
  emitEvent: (event: string, ...args: unknown[]) => void;
  createEngine: (
    config: WorkflowConfig,
    cwd: string,
    task: string,
    options: WorkflowEngineOptions,
  ) => WorkflowCallChildEngine;
}

export interface WorkflowEngineServices {
  optionsBuilder: OptionsBuilder;
  stepExecutor: StepExecutor;
  parallelRunner: ParallelRunner;
  arpeggioRunner: ArpeggioRunner;
  teamLeaderRunner: TeamLeaderRunner;
  systemStepExecutor: SystemStepExecutor;
  loopMonitorJudgeRunner: LoopMonitorJudgeRunner;
  workflowCallRunner: WorkflowCallRunner;
}

export function assertTaskPrefixPair(taskPrefix: string | undefined, taskColorIndex: number | undefined): void {
  const hasTaskPrefix = taskPrefix != null;
  const hasTaskColorIndex = taskColorIndex != null;
  if (hasTaskPrefix !== hasTaskColorIndex) {
    throw new Error('taskPrefix and taskColorIndex must be provided together');
  }
}

export function createSharedRuntime(
  resumePoint: WorkflowResumePoint | undefined,
  maxSteps: WorkflowMaxSteps,
): WorkflowSharedRuntimeState {
  const now = Date.now();
  return {
    startedAtMs: resumePoint ? now - resumePoint.elapsed_ms : now,
    maxSteps,
    dynamicParallelSelectionStore: new DynamicParallelSelectionStore(
      new Map(Object.entries(resumePoint?.dynamic_parallel_selections ?? {})),
    ),
    dynamicFacetSelectionStore: new DynamicFacetSelectionStore(
      new Map(Object.entries(resumePoint?.dynamic_facet_selections ?? {})),
    ),
    workflowCallInvocationEvidence: restoreWorkflowCallInvocationEvidence(resumePoint),
    workflowStepParticipationIndex: restoreWorkflowStepParticipationIndex(resumePoint),
    companionReviewAuthority: new CompanionReviewAuthority(),
  };
}

export function ensureRunDirsExist(runPaths: RunPaths): void {
  for (const dir of [
    runPaths.runRootAbs,
    runPaths.reportsAbs,
    runPaths.contextAbs,
    runPaths.contextKnowledgeAbs,
    runPaths.contextPolicyAbs,
    runPaths.contextPreviousResponsesAbs,
    runPaths.logsAbs,
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function applyRuntimeEnvironment(
  cwd: string,
  config: WorkflowConfig,
  stage: 'init' | 'step',
): void {
  const prepared = prepareRuntimeEnvironment(cwd, config.runtime);
  if (!prepared) {
    return;
  }

  log.info('Runtime environment prepared', {
    stage,
    runtimeRoot: prepared.runtimeRoot,
    envFile: prepared.envFile,
    prepare: prepared.prepare,
    tmpdir: prepared.injectedEnv.TMPDIR,
    gradleUserHome: prepared.injectedEnv.GRADLE_USER_HOME,
    npmCache: prepared.injectedEnv.npm_config_cache,
  });
}

export function assertFindingReviewPresentationCapacity(input: {
  ledger: ReturnType<FindingLedgerStore['loadLedger']>;
  presentationCounts: ReadonlyMap<string, number>;
  maxSteps: WorkflowMaxSteps;
  currentIteration: number;
  stepName: string;
}): void {
  const unpresented = (input.ledger.reviewerAnomalies ?? [])
    .filter(hasIntakeContract)
    .filter((anomaly) => (
      !isConcludedReviewerAnomaly(anomaly)
      && (input.presentationCounts.get(anomaly.id) ?? 0) === 0
    ));
  if (unpresented.length === 0) {
    return;
  }
  const countsByOwner = new Map<string, number>();
  for (const anomaly of unpresented) {
    const owner = anomaly.intakeContract.presentationOwnerReviewer;
    countsByOwner.set(owner, (countsByOwner.get(owner) ?? 0) + 1);
  }
  const total = unpresented.length;
  const ownerInvocationCount = Math.max(
    ...Array.from(countsByOwner.values(), (count) => Math.ceil(count / 64)),
  );
  const requiredInvocations = Math.max(ownerInvocationCount, Math.ceil(total / 128));
  const remainingCapacity = typeof input.maxSteps === 'number'
    ? Math.max(0, input.maxSteps - input.currentIteration + (input.currentIteration > 0 ? 1 : 0))
    : 0;
  if (requiredInvocations <= remainingCapacity) {
    return;
  }
  throw new FindingReviewCapacityError({
    stepName: input.stepName,
    anomalyIds: unpresented.map(({ id }) => id),
    classificationAuthorityIds: unpresented.map(
      ({ intakeContract }) => intakeContract.classificationAuthorityId,
    ),
    requiredInvocations,
    remainingCapacity,
  });
}

function targetPathsForRestatementRequest(target: FindingTarget): string[] {
  const sortedUniquePaths = (paths: readonly string[]): string[] => (
    [...new Set(paths)].sort(compareBinaryStrings)
  );
  switch (target.kind) {
    case 'code':
      return sortedUniquePaths(target.paths);
    case 'structure':
      return sortedUniquePaths([...target.scope.roots, ...target.manifestTargets]);
    case 'absence':
      return target.predicate.kind === 'path_state'
        ? [target.predicate.path]
        : sortedUniquePaths(target.predicate.roots);
    case 'review_scope':
      return [];
  }
}

/**
 * 提示回数の正本は canonical review publication だけ。V2 context を持つ
 * publication の `presentedReviewerAnomalyIds` を publication ID 単位で数える。
 *
 * `reportDir` は必ず絶対パス（`runPaths.reportsAbs`）を渡すこと。
 * `listFindingReviewPublications` は `resolve()` で解決するため、相対パスを渡すと
 * エンジンの cwd ではなく `process.cwd()` 起点になる。worktree 実行のように両者が
 * 一致しない構成では別のディレクトリを数え、提示回数が publication を書き込む側
 * （StepExecutor / findings-manager の `reviewPublicationDir` = reportsAbs）と
 * 食い違う。提示ラダーが進まないまま終端処分だけが確定する事故の前提条件になる。
 */
function collectFindingReviewPresentationCounts(reportDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const publication of listFindingReviewPublications(reportDir)) {
    if (publication.presentationContext?.revision !== 2) {
      continue;
    }
    for (const anomalyId of publication.presentationContext.presentedReviewerAnomalyIds) {
      counts.set(anomalyId, (counts.get(anomalyId) ?? 0) + 1);
    }
  }
  return counts;
}

type LoadedFindingLedger = ReturnType<FindingLedgerStore['loadLedger']>;
type LoadedReviewerAnomaly = NonNullable<LoadedFindingLedger['reviewerAnomalies']>[number];

/** `intake-contract-incomplete` の anomaly は intakeContract を必ず持つ（台帳 invariant）。 */
type IntakeContractAnomaly = LoadedReviewerAnomaly & {
  readonly intakeContract: NonNullable<LoadedReviewerAnomaly['intakeContract']>;
};

function hasIntakeContract(anomaly: LoadedReviewerAnomaly): anomaly is IntakeContractAnomaly {
  return anomaly.kind === 'intake-contract-incomplete' && anomaly.intakeContract !== undefined;
}

interface OutstandingIntakeAnomaly {
  readonly anomaly: IntakeContractAnomaly;
  readonly presentedCount: number;
}

/**
 * 未消化の intake anomaly を、指定した提示フェーズと owner に限って
 * 決定的な順序（未提示優先 → 最初の観測時刻 → anomaly ID）で列挙する。
 * owner batch と escalation batch はこの1関数を共有し、同じ anomaly が
 * 両方の batch に入ることがない。
 */
function collectOutstandingIntakeAnomalies(input: {
  ledger: LoadedFindingLedger;
  presentationCounts: ReadonlyMap<string, number>;
  ownerStepNames: ReadonlySet<string>;
  phase: RestatementPresentationPhase;
  escalationEnabled: boolean;
}): OutstandingIntakeAnomaly[] {
  return (input.ledger.reviewerAnomalies ?? [])
    .filter(hasIntakeContract)
    .filter((anomaly) => (
      input.ownerStepNames.has(anomaly.intakeContract.presentationOwnerReviewer)
      // 終端処分済みは提示予算が残っていても二度と提示しない。提示を続けると
      // その言い直しが照合を通った瞬間に promotion が付き、終端処分と同居して
      // 台帳不変条件を破る。終端後の行き先は terminal adjudication ルート。
      && !isConcludedReviewerAnomaly(anomaly)
    ))
    .map((anomaly) => ({
      anomaly,
      presentedCount: input.presentationCounts.get(anomaly.id) ?? 0,
    }))
    .filter(({ anomaly, presentedCount }) => (
      resolveRestatementPresentationPhase({
        presentedCount,
        presentationLimit: anomaly.intakeContract.presentationLimit,
        escalationEnabled: input.escalationEnabled,
      }) === input.phase
    ))
    .sort((left, right) => (
      left.presentedCount - right.presentedCount
      || compareBinaryStrings(left.anomaly.firstObserved.timestamp, right.anomaly.firstObserved.timestamp)
      || compareBinaryStrings(left.anomaly.id, right.anomaly.id)
    ));
}

/**
 * そのレビュアーが観測者に含まれる未決着の非 intake anomaly があるか。
 *
 * 非 intake anomaly（protocol-anomaly / verdict-claims-mismatch / 報告拒否由来）は
 * 言い直し予算に乗らず、決着条件は「観測者全員の後続完全レビュー成立」による
 * 取り下げ（withdrawReviewerAnomaliesSupersededByReview）だけ。したがって slot は
 * そのレビュアーの完全な再レビューを1回発行する必要がある。
 */
function hasOutstandingNonIntakeAnomalyFor(
  ledger: LoadedFindingLedger,
  reviewerStepName: string,
): boolean {
  return (ledger.reviewerAnomalies ?? []).some((anomaly) => (
    isOutstandingReviewerAnomaly(anomaly)
    && anomaly.intakeContract === undefined
    // verdict 由来の anomaly は verdict を伴う publication でしか決着しない。
    // slot のフルレビューは判定ラダーを持たないので verdict を出せず、発行しても
    // 決着させられない呼び出しになる（ワークフローのレビューステップ本体を待つ）。
    && anomaly.kind !== 'verdict-claims-mismatch'
    && anomaly.reviewers.includes(reviewerStepName)
  ));
}

/**
 * 1呼び出しに載せる言い直し request の上限。
 *
 * 投与量効果の実測（263試行）: バックログ10件以下で回答率86%、10件超で44%。
 * 上限を超える分は同じラウンドの次のパスへ回る（提示予算の計上契約は不変）。
 */
const MAX_RESTATEMENT_REQUESTS_PER_CALL = 10;

function buildRestatementRequests(input: {
  ledger: LoadedFindingLedger;
  entries: readonly OutstandingIntakeAnomaly[];
  reviewer: string;
  reviewScopeSnapshotId: string;
}): RestatementRequestV1[] {
  return input.entries.flatMap(({ anomaly, presentedCount }) => {
    const raw = anomaly.sourceRawFindingIds
      .map((rawId) => input.ledger.rawFindings.find((candidate) => candidate.rawFindingId === rawId))
      .find((candidate) => candidate !== undefined);
    if (raw === undefined) {
      return [];
    }
    // 照合ゲートが要求する claim 本文を選べない観測は、どう答えても受理されない。
    // request を作らずに提示予算を温存する（終端は後続レビュー成立による取り下げ）。
    const claimAtom = selectRestatementSourceClaimAtom(anomaly, raw);
    if (claimAtom === undefined) {
      return [];
    }
    const requestWithoutId = {
      anomalyId: anomaly.id,
      reviewer: input.reviewer,
      presentationOrdinal: presentedCount + 1,
      reviewScopeSnapshotId: input.reviewScopeSnapshotId,
      sourceExcerptDigest: raw.sourceBinding.excerptDigest,
      claimedExcerpt: claimAtom.slice(0, RAW_FINDING_LIMITS.maxDescriptionChars),
      targetPaths: targetPathsForRestatementRequest(raw.target),
      missingRequirements: anomaly.intakeContract.missingRequirements,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    return [{
      ...requestWithoutId,
      restatementRequestId: computeRestatementRequestId(requestWithoutId),
    }];
  });
}

/**
 * 1呼び出しに載せられる request 数。投与量上限と、1 step あたりの raw finding
 * 上限（owner batch と escalation batch の合計）の小さいほうを採る。
 */
function remainingRestatementSlots(allocatedRequestCount: number): number {
  return Math.min(
    MAX_RESTATEMENT_REQUESTS_PER_CALL,
    RAW_FINDING_LIMITS.maxRawFindingsPerReviewer,
    Math.max(0, RAW_FINDING_LIMITS.maxRawFindingsPerStep - allocatedRequestCount),
  );
}

export function createWorkflowEngineServices(params: WorkflowEngineSetupParams): WorkflowEngineServices {
  const phaseRelay = createWorkflowPhaseRelay(
    (event, ...args) => params.emitEvent(event, ...args),
    params.getCurrentWorkflowStack,
  );
  let frozenFindingContractInput: {
    contextKey: string;
    ledger: ReturnType<FindingLedgerStore['loadLedger']>;
    presentationCounts: Map<string, number>;
    contexts: Map<string, FindingContractInstructionContext>;
  } | undefined;
  /**
   * レビューラウンド本編の reviewer context。
   *
   * 言い直し request はここへ載せない。言い直しはレビューラウンドへ相乗りさせず、
   * manager 取り込み後の専用 slot（buildFindingRestatementSlotContexts）が
   * レビュアーごとの直接呼び出しとして発行する。
   */
  const buildFindingContractInstructionContext = (
    step: WorkflowStep,
    isReviewer: boolean,
    sharedReviewScopeSnapshotId?: string,
    findingContractFreezeKey?: string,
  ): FindingContractInstructionContext | undefined => {
    if (!params.findingContract) {
      return undefined;
    }
    if (!params.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }

    let ledger: ReturnType<FindingLedgerStore['loadLedger']>;
    let presentationCounts: Map<string, number>;
    let frozenContexts: Map<string, FindingContractInstructionContext> | undefined;
    if (
      sharedReviewScopeSnapshotId !== undefined
      && findingContractFreezeKey !== undefined
      && frozenFindingContractInput?.contextKey === findingContractFreezeKey
    ) {
      ({ ledger, presentationCounts, contexts: frozenContexts } = frozenFindingContractInput);
    } else {
      ledger = params.findingLedgerStore.loadLedger();
      presentationCounts = collectFindingReviewPresentationCounts(params.runPaths.reportsAbs);
      if (findingContractFreezeKey !== undefined) {
        frozenFindingContractInput = {
          contextKey: findingContractFreezeKey,
          ledger,
          presentationCounts,
          contexts: new Map(),
        };
        frozenContexts = frozenFindingContractInput.contexts;
      }
    }
    if (frozenContexts !== undefined && isReviewer) {
      const frozenContext = frozenContexts.get(step.name);
      if (frozenContext !== undefined) {
        return frozenContext;
      }
    }
    let reviewer: FindingContractInstructionContext['reviewer'];
    if (isReviewer) {
      const reviewScopeSnapshotId = sharedReviewScopeSnapshotId
        ?? computeReviewScopeSnapshotId(params.getCwd());
      assertFindingReviewPresentationCapacity({
        ledger,
        presentationCounts,
        maxSteps: params.getMaxSteps(),
        currentIteration: params.state.iteration,
        stepName: step.name,
      });
      reviewer = {
        reviewScopeSnapshotId,
        presentationContext: createFindingReviewPresentationContextV2({
          reviewScopeSnapshotId,
          restatementRequests: [],
        }),
      };
      if (frozenContexts !== undefined) {
        frozenContexts.set(step.name, {
          ledgerSummary: renderFindingLedgerInstructionSummary(ledger),
          reportLedgerSummary: renderFindingLedgerReportSummary(ledger),
          hasOpenFindings: ledgerHasOpenFindings(ledger),
          hasWaivedFindings: ledgerHasWaivedFindings(ledger),
          hasDismissedFindings: ledgerHasDismissedFindings(ledger),
          reviewer,
        });
      }
    }
    const context = {
      ledgerSummary: renderFindingLedgerInstructionSummary(ledger),
      reportLedgerSummary: renderFindingLedgerReportSummary(ledger),
      hasOpenFindings: ledgerHasOpenFindings(ledger),
      hasWaivedFindings: ledgerHasWaivedFindings(ledger),
      hasDismissedFindings: ledgerHasDismissedFindings(ledger),
      ...(reviewer !== undefined ? { reviewer } : {}),
    };
    return context;
  };

  /**
   * slot の1パス分の reviewer context を owner ごと・枠ごとに組む。
   *
   * 呼ばれるたびに台帳と提示回数を読み直す。slot は findings-manager の取り込みが
   * 終わった後に走るため、前パスの結果を次のパスの判定へ反映しなければ同じ
   * anomaly を何度も同じ内容で提示し続ける。
   *
   * owner ごとに persona / policy / knowledge / report 形式が違うため、1 owner =
   * 1 context = 1 provider call に分ける。対象が無い owner・枠は結果に含めない。
   */
  const buildFindingRestatementSlotContexts = (input: {
    ownerReviewerSteps: readonly AgentWorkflowStep[];
    reviewScopeSnapshotId: string;
  }): ReadonlyMap<string, FindingRestatementSlotOwnerContexts> => {
    const contexts = new Map<string, FindingRestatementSlotOwnerContexts>();
    if (!params.findingContract) {
      return contexts;
    }
    if (!params.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }
    const ledger = params.findingLedgerStore.loadLedger();
    const presentationCounts = collectFindingReviewPresentationCounts(params.runPaths.reportsAbs);
    // 台帳はこの関数で1回だけ読むので、その要約も owner 数 × 枠数ぶん作り直さない。
    const ledgerFacts = {
      ledgerSummary: renderFindingLedgerInstructionSummary(ledger),
      reportLedgerSummary: renderFindingLedgerReportSummary(ledger),
      hasOpenFindings: ledgerHasOpenFindings(ledger),
      hasWaivedFindings: ledgerHasWaivedFindings(ledger),
      hasDismissedFindings: ledgerHasDismissedFindings(ledger),
    };
    const buildContext = (
      restatementRequests: readonly RestatementRequestV1[],
    ): FindingContractInstructionContext => ({
      ...ledgerFacts,
      reviewer: {
        reviewScopeSnapshotId: input.reviewScopeSnapshotId,
        presentationContext: createFindingReviewPresentationContextV2({
          reviewScopeSnapshotId: input.reviewScopeSnapshotId,
          restatementRequests: [...restatementRequests],
        }),
      },
    });
    let allocatedRequestCount = 0;
    for (const ownerStep of input.ownerReviewerSteps) {
      // 格上げ先を持つ owner だけが最終1回を escalation へ譲る。宛先の解決は
      // slot 実行側（resolveSlotProviderTarget）と同じ関数を通す。
      const escalationEnabled = resolveFindingEscalationTarget({
        seat: params.options.internalAgentSeats?.escalationReviewer,
        escalation: optionsBuilder.resolveStepProviderModel(ownerStep).escalation,
      }) !== undefined;
      const requestsFor = (phase: RestatementPresentationPhase): RestatementRequestV1[] => {
        const requests = buildRestatementRequests({
          ledger,
          entries: collectOutstandingIntakeAnomalies({
            ledger,
            presentationCounts,
            ownerStepNames: new Set([ownerStep.name]),
            phase,
            escalationEnabled,
          }).slice(0, remainingRestatementSlots(allocatedRequestCount)),
          reviewer: phase === 'escalation'
            ? FINDING_ESCALATION_REVIEWER_ROUTING_KEY
            : ownerStep.name,
          reviewScopeSnapshotId: input.reviewScopeSnapshotId,
        });
        allocatedRequestCount += requests.length;
        return requests;
      };
      const ownerRequests = requestsFor('restatement');
      const escalationRequests = escalationEnabled ? requestsFor('escalation') : [];
      const ownerNeedsFullReview = hasOutstandingNonIntakeAnomalyFor(ledger, ownerStep.name);
      if (ownerRequests.length === 0 && escalationRequests.length === 0 && !ownerNeedsFullReview) {
        continue;
      }
      contexts.set(ownerStep.name, {
        ownerNeedsFullReview,
        ...(ownerRequests.length === 0 && !ownerNeedsFullReview
          ? {}
          : { owner: buildContext(ownerRequests) }),
        ...(escalationRequests.length === 0
          ? {}
          : { escalation: buildContext(escalationRequests) }),
      });
    }
    return contexts;
  };

  /**
   * 言い直し提示数を使い切った claim-bearing anomaly の evidence-search 入力を
   * 作る。evidence-search publication 自体も提示履歴へ保存するため、保存済みの
   * 試行は先に除外する（manager 取り込み前の crash/resume でも二重呼び出しに
   * ならない）。
   */
  const buildFindingEvidenceSearchRequests = (input: {
    ownerReviewerSteps: readonly AgentWorkflowStep[];
    reviewScopeSnapshotId: string;
  }): readonly FindingEvidenceSearchRequest[] => {
    if (!params.findingContract || !params.findingLedgerStore) {
      return [];
    }
    let evidenceSnapshot: ReviewScopeProofSnapshot;
    try {
      const captured = captureReviewScopeProofSnapshot(params.getCwd());
      evidenceSnapshot = captured.reviewScopeSnapshotId === input.reviewScopeSnapshotId
        ? captured
        : {
            reviewScopeSnapshotId: input.reviewScopeSnapshotId,
            trackedDiff: undefined,
            untrackedEvidence: [],
            queryInventory: [],
            changedPaths: [],
          };
    } catch {
      evidenceSnapshot = {
        reviewScopeSnapshotId: input.reviewScopeSnapshotId,
        trackedDiff: undefined,
        untrackedEvidence: [],
        queryInventory: [],
        changedPaths: [],
      };
    }
    const ledger = params.findingLedgerStore.loadLedger();
    const publications = listFindingReviewPublications(params.runPaths.reportsAbs);
    const presentationCounts = collectFindingReviewPresentationCounts(params.runPaths.reportsAbs);
    const rawFindingsById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
    const presentationHistoryByAnomalyId = new Map<string, string[]>();
    for (const publication of publications) {
      if (publication.presentationContext.revision !== 2) {
        continue;
      }
      for (const request of publication.presentationContext.restatementRequests) {
        const history = presentationHistoryByAnomalyId.get(request.anomalyId) ?? [];
        history.push(
          `publication=${publication.publicationId} reviewer=${publication.reviewerStepName} ordinal=${request.presentationOrdinal} digest=${publication.reportDigest}`,
        );
        presentationHistoryByAnomalyId.set(request.anomalyId, history);
      }
    }
    const appliedRoundMarkers = [
      ...(ledger.stopBudget?.roundMarkers ?? []),
      ...(ledger.pendingManagerCommit?.completed.stopBudget?.roundMarkers ?? []),
    ];
    const appliedPublicationIds = new Set(
      appliedRoundMarkers.flatMap((marker) => marker.split('\0').filter((token) => token.length > 0)),
    );
    const isPublicationApplied = (publicationId: string): boolean => appliedPublicationIds.has(publicationId);
    const evidencePublications = publications.filter((publication) => (
      publication.repairOrigin === 'evidence-search'
      && publication.presentationContext.revision === 2
    ));
    const attempted = new Set(
      evidencePublications
        .filter((publication) => isPublicationApplied(publication.publicationId))
        .flatMap((publication) => publication.presentationContext.presentedReviewerAnomalyIds),
    );
    const requests: FindingEvidenceSearchRequest[] = [];
    for (const ownerStep of input.ownerReviewerSteps) {
      const pendingPublications = evidencePublications.filter((publication) => (
        publication.reviewerStepName === ownerStep.name
        && !isPublicationApplied(publication.publicationId)
      ));
      const pendingRecoveryAnomalyIds = new Set(
        pendingPublications.flatMap((publication) => (
          publication.presentationContext.restatementRequests.map((request) => request.anomalyId)
        )),
      );
      for (const publication of pendingPublications) {
        for (const request of publication.presentationContext.restatementRequests) {
          requests.push({
            ownerReviewerStepName: ownerStep.name,
            request,
            reportContent: publication.reportContent,
          });
        }
      }
      const entries = (ledger.reviewerAnomalies ?? [])
        .filter(hasIntakeContract)
        .filter((anomaly) => (
          anomaly.intakeContract.observationClass === 'claim-bearing'
          && anomaly.intakeContract.presentationOwnerReviewer === ownerStep.name
          && !isConcludedReviewerAnomaly(anomaly)
          && !attempted.has(anomaly.id)
          && !pendingRecoveryAnomalyIds.has(anomaly.id)
          && (presentationCounts.get(anomaly.id) ?? 0) >= anomaly.intakeContract.presentationLimit
        ))
        .map((anomaly) => ({
          anomaly,
          presentedCount: presentationCounts.get(anomaly.id) ?? 0,
        }));
      const restatementRequests = buildRestatementRequests({
        ledger,
        entries,
        reviewer: ownerStep.name,
        reviewScopeSnapshotId: input.reviewScopeSnapshotId,
      });
      for (const request of restatementRequests) {
        const anomaly = entries.find(({ anomaly: entry }) => entry.id === request.anomalyId)?.anomaly;
        const sourceRaw = anomaly?.sourceRawFindingIds
          .map((rawId) => rawFindingsById.get(rawId))
          .find((candidate) => candidate !== undefined);
        if (anomaly === undefined || sourceRaw === undefined) {
          continue;
        }
        const searchRequest = buildFindingEvidenceSearchRequest({
          snapshot: evidenceSnapshot,
          anomaly,
          sourceRaw,
          request,
          presentationCount: presentationCounts.get(anomaly.id) ?? 0,
          ownerReviewerStepName: ownerStep.name,
          presentationHistory: presentationHistoryByAnomalyId.get(anomaly.id) ?? [],
        });
        if (searchRequest !== undefined) {
          requests.push(searchRequest);
        }
      }
    }
    return requests;
  };

  // base の解決は ref 走査を伴うため、ラン境界で一度だけ解決して保持する。
  const getReviewScope = createTaskReviewScopeResolver({
    getCwd: params.getCwd,
    getPrContext: () => params.options.prContext,
  });

  const optionsBuilder = new OptionsBuilder(
    params.options,
    params.getCwd,
    () => params.projectCwd,
    (persona) => params.state.personaSessions.get(persona),
    params.getReportDir,
    () => params.options.language,
    () => params.config.steps.map((step) => ({ name: step.name, description: step.description })),
    () => params.config.name,
    () => params.config.description,
    params.getCurrentWorkflowStack,
    buildFindingContractInstructionContext,
    () => params.task,
    buildFindingRestatementSlotContexts,
    getReviewScope,
    buildFindingEvidenceSearchRequests,
  );

  const dynamicFacetSelector = new DynamicFacetSelectorCoordinator({
    engineOptions: params.options,
    selectionStore: params.sharedRuntime.dynamicFacetSelectionStore!,
    getCwd: params.getCwd,
    getReportDirectory: () => params.runPaths.reportsAbs,
    getReportNames: (_step, state) => getSelectorReportNames(
      params.config,
      state,
      params.resumeStackPrefix,
      params.options.workflowCallResolver,
      params.projectCwd,
      params.getCwd(),
      params.sharedRuntime.workflowCallInvocationEvidence!,
      params.sharedRuntime.workflowStepParticipationIndex!,
    ),
    getWorkflowReference: () => getWorkflowReference(params.config),
    workflowCallPath: params.resumeStackPrefix,
    commitSelection: params.persistDynamicFacetSelection,
    ...(params.options.selectorGitCommandRunner === undefined
      ? {}
      : { inputReader: new SelectorInputReader(params.options.selectorGitCommandRunner) }),
    getUnresolvedFindings: () => {
      if (!params.findingLedgerStore) {
        return '';
      }
      const ledger = params.findingLedgerStore.loadLedger();
      const summary = renderFindingLedgerInstructionSummary(ledger);
      const projection = JSON.parse(summary) as { open?: readonly unknown[] };
      if (!projection.open || projection.open.length === 0) {
        return '';
      }
      return summary;
    },
  });
  const companionReviewAuthority = params.sharedRuntime.companionReviewAuthority;
  if (companionReviewAuthority === undefined) {
    throw new Error('Companion review authority is missing from shared workflow runtime');
  }

  const stepExecutor = new StepExecutor({
    optionsBuilder,
    getCwd: params.getCwd,
    getProjectCwd: () => params.projectCwd,
    getReportDir: params.getReportDir,
    getRunPaths: params.getRunPaths,
    getLanguage: () => params.options.language,
    getInteractive: () => params.options.interactive === true,
    getWorkflowSteps: () => params.config.steps.map((step) => ({ name: step.name, description: step.description })),
    getWorkflowName: () => params.config.name,
    getTask: () => params.task,
    getWorkflowDescription: () => params.config.description,
    getWorkflowCallVars: () => params.options.workflowCallVars,
    getRetryNote: () => params.options.retryNote,
    getPrContext: () => params.options.prContext,
    getReviewScope,
    getObservabilityRunId: () => params.options.observabilityRunId,
    observabilityEnabled: () => params.options.observability?.enabled === true,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    structuredOutputNormalizers: params.options.structuredOutputNormalizers,
    structuredCaller: params.structuredCaller,
    internalAgentSeats: params.options.internalAgentSeats,
    abortSignal: params.options.abortSignal,
    findingContract: params.findingContract,
    findingManagerAuthority: params.findingManagerAuthority,
    workflowProvider: params.config.provider,
    workflowModel: params.config.model,
    executionProvider: params.options.provider,
    executionModel: params.options.model,
    findingLedgerStore: params.findingLedgerStore,
    refreshFindingsState: params.refreshFindingsState,
    emitEvent: params.emitEvent,
    recordSynthesizedAgentUsage: (stepName, providerInfo, success, usage) =>
      recordAgentUsageEvent(params.options, stepName, 'normal', providerInfo, success, usage),
    getRunId: () => params.runPaths.slug,
    getRunPathNamespace: () => params.options.runPathNamespace ?? [],
    companionDefinitions: params.config.companions,
    companionProviders: params.options.companionProviders,
    companionSelectorProvider: params.options.selectorProvider,
    companionDiffReader: params.options.companionDiffReader,
    companionReviewAuthority,
    getFindingCallNamespace: () => params.options.findingCallNamespace ?? '',
    ...phaseRelay,
    getFacetPool: (name: string) => params.config.facetPools?.[name],
    dynamicFacetSelectorCoordinator: dynamicFacetSelector,
  });

  const workflowCallRunner = new WorkflowCallRunner({
    getConfig: () => params.config,
    getMaxSteps: params.getMaxSteps,
    updateMaxSteps: params.updateMaxSteps,
    state: params.state as never,
    projectCwd: params.projectCwd,
    getCwd: params.getCwd,
    task: params.task,
    getOptions: () => params.options,
    sharedRuntime: params.sharedRuntime,
    resumeStackPrefix: [...(params.resumeStackPrefix ?? [])],
    consumeWorkflowCallContinuation: params.consumeWorkflowCallContinuation,
    runPaths: params.runPaths,
    setActiveResumePoint: params.setActiveResumePoint,
    emit: params.emitEvent,
    resolveWorkflowCall: (request) => params.options.workflowCallResolver!(request),
    createEngine: params.createEngine,
    findingContract: params.findingContract,
    findingLedgerStore: params.findingLedgerStore,
    refreshFindingsState: params.refreshFindingsState,
  });

  const dynamicParallelSelector = new DynamicParallelSelectorCoordinator({
    engineOptions: params.options,
    selectionStore: params.sharedRuntime.dynamicParallelSelectionStore!,
    getCwd: params.getCwd,
    getReportDirectory: () => params.runPaths.reportsAbs,
    getReportNames: (_step, state) => getSelectorReportNames(
      params.config,
      state,
      params.resumeStackPrefix,
      params.options.workflowCallResolver,
      params.projectCwd,
      params.getCwd(),
      params.sharedRuntime.workflowCallInvocationEvidence!,
      params.sharedRuntime.workflowStepParticipationIndex!,
    ),
    getWorkflowReference: () => getWorkflowReference(params.config),
    workflowCallPath: params.resumeStackPrefix,
    commitSelection: params.persistDynamicParallelSelection,
    ...(params.options.selectorGitCommandRunner === undefined
      ? {}
      : { inputReader: new SelectorInputReader(params.options.selectorGitCommandRunner) }),
  });

  const parallelRunner = new ParallelRunner({
    optionsBuilder,
    stepExecutor,
    engineOptions: params.options,
    getCwd: params.getCwd,
    dynamicParallelSelector,
    getWorkflowName: () => params.config.name,
    getTask: () => params.task,
    getInteractive: () => params.options.interactive === true,
    observabilityEnabled: params.options.observability?.enabled === true,
    observabilityRunId: params.options.observabilityRunId,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    refreshFindingsState: params.refreshFindingsState,
    emitEvent: params.emitEvent,
    findingContract: params.findingContract,
    internalAgentSeats: params.options.internalAgentSeats,
    findingManagerAuthority: params.findingManagerAuthority,
    workflowProvider: params.config.provider,
    workflowModel: params.config.model,
    findingLedgerStore: params.findingLedgerStore,
    getWorkflowCallRunner: () => workflowCallRunner,
    claimStepOccurrence: params.claimStepOccurrence,
    updateMaxSteps: params.updateMaxSteps,
    setActiveResumePoint: (step, iteration, occurrence) => params.setActiveResumePoint(
      step,
      iteration,
      occurrence,
      params.resumeStackPrefix,
    ),
    getRunId: () => params.runPaths.slug,
    reviewPublicationDir: params.runPaths.reportsAbs,
    getFindingCallNamespace: () => params.options.findingCallNamespace ?? '',
    runQualityGates,
    ...phaseRelay,
  });

  const arpeggioRunner = new ArpeggioRunner({
    optionsBuilder,
    stepExecutor,
    getCwd: params.getCwd,
    getWorkflowName: () => params.config.name,
    getInteractive: () => params.options.interactive === true,
    childProcessEnv: params.options.childProcessEnv,
    observabilityEnabled: params.options.observability?.enabled === true,
    observabilityRunId: params.options.observabilityRunId,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    onPhaseStart: phaseRelay.onPhaseStart,
    onPhaseComplete: phaseRelay.onPhaseComplete,
  });

  const teamLeaderRunner = new TeamLeaderRunner({
    optionsBuilder,
    stepExecutor,
    engineOptions: params.options,
    getCwd: params.getCwd,
    getTask: () => params.task,
    getState: () => params.state,
    getWorkflowName: () => params.config.name,
    getInteractive: () => params.options.interactive === true,
    getRunPaths: params.getRunPaths,
    findingContract: params.findingContract,
    findingLedgerStore: params.findingLedgerStore,
    operationJournal: params.options.operationJournal,
    observabilityEnabled: params.options.observability?.enabled === true,
    observabilityRunId: params.options.observabilityRunId,
    sanitizeObservabilityText: params.options.sanitizeObservabilityText,
    getCurrentWorkflowStack: params.getCurrentWorkflowStack,
    onPhaseStart: phaseRelay.onPhaseStart,
    onPhaseComplete: phaseRelay.onPhaseComplete,
    emitEvent: params.emitEvent,
  });

  const systemStepExecutor = new SystemStepExecutor({
    task: params.task,
    projectCwd: params.projectCwd,
    getCwd: params.getCwd,
    taskContext: params.options.currentTask,
    getRuleContext: () => {
      return {
        interactive: params.options.interactive === true,
      };
    },
    getStatusJudgmentContext: (step, state, lastResponse, runtime) => optionsBuilder.buildPhaseRunnerContext(
      step,
      state,
      lastResponse,
      params.updatePersonaSession,
      phaseRelay.onPhaseStart,
      phaseRelay.onPhaseComplete,
      phaseRelay.onJudgeStage,
      state.iteration,
      runtime,
    ),
    systemStepServicesFactory: params.options.systemStepServicesFactory,
  });

  const loopMonitorJudgeRunner = new LoopMonitorJudgeRunner({
    optionsBuilder,
    stepExecutor,
    state: params.state as never,
    task: params.task,
    getMaxSteps: params.getMaxSteps,
    language: params.options.language,
    internalAgentSeats: params.options.internalAgentSeats,
    updatePersonaSession: params.updatePersonaSession,
    resolveNextStepFromDone: params.resolveNextStepFromDone as never,
    onStepStart: (step, iteration, instruction, providerInfo, resumeStepName, stepIteration) => {
      const workflowStack = requireWorkflowResumeStackSnapshot(
        params.getCurrentWorkflowStack(),
      );
      params.emitEvent(
        'step:start',
        step,
        iteration,
        instruction,
        providerInfo,
        params.config.name,
        resumeStepName,
        stepIteration,
        workflowStack,
        params.findingLedgerStore?.ledgerIdentity,
        params.findingLedgerStore
          ?.loadLedger()
          .findings
          .map((finding) => finding.id),
      );
      return workflowStack;
    },
    onStepComplete: (step, response, instruction, resumeStepName, workflowStack) => {
      params.emitEvent(
        'step:complete',
        step,
        response,
        instruction,
        resumeStepName,
        workflowStack,
      );
    },
    emitCollectedReports: () => {
      for (const {
        step,
        filePath,
        fileName,
        context,
      } of stepExecutor.drainReportFiles()) {
        params.emitEvent(
          'step:report',
          step,
          filePath,
          fileName,
          context,
        );
      }
    },
    resetCycleDetector: params.resetCycleDetector,
    ...(params.findingContract && params.findingLedgerStore
      ? {
          getFindingsSummaryForJudge: () =>
            renderLoopMonitorFindingsSummary(params.findingLedgerStore!.loadLedger(), params.findingContract!),
        }
      : {}),
  });

  return {
    optionsBuilder,
    stepExecutor,
    parallelRunner,
    arpeggioRunner,
    teamLeaderRunner,
    systemStepExecutor,
    loopMonitorJudgeRunner,
    workflowCallRunner,
  };
}

function getSelectorReportNames(
  config: WorkflowConfig,
  state: WorkflowState,
  resumeStackPrefix: readonly WorkflowResumePointEntry[],
  workflowCallResolver: WorkflowEngineOptions['workflowCallResolver'],
  projectCwd: string,
  lookupCwd: string,
  workflowCallInvocationEvidence: WorkflowCallInvocationEvidence,
  workflowStepParticipationIndex: import('../workflow-step-participation-index.js').WorkflowStepParticipationIndex,
): readonly string[] {
  const results = config.steps
    .map((step) => resolveWorkflowStepReportNamesWithDiagnostics(step, createReviewReportDiscoveryContext({
      step,
      workflow: config,
      workflowCallResolver,
      projectCwd,
      lookupCwd,
      resumeStackPrefix,
      stepOutputNames: new Set(state.stepOutputs.keys()),
      restoredStepIterationNames: state.restoredStepIterationNames,
      dynamicParallelSelections: state.dynamicParallelSelections,
      workflowCallInvocations: snapshotWorkflowCallInvocationEvidence(
        workflowCallInvocationEvidence,
      ),
      workflowStepParticipations: workflowStepParticipationIndex.snapshot(),
    })));
  const failures = results.flatMap((result) => result.failures);
  if (failures.length > 0) {
    throw new Error(
      `Unable to resolve dynamic selector report inputs: ${failures.map((failure) => failure.reason).join('; ')}`,
    );
  }
  return results.flatMap((result) => result.reportNames);
}
