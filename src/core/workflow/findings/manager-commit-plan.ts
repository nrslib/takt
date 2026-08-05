import type {
  CanonicalRawReconcileProvenance,
  ProvisionalFindingSpec,
} from './reconciler.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import { resolveReviewIntegrityLimits } from './review-integrity.js';
import { captureFindingPreconditions } from './finding-preconditions.js';
import type {
  FindingLedgerMutation,
  ProvisionalLandingReport,
  ReviewerAnomalyLandingReport,
  UnsupportedRawFindingReport,
} from './store.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  FindingObservation,
  InterpretationRecoveryOriginSettlement,
} from './types.js';
import { evaluateRawAdmission, type RawAdmissionEvaluation, type ReviewerIntakeResult } from './manager-admission.js';
import { provisionalSpecForRawKind } from './manager-provisional.js';
import type { ManagerDecisionStageResult, RunFindingManagerForStepInput } from './manager-contracts.js';

import { mergeOutputs, revalidateManagerPlan } from './manager-commit-revalidation.js';
import {
  applyCommitLedgerStates,
  reconcileCommitPlan,
} from './manager-commit-finalization.js';
import type { RejectedObservationAttachment } from './manager-provisional-settlement.js';
import {
  collectManagerActionRecoveryCandidates,
  planManagerActionRecovery,
  type ManagerActionRecoveryLifecyclePlan,
} from './manager-action-recovery.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';
import type { ResolutionRenotificationTransition } from './resolution-renotification.js';
import type { FindingLifecycleCommand } from './lifecycle-transaction.js';
import {
  captureReviewScopeSnapshot,
  type ReviewScopeProofSnapshot,
} from './snapshot.js';
import { computeConflictEvidenceHash } from './adjudication-evidence.js';
import {
  prepareInterpretationCaseActions,
  stagePreparedInterpretationCaseOwnership,
  type PreparedInterpretationCasePlan,
} from './interpretation-case-finalizer.js';
import { issueInterpretationCaseConflictAuthority } from './interpretation-case-authority.js';
import { createAnchorAdjudication } from '../../models/finding-anchor-relevance.js';
import { createEmptyManagerOutput } from './manager-output.js';
import { appendRawFindingsWithCanonicalSnapshots } from './raw-canonical-snapshot.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { classifyConflictTarget } from './conflict-target.js';
import {
  findIndependentProvisionalDestination,
  independentProvisionalIdentity,
} from './independent-provisional-identity.js';
import type { ProvisionalTargetConflictCandidate } from './decision-assembly.js';
import { issueRawProvisionalIdentityProof } from './raw-provisional-identity-proof.js';
import { applyFindingLifecycleCommands } from './lifecycle-transaction.js';
import { landUnownedConflictRawClaims } from './conflict-claim-landing.js';
import { computeConflictReactivationDigest } from '../../models/finding-contract-identity.js';
import { collectRestatementRequests } from './review-publication.js';

export function attachCapturedConflictHeads(input: {
  commands: readonly FindingLifecycleCommand[];
  resolvedConflictIds: ReadonlySet<string>;
  capturedConflictHeads: ManagerDecisionStageResult['conflictTargetHeads'];
  cwd: string;
}): FindingLifecycleCommand[] {
  return input.commands.map((command) => {
    const expectedHeadsByTarget = new Map(command.expectedHeadsByTarget);
    for (const conflict of command.changes.conflicts) {
      if (
        input.resolvedConflictIds.has(conflict.id)
        && input.capturedConflictHeads.has(conflict.id)
      ) {
        const captured = input.capturedConflictHeads.get(conflict.id)!;
        expectedHeadsByTarget.set(
          `conflict\0${conflict.id}`,
          captured.lifecycleHead,
        );
      }
    }
    return expectedHeadsByTarget.size === 0
      ? command
      : {
          ...command,
          expectedHeadsByTarget,
        };
  });
}

function attachInterpretationCaseOrigins(
  commands: readonly FindingLifecycleCommand[],
  prepared: PreparedInterpretationCasePlan,
): FindingLifecycleCommand[] {
  const caseIdsByRawFindingId = new Map<string, string>();
  for (const preparedCase of prepared.cases) {
    for (const rawFindingId of preparedCase.rawFindingIds) {
      if (caseIdsByRawFindingId.has(rawFindingId)) {
        throw new Error(`Interpretation raw finding "${rawFindingId}" has multiple case owners`);
      }
      caseIdsByRawFindingId.set(rawFindingId, preparedCase.caseId);
    }
  }
  return commands.map((command) => ({
    ...command,
    interpretationCaseIdsByRawFindingId: caseIdsByRawFindingId,
  }));
}

export interface CommitMutationResult {
  applied: boolean;
  managerDecisionLedger: FindingLedger;
  managerDecisionCommands: FindingLifecycleCommand[];
  lifecycleManagerOutput: FindingManagerOutput;
  staleRejections: string[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  admissionRejections: RawAdmissionEvaluation['admissionRejections'];
  provisionalLandings: ProvisionalLandingReport[];
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
  interpretationRecoverySettlements: InterpretationRecoveryOriginSettlement[];
  resolutionRenotifications: ResolutionRenotificationTransition[];
  rejectedObservationAttachments: RejectedObservationAttachment[];
  settlementCommands: FindingLifecycleCommand[];
  actionRecoveryPlan: ManagerActionRecoveryLifecyclePlan | null;
  interpretationPrepared: PreparedInterpretationCasePlan;
}

export interface FindingManagerCommitPlanInput {
  input: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  intake: ReviewerIntakeResult;
  admission: RawAdmissionEvaluation;
  managerDecision: ManagerDecisionStageResult;
  observation: FindingObservation;
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
  reviewScopeSnapshotId: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
}

function containsIsolatedRawFinding(
  sourceRawFindingIds: readonly string[],
  isolatedRawFindingIds: ReadonlySet<string>,
): boolean {
  return sourceRawFindingIds.some((rawFindingId) => isolatedRawFindingIds.has(rawFindingId));
}

function isolateManagerOutputForCommit(
  output: FindingManagerOutput,
  isolatedRawFindingIds: ReadonlySet<string>,
): FindingManagerOutput {
  const retain = <T extends { rawFindingIds: string[] }>(entries: readonly T[]): T[] => (
    entries.filter((entry) => !containsIsolatedRawFinding(entry.rawFindingIds, isolatedRawFindingIds))
  );
  const matches = retain(output.matches);
  const newFindings = retain(output.newFindings);
  const resolvedFindings = retain(output.resolvedFindings);
  const reopenedFindings = retain(output.reopenedFindings);
  const conflicts = retain(output.conflicts);
  const landedRawFindingIds = new Set([
    ...matches.flatMap((entry) => entry.rawFindingIds),
    ...newFindings.flatMap((entry) => entry.rawFindingIds),
    ...resolvedFindings.flatMap((entry) => entry.rawFindingIds),
    ...reopenedFindings.flatMap((entry) => entry.rawFindingIds),
    ...conflicts.flatMap((entry) => entry.rawFindingIds),
  ]);
  return {
    ...output,
    anchorAdjudications: output.anchorAdjudications.filter(
      (adjudication) => landedRawFindingIds.has(adjudication.rawFindingId),
    ),
    matches,
    newFindings,
    resolvedFindings,
    reopenedFindings,
    conflicts,
  };
}

function prospectiveStaleConflictResolutions(input: {
  recoveryLedger: FindingLedger;
  prospectiveLedger: FindingLedger;
  resolvedConflicts: FindingManagerOutput['resolvedConflicts'];
  capturedConflictHeads: ManagerDecisionStageResult['conflictTargetHeads'];
  reviewScopeSnapshotId: string;
}): Set<string> {
  const stale = new Set<string>();
  for (const resolved of input.resolvedConflicts) {
    const captured = input.capturedConflictHeads.get(resolved.conflictId);
    const originalConflict = input.recoveryLedger.conflicts.find(
      (conflict) => conflict.id === resolved.conflictId,
    );
    if (captured === undefined || originalConflict === undefined) {
      continue;
    }
    const dependencyLedger: FindingLedger = {
      ...input.prospectiveLedger,
      conflicts: input.prospectiveLedger.conflicts.map((conflict) => (
        conflict.id === resolved.conflictId ? originalConflict : conflict
      )),
    };
    const prospectiveHash = computeConflictEvidenceHash(
      originalConflict,
      dependencyLedger,
      input.reviewScopeSnapshotId,
    );
    if (
      captured.reviewScopeSnapshotId !== input.reviewScopeSnapshotId
      || captured.evidenceSetHash !== prospectiveHash
    ) {
      stale.add(resolved.conflictId);
    }
  }
  return stale;
}

interface ManagerEntryIsolationPlan {
  droppedRawFindingIds: Set<string>;
  provisionalSpecs: ProvisionalFindingSpec[];
}

interface PreparedProvisionalTargetLanding {
  candidate: ProvisionalTargetConflictCandidate;
  mode: 'attach_exact' | 'identity_unproven';
  destinationFindingId: string | null;
  spec: ProvisionalFindingSpec;
  interpretationCaseId?: string;
}

function prepareProvisionalTargetLandings(input: {
  ledger: FindingLedger;
  candidates: readonly ProvisionalTargetConflictCandidate[];
  intake: ReviewerIntakeResult;
  retainedRawFindingIds: ReadonlySet<string>;
}): PreparedProvisionalTargetLanding[] {
  const itemsByRawFindingId = new Map(
    input.intake.items.map((item) => [item.wire.rawFindingId, item]),
  );
  return input.candidates.flatMap((candidate): PreparedProvisionalTargetLanding[] => {
    if (!input.retainedRawFindingIds.has(candidate.rawFindingId)) {
      return [];
    }
    const classification = classifyConflictTarget({
      ledger: input.ledger,
      targetFindingId: candidate.targetFindingId,
    });
    if (classification.kind !== 'provisional_target') {
      return [];
    }
    const item = itemsByRawFindingId.get(candidate.rawFindingId);
    if (item === undefined) {
      throw new Error(
        `Provisional conflict raw finding "${candidate.rawFindingId}" is missing from intake`,
      );
    }
    const exact = classification.targetIdentityHash === item.wire.targetIdentityHash
      && classification.claimIdentityHash === item.wire.claimIdentityHash
      && classification.semanticClaimIdentityHash === item.wire.semanticClaimIdentityHash;
    if (exact) {
      return [{
        candidate,
        mode: 'attach_exact',
        destinationFindingId: classification.findingId,
        spec: {
          kind: classification.provisionalKind,
          stableKey: classification.provisionalStableKey,
          lineageKey: classification.provisionalLineageKey,
          sourceRawFindingIds: [candidate.rawFindingId],
          reason: candidate.evidence,
          title: item.wire.title,
          severity: item.wire.severity,
          ...(item.wire.description === null ? {} : { description: item.wire.description }),
          ...(item.wire.suggestion === null ? {} : { suggestion: item.wire.suggestion }),
          reviewers: [item.wire.reviewer],
          recoveryReviewerStableKey: item.canonical.reviewerStableKey,
          target: item.wire.target,
          targetIdentityHash: item.wire.targetIdentityHash,
          claimIdentityHash: item.wire.claimIdentityHash,
          semanticClaimIdentityHash: item.wire.semanticClaimIdentityHash,
        },
      }];
    }
    const identity = independentProvisionalIdentity(item.wire);
    const existing = findIndependentProvisionalDestination({
      ledger: input.ledger,
      stableKey: identity.independentStableKey,
    });
    return [{
      candidate,
      mode: 'identity_unproven',
      destinationFindingId: existing?.finding.id ?? null,
      spec: {
        kind: 'raw-adjudication-unresolved',
        stableKey: identity.independentStableKey,
        lineageKey: identity.independentLineageKey,
        sourceRawFindingIds: [candidate.rawFindingId],
        reason: 'identity_unproven',
        title: item.wire.title,
        severity: item.wire.severity,
        ...(item.wire.description === null ? {} : { description: item.wire.description }),
        ...(item.wire.suggestion === null ? {} : { suggestion: item.wire.suggestion }),
        reviewers: [item.wire.reviewer],
        recoveryReviewerStableKey: item.canonical.reviewerStableKey,
        target: item.wire.target,
        targetIdentityHash: item.wire.targetIdentityHash,
        claimIdentityHash: item.wire.claimIdentityHash,
        semanticClaimIdentityHash: item.wire.semanticClaimIdentityHash,
      },
    }];
  });
}

function freshProductTargetConflictOutput(input: {
  ledger: FindingLedger;
  candidates: readonly ProvisionalTargetConflictCandidate[];
  intake: ReviewerIntakeResult;
  retainedRawFindingIds: ReadonlySet<string>;
}): FindingManagerOutput {
  const output = createEmptyManagerOutput();
  const itemsByRawFindingId = new Map(
    input.intake.items.map((item) => [item.wire.rawFindingId, item]),
  );
  const grouped = new Map<string, ProvisionalTargetConflictCandidate[]>();
  for (const candidate of input.candidates) {
    if (!input.retainedRawFindingIds.has(candidate.rawFindingId)) continue;
    if (classifyConflictTarget({
      ledger: input.ledger,
      targetFindingId: candidate.targetFindingId,
    }).kind !== 'product_target') {
      continue;
    }
    grouped.set(
      candidate.targetFindingId,
      [...(grouped.get(candidate.targetFindingId) ?? []), candidate],
    );
  }
  for (const [targetFindingId, candidates] of grouped) {
    output.conflicts.push({
      findingIds: [targetFindingId],
      rawFindingIds: candidates.map(({ rawFindingId }) => rawFindingId)
        .sort(compareBinaryStrings),
      description: candidates.map(({ evidence }) => evidence)
        .sort(compareBinaryStrings)
        .join('; '),
    });
    for (const candidate of candidates) {
      const item = itemsByRawFindingId.get(candidate.rawFindingId);
      if (item === undefined) {
        throw new Error(`Fresh product conflict raw "${candidate.rawFindingId}" is missing`);
      }
      output.anchorAdjudications.push(createAnchorAdjudication({
        rawFindingId: candidate.rawFindingId,
        decision: 'conflict',
        findingId: targetFindingId,
        anchorRelevance: item.wire.target.kind === 'absence' ? 'relevant' : 'not_applicable',
        evidence: candidate.evidence,
      }));
    }
  }
  return output;
}

function groupProvisionalTargetLandingSpecs(
  landings: readonly PreparedProvisionalTargetLanding[],
): ProvisionalFindingSpec[] {
  const byStableKey = new Map<string, ProvisionalFindingSpec[]>();
  for (const { spec } of landings) {
    byStableKey.set(spec.stableKey, [...(byStableKey.get(spec.stableKey) ?? []), spec]);
  }
  return [...byStableKey.values()].map((specs) => {
    const first = specs[0];
    if (first === undefined) {
      throw new Error('Provisional target landing spec group must be non-empty');
    }
    if (specs.some((spec) => (
      spec.kind !== first.kind
      || spec.lineageKey !== first.lineageKey
      || spec.targetIdentityHash !== first.targetIdentityHash
      || spec.claimIdentityHash !== first.claimIdentityHash
      || spec.semanticClaimIdentityHash !== first.semanticClaimIdentityHash
    ))) {
      throw new Error(
        `Provisional target landing specs disagree for stable key "${first.stableKey}"`,
      );
    }
    return {
      ...first,
      sourceRawFindingIds: [...new Set(
        specs.flatMap((spec) => spec.sourceRawFindingIds),
      )].sort(compareBinaryStrings),
      reviewers: [...new Set(specs.flatMap((spec) => spec.reviewers))]
        .sort(compareBinaryStrings),
      reason: [...new Set(specs.map((spec) => spec.reason))]
        .sort(compareBinaryStrings)
        .join('; '),
    };
  }).sort((left, right) => compareBinaryStrings(left.stableKey, right.stableKey));
}

function assertDedicatedAttachmentArtifacts(input: {
  ledger: FindingLedger;
  rawFindingId: string;
  targetFindingId: string;
  proofRecordId: string;
  lifecycleEvidenceBindingId: string;
}): void {
  const proofs = input.ledger.evidenceRecords.filter((record) => (
    record.evidenceId === input.proofRecordId
    && record.kind === 'engine_proof'
    && record.subject.kind === 'raw_provisional_claim_identical'
    && record.subject.rawFindingId === input.rawFindingId
    && record.subject.targetFindingId === input.targetFindingId
  ));
  const bindings = input.ledger.evidenceBindings.filter((binding) => (
    binding.bindingId === input.lifecycleEvidenceBindingId
    && binding.evidenceId === input.proofRecordId
    && binding.sourceRawFindingId === input.rawFindingId
    && binding.operation === 'attach_raw_to_provisional'
    && binding.target.entityKind === 'finding'
    && binding.target.entityId === input.targetFindingId
  ));
  const events = input.ledger.lifecycleEvents.filter((event) => (
    event.operation === 'attach_raw_to_provisional'
    && event.evidenceBindingIds.includes(input.lifecycleEvidenceBindingId)
    && event.transitions.some((transition) => (
      transition.after.entityKind === 'finding'
      && transition.after.entityId === input.targetFindingId
    ))
  ));
  if (proofs.length !== 1 || bindings.length !== 1 || events.length !== 1) {
    throw new Error(
      `Dedicated provisional attachment for raw "${input.rawFindingId}" must produce exactly one proof, binding, and event`,
    );
  }
}

function applyPreparedProvisionalAttachments(input: {
  recoveryLedger: FindingLedger;
  plan: ReturnType<typeof reconcileCommitPlan>;
  landings: readonly PreparedProvisionalTargetLanding[];
  intake: ReviewerIntakeResult;
  observation: FindingObservation;
  scopeIdentity: string;
}): ReturnType<typeof reconcileCommitPlan> {
  const attachLandings = input.landings.filter(
    (landing): landing is PreparedProvisionalTargetLanding & { destinationFindingId: string } => (
      landing.destinationFindingId !== null
    ),
  );
  if (attachLandings.length === 0) {
    return input.plan;
  }
  const itemsByRawFindingId = new Map(
    input.intake.items.map((item) => [item.wire.rawFindingId, item]),
  );
  let proofLedger: FindingLedger = {
    ...input.plan.managerDecisionLedger,
    findings: input.recoveryLedger.findings,
    conflicts: input.recoveryLedger.conflicts,
    lifecycleReservations: input.recoveryLedger.lifecycleReservations,
    lifecycleEvents: input.recoveryLedger.lifecycleEvents,
  };
  const commands: FindingLifecycleCommand[] = [];
  const attachedFindingIds = new Set<string>();
  for (const landing of [...attachLandings].sort((left, right) => (
    compareBinaryStrings(left.destinationFindingId, right.destinationFindingId)
    || compareBinaryStrings(left.candidate.rawFindingId, right.candidate.rawFindingId)
  ))) {
    const item = itemsByRawFindingId.get(landing.candidate.rawFindingId);
    if (item === undefined) {
      throw new Error(`Provisional attachment raw "${landing.candidate.rawFindingId}" is missing`);
    }
    const issued = issueRawProvisionalIdentityProof({
      ledger: proofLedger,
      rawFindingId: landing.candidate.rawFindingId,
      targetFindingId: landing.destinationFindingId,
      runId: input.observation.runId,
      scopeIdentity: input.scopeIdentity,
      contributionOrigin: landing.interpretationCaseId === undefined
        ? { kind: 'external' }
        : { kind: 'interpretation_case', caseId: landing.interpretationCaseId },
      issuedAt: input.observation.timestamp,
    });
    proofLedger = {
      ...proofLedger,
      evidenceRecords: [...proofLedger.evidenceRecords, issued.proofRecord],
    };
    const before = proofLedger.findings.find(
      (finding) => finding.id === landing.destinationFindingId,
    );
    if (before?.status !== 'open' || before.provisional === undefined) {
      throw new Error(`Provisional attachment target "${landing.destinationFindingId}" is unavailable`);
    }
    const after = {
      ...before,
      lifecycle: 'persists' as const,
      revision: before.revision + 1,
      rawFindingIds: [...new Set([...before.rawFindingIds, item.wire.rawFindingId])]
        .sort(compareBinaryStrings),
      reviewers: [...new Set([...before.reviewers, item.wire.reviewer])]
        .sort(compareBinaryStrings),
      evidenceIds: [...new Set([...before.evidenceIds, issued.proofRecord.evidenceId])]
        .sort(compareBinaryStrings),
      lastSeen: input.observation,
      provisional: {
        ...before.provisional,
        sourceRawFindingIds: [...new Set([
          ...before.provisional.sourceRawFindingIds,
          item.wire.rawFindingId,
        ])].sort(compareBinaryStrings),
        lastObservedAt: input.observation,
      },
    };
    const { revision: _revision, ...projection } = after;
    void _revision;
    const command: FindingLifecycleCommand = {
      operation: 'attach_raw_to_provisional',
      changes: { findings: [projection], conflicts: [] },
      authority: issued.authority,
      ...(landing.interpretationCaseId === undefined
        ? {}
        : {
            interpretationCaseIdsByRawFindingId: new Map([[
              item.wire.rawFindingId,
              landing.interpretationCaseId,
            ]]),
          }),
      evidenceSourcesByTarget: new Map([[
        `finding\0${after.id}`,
        {
          sourceRawFindingIds: [item.wire.rawFindingId],
          authorityEvidenceIds: [issued.proofRecord.evidenceId],
        },
      ]]),
    };
    proofLedger = applyFindingLifecycleCommands({
      ledger: proofLedger,
      commands: [command],
      occurredAt: input.observation,
    });
    assertDedicatedAttachmentArtifacts({
      ledger: proofLedger,
      rawFindingId: item.wire.rawFindingId,
      targetFindingId: after.id,
      proofRecordId: issued.authority.proofRecordId,
      lifecycleEvidenceBindingId: issued.authority.lifecycleEvidenceBindingId,
    });
    commands.push(command);
    attachedFindingIds.add(after.id);
  }
  const finalFindingsById = new Map(proofLedger.findings.map((finding) => [finding.id, finding]));
  const replaceProjections = (ledger: FindingLedger): FindingLedger => ({
    ...ledger,
    evidenceRecords: proofLedger.evidenceRecords,
    evidenceBindings: proofLedger.evidenceBindings,
    findings: ledger.findings.map((finding) => (
      attachedFindingIds.has(finding.id) ? finalFindingsById.get(finding.id)! : finding
    )),
  });
  return {
    ...input.plan,
    ledger: replaceProjections(input.plan.ledger),
    managerDecisionLedger: replaceProjections(input.plan.managerDecisionLedger),
    managerDecisionCommands: [
      ...input.plan.managerDecisionCommands.filter((command) => !(
        command.operation === 'update_provisional'
        && command.changes.findings.some((finding) => attachedFindingIds.has(finding.id))
      )),
      ...commands,
    ],
  };
}

function assertDedicatedPlanTransformations(input: {
  recoveryLedger: FindingLedger;
  plan: ReturnType<typeof reconcileCommitPlan>;
  landings: readonly PreparedProvisionalTargetLanding[];
}): void {
  const attachedFindingIds = new Set(input.landings.flatMap((landing) => (
    landing.destinationFindingId === null ? [] : [landing.destinationFindingId]
  )));
  for (const landing of input.landings) {
    if (
      landing.mode === 'attach_exact'
      && landing.destinationFindingId !== landing.candidate.targetFindingId
    ) {
      throw new Error(
        `Exact provisional attachment for raw "${landing.candidate.rawFindingId}" must retain rejected target "${landing.candidate.targetFindingId}"`,
      );
    }
    if (landing.destinationFindingId === null) {
      continue;
    }
    const attachments = input.plan.managerDecisionCommands.filter((command) => (
      command.operation === 'attach_raw_to_provisional'
      && command.authority.kind === 'verified_raw_provisional_identity'
      && command.authority.rawFindingId === landing.candidate.rawFindingId
      && command.authority.targetFindingId === landing.destinationFindingId
    ));
    if (attachments.length !== 1) {
      throw new Error(
        `Commit plan must contain exactly one dedicated provisional attachment for raw "${landing.candidate.rawFindingId}"`,
      );
    }
  }
  const genericAttachment = input.plan.managerDecisionCommands.find((command) => (
    command.operation === 'update_provisional'
    && command.changes.findings.some((finding) => attachedFindingIds.has(finding.id))
  ));
  if (genericAttachment !== undefined) {
    throw new Error('Commit plan retained a generic provisional update for a verified attachment');
  }
  const unresolvedReactivation = input.plan.managerDecisionCommands.find((command) => {
    if (command.operation !== 'observe_conflict') {
      return false;
    }
    const conflictId = command.changes.conflicts[0]?.id;
    return conflictId !== undefined
      && input.recoveryLedger.conflicts.some((conflict) => (
        conflict.id === conflictId && conflict.status === 'resolved'
      ));
  });
  if (unresolvedReactivation !== undefined) {
    throw new Error('Commit plan retained observe_conflict for a resolved conflict reactivation');
  }
}

function dedicatedPlanProjection(
  plan: ReturnType<typeof reconcileCommitPlan>,
): { attachments: string[]; reactivations: string[] } {
  const attachments = plan.managerDecisionCommands.flatMap((command) => (
    command.operation === 'attach_raw_to_provisional'
    && command.authority.kind === 'verified_raw_provisional_identity'
      ? [`${command.authority.rawFindingId}\0${command.authority.targetFindingId}`]
      : []
  )).sort(compareBinaryStrings);
  const reactivations = plan.managerDecisionCommands.flatMap((command) => (
    command.operation === 'reactivate_conflict'
    && command.authority.kind === 'conflict_reactivation'
      ? [`${command.authority.conflictId}\0${command.authority.reactivationDigest}`]
      : []
  )).sort(compareBinaryStrings);
  return { attachments, reactivations };
}

function assertDedicatedPlanEquivalence(
  initial: ReturnType<typeof reconcileCommitPlan>,
  rebuilt: ReturnType<typeof reconcileCommitPlan>,
): void {
  const initialProjection = dedicatedPlanProjection(initial);
  const rebuiltProjection = dedicatedPlanProjection(rebuilt);
  if (JSON.stringify(initialProjection) !== JSON.stringify(rebuiltProjection)) {
    throw new Error('Reconstructed commit plan changed its dedicated attachment or reactivation operations');
  }
}

export function applyDedicatedCommitPlanOperations(input: {
  recoveryLedger: FindingLedger;
  plan: ReturnType<typeof reconcileCommitPlan>;
  landings: readonly PreparedProvisionalTargetLanding[];
  intake: ReviewerIntakeResult;
  observation: FindingObservation;
  scopeIdentity: string;
}): ReturnType<typeof reconcileCommitPlan> {
  let plan = upgradeResolvedConflictReactivations({
    recoveryLedger: input.recoveryLedger,
    plan: input.plan,
    observation: input.observation,
  });
  plan = applyPreparedProvisionalAttachments({
    recoveryLedger: input.recoveryLedger,
    plan,
    landings: input.landings,
    intake: input.intake,
    observation: input.observation,
    scopeIdentity: input.scopeIdentity,
  });
  assertDedicatedPlanTransformations({
    recoveryLedger: input.recoveryLedger,
    plan,
    landings: input.landings,
  });
  return plan;
}

function upgradeResolvedConflictReactivations(input: {
  recoveryLedger: FindingLedger;
  plan: ReturnType<typeof reconcileCommitPlan>;
  observation: FindingObservation;
}): ReturnType<typeof reconcileCommitPlan> {
  const reactivatedConflictIds = new Set(input.plan.managerDecisionCommands.flatMap((command) => {
    if (command.operation !== 'observe_conflict') return [];
    const conflictId = command.changes.conflicts[0]?.id;
    const before = conflictId === undefined
      ? undefined
      : input.recoveryLedger.conflicts.find((conflict) => conflict.id === conflictId);
    return before?.status === 'resolved' ? [conflictId] : [];
  }));
  if (reactivatedConflictIds.size === 0) {
    return input.plan;
  }
  const simulated = landUnownedConflictRawClaims({
    ledger: input.plan.managerDecisionLedger,
    observation: input.observation,
  });
  return {
    ...input.plan,
    managerDecisionCommands: input.plan.managerDecisionCommands.map((command) => {
      const conflictId = command.changes.conflicts[0]?.id;
      if (
        command.operation !== 'observe_conflict'
        || conflictId === undefined
        || !reactivatedConflictIds.has(conflictId)
      ) {
        return command;
      }
      const before = input.recoveryLedger.conflicts.find(
        (conflict) => conflict.id === conflictId,
      )!;
      const expectedConflictHead = captureFindingLifecycleHead(
        input.recoveryLedger,
        'conflict',
        conflictId,
      );
      if (expectedConflictHead === undefined) {
        throw new Error(`Resolved conflict "${conflictId}" has no lifecycle head`);
      }
      const newRawFindingIds = command.changes.conflicts[0]!.rawFindingIds.filter(
        (rawFindingId) => !before.rawFindingIds.includes(rawFindingId),
      );
      const rawClaims = newRawFindingIds.map((rawFindingId) => {
        const landing = simulated.conflictRawClaimLandings.find((candidate) => (
          candidate.conflictId === conflictId && candidate.rawFindingId === rawFindingId
        ));
        if (landing === undefined) {
          throw new Error(`Reactivated conflict raw "${rawFindingId}" has no planned holding landing`);
        }
        return {
          rawFindingId,
          rawCanonicalSnapshotId: landing.rawCanonicalSnapshotId,
          rawPayloadDigest: landing.rawPayloadDigest,
          claimSnapshotDigest: landing.claimSnapshotDigest,
          rawClaimLandingId: landing.rawClaimLandingId,
          holdingAllocationId: landing.holdingAllocationId,
          holdingFindingId: landing.holdingFindingId,
        };
      });
      const firstRawClaim = rawClaims[0];
      if (firstRawClaim === undefined) {
        throw new Error(`Reactivated conflict "${conflictId}" has no new raw claims`);
      }
      const newRawClaims: [typeof firstRawClaim, ...(typeof rawClaims)] = [
        firstRawClaim,
        ...rawClaims.slice(1),
      ];
      return {
        ...command,
        operation: 'reactivate_conflict',
        authority: {
          kind: 'conflict_reactivation',
          conflictId,
          expectedConflictHead,
          newRawClaims,
          reactivationDigest: computeConflictReactivationDigest({
            conflictId,
            expectedConflictHead,
            newRawClaims,
          }),
        },
        evidenceSourcesByTarget: new Map(),
      };
    }),
  };
}

function planManagerEntryIsolation(
  output: FindingManagerOutput,
  staleRecoveryRawFindingIds: ReadonlySet<string>,
  intake: ReviewerIntakeResult,
): ManagerEntryIsolationPlan {
  const entries = [
    ...output.matches,
    ...output.newFindings,
    ...output.resolvedFindings,
    ...output.reopenedFindings,
    ...output.conflicts,
  ];
  const droppedRawFindingIds = new Set(entries
    .filter((entry) => containsIsolatedRawFinding(
      entry.rawFindingIds,
      staleRecoveryRawFindingIds,
    ))
    .flatMap((entry) => entry.rawFindingIds));
  const intakeByRawFindingId = new Map(
    intake.items.map((item) => [item.wire.rawFindingId, item]),
  );
  const provisionalSpecs = [...droppedRawFindingIds].flatMap((rawFindingId) => {
    if (staleRecoveryRawFindingIds.has(rawFindingId)) {
      return [];
    }
    const item = intakeByRawFindingId.get(rawFindingId);
    if (item === undefined) {
      throw new Error(
        `Raw finding "${rawFindingId}" from a dropped mixed manager entry is missing from manager intake`,
      );
    }
    return [provisionalSpecForRawKind({
      wire: item.wire,
      canonical: item.canonical,
      reason: 'The mixed manager entry also referenced a stale recovery raw, so the complete entry was discarded atomically and this fresh observation was isolated for adjudication',
    }, 'raw-adjudication-unresolved')];
  });
  return { droppedRawFindingIds, provisionalSpecs };
}

function prepareCommitReconciliation(
  params: FindingManagerCommitPlanInput,
  freshLedger: FindingLedger,
  interpretationPrepared: PreparedInterpretationCasePlan,
  isolatedRawFindingIds: ReadonlySet<string>,
) {
  const evaluatedAdmission = evaluateRawAdmission({
    cwd: params.input.cwd,
    reviewScopeSnapshotId: params.reviewScopeSnapshotId,
    runId: params.input.ledgerStore.runId,
    scopeIdentity: params.input.ledgerStore.ledgerIdentity,
    previousLedger: freshLedger,
    intake: params.intake,
    reviewScopeSnapshot: params.reviewScopeSnapshot,
    workflowTask: params.input.workflowTask,
    presentationLimit: params.reviewIntegrityLimits.maxReviewRounds,
    restatementRequests: collectRestatementRequests(params.input.subResults.map(({ publication }) => publication)),
  });
  const retainItem = (item: { wire: { rawFindingId: string } }): boolean => (
    !isolatedRawFindingIds.has(item.wire.rawFindingId)
  );
  const retainSpec = (spec: { sourceRawFindingIds: readonly string[] }): boolean => (
    !containsIsolatedRawFinding(spec.sourceRawFindingIds, isolatedRawFindingIds)
  );
  const intakeItemByRawFindingId = new Map(
    params.intake.items.map((item) => [item.wire.rawFindingId, item]),
  );
  const intakeContractEntityRawFindingIds = new Set(
    [...params.intake.entityBindings.entries()].flatMap(([rawFindingId, binding]) => (
      binding.kind === 'entity_group'
        && (binding.decision === 'new_entity' || binding.decision === 'ambiguous')
        && intakeItemByRawFindingId.get(rawFindingId)?.wire.evidence.length === 0
        ? binding.groupRawFindingIds
        : []
    )),
  );
  const admission: RawAdmissionEvaluation = {
    admissionRejections: evaluatedAdmission.admissionRejections.filter(
      (rejection) => !isolatedRawFindingIds.has(rejection.rawFindingId),
    ),
    admissionAnomalySpecs: evaluatedAdmission.admissionAnomalySpecs.filter(retainSpec),
    admissionProvisionalSpecs: evaluatedAdmission.admissionProvisionalSpecs.filter(retainSpec),
    preAdmissionEntityMutations: evaluatedAdmission.preAdmissionEntityMutations.filter(
      (mutation) => retainSpec(mutation)
        && !mutation.sourceRawFindingIds.some((rawFindingId) => (
          intakeContractEntityRawFindingIds.has(rawFindingId)
        )),
    ),
    admissionRejectedItems: evaluatedAdmission.admissionRejectedItems.filter(retainItem),
    pendingRejectedObservations: evaluatedAdmission.pendingRejectedObservations.filter(
      ({ item }) => retainItem(item),
    ),
    cleanAdmitted: evaluatedAdmission.cleanAdmitted.filter(retainItem),
    tainted: evaluatedAdmission.tainted.filter(retainItem),
    taintedAdmitted: evaluatedAdmission.taintedAdmitted.filter(retainItem),
    ladderAnomalySpecs: evaluatedAdmission.ladderAnomalySpecs.filter(retainSpec),
    verifiedEvidenceCandidates: evaluatedAdmission.verifiedEvidenceCandidates.filter(
      (candidate) => !isolatedRawFindingIds.has(candidate.rawFindingId),
    ),
    provisionalOnlyLadderRawIds: new Set(
      [...evaluatedAdmission.provisionalOnlyLadderRawIds].filter(
        (rawFindingId) => !isolatedRawFindingIds.has(rawFindingId),
      ),
    ),
    cleanWire: evaluatedAdmission.cleanWire.filter(
      (wire) => !isolatedRawFindingIds.has(wire.rawFindingId),
    ),
    verifiedEvidenceRecordsByRawFindingId: new Map(
      [...evaluatedAdmission.verifiedEvidenceRecordsByRawFindingId].filter(
        ([rawFindingId]) => !isolatedRawFindingIds.has(rawFindingId),
      ),
    ),
  };
  const freshAdmittedItems = [...admission.cleanAdmitted, ...admission.taintedAdmitted];
  const freshAdmittedRawIds = new Set(freshAdmittedItems.map((item) => item.wire.rawFindingId));
  const provisionalTargetLandings = prepareProvisionalTargetLandings({
    ledger: freshLedger,
    candidates: params.managerDecision.provisionalTargetConflicts ?? [],
    intake: params.intake,
    retainedRawFindingIds: freshAdmittedRawIds,
  });
  const provisionalTargetProductOutput = freshProductTargetConflictOutput({
    ledger: freshLedger,
    candidates: params.managerDecision.provisionalTargetConflicts ?? [],
    intake: params.intake,
    retainedRawFindingIds: freshAdmittedRawIds,
  });
  const pendingRejectedRawFindingIds = new Set(
    admission.pendingRejectedObservations.map(({ item }) => item.wire.rawFindingId),
  );
  const reconcileRawFindings = [
    ...admission.cleanWire,
    ...admission.admissionRejectedItems
      .filter((item) => !pendingRejectedRawFindingIds.has(item.wire.rawFindingId))
      .map((item) => item.wire),
    ...admission.taintedAdmitted
      .map((item) => item.wire),
    ...params.intake.items
      .filter((item) => (
        params.intake.overflowRawFindingIds.has(item.canonical.rawFindingId)
        && !isolatedRawFindingIds.has(item.canonical.rawFindingId)
      ))
      .map((item) => item.wire),
  ];
  const rawProvenanceByRawFindingId = new Map<string, CanonicalRawReconcileProvenance>(
    params.intake.items.flatMap((item) => (
      isolatedRawFindingIds.has(item.canonical.rawFindingId)
        ? []
        : [[item.canonical.rawFindingId, {
            reviewerStableKey: item.canonical.reviewerStableKey,
            lineageKey: item.canonical.lineageKey,
            claimIdentityHash: item.canonical.claimIdentityHash,
            canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(item.canonical),
            canonicalProvenance: item.canonical.provenance,
          }] as const]
    )),
  );
  const baseSpecs: ProvisionalFindingSpec[] = [
    ...params.intake.intakeProvisionalSpecs.filter(retainSpec),
    ...admission.admissionProvisionalSpecs.filter(retainSpec),
    ...params.managerDecision.cleanProvisionalSpecs.filter((spec) => (
      retainSpec(spec)
      && spec.sourceRawFindingIds.every((rawFindingId) => freshAdmittedRawIds.has(rawFindingId))
    )),
    ...interpretationPrepared.provisionalFindings.filter((spec) => (
      retainSpec(spec)
      && spec.sourceRawFindingIds.every((rawFindingId) => freshAdmittedRawIds.has(rawFindingId))
    )),
    ...groupProvisionalTargetLandingSpecs(provisionalTargetLandings),
  ];
  return {
    admission,
    reconcileRawFindings,
    rawProvenanceByRawFindingId,
    baseSpecs,
    provisionalTargetLandings,
    provisionalTargetProductOutput,
    cleanWireById: new Map(
      admission.cleanAdmitted.map((item) => [item.wire.rawFindingId, item.wire]),
    ),
    cleanCanonicalById: new Map(
      admission.cleanAdmitted.map((item) => [item.canonical.rawFindingId, item.canonical]),
    ),
    capturedPreconditions: captureFindingPreconditions(params.previousLedger),
    anomalySpecs: [
      ...params.intake.intakeAnomalySpecs,
      ...admission.admissionAnomalySpecs,
      ...admission.ladderAnomalySpecs,
    ],
    invalidInterpretationRawFindingIds: new Set([
      ...admission.admissionAnomalySpecs,
      ...admission.ladderAnomalySpecs,
    ].flatMap((spec) => spec.sourceRawFindingIds)),
  };
}

function interpretationManagerOutput(
  prepared: PreparedInterpretationCasePlan,
  items: readonly ReviewerIntakeResult['items'][number][],
): FindingManagerOutput {
  const rawFindingsById = new Map(items.map((item) => [item.wire.rawFindingId, item.wire]));
  const adjudicate = (input: {
    rawFindingId: string;
    decision: 'same' | 'new' | 'conflict';
    findingId?: string;
    evidence: string;
  }) => {
    const rawFinding = rawFindingsById.get(input.rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(`Interpretation output is missing raw finding "${input.rawFindingId}"`);
    }
    if (rawFinding.target.kind === 'absence') {
      throw new Error(
        `Absence raw finding "${input.rawFindingId}" cannot land without explicit anchor relevance`,
      );
    }
    return createAnchorAdjudication({
      rawFindingId: input.rawFindingId,
      decision: input.decision,
      anchorRelevance: 'not_applicable',
      ...(input.findingId === undefined ? {} : { findingId: input.findingId }),
      evidence: input.evidence,
    });
  };
  return {
    ...prepared.managerOutput,
    anchorAdjudications: [
      ...prepared.managerOutput.matches.flatMap((match) => (
        match.rawFindingIds.map((rawFindingId) => adjudicate({
          rawFindingId,
          decision: 'same',
          findingId: match.findingId,
          evidence: match.evidence ?? 'Engine-issued interpretation-case SameProof.',
        }))
      )),
      ...prepared.managerOutput.newFindings.flatMap((finding) => (
        finding.rawFindingIds.map((rawFindingId) => adjudicate({
          rawFindingId,
          decision: 'new',
          evidence: 'Interpretation case created one independent product finding.',
        }))
      )),
      ...prepared.managerOutput.conflicts.flatMap((conflict) => {
        const findingId = conflict.findingIds[0];
        if (findingId === undefined || conflict.findingIds.length !== 1) {
          throw new Error('Interpretation case conflict must reference exactly one product finding');
        }
        return conflict.rawFindingIds.map((rawFindingId) => adjudicate({
          rawFindingId,
          decision: 'conflict',
          findingId,
          evidence: conflict.description,
        }));
      }),
    ],
  };
}

function completeReconciledRawSnapshots(input: {
  plan: ReturnType<typeof reconcileCommitPlan>;
  items: readonly ReviewerIntakeResult['items'][number][];
  observation: FindingObservation;
}): ReturnType<typeof reconcileCommitPlan> {
  const completeLedger = (ledger: FindingLedger): FindingLedger => {
    const storedRawFindingIds = new Set(
      ledger.rawFindings.map((raw) => raw.rawFindingId),
    );
    return appendRawFindingsWithCanonicalSnapshots({
      ledger,
      items: input.items.filter(
        (item) => storedRawFindingIds.has(item.wire.rawFindingId),
      ),
      capturedAt: input.observation,
    });
  };
  return {
    ...input.plan,
    ledger: completeLedger(input.plan.ledger),
    managerDecisionLedger: completeLedger(input.plan.managerDecisionLedger),
  };
}

export function buildFindingManagerCommitMutation(
  params: FindingManagerCommitPlanInput,
  freshLedger: FindingLedger,
): FindingLedgerMutation<CommitMutationResult> {
  if (freshLedger.stopBudget?.roundMarkers.includes(params.stopBudgetRoundMarker) === true) {
    return {
      ledger: freshLedger,
      result: {
        applied: false,
        managerDecisionLedger: freshLedger,
        managerDecisionCommands: [],
        lifecycleManagerOutput: params.managerDecision.managerOutput,
        staleRejections: [],
        unsupportedRawFindingReports: [],
        admissionRejections: [],
        provisionalLandings: [],
        reviewerAnomalyLandings: [],
        interpretationRecoverySettlements: [],
        resolutionRenotifications: [],
        rejectedObservationAttachments: [],
        settlementCommands: [],
        actionRecoveryPlan: null,
        interpretationPrepared: {
          cases: [],
          managerOutput: createEmptyManagerOutput(),
          provisionalFindings: [],
        },
      },
    };
  }
  const recoveryLedger = freshLedger;
  let interpretationPrepared = prepareInterpretationCaseActions({
    ledger: recoveryLedger,
    items: params.managerDecision.interpretation.items,
    completedAttemptIds:
      params.managerDecision.interpretation.completedAttemptIdsForCommit,
    directPlans: params.managerDecision.interpretation.directPlans,
    proofFastPathPlans: params.managerDecision.interpretation.proofFastPathPlans,
    provisionalOnlyRawFindingIds:
      params.managerDecision.interpretation.provisionalOnlyRawFindingIds,
  });
  const staleRecoveryRawFindingIds = new Set<string>();
  const managerEntryIsolation = planManagerEntryIsolation(
    params.managerDecision.managerOutput,
    staleRecoveryRawFindingIds,
    params.intake,
  );
  let prepared = prepareCommitReconciliation(
    params,
    recoveryLedger,
    interpretationPrepared,
    staleRecoveryRawFindingIds,
  );
  if (prepared.invalidInterpretationRawFindingIds.size > 0) {
    interpretationPrepared = prepareInterpretationCaseActions({
      ledger: recoveryLedger,
      items: params.managerDecision.interpretation.items,
      completedAttemptIds: params.managerDecision.interpretation.completedAttemptIdsForCommit,
      directPlans: params.managerDecision.interpretation.directPlans,
      proofFastPathPlans: params.managerDecision.interpretation.proofFastPathPlans,
      provisionalOnlyRawFindingIds: params.managerDecision.interpretation.provisionalOnlyRawFindingIds,
      invalidRawFindingIds: prepared.invalidInterpretationRawFindingIds,
    });
    prepared = prepareCommitReconciliation(
      params,
      recoveryLedger,
      interpretationPrepared,
      staleRecoveryRawFindingIds,
    );
  }
  const roundsCompleted = stopBudgetRoundsCompleted(freshLedger);
  const actionRecoveryCandidates = collectManagerActionRecoveryCandidates(
    recoveryLedger,
    roundsCompleted,
  );
  const { input, managerDecision } = params;
  const { managerOutput } = managerDecision;
  const { admission } = prepared;
  const isolatedManagerOutput = isolateManagerOutputForCommit(
    managerOutput,
    managerEntryIsolation.droppedRawFindingIds,
  );
  const freshReviewScopeSnapshotId = isolatedManagerOutput.resolvedConflicts.length === 0
    ? params.reviewScopeSnapshotId
    : captureReviewScopeSnapshot(input.cwd).reviewScopeSnapshotId;

  const revalidated = revalidateManagerPlan({
    managerOutput: isolatedManagerOutput,
    freshLedger: recoveryLedger,
    cleanWire: admission.cleanWire,
    cleanWireById: prepared.cleanWireById,
    cleanCanonicalById: prepared.cleanCanonicalById,
    capturedPreconditions: prepared.capturedPreconditions,
    capturedConflictHeads: managerDecision.conflictTargetHeads,
    reviewScopeSnapshotId: freshReviewScopeSnapshotId,
    runInput: input,
  });
  const staleRejections = [...revalidated.staleRejections];
  const output = revalidated.output;

  const specs = [
    ...prepared.baseSpecs,
    ...revalidated.provisionalSpecs,
    ...managerEntryIsolation.provisionalSpecs,
  ].filter((spec) => !containsIsolatedRawFinding(
    spec.sourceRawFindingIds,
    staleRecoveryRawFindingIds,
  ));
  let merged = isolateManagerOutputForCommit(
    mergeOutputs(
      mergeOutputs(output, prepared.provisionalTargetProductOutput),
      interpretationManagerOutput(
        interpretationPrepared,
        params.managerDecision.interpretation.items,
      ),
    ),
    managerEntryIsolation.droppedRawFindingIds,
  );
  const conflictAuthorityByRawFindingId = new Map(
    interpretationPrepared.cases.flatMap((preparedCase) => {
      if (preparedCase.action.kind !== 'open_product_conflict') {
        return [];
      }
      const authority = issueInterpretationCaseConflictAuthority({
        ledger: recoveryLedger,
        preparedCase,
        items: params.managerDecision.interpretation.items,
      });
      return preparedCase.rawFindingIds.map((rawFindingId) => [rawFindingId, authority] as const);
    }),
  );
  const rawProvenanceByRawFindingId = new Map(
    [...prepared.rawProvenanceByRawFindingId].map(([rawFindingId, provenance]) => {
      const authority = conflictAuthorityByRawFindingId.get(rawFindingId);
      return [
        rawFindingId,
        authority === undefined
          ? provenance
          : { ...provenance, interpretationCaseConflictAuthority: authority },
      ] as const;
    }),
  );
  const reconcileInput = {
    runInput: input,
    freshLedger: recoveryLedger,
    rawFindings: prepared.reconcileRawFindings,
    managerOutput: merged,
    provisionalSpecs: specs,
    entityProvisionalMutations: admission.preAdmissionEntityMutations,
    anomalySpecs: prepared.anomalySpecs,
    rawProvenanceByRawFindingId,
    cleanWire: admission.cleanWire,
    explicitResolvedByMapping: new Map<string, string>(),
    explicitPromotedFindingIds: new Set<string>(),
    recoveryProvisionalRawFindingIds: new Set<string>(),
    staleRawFindingIds: staleRecoveryRawFindingIds,
    deferredRawFindingIds: new Set<string>(),
    resolutionRenotifications: revalidated.resolutionRenotifications,
    unsupportedRawFindingReports: [
      ...managerDecision.unsupportedRawFindingReports,
      ...revalidated.unsupportedRawFindingReports,
    ],
    healthyReviewerStableKeys: params.intake.healthyReviewerStableKeys,
    verifiedEvidenceRecordsByRawFindingId: admission.verifiedEvidenceRecordsByRawFindingId,
  };
  const interpretationProvisionalTargetLandings = interpretationPrepared.cases.flatMap(
    (preparedCase): PreparedProvisionalTargetLanding[] => {
      if (preparedCase.action.kind !== 'land_provisional_target') {
        return [];
      }
      const action = preparedCase.action;
      return action.provisionalFindings.map((spec) => {
        const rawFindingId = spec.sourceRawFindingIds[0];
        if (rawFindingId === undefined || spec.sourceRawFindingIds.length !== 1) {
          throw new Error('Interpretation provisional target landing must own exactly one raw finding');
        }
        if (spec.reason !== 'attach_exact' && spec.reason !== 'identity_unproven') {
          throw new Error(
            `Interpretation provisional target landing for raw "${rawFindingId}" has invalid reason "${spec.reason}"`,
          );
        }
        const mode = spec.reason;
        const destinationFindingId = mode === 'attach_exact'
          ? action.rejectedConflictTargetFindingId
          : findIndependentProvisionalDestination({
              ledger: recoveryLedger,
              stableKey: spec.stableKey,
            })?.finding.id ?? null;
        return {
          candidate: {
            rawFindingId,
            targetFindingId: action.rejectedConflictTargetFindingId,
            evidence: spec.reason,
          },
          mode,
          destinationFindingId,
          spec,
          interpretationCaseId: preparedCase.caseId,
        };
      });
    },
  );
  const provisionalTargetLandings = [
    ...prepared.provisionalTargetLandings,
    ...interpretationProvisionalTargetLandings,
  ];
  const buildReconcilePlan = (
    managerOutput: FindingManagerOutput,
  ): ReturnType<typeof reconcileCommitPlan> => {
    let plan = completeReconciledRawSnapshots({
      plan: reconcileCommitPlan({ ...reconcileInput, managerOutput }),
      items: params.intake.items,
      observation: params.observation,
    });
    plan = applyDedicatedCommitPlanOperations({
      recoveryLedger,
      plan,
      landings: provisionalTargetLandings,
      intake: params.intake,
      observation: params.observation,
      scopeIdentity: input.ledgerStore.ledgerIdentity,
    });
    return plan;
  };
  let reconcilePlan = buildReconcilePlan(merged);
  const initialReconcilePlan = reconcilePlan;
  const noActionRecoveryPlan = (ledger: FindingLedger): ManagerActionRecoveryLifecyclePlan => ({
    ledger,
    output: createEmptyManagerOutput(),
    appliedLedger: ledger,
    settledLedger: ledger,
    settlements: new Map(),
    failures: new Map(),
  });
  const buildActionRecoveryPlan = (
    ledger: FindingLedger,
  ): ManagerActionRecoveryLifecyclePlan => planManagerActionRecovery({
    ledger,
    candidates: actionRecoveryCandidates,
    cwd: input.cwd,
    context: {
      workflowName: input.workflowName,
      stepName: input.parentStep.name,
      runId: input.runId,
      timestamp: input.timestamp,
    },
    observation: params.observation,
  });
  const shouldBuildActionRecoveryPlan = interpretationPrepared.cases.length === 0
    && actionRecoveryCandidates.length > 0;
  let actionRecoveryPlan = shouldBuildActionRecoveryPlan
    ? buildActionRecoveryPlan(reconcilePlan.ledger)
    : noActionRecoveryPlan(reconcilePlan.ledger);
  const prospectiveStaleConflictIds = prospectiveStaleConflictResolutions({
    recoveryLedger,
    prospectiveLedger: actionRecoveryPlan.ledger,
    resolvedConflicts: merged.resolvedConflicts,
    capturedConflictHeads: managerDecision.conflictTargetHeads,
    reviewScopeSnapshotId: freshReviewScopeSnapshotId,
  });
  if (prospectiveStaleConflictIds.size > 0) {
    merged = {
      ...merged,
      resolvedConflicts: merged.resolvedConflicts.filter(
        (resolved) => !prospectiveStaleConflictIds.has(resolved.conflictId),
      ),
    };
    staleRejections.push(...[...prospectiveStaleConflictIds]
      .sort(compareBinaryStrings)
      .map((conflictId) => (
        `conflictDecisions: conflict "${conflictId}" (resolve) rejected at commit: the same plan changes its adjudication evidence dependencies`
      )));
    const rebuiltReconcilePlan = buildReconcilePlan(merged);
    assertDedicatedPlanEquivalence(initialReconcilePlan, rebuiltReconcilePlan);
    reconcilePlan = rebuiltReconcilePlan;
    actionRecoveryPlan = shouldBuildActionRecoveryPlan
      ? buildActionRecoveryPlan(reconcilePlan.ledger)
      : noActionRecoveryPlan(reconcilePlan.ledger);
  }
  // 監査レポートには実際に着地した spec だけを載せる（dismiss と同一ラウンドで
  // 抑止された同一 claim の spec は着地していない — reconcileCommitPlan 参照）。
  const provisionalLandings = [
    ...reconcilePlan.landedSpecs.map((spec): ProvisionalLandingReport => ({
      kind: spec.kind,
      stableKey: spec.stableKey,
      reason: spec.reason,
      sourceRawFindingIds: spec.sourceRawFindingIds,
    })),
    ...reconcilePlan.entityMutationResults.flatMap((result): ProvisionalLandingReport[] => {
      if (result.outcome === 'terminal_audit') {
        return [];
      }
      const finding = reconcilePlan.ledger.findings.find(
        (entry) => entry.id === result.findingId,
      );
      return finding?.status === 'open' && finding.provisional !== undefined
        ? [{
            kind: finding.provisional.kind,
            stableKey: finding.provisional.stableKey,
            reason: result.mutation.reason,
            sourceRawFindingIds: result.mutation.sourceRawFindingIds,
          }]
        : [];
    }),
  ];

  const stagedManagerDecisionLedger = stagePreparedInterpretationCaseOwnership({
    ledger: reconcilePlan.managerDecisionLedger,
    prepared: interpretationPrepared,
    items: params.managerDecision.interpretation.items,
    observation: params.observation,
  });
  const stagedSettledLedger = stagePreparedInterpretationCaseOwnership({
    ledger: actionRecoveryPlan.ledger,
    prepared: interpretationPrepared,
    items: params.managerDecision.interpretation.items,
    observation: params.observation,
  });
  const finalized = applyCommitLedgerStates({
    runInput: input,
    freshLedger,
    settledLedger: stagedSettledLedger,
    baseAnomalySpecs: prepared.anomalySpecs,
    pendingRejectedObservations: admission.pendingRejectedObservations,
    verifiedEvidenceCandidates: admission.verifiedEvidenceCandidates,
  });
  const finalizedLedger = appendRawFindingsWithCanonicalSnapshots({
    ledger: finalized.ledger,
    items: admission.pendingRejectedObservations.map(({ item }) => item),
    capturedAt: params.observation,
  });
  const interpretationRecoverySettlements: InterpretationRecoveryOriginSettlement[] = [];
  return {
    ledger: finalizedLedger,
    result: {
      applied: true,
      managerDecisionLedger: stagedManagerDecisionLedger,
      managerDecisionCommands: attachInterpretationCaseOrigins(attachCapturedConflictHeads({
        commands: reconcilePlan.managerDecisionCommands,
        resolvedConflictIds: new Set(
          reconcilePlan.managerOutput.resolvedConflicts.map(
            (conflict) => conflict.conflictId,
          ),
        ),
        capturedConflictHeads: managerDecision.conflictTargetHeads,
        cwd: input.cwd,
      }), interpretationPrepared),
      lifecycleManagerOutput: reconcilePlan.managerOutput,
      staleRejections: [...staleRejections, ...reconcilePlan.normalizationRejections],
      unsupportedRawFindingReports: revalidated.unsupportedRawFindingReports,
      admissionRejections: admission.admissionRejections,
      provisionalLandings,
      reviewerAnomalyLandings: finalized.reviewerAnomalyLandings,
      interpretationRecoverySettlements,
      resolutionRenotifications: revalidated.resolutionRenotifications,
      rejectedObservationAttachments: [
        ...reconcilePlan.rejectedObservationAttachments,
        ...finalized.rejectedObservationAttachments,
      ],
      settlementCommands: attachInterpretationCaseOrigins(
        reconcilePlan.settlementCommands,
        interpretationPrepared,
      ),
      actionRecoveryPlan,
      interpretationPrepared,
    },
  };
}
