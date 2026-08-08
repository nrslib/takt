import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AgentWorkflowStep } from '../core/models/types.js';
import type { FindingLedger, RawFinding } from '../core/workflow/findings/types.js';
import {
  canonicalRawFindingFixture,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import {
  applyReviewerAnomalySpecsToLedger,
  createReviewerAnomalySpec,
  linkPromotedReviewerAnomalies,
} from '../core/workflow/findings/reviewer-anomalies.js';
import {
  computeRestatementRequestId,
  createFindingReviewPresentationContextV2,
  createFindingReviewPublication,
  PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import { intakeReviewerOutputs } from '../core/workflow/findings/manager-intake.js';
import { evaluateRawAdmission } from '../core/workflow/findings/manager-admission.js';
import { captureReviewScopeProofSnapshot } from '../core/workflow/findings/snapshot.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { applyCommitLedgerStates } from '../core/workflow/findings/manager-commit-finalization.js';
import { runFindingRestatementSlot } from '../core/workflow/findings/restatement-slot-runner.js';

const targetPath = 'src/core/workflow/findings/evidence-search.ts';
const claim = 'The exhausted claim is supported by the implementation.';
const observedAt = {
  runId: 'run-evidence-search',
  stepName: 'architecture-review',
  timestamp: '2026-08-09T00:00:00.000Z',
};

function emptyLedger(): FindingLedger {
  return {
    workflowName: 'evidence-search-workflow',
    nextId: 1,
    updatedAt: observedAt.timestamp,
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
  };
}

function buildAnomaly(): { ledger: FindingLedger; source: RawFinding; anomalyId: string } {
  const source = canonicalRawFindingFixture({
    rawFindingId: 'evidence-search-source',
    stepName: 'architecture-review',
    reviewer: 'architecture-review',
    familyTag: null,
    severity: null,
    title: null,
    description: null,
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: [targetPath] },
    evidence: [],
    rawExcerpt: claim,
  });
  const canonical = canonicalizeReviewerRawFinding(
    candidateFromStoredRawFinding(source, 'evidence-search-reviewer'),
    { ledger: emptyLedger() },
  ).canonical;
  const spec = createReviewerAnomalySpec({
    wire: source,
    canonical,
    anomalyKind: 'intake-contract-incomplete',
    reason: 'The original observation has no admitted evidence',
    intakeContract: {
      observationClass: 'claim-bearing',
      classificationAuthorityId: 'system/intake_observation_classification_v1',
      reasonCodes: ['claim-evidence-missing'],
      missingRequirements: ['claimEvidence'],
      presentationOwnerReviewer: source.reviewer,
      presentationLimit: 1,
    },
  });
  const ledger = applyReviewerAnomalySpecsToLedger(
    { ...emptyLedger(), rawFindings: [source] },
    [spec],
    { workflowName: emptyLedger().workflowName, ...observedAt },
    new Set(),
  );
  return {
    ledger,
    source,
    anomalyId: ledger.reviewerAnomalies![0]!.id,
  };
}

function evidenceSearchPublication(input: {
  anomalyId: string;
  snapshotId: string;
  rawFindings: readonly unknown[];
  reportName: string;
  repairOrigin?: 'evidence-search';
}) {
  const requestWithoutId = {
    anomalyId: input.anomalyId,
    reviewer: 'architecture-review',
    presentationOrdinal: 2,
    reviewScopeSnapshotId: input.snapshotId,
    sourceExcerptDigest: 'f'.repeat(64),
    claimedExcerpt: claim,
    targetPaths: [targetPath],
    missingRequirements: ['claimEvidence'] as const,
    expectedRelation: 'new' as const,
    expectedTargetFindingId: null,
    expectedTargetPreconditionClass: 'absent' as const,
  };
  const presentationContext = createFindingReviewPresentationContextV2({
    reviewScopeSnapshotId: input.snapshotId,
    restatementRequests: [{
      ...requestWithoutId,
      restatementRequestId: computeRestatementRequestId(requestWithoutId),
    }],
  });
  return createFindingReviewPublication({
    identity: {
      scopeIdentity: 'scope-evidence-search',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 2,
      reviewerStepName: 'architecture-review',
      reportName: input.reportName,
    },
    protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    reportContent: `Evidence search report\n${claim}`,
    rawFindings: input.rawFindings,
    presentationContext,
    ...(input.repairOrigin === undefined ? {} : { repairOrigin: input.repairOrigin }),
  });
}

describe('FC evidence-search fallback', () => {
  it('passes a byte-exact evidence-search candidate through admission and records its origin', () => {
    const { ledger, source, anomalyId } = buildAnomaly();
    const snapshot = captureReviewScopeProofSnapshot(process.cwd());
    const firstLine = readFileSync(targetPath, 'utf8').split('\n')[0]!;
    const publication = evidenceSearchPublication({
      anomalyId,
      snapshotId: snapshot.reviewScopeSnapshotId,
      reportName: 'evidence-search-exact',
      repairOrigin: 'evidence-search',
      rawFindings: [reviewerRawExtractionFixture({
        rawFindingId: 'evidence-search-admitted',
        familyTag: 'evidence-search',
        severity: 'high',
        title: 'Claim is supported by the implementation',
        description: claim,
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: { kind: 'code', paths: [targetPath] },
        evidenceRequests: [{
          kind: 'file_quote',
          path: targetPath,
          startLine: 1,
          endLine: 1,
        }],
        rawExcerpt: claim,
      })],
    });
    const intake = intakeReviewerOutputs({
      subResults: [{ subStep: { name: 'architecture-review' } as never, publication }],
      previousLedger: ledger,
      workflowName: ledger.workflowName,
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 2,
      runId: observedAt.runId,
      workflowTask: 'Review the implementation.',
      cwd: process.cwd(),
      scopeIdentity: 'scope-evidence-search',
      issuedAt: observedAt.timestamp,
      reviewScopeSnapshot: snapshot,
    });
    const admission = evaluateRawAdmission({
      cwd: process.cwd(),
      reviewScopeSnapshotId: snapshot.reviewScopeSnapshotId,
      runId: observedAt.runId,
      scopeIdentity: 'scope-evidence-search',
      previousLedger: ledger,
      intake,
      reviewScopeSnapshot: snapshot,
      workflowTask: 'Review the implementation.',
      presentationLimit: 1,
      restatementRequestBindings: publication.presentationContext.revision === 2
        ? [{
            request: publication.presentationContext.restatementRequests[0]!,
            publicationId: publication.publicationId,
            reportDigest: publication.reportDigest,
            repairOrigin: 'evidence-search',
          }]
        : [],
    });

    expect(intake.items[0]?.canonical.evidence).toHaveLength(1);
    expect(intake.items[0]?.canonical.evidence[0]).toMatchObject({
      path: targetPath,
      verbatimExcerpt: firstLine,
    });
    expect(admission.verifiedEvidenceCandidates[0]?.promotionOrigin).toBe('evidence-search');

    const admitted = admission.cleanAdmitted[0]!.wire;
    const linked = linkPromotedReviewerAnomalies({
      ...ledger,
      rawFindings: [...ledger.rawFindings, admitted],
      findings: [{
        id: 'F-SEARCH-1',
        status: 'open',
        lifecycle: 'new',
        target: admitted.target,
        targetIdentityHash: admitted.targetIdentityHash,
        claimIdentityHash: admitted.claimIdentityHash,
        semanticClaimIdentityHash: admitted.semanticClaimIdentityHash,
        severity: admitted.severity!,
        title: admitted.title!,
        description: admitted.description!,
        evidenceIds: [],
        reviewers: [admitted.reviewer],
        rawFindingIds: [admitted.rawFindingId],
        firstSeen: observedAt,
        lastSeen: observedAt,
        revision: 1,
      }],
    }, admission.verifiedEvidenceCandidates);

    expect(linked.reviewerAnomalies?.[0]).toMatchObject({
      promotedFindingId: 'F-SEARCH-1',
      promotionOrigin: 'evidence-search',
    });
  });

  it.each([
    ['null', []],
    ['mismatch', [reviewerRawExtractionFixture({
      rawFindingId: 'mismatch',
      familyTag: 'evidence-search',
      severity: 'high',
      title: 'Wrong claim',
      description: 'A different claim.',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: [targetPath] },
      evidenceRequests: [],
      rawExcerpt: claim,
    })]],
  ])('records terminal disposition for %s evidence-search output', (_label, rawFindings) => {
    const { ledger, anomalyId } = buildAnomaly();
    const snapshot = captureReviewScopeProofSnapshot(process.cwd());
    const publication = evidenceSearchPublication({
      anomalyId,
      snapshotId: snapshot.reviewScopeSnapshotId,
      reportName: `evidence-search-${_label}`,
      repairOrigin: 'evidence-search',
      rawFindings,
    });
    const committed = applyCommitLedgerStates({
      runInput: {
        workflowName: ledger.workflowName,
        parentStep: { name: 'reviewers' },
        runId: observedAt.runId,
        timestamp: observedAt.timestamp,
        subResults: [{ publication }],
      } as never,
      freshLedger: ledger,
      settledLedger: ledger,
      baseAnomalySpecs: [],
      pendingRejectedObservations: [],
      verifiedEvidenceCandidates: [],
      anomalyAdjudications: [],
    });

    expect(committed.ledger.reviewerAnomalies?.[0]?.intakeContract?.terminalDisposition)
      .toMatchObject({ kind: 'restatement_exhausted_claim_bearing' });
  });

  it('does not invoke evidence-search twice for one anomaly after the first attempt is recorded', async () => {
    const ownerStep = {
      name: 'architecture-review',
      kind: 'agent',
      persona: 'architecture-review',
      outputContracts: [{ name: 'architecture-review.md', format: 'Owner report format.' }],
    } as AgentWorkflowStep;
    const request = {
      ownerReviewerStepName: ownerStep.name,
      request: {} as never,
      reportContent: 'evidence search',
    };
    const runFindingEvidenceSearch = vi.fn().mockResolvedValue({
      subStep: ownerStep,
      publication: {},
      reviewEvidence: 'none',
      repairOrigin: 'evidence-search',
    });
    const ingest = vi.fn().mockResolvedValue(undefined);
    let first = true;
    const input = {
      ownerReviewerSteps: [ownerStep],
      buildSlotContexts: () => new Map(),
      buildEvidenceSearchRequests: () => {
        if (!first) return [];
        first = false;
        return [request];
      },
      ingest,
      reviewScopeSnapshotId: 'a'.repeat(64),
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: { iteration: 1 },
      task: 'Review',
      maxSteps: 5,
      optionsBuilder: {
        resolveStepProviderModel: () => ({ provider: 'mock', model: 'test-model' }),
      },
      stepExecutor: {
        runFindingEvidenceSearch,
        resumeFindingReviewPublication: vi.fn().mockResolvedValue(undefined),
      } as never,
      updatePersonaSession: vi.fn(),
      presentationLimit: 1,
    } as never;

    await runFindingRestatementSlot(input);
    await runFindingRestatementSlot(input);

    expect(runFindingEvidenceSearch).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
