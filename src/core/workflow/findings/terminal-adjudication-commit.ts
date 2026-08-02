import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { computeTerminalSettlementId } from '../../models/finding-contract-identity.js';
import type {
  ResolvedTerminalAdjudicationPlan,
  TerminalAdjudicationSettlement,
} from '../../models/finding-contract-types.js';
import { createFindingLedgerEntry } from './finding-entry.js';
import { applyFindingLifecycleCommands } from './lifecycle-transaction.js';
import type { FindingLedger, FindingLedgerEntry, FindingObservation } from './types.js';

function withoutRevision<T extends { revision: number }>(value: T): Omit<T, 'revision'> {
  const { revision: _revision, ...rest } = value;
  void _revision;
  return rest;
}

function requiredFinding(ledger: FindingLedger, findingId: string): FindingLedgerEntry {
  const finding = ledger.findings.find((candidate) => candidate.id === findingId);
  if (finding === undefined) {
    throw new Error(`Terminal adjudication references unknown finding "${findingId}"`);
  }
  return finding;
}

export function applyResolvedTerminalAdjudication(input: {
  ledger: FindingLedger;
  attemptId: string;
  plan: ResolvedTerminalAdjudicationPlan;
  observation: FindingObservation;
}): { ledger: FindingLedger; applied: boolean } {
  const attempt = input.ledger.terminalAdjudicationAttempts.find(
    (candidate) => candidate.attemptId === input.attemptId,
  );
  if (attempt?.stage !== 'proposed') {
    throw new Error(`Terminal adjudication attempt "${input.attemptId}" is not proposed`);
  }
  if (input.plan.kind === 'undetermined') {
    const reasonCodes = [...input.plan.reasonCodes];
    return {
      ledger: {
        ...input.ledger,
        terminalAdjudicationAttempts: input.ledger.terminalAdjudicationAttempts.map((candidate) => (
          candidate.attemptId === attempt.attemptId
            ? {
                ...attempt,
                stage: 'completed' as const,
                result: {
                  kind: 'verification_undetermined' as const,
                  proposal: structuredClone(attempt.proposal),
                  proposalDigest: attempt.proposalDigest,
                  reasonCodes,
                },
              }
            : candidate
        )),
      },
      applied: false,
    };
  }
  if (attempt.proposal.kind === 'undetermined') {
    throw new Error(`Terminal adjudication attempt "${input.attemptId}" has no applicable proposal`);
  }
  const plan = input.plan;
  const proposal = attempt.proposal;
  const authority = plan.authority;
  const provisional = requiredFinding(input.ledger, authority.findingId);
  if (provisional.status !== 'open' || provisional.provisional === undefined) {
    throw new Error(`Terminal adjudication subject "${provisional.id}" is not open provisional`);
  }
  const proofRecordIds = [...authority.proofRecordIds].sort(compareBinaryStrings);
  const serializedAuthority = {
    kind: 'verified_terminal_adjudication' as const,
    episodeId: authority.episodeId,
    attemptId: attempt.attemptId,
    verificationDigest: authority.verificationDigest,
    proofRecordIds,
    scopeBindingIds: plan.kind === 'dismiss' ? [...plan.authority.scopeBindingIds] : [],
  };
  const rawIds = provisional.provisional.sourceRawFindingIds;
  let operation: 'promote_provisional' | 'supersede_findings' | 'dismiss_finding';
  let findings: FindingLedgerEntry[];
  if (plan.kind === 'promote_independent') {
    const { provisional: _metadata, ...durable } = provisional;
    void _metadata;
    const product = plan.authority.productProjection;
    operation = 'promote_provisional';
    findings = [createFindingLedgerEntry({
      ...durable,
      status: 'open',
      lifecycle: 'persists',
      target: structuredClone(product.target),
      targetIdentityHash: product.targetIdentityHash,
      claimIdentityHash: product.claimIdentityHash,
      semanticClaimIdentityHash: product.semanticClaimIdentityHash,
      severity: product.severity,
      title: product.title,
      description: product.description,
      ...(product.suggestion === null ? {} : { suggestion: product.suggestion }),
      evidenceIds: [...new Set([...provisional.evidenceIds, ...product.evidenceRecordIds, ...proofRecordIds])]
        .sort(compareBinaryStrings),
      lastSeen: structuredClone(input.observation),
    })];
  } else if (plan.kind === 'merge_existing') {
    const target = requiredFinding(input.ledger, plan.authority.targetFindingId);
    operation = 'supersede_findings';
    findings = [
      createFindingLedgerEntry({
        ...provisional,
        status: 'superseded',
        lifecycle: 'superseded',
        supersededByFindingId: target.id,
      }),
      createFindingLedgerEntry({
        ...target,
        rawFindingIds: [...new Set([...target.rawFindingIds, ...provisional.rawFindingIds])]
          .sort(compareBinaryStrings),
        evidenceIds: [...new Set([...target.evidenceIds, ...provisional.evidenceIds, ...proofRecordIds])]
          .sort(compareBinaryStrings),
        reviewers: [...new Set([...target.reviewers, ...provisional.reviewers])]
          .sort(compareBinaryStrings),
        lastSeen: structuredClone(input.observation),
      }),
    ];
  } else {
    operation = 'dismiss_finding';
    findings = [createFindingLedgerEntry({
      ...provisional,
      status: 'dismissed',
      lifecycle: 'dismissed',
      dismissal: {
        basis: plan.authority.basis,
        reason: proposal.rationale ?? `Verified terminal adjudication ${authority.verificationDigest}`,
        authority: 'terminal_adjudication',
        ...(plan.authority.basis === 'outside_task_scope' ? {
          taskQuote: plan.authority.taskQuote,
          workflowTaskDigest: plan.authority.workflowTaskDigest,
          adjudicationTaskId: plan.authority.adjudicationTaskId,
        } : {}),
        decidedAt: structuredClone(input.observation),
      },
    })];
  }
  const beforeEvents = input.ledger.lifecycleEvents.length;
  const applied = applyFindingLifecycleCommands({
    ledger: input.ledger,
    commands: [{
      operation,
      changes: { findings: findings.map(withoutRevision), conflicts: [] },
      authority: serializedAuthority,
      evidenceSourcesByTarget: new Map(findings.map((finding) => [
        `finding\0${finding.id}`,
        plan.kind === 'dismiss' && plan.authority.scopeBindingIds.length > 0
          ? { sourceRawFindingIds: [], authorityEvidenceIds: [] }
          : { sourceRawFindingIds: rawIds, authorityEvidenceIds: proofRecordIds },
      ])),
    }],
    occurredAt: input.observation,
  });
  const lifecycleEventIds = applied.lifecycleEvents.slice(beforeEvents)
    .map(({ eventId }) => eventId).sort(compareBinaryStrings);
  const settlementId = computeTerminalSettlementId(authority.episodeId);
  const settlementBase = {
    settlementId,
    episodeId: authority.episodeId,
    attemptId: attempt.attemptId,
    provisionalFindingId: provisional.id,
    expectedHead: structuredClone(authority.expectedHead),
    sourceClaimRefIds: [...authority.sourceClaimRefIds].sort(compareBinaryStrings),
    lifecycleEventIds,
    verificationDigest: authority.verificationDigest,
    recordedAt: structuredClone(input.observation),
  };
  const settlement: TerminalAdjudicationSettlement = plan.kind === 'promote_independent'
    ? { ...settlementBase, outcome: 'promoted', targetFindingId: provisional.id }
    : plan.kind === 'merge_existing'
      ? { ...settlementBase, outcome: 'merged', targetFindingId: plan.authority.targetFindingId }
      : { ...settlementBase, outcome: 'dismissed' };
  return {
    ledger: {
      ...applied,
      updatedAt: input.observation.timestamp,
      terminalAdjudicationSettlements: [...applied.terminalAdjudicationSettlements, settlement],
      terminalAdjudicationAttempts: applied.terminalAdjudicationAttempts.map((candidate) => (
        candidate.attemptId === attempt.attemptId
          ? {
              ...attempt,
              stage: 'applied' as const,
              proposal,
              appliedAt: structuredClone(input.observation),
              verificationDigest: authority.verificationDigest,
              settlementId,
              lifecycleEventIds,
            }
          : candidate
      )),
    },
    applied: true,
  };
}
