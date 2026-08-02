import type { AgentWorkflowStep } from '../../models/types.js';
import { computeFindingManagerRoundIdentity } from '../../models/finding-contract-identity.js';
import type {
  FindingLedger,
  FindingManagerTaskAudit,
  FindingObservation,
} from './types.js';
import { classifyRawFindingsMechanically } from './mechanical-classification.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import {
  computeInvalidLocationCandidates,
} from './manager-utils.js';
import { hasDisputeClaimsHeading } from './manager-output-validation.js';
import type {
  FindingManagerValidationAttemptReport,
} from './store.js';
import type { ManagerDecisionStageResult, RunFindingManagerForStepInput } from './manager-contracts.js';
import { runInterpretationCases } from './interpretation-case-runner.js';
import { assembleCleanManagerDecision } from './manager-clean-decision.js';
import { runMainManagerTasks } from './manager-task-runner.js';
import {
  hasLifecycleProductTransitionCapability,
  hasLifecycleTransitionIntent,
} from './raw-relation-capabilities.js';
import { computeWorkflowTaskDigest } from './task-scope-adjudication.js';
import { runTerminalAdjudication } from './terminal-adjudication-runner.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';

export {
  FINDING_MANAGER_SCHEMA_REF,
  RAW_FINDINGS_SCHEMA_REF,
  createRawFindingsStructuredOutput,
} from './manager-agent.js';

export async function runManagerDecisionStage(params: {
  input: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  admission: RawAdmissionEvaluation;
  managerStep: AgentWorkflowStep;
  observation: FindingObservation;
  reviewScopeSnapshotId: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
  stopBudgetRoundMarker: string;
  preAdmissionTaskAudits: FindingManagerTaskAudit[];
}): Promise<ManagerDecisionStageResult> {
  const {
    input,
    previousLedger,
    admission,
    managerStep,
    observation,
    reviewScopeSnapshotId,
    preAdmissionTaskAudits,
  } = params;
  const {
    cleanWire,
    taintedAdmitted,
    provisionalOnlyLadderRawIds,
  } = admission;
  const workflowTaskDigest = computeWorkflowTaskDigest(input.workflowTask);
  const findingsById = new Map(previousLedger.findings.map((finding) => [finding.id, finding]));
  const cleanAuditOnlyLifecycleRawIds = new Set(
      admission.cleanAdmitted
        .filter((item) => (
          item.canonical.relation !== null
          && item.canonical.relation !== 'new'
          && !hasLifecycleProductTransitionCapability({
            relation: item.canonical.relation,
            target: item.canonical.targetFindingId === undefined
              ? undefined
              : findingsById.get(item.canonical.targetFindingId),
            workflowTaskDigest,
          })
        ))
        .map((item) => item.wire.rawFindingId),
    );
  const decisionAdmission: RawAdmissionEvaluation = cleanAuditOnlyLifecycleRawIds.size === 0
      ? admission
      : {
          ...admission,
          cleanAdmitted: admission.cleanAdmitted.filter(
            (item) => !cleanAuditOnlyLifecycleRawIds.has(item.wire.rawFindingId),
          ),
          cleanWire: cleanWire.filter(
            (wire) => !cleanAuditOnlyLifecycleRawIds.has(wire.rawFindingId),
          ),
        };
  const invalidLocationCandidates = computeInvalidLocationCandidates(input.cwd, previousLedger);
    const invalidLocationCandidateFindingIds = new Set(invalidLocationCandidates.keys());
    const dismissCandidates = new Map<string, string>();
    const dismissCandidateFindingIds = new Set(dismissCandidates.keys());
    const mechanical = classifyRawFindingsMechanically({
      previousLedger,
      rawFindings: decisionAdmission.cleanWire,
    });
    const hasDisputeClaims = hasDisputeClaimsHeading(input.priorStepResponseText);
    const hasActiveConflict = previousLedger.conflicts.some((conflict) => conflict.status === 'active');
    const needsAgent = mechanical.residualRawFindings.length > 0
      || hasDisputeClaims
      || hasActiveConflict
      || invalidLocationCandidateFindingIds.size > 0
      || dismissCandidateFindingIds.size > 0;

    let initialInvalidAttempts: FindingManagerValidationAttemptReport[] = [];
    let taskExecution: Awaited<ReturnType<typeof runMainManagerTasks>> | undefined;
    if (needsAgent) {
      taskExecution = await runMainManagerTasks({
        contract: input.contract,
        previousLedger,
        reviewScopeSnapshotId,
        residualRawFindings: mechanical.residualRawFindings,
        mechanicallyClassifiedCount: decisionAdmission.cleanWire.length
          - mechanical.residualRawFindings.length,
        priorStepResponseText: input.priorStepResponseText,
        invalidLocationCandidates,
        dismissCandidates,
        evidenceRecordsByRawFindingId: admission.verifiedEvidenceRecordsByRawFindingId,
        managerStep,
        runInput: input,
        managerAuthority: input.managerAuthority,
        workflowTask: input.workflowTask,
        subResults: input.subResults,
      });
      initialInvalidAttempts = taskExecution.invalidAttemptMessages.map((message, index) => ({
        attempt: index + 1,
        managerOutput: { error: message },
        validationErrors: [message],
      }));
    }

    const cleanDecision = assembleCleanManagerDecision({
      previousLedger,
      admission: decisionAdmission,
      mechanical,
      decisions: taskExecution?.decisions,
      initialInvalidAttempts,
      invalidLocationCandidateFindingIds,
      dismissCandidateFindingIds,
      managerAuthority: input.managerAuthority,
      priorStepResponseText: input.priorStepResponseText,
      rawFailureById: taskExecution?.rawFailures,
    });
    const {
      managerOutput,
      invalidAttempts,
      cleanProvisionalSpecs,
      cleanWireById,
      cleanCanonicalById,
    } = cleanDecision;
    let unsupportedRawFindingReports = cleanDecision.unsupportedRawFindingReports;

    for (const item of admission.cleanAdmitted) {
      if (!cleanAuditOnlyLifecycleRawIds.has(item.wire.rawFindingId)) {
        continue;
      }
      unsupportedRawFindingReports = [...unsupportedRawFindingReports, {
        rawFindingId: item.wire.rawFindingId,
        targetFindingId: item.wire.targetFindingId
          ?? item.canonical.targetFindingId
          ?? '(none)',
        evidence: 'Lifecycle claim has no transition capability for the target state; recorded for audit only — no finding was created or changed',
      }];
    }

    // 曖昧起源の lifecycle claim には product finding の作成・変更権限がない。
    const taintedLifecycle = taintedAdmitted.filter(
      (item) => hasLifecycleTransitionIntent({
        relation: item.canonical.relation,
        targetFindingId: item.canonical.targetFindingId,
      }),
    );
    for (const item of taintedLifecycle) {
      unsupportedRawFindingReports = [...unsupportedRawFindingReports, {
        rawFindingId: item.wire.rawFindingId,
        targetFindingId: item.wire.targetFindingId ?? item.canonical.targetFindingId ?? '(none)',
        evidence: 'Ambiguity-tainted lifecycle claim has no product transition capability; recorded for audit only — no finding was created or changed',
      }];
    }
    const ladderTainted = taintedAdmitted.filter(
      (item) => !taintedLifecycle.includes(item),
    );
    await runTerminalAdjudication({
      runInput: input,
      observation,
      roundIdentity: computeFindingManagerRoundIdentity({
        scopeIdentity: workflowTaskDigest,
        workflowName: input.workflowName,
        roundMarker: params.stopBudgetRoundMarker,
      }),
      scopeIdentity: workflowTaskDigest,
      reviewScopeSnapshot: params.reviewScopeSnapshot,
    });
    const interpretation = await runInterpretationCases({
      items: ladderTainted,
      provisionalOnlyRawFindingIds: provisionalOnlyLadderRawIds,
      ledgerStore: input.ledgerStore,
      contract: input.contract,
      workflowProvider: input.workflowProvider,
      workflowModel: input.workflowModel,
      optionsBuilder: input.optionsBuilder,
      stepExecutor: input.stepExecutor,
      observation,
      roundMarker: params.stopBudgetRoundMarker,
      scopeIdentity: workflowTaskDigest,
      verifiedEvidenceRecordsByRawFindingId: admission.verifiedEvidenceRecordsByRawFindingId,
    });

  return {
    managerOutput,
    conflictTargetHeads: taskExecution?.conflictTargetHeads ?? new Map(),
    invalidAttempts,
    cleanProvisionalSpecs,
    unsupportedRawFindingReports,
    cleanWireById,
    cleanCanonicalById,
    interpretation,
    taskAudits: [
      ...preAdmissionTaskAudits,
      ...(taskExecution?.taskAudits ?? []),
    ],
  };
}
