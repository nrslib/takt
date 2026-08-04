import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  computeConflictClaimSettlementId,
} from '../../models/finding-contract-identity.js';
import type {
  ConflictAdjudicationAttempt,
  ConflictClaimSettlement,
  ResolvedConflictAdjudicationPlan,
} from '../../models/finding-contract-types.js';
import { createFindingLedgerEntry } from './finding-entry.js';
import {
  isConflictResolved,
  refreshActiveConflictAdjudicationSnapshots,
} from './conflict-adjudication-model.js';
import { applyFindingLifecycleCommands } from './lifecycle-transaction.js';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingObservation,
} from './types.js';

export type FindingConflictAdjudicationDisposition =
  | 'finding_closed'
  | 'actionable_fix'
  | 'unresolved';

export interface ApplyResolvedConflictAdjudicationResult {
  ledger: FindingLedger;
  disposition: FindingConflictAdjudicationDisposition;
  applied: boolean;
}

function withoutRevision<T extends { revision: number }>(value: T): Omit<T, 'revision'> {
  const { revision: _revision, ...projection } = value;
  void _revision;
  return projection;
}

function requiredFinding(ledger: FindingLedger, findingId: string): FindingLedgerEntry {
  const finding = ledger.findings.find((candidate) => candidate.id === findingId);
  if (finding === undefined) {
    throw new Error(`Conflict adjudication references unknown finding "${findingId}"`);
  }
  return finding;
}

function requiredConflict(ledger: FindingLedger, conflictId: string): FindingLedgerConflict {
  const conflict = ledger.conflicts.find((candidate) => candidate.id === conflictId);
  if (conflict === undefined || conflict.status !== 'active') {
    throw new Error(`Conflict adjudication references inactive conflict "${conflictId}"`);
  }
  return conflict;
}

function appendActionableFix(existing: string | undefined, actionableFix: string | null): string | undefined {
  if (actionableFix === null) {
    return existing;
  }
  const annotation = `[adjudicated fix] ${actionableFix}`;
  return existing === undefined || existing.length === 0
    ? annotation
    : `${existing}\n${annotation}`;
}

function mergeHoldingProjection(input: {
  ledger: FindingLedger;
  authority: Extract<ResolvedConflictAdjudicationPlan, { kind: 'merge_holding' }>['authority'];
  actionableFix: string | null;
  observation: FindingObservation;
}): FindingLedgerEntry[] {
  const holding = requiredFinding(input.ledger, input.authority.holdingFindingId);
  const target = requiredFinding(input.ledger, input.authority.targetFindingId);
  const mergedRawFindingIds = [...new Set([...target.rawFindingIds, ...holding.rawFindingIds])]
    .sort(compareBinaryStrings);
  const mergedEvidenceIds = [...new Set([...target.evidenceIds, ...holding.evidenceIds])]
    .sort(compareBinaryStrings);
  const mergedReviewers = [...new Set([...target.reviewers, ...holding.reviewers])]
    .sort(compareBinaryStrings);
  return [
    createFindingLedgerEntry({
      ...holding,
      status: 'superseded',
      lifecycle: 'superseded',
      supersededByFindingId: target.id,
    }),
    createFindingLedgerEntry({
      ...target,
      rawFindingIds: mergedRawFindingIds,
      evidenceIds: mergedEvidenceIds,
      reviewers: mergedReviewers,
      suggestion: appendActionableFix(target.suggestion, input.actionableFix),
      lastSeen: structuredClone(input.observation),
    }),
  ];
}

function promoteHoldingProjection(input: {
  ledger: FindingLedger;
  authority: Extract<ResolvedConflictAdjudicationPlan, { kind: 'promote_holding' }>['authority'];
  actionableFix: string | null;
  observation: FindingObservation;
}): FindingLedgerEntry {
  const holding = requiredFinding(input.ledger, input.authority.holdingFindingId);
  const { provisional: _provisional, ...durableHolding } = holding;
  void _provisional;
  const product = input.authority.productProjection;
  return createFindingLedgerEntry({
    ...durableHolding,
    status: 'open',
    lifecycle: 'persists',
    target: structuredClone(product.target),
    targetIdentityHash: product.targetIdentityHash,
    claimIdentityHash: product.claimIdentityHash,
    semanticClaimIdentityHash: product.semanticClaimIdentityHash,
    severity: product.severity,
    title: product.title,
    description: product.description,
    suggestion: appendActionableFix(product.suggestion ?? undefined, input.actionableFix),
    evidenceIds: [...new Set([...holding.evidenceIds, ...product.evidenceRecordIds])]
      .sort(compareBinaryStrings),
    lastSeen: structuredClone(input.observation),
  });
}

function terminateSubjectProjection(input: {
  ledger: FindingLedger;
  authority: Extract<ResolvedConflictAdjudicationPlan, { kind: 'terminate_subject' }>['authority'];
  observation: FindingObservation;
}): FindingLedgerEntry {
  const finding = requiredFinding(input.ledger, input.authority.findingId);
  return input.authority.basis === 'finding_no_issue_after_verification'
    ? createFindingLedgerEntry({
        ...finding,
        status: 'resolved',
        lifecycle: 'resolved',
        resolvedAt: input.observation.timestamp,
        resolvedEvidence: `Verified conflict adjudication ${input.authority.verificationDigest}`,
      })
    : createFindingLedgerEntry({
        ...finding,
        status: 'invalidated',
        lifecycle: 'invalidated',
        invalidatedAt: input.observation.timestamp,
        invalidatedEvidence: `Verified conflict adjudication ${input.authority.verificationDigest}`,
      });
}

function verificationUndetermined(input: {
  ledger: FindingLedger;
  attempt: Extract<ConflictAdjudicationAttempt, { stage: 'proposed' }>;
  plan: Extract<ResolvedConflictAdjudicationPlan, { kind: 'undetermined' }>;
  observation: FindingObservation;
}): FindingLedger {
  const {
    proposal: _proposal,
    proposalDigest: _proposalDigest,
    ...completedAttempt
  } = input.attempt;
  void _proposal;
  void _proposalDigest;
  return {
    ...input.ledger,
    conflictAdjudicationAttempts: input.ledger.conflictAdjudicationAttempts.map((attempt) => (
      attempt.attemptId !== input.attempt.attemptId
        ? attempt
        : {
            ...completedAttempt,
            stage: 'completed' as const,
            completedAt: structuredClone(input.attempt.completedAt),
            result: {
              kind: 'verification_undetermined' as const,
              proposal: structuredClone(input.attempt.proposal),
              proposalDigest: input.attempt.proposalDigest,
              reasonCodes: [...input.plan.reasonCodes],
            },
          }
    )),
    updatedAt: input.observation.timestamp,
  };
}

function settlementForPlan(input: {
  plan: Exclude<ResolvedConflictAdjudicationPlan, { kind: 'undetermined' }>;
  attempt: Extract<ConflictAdjudicationAttempt, { stage: 'proposed' }>;
  lifecycleEventIds: string[];
  observation: FindingObservation;
}): ConflictClaimSettlement {
  const authority = input.plan.authority;
  const base = {
    settlementId: computeConflictClaimSettlementId(
      input.attempt.conflictId,
      authority.kind === 'terminate_subject' ? authority.subjectId : authority.holdingSubjectId,
    ),
    conflictId: input.attempt.conflictId,
    conflictSnapshotId: authority.conflictSnapshotId,
    subjectId: authority.kind === 'terminate_subject' ? authority.subjectId : authority.holdingSubjectId,
    subjectRole: authority.kind === 'terminate_subject'
      ? authority.subjectRole
      : 'holding_provisional' as const,
    findingId: authority.kind === 'terminate_subject'
      ? authority.findingId
      : authority.holdingFindingId,
    expectedHead: structuredClone(
      authority.kind === 'terminate_subject'
        ? authority.subjectExpectedHead
        : authority.holdingExpectedHead,
    ),
    attemptId: input.attempt.attemptId,
    rawClaimLandingIds: [...authority.rawClaimLandingIds],
    lifecycleEventIds: input.lifecycleEventIds,
    verificationDigest: authority.verificationDigest,
    recordedAt: structuredClone(input.observation),
  };
  switch (input.plan.kind) {
    case 'merge_holding':
      return { ...base, outcome: 'merged', targetFindingId: input.plan.authority.targetFindingId };
    case 'promote_holding':
      return { ...base, outcome: 'promoted', targetFindingId: input.plan.authority.holdingFindingId };
    case 'terminate_subject':
      return input.plan.authority.basis === 'finding_no_issue_after_verification'
        ? { ...base, outcome: 'resolved' }
        : { ...base, outcome: 'invalidated' };
  }
}

function serializedAuthority(input: {
  attemptId: string;
  conflictId: string;
  plan: Exclude<ResolvedConflictAdjudicationPlan, { kind: 'undetermined' }>;
}) {
  return {
    kind: 'verified_conflict_adjudication' as const,
    conflictId: input.conflictId,
    conflictSnapshotId: input.plan.authority.conflictSnapshotId,
    attemptId: input.attemptId,
    verificationDigest: input.plan.authority.verificationDigest,
    proofRecordIds: [...input.plan.authority.proofRecordIds],
  };
}

export function applyResolvedConflictAdjudication(input: {
  ledger: FindingLedger;
  attemptId: string;
  plan: ResolvedConflictAdjudicationPlan;
  observation: FindingObservation;
}): ApplyResolvedConflictAdjudicationResult {
  const attempt = input.ledger.conflictAdjudicationAttempts.find(
    (candidate) => candidate.attemptId === input.attemptId,
  );
  if (attempt?.stage !== 'proposed') {
    throw new Error(`Conflict adjudication attempt "${input.attemptId}" is not proposed`);
  }
  if (input.plan.kind === 'undetermined') {
    return {
      ledger: verificationUndetermined({
        ledger: input.ledger,
        attempt,
        plan: input.plan,
        observation: input.observation,
      }),
      disposition: 'unresolved',
      applied: false,
    };
  }
  if (attempt.proposal.kind === 'undetermined') {
    throw new Error(`Conflict adjudication attempt "${input.attemptId}" has no applicable proposal`);
  }
  const resolvedPlan = input.plan;
  const appliedProposal = attempt.proposal;
  const conflict = requiredConflict(input.ledger, attempt.conflictId);
  const projectedFindings = input.plan.kind === 'merge_holding'
    ? mergeHoldingProjection({
        ledger: input.ledger,
        authority: input.plan.authority,
        actionableFix: input.plan.actionableFix,
        observation: input.observation,
      })
    : input.plan.kind === 'promote_holding'
      ? [promoteHoldingProjection({
          ledger: input.ledger,
          authority: input.plan.authority,
          actionableFix: input.plan.actionableFix,
          observation: input.observation,
        })]
      : [terminateSubjectProjection({
          ledger: input.ledger,
          authority: input.plan.authority,
          observation: input.observation,
        })];
  const authority = serializedAuthority({
    attemptId: attempt.attemptId,
    conflictId: conflict.id,
    plan: resolvedPlan,
  });
  const findings = projectedFindings.map((finding) => createFindingLedgerEntry({
    ...finding,
    evidenceIds: [...new Set([...finding.evidenceIds, ...authority.proofRecordIds])]
      .sort(compareBinaryStrings),
  }));
  const beforeEventCount = input.ledger.lifecycleEvents.length;
  const applied = applyFindingLifecycleCommands({
    ledger: input.ledger,
    commands: [{
      operation: 'apply_conflict_adjudication',
      changes: {
        findings: findings.map(withoutRevision),
        conflicts: [withoutRevision(conflict)],
      },
      authority,
      evidenceSourcesByTarget: new Map(findings.map((finding) => [
        `finding\0${finding.id}`,
        {
          sourceRawFindingIds: [],
          authorityEvidenceIds: authority.proofRecordIds,
        },
      ])),
    }],
    occurredAt: input.observation,
  });
  const lifecycleEventIds = applied.lifecycleEvents.slice(beforeEventCount)
    .map(({ eventId }) => eventId);
  const settlement = settlementForPlan({
    plan: input.plan,
    attempt,
    lifecycleEventIds,
    observation: input.observation,
  });
  let settled: FindingLedger = {
    ...applied,
    conflictClaimSettlements: [...applied.conflictClaimSettlements, settlement],
    conflictAdjudicationAttempts: applied.conflictAdjudicationAttempts.map((candidate) => (
      candidate.attemptId !== attempt.attemptId
        ? candidate
        : {
            ...attempt,
            stage: 'applied' as const,
            appliedAt: structuredClone(input.observation),
            proposal: appliedProposal,
            verificationDigest: resolvedPlan.authority.verificationDigest,
            claimSettlementIds: [settlement.settlementId],
            lifecycleEventIds,
          }
    )),
  };
  if (isConflictResolved(settled, conflict.id)) {
    const currentConflict = requiredConflict(settled, conflict.id);
    settled = applyFindingLifecycleCommands({
      ledger: settled,
      commands: [{
        operation: 'resolve_conflict',
        changes: {
          findings: [],
          conflicts: [withoutRevision({
            ...currentConflict,
            status: 'resolved',
            resolvedAt: input.observation.timestamp,
            resolvedEvidence: `Verified conflict settlement ${settlement.settlementId}`,
          })],
        },
        authority,
        evidenceSourcesByTarget: new Map(),
      }],
      occurredAt: input.observation,
    });
  } else {
    settled = refreshActiveConflictAdjudicationSnapshots({
      ledger: settled,
      originStep: attempt.originStep,
      createdAt: input.observation,
    });
  }
  return {
    ledger: settled,
    disposition: resolvedPlan.kind === 'terminate_subject'
      ? 'finding_closed'
      : resolvedPlan.actionableFix === null
        ? 'finding_closed'
        : 'actionable_fix',
    applied: true,
  };
}

export function selectConflictForAdjudication(
  ledger: FindingLedger,
  isUnadjudicated: (conflict: FindingLedgerConflict) => boolean,
): FindingLedgerConflict | undefined {
  return ledger.conflicts.find((conflict) => conflict.status === 'active' && isUnadjudicated(conflict));
}
