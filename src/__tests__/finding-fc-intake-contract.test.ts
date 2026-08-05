import { describe, expect, it } from 'vitest';
import {
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';
import type {
  FindingLedger,
  FindingObservation,
  ReviewerAnomalyEntry,
  RawFinding,
} from '../core/workflow/findings/types.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  computeReviewerAnomalyStableKey,
} from '../core/workflow/findings/raw-canonicalization.js';
import {
  evaluateRawAdmission,
  type ReviewerIntakeResult,
} from '../core/workflow/findings/manager-admission.js';
import { captureReviewScopeProofSnapshot } from '../core/workflow/findings/snapshot.js';
import { applyReviewerAnomalySpecsToLedger, createReviewerAnomalySpec, linkPromotedReviewerAnomalies } from '../core/workflow/findings/reviewer-anomalies.js';
import {
  assertFindingReviewPresentationContext,
  computeRestatementRequestId,
  createFindingReviewPresentationContextV2,
  createFindingReviewPublication,
  loadFindingReviewPublication,
  listFindingReviewPublications,
  persistFindingReviewPublication,
  STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import { migrateLegacyIntakeProvisionalFindings } from '../core/workflow/findings/legacy-intake-reclassification.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { computeRawPayloadDigest } from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { collectFindingLedgerProjectionInvariantViolations } from '../core/models/finding-ledger-invariants.js';
import { buildFindingContractInstruction } from '../core/workflow/instruction/finding-contract-instruction.js';
import { rawCanonicalSnapshotFixture } from './helpers/finding-lifecycle-fixture.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FINDING_REVIEW_PUBLICATIONS_INTERNAL_DIRECTORY,
  REPORT_INTERNAL_NAMESPACE,
} from '../core/models/reserved-report-names.js';
import { applyCommitLedgerStates } from '../core/workflow/findings/manager-commit-finalization.js';
import {
  assertFindingReviewPresentationCapacity,
  FindingReviewCapacityError,
} from '../core/workflow/engine/WorkflowEngineSetup.js';
import { createProvisionalClaimBindingAuthorizationReference } from '../core/models/finding-provisional-claim-authorization.js';
import { createEngineProofRecord } from '../core/models/finding-evidence-record.js';
import { parseFindingLedger } from '../core/models/finding-schemas.js';

const observedAt: FindingObservation = {
  runId: 'run-fc-intake',
  stepName: 'architecture-review',
  timestamp: '2026-08-05T00:00:00.000Z',
};

function emptyLedger(): FindingLedger {
  return {
    workflowName: 'peer-review',
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

function canonicalItem(raw: RawFinding, ledger = emptyLedger()) {
  const candidate = candidateFromStoredRawFinding(raw, 'reviewer-stable-key');
  const result = canonicalizeReviewerRawFinding(candidate, { ledger });
  return { wire: raw, canonical: result.canonical };
}

function intake(item: ReturnType<typeof canonicalItem>, binding?: ReviewerIntakeResult['entityBindings']): ReviewerIntakeResult {
  return {
    items: [item],
    entityBindings: binding ?? new Map(),
    overflowRawFindingIds: new Set(),
    intakeProvisionalSpecs: [],
    intakeAnomalySpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
    healthyReviewerStableKeys: new Set(),
  };
}

function incompleteRaw(rawFindingId: string, overrides: Partial<RawFinding> = {}): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId,
    stepName: 'architecture-review',
    reviewer: 'architecture-review',
    familyTag: null,
    severity: null,
    title: null,
    description: null,
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/example.ts'] },
    evidence: [],
    ...overrides,
  });
}

function evidenceLessLegacyHolding(kind: 'raw-adjudication-unresolved' | 'raw-meaning-ambiguous'): {
  ledger: FindingLedger;
  findingId: string;
} {
  const raw = incompleteRaw(`raw-legacy-${kind}`);
  const snapshot = rawCanonicalSnapshotFixture(raw, observedAt);
  const findingId = 'F-0001';
  const findingHead = {
    entityKind: 'finding' as const,
    entityId: findingId,
    revision: 1,
    eventId: '8'.repeat(64),
    projectionDigest: '9'.repeat(64),
  };
  const provisional = {
    kind,
    stableKey: 'a'.repeat(64),
    lineageKey: 'b'.repeat(64),
    sourceRawFindingIds: [raw.rawFindingId],
    reason: 'evidence-less pre-admission holding',
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    gateEffect: 'block' as const,
    firstObservedRound: 1,
  };
  const authorization = createProvisionalClaimBindingAuthorizationReference({
    kind: 'new_provisional_bundle' as const,
    bindingDecisionId: 'd'.repeat(64),
    creationRequestKey: 'c'.repeat(64),
    expectedHead: null,
    sourceRawFindingIds: [raw.rawFindingId],
  });
  const proof = createEngineProofRecord({
    kind: 'engine_proof',
    purpose: 'lifecycle_authority',
    verifierId: 'takt.finding-lifecycle-policy',
    verifierVersion: '1',
    workflowName: 'peer-review',
    runId: observedAt.runId,
    scopeIdentity: 'scope',
    snapshotId: '1'.repeat(64),
    claimIdentityHash: raw.claimIdentityHash,
    targetFindingId: findingId,
    subject: {
      kind: 'finding_provisional_isolation',
      findingId,
      provisionalKind: kind,
      stableKey: provisional.stableKey,
      claimBindingAuthorizationReferences: [authorization],
    },
    dependencyDigests: [findingHead.projectionDigest],
    resultDigest: '2'.repeat(64),
    issuedAt: observedAt.timestamp,
  });
  return {
    findingId,
    ledger: {
      ...emptyLedger(),
      findings: [{
        id: findingId,
        status: 'open',
        lifecycle: 'new',
        target: raw.target,
        targetIdentityHash: raw.targetIdentityHash,
        claimIdentityHash: raw.claimIdentityHash,
        semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
        severity: null,
        title: null,
        evidenceIds: [],
        reviewers: [raw.reviewer],
        rawFindingIds: [raw.rawFindingId],
        firstSeen: observedAt,
        lastSeen: observedAt,
        revision: 1,
        provisional,
      }],
      rawFindings: [raw],
      rawCanonicalSnapshots: [snapshot],
      evidenceRecords: [proof],
      evidenceBindings: [{
        bindingId: '3'.repeat(64),
        evidenceId: proof.evidenceId,
        claimIdentityHash: raw.claimIdentityHash,
        sourceRawFindingId: raw.rawFindingId,
        sourceRawIntegrityDigest: null,
        contributionOrigin: { kind: 'external' },
        operation: 'update_provisional',
        target: { entityKind: 'finding', entityId: findingId, expectedHead: findingHead },
      }],
      lifecycleEvents: [{
        eventId: findingHead.eventId,
        mutationId: '4'.repeat(64),
        reservationId: '5'.repeat(64),
        operation: 'update_provisional',
        transitions: [{ before: null, after: findingHead }],
        evidenceBindingIds: ['3'.repeat(64)],
        outcome: { kind: 'projection_applied' },
        resultDigest: '6'.repeat(64),
        occurredAt: observedAt,
      }],
    },
  };
}

describe('FC intake contract', () => {
  it('routes an identity-incomplete raw finding to intake-contract-incomplete without provisional landing', () => {
    const raw = incompleteRaw('raw-incomplete');
    const item = canonicalItem(raw);
    const evaluation = evaluateRawAdmission({
      cwd: process.cwd(),
      reviewScopeSnapshotId: 'a'.repeat(64),
      runId: observedAt.runId,
      scopeIdentity: 'scope-fc-intake',
      previousLedger: emptyLedger(),
      intake: intake(item),
      reviewScopeSnapshot: captureReviewScopeProofSnapshot(process.cwd()),
      workflowTask: 'Review the implementation.',
      presentationLimit: 2,
    });

    expect(evaluation.ladderAnomalySpecs).toEqual([
      expect.objectContaining({
        kind: 'intake-contract-incomplete',
        intakeContract: expect.objectContaining({
          observationClass: 'claim-bearing',
          reasonCodes: ['claim-evidence-missing', 'product-identity-incomplete'],
        }),
      }),
    ]);
    expect(evaluation.admissionProvisionalSpecs).toHaveLength(0);
  });

  it('uses source-bound excerpt digest so two extraction-loss excerpts do not collide', () => {
    const first = computeReviewerAnomalyStableKey({
      reviewerStableKey: 'reviewer',
      lineageKey: 'lineage-a',
      anomalyKind: 'intake-contract-incomplete',
      sourceExcerptDigest: 'excerpt-a',
    });
    const sameClaim = computeReviewerAnomalyStableKey({
      reviewerStableKey: 'reviewer',
      lineageKey: 'lineage-b',
      anomalyKind: 'intake-contract-incomplete',
      sourceExcerptDigest: 'excerpt-a',
    });
    const differentClaim = computeReviewerAnomalyStableKey({
      reviewerStableKey: 'reviewer',
      lineageKey: 'lineage-a',
      anomalyKind: 'intake-contract-incomplete',
      sourceExcerptDigest: 'excerpt-b',
    });

    expect(sameClaim).toBe(first);
    expect(differentClaim).not.toBe(first);
  });

  it.each(['new_entity', 'ambiguous'] as const)('routes evidence-less %s entity binding to anomaly', (decision) => {
    const raw = incompleteRaw(`raw-${decision}`, {
      familyTag: 'bug',
      severity: 'high',
      title: 'Observed issue',
      description: 'The issue is visible in the reviewed code.',
    });
    const item = canonicalItem(raw);
    const evaluation = evaluateRawAdmission({
      cwd: process.cwd(),
      reviewScopeSnapshotId: 'b'.repeat(64),
      runId: observedAt.runId,
      scopeIdentity: 'scope-fc-intake',
      previousLedger: emptyLedger(),
      intake: intake(item, new Map([[raw.rawFindingId, {
        kind: 'entity_group',
        decision,
        creationRequestKey: 'c'.repeat(64),
        commitOrderKey: 'd'.repeat(64),
        capturedLocusHeadDigest: 'e'.repeat(64),
        groupRawFindingIds: [raw.rawFindingId],
        reason: 'No authoritative evidence was available',
      }]])),
      reviewScopeSnapshot: captureReviewScopeProofSnapshot(process.cwd()),
      workflowTask: 'Review the implementation.',
      presentationLimit: 2,
    });

    expect(evaluation.admissionAnomalySpecs[0]).toMatchObject({
      kind: 'intake-contract-incomplete',
      intakeContract: expect.objectContaining({
        reasonCodes: ['claim-evidence-missing'],
        missingRequirements: ['claimEvidence'],
      }),
    });
    expect(evaluation.admissionProvisionalSpecs).toHaveLength(0);
  });

  it('classifies empty protocol framing as protocol-noise and keeps an undecidable item claim-bearing', () => {
    const protocolItem = canonicalItem(incompleteRaw('raw-protocol', {
      target: { kind: 'review_scope' },
      rawExcerpt: undefined,
    }));
    const undecidableItem = canonicalItem(incompleteRaw('raw-undecidable', {
      target: { kind: 'review_scope' },
      rawExcerpt: 'The reviewer emitted an unclassified observation.',
    }));
    const evaluate = (item: ReturnType<typeof canonicalItem>) => evaluateRawAdmission({
      cwd: process.cwd(),
      reviewScopeSnapshotId: 'c'.repeat(64),
      runId: observedAt.runId,
      scopeIdentity: 'scope-fc-intake',
      previousLedger: emptyLedger(),
      intake: intake(item),
      reviewScopeSnapshot: captureReviewScopeProofSnapshot(process.cwd()),
      workflowTask: 'Review the implementation.',
      presentationLimit: 2,
    }).ladderAnomalySpecs[0]!.intakeContract;

    expect(evaluate(protocolItem)).toMatchObject({ observationClass: 'protocol-noise' });
    expect(evaluate(undecidableItem)).toMatchObject({ observationClass: 'claim-bearing' });
  });

  it('promotes only exact restatement correspondence and does not require anomaly ID echo', () => {
    const sourceExcerpt = 'The same defect remains observable.';
    const source = incompleteRaw('raw-source', {
      rawExcerpt: sourceExcerpt,
      sourceBinding: {
        reportDigest: 'f'.repeat(64),
        startByte: 0,
        endByte: Buffer.byteLength(sourceExcerpt),
        excerptDigest: '1'.repeat(64),
      },
    });
    const admitted = canonicalRawFindingFixture({
      rawFindingId: 'raw-admitted',
      stepName: source.stepName,
      reviewer: source.reviewer,
      familyTag: 'bug',
      severity: 'high',
      title: 'Observed issue',
      description: sourceExcerpt,
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: source.target,
      sourceBinding: source.sourceBinding,
      evidence: [],
    });
    const sourceItem = canonicalItem(source);
    const defect = {
      observationClass: 'claim-bearing' as const,
      classificationAuthorityId: 'system/intake_observation_classification_v1',
      reasonCodes: ['normalizer-extraction-loss'] as const,
      missingRequirements: ['description'] as const,
      presentationOwnerReviewer: source.reviewer,
      presentationLimit: 2,
    };
    const spec = createReviewerAnomalySpec({
      wire: source,
      canonical: sourceItem.canonical,
      anomalyKind: 'intake-contract-incomplete',
      reason: 'Normalizer lost the source-bound description',
      intakeContract: defect,
    });
    const withAnomaly = applyReviewerAnomalySpecsToLedger(emptyLedger(), [spec], {
      workflowName: 'peer-review',
      stepName: observedAt.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    });
    const anomaly = withAnomaly.reviewerAnomalies![0]!;
    const requestWithoutId = {
      anomalyId: anomaly.id,
      reviewer: source.reviewer,
      presentationOrdinal: 1,
      reviewScopeSnapshotId: '2'.repeat(64),
      sourceExcerptDigest: source.sourceBinding.excerptDigest,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    const linked = linkPromotedReviewerAnomalies({
      ...withAnomaly,
      rawFindings: [source, admitted],
      findings: [{
        id: 'F-0001',
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
    }, [{
      lineageKey: 'not-authoritative',
      rawFindingId: admitted.rawFindingId,
      restatementRequest: {
        ...requestWithoutId,
        restatementRequestId: computeRestatementRequestId(requestWithoutId),
      },
    }]);

    expect(linked.reviewerAnomalies![0]!.promotedFindingId).toBe('F-0001');
  });

  it('promotes a final presentation before applying claim-bearing terminal disposition', () => {
    const sourceExcerpt = 'The same defect remains observable.';
    const source = incompleteRaw('raw-final-source', {
      rawExcerpt: sourceExcerpt,
      sourceBinding: {
        reportDigest: 'f'.repeat(64),
        startByte: 0,
        endByte: Buffer.byteLength(sourceExcerpt),
        excerptDigest: '1'.repeat(64),
      },
    });
    const admitted = canonicalRawFindingFixture({
      rawFindingId: 'raw-final-admitted',
      stepName: source.stepName,
      reviewer: source.reviewer,
      familyTag: 'bug',
      severity: 'high',
      title: 'Observed issue',
      description: sourceExcerpt,
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: source.target,
      sourceBinding: source.sourceBinding,
      evidence: [],
    });
    const sourceItem = canonicalItem(source);
    const defect = {
      observationClass: 'claim-bearing' as const,
      classificationAuthorityId: 'system/intake_observation_classification_v1',
      reasonCodes: ['normalizer-extraction-loss'] as const,
      missingRequirements: ['description'] as const,
      presentationOwnerReviewer: source.reviewer,
      presentationLimit: 1,
    };
    const spec = createReviewerAnomalySpec({
      wire: source,
      canonical: sourceItem.canonical,
      anomalyKind: 'intake-contract-incomplete',
      reason: 'Normalizer lost the source-bound description',
      intakeContract: defect,
    });
    const finding = {
      id: 'F-0001',
      status: 'open' as const,
      lifecycle: 'new' as const,
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
    };
    const withAnomaly = applyReviewerAnomalySpecsToLedger(emptyLedger(), [spec], {
      workflowName: 'peer-review',
      stepName: observedAt.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    });
    const anomaly = withAnomaly.reviewerAnomalies![0]!;
    const requestWithoutId = {
      anomalyId: anomaly.id,
      reviewer: source.reviewer,
      presentationOrdinal: 1,
      reviewScopeSnapshotId: '2'.repeat(64),
      sourceExcerptDigest: source.sourceBinding.excerptDigest,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    const context = createFindingReviewPresentationContextV2({
      reviewScopeSnapshotId: requestWithoutId.reviewScopeSnapshotId,
      restatementRequests: [{
        ...requestWithoutId,
        restatementRequestId: computeRestatementRequestId(requestWithoutId),
      }],
    });
    const publication = createFindingReviewPublication({
      identity: {
        scopeIdentity: 'scope-final-promotion',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 1,
        reviewerStepName: source.reviewer,
        reportName: 'architecture-review.md',
      },
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: sourceReport(context),
      rawFindings: [],
      presentationContext: context,
    });
    const committed = applyCommitLedgerStates({
      runInput: {
        workflowName: 'peer-review',
        parentStep: { name: 'reviewers' },
        runId: observedAt.runId,
        timestamp: observedAt.timestamp,
        subResults: [{ publication }],
      } as never,
      freshLedger: {
        ...withAnomaly,
        rawFindings: [source, admitted],
        findings: [finding],
      },
      settledLedger: {
        ...withAnomaly,
        rawFindings: [source, admitted],
        findings: [finding],
      },
      baseAnomalySpecs: [],
      pendingRejectedObservations: [],
      verifiedEvidenceCandidates: [{
        lineageKey: 'not-authoritative',
        rawFindingId: admitted.rawFindingId,
        restatementRequest: {
          ...requestWithoutId,
          restatementRequestId: computeRestatementRequestId(requestWithoutId),
        },
      }],
    });

    expect(committed.ledger.reviewerAnomalies?.[0]?.promotedFindingId).toBe('F-0001');
    expect(committed.ledger.reviewerAnomalies?.[0]?.intakeContract?.terminalDisposition).toBeUndefined();
  });

  it('stores the chronologically last counted publication as terminal audit pointer', () => {
    const source = incompleteRaw('raw-terminal-pointer', {
      rawExcerpt: 'A bounded claim for pointer ordering.',
    });
    const canonical = canonicalItem(source);
    const spec = createReviewerAnomalySpec({
      wire: source,
      canonical: canonical.canonical,
      anomalyKind: 'intake-contract-incomplete',
      reason: 'Terminal pointer ordering',
      intakeContract: {
        observationClass: 'claim-bearing',
        classificationAuthorityId: 'system/intake_observation_classification_v1',
        reasonCodes: ['claim-evidence-missing'],
        missingRequirements: ['claimEvidence'],
        presentationOwnerReviewer: source.reviewer,
        presentationLimit: 2,
      },
    });
    const withAnomaly = applyReviewerAnomalySpecsToLedger(emptyLedger(), [spec], {
      workflowName: 'peer-review',
      stepName: observedAt.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    });
    const anomalyId = withAnomaly.reviewerAnomalies![0]!.id;
    const publications = [1, 2, 3].map((stepIteration) => {
      const requestWithoutId = {
        anomalyId,
        reviewer: source.reviewer,
        presentationOrdinal: stepIteration,
        reviewScopeSnapshotId: 'a'.repeat(64),
        sourceExcerptDigest: source.sourceBinding.excerptDigest,
        expectedRelation: 'new' as const,
        expectedTargetFindingId: null,
        expectedTargetPreconditionClass: 'absent' as const,
      };
      const context = createFindingReviewPresentationContextV2({
        reviewScopeSnapshotId: requestWithoutId.reviewScopeSnapshotId,
        restatementRequests: [{
          ...requestWithoutId,
          restatementRequestId: computeRestatementRequestId(requestWithoutId),
        }],
      });
      return createFindingReviewPublication({
        identity: {
          scopeIdentity: 'scope-terminal-pointer',
          callNamespace: '',
          parentStepName: 'reviewers',
          stepIteration,
          reviewerStepName: source.reviewer,
          reportName: `architecture-review-${stepIteration}.md`,
        },
        protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
        reportContent: sourceReport(context),
        rawFindings: [],
        presentationContext: context,
      });
    });
    const committed = applyCommitLedgerStates({
      runInput: {
        workflowName: 'peer-review',
        parentStep: { name: 'reviewers' },
        runId: observedAt.runId,
        timestamp: observedAt.timestamp,
        subResults: publications.map((publication) => ({ publication })),
      } as never,
      freshLedger: emptyLedger(),
      settledLedger: emptyLedger(),
      baseAnomalySpecs: [spec],
      pendingRejectedObservations: [],
      verifiedEvidenceCandidates: [],
    });

    expect(committed.ledger.reviewerAnomalies?.[0]?.intakeContract?.terminalDisposition)
      .toMatchObject({
        terminalPublicationId: publications[2]!.publicationId,
        workflowOutcome: 'review_integrity_unresolved',
      });
  });

  it('creates a binary-sorted V2 context and persists its publication idempotently', () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-fc-publication-'));
    try {
      const requests = ['b', 'a'].map((anomalyId, index) => {
        const requestWithoutId = {
          anomalyId,
          reviewer: 'architecture-review',
          presentationOrdinal: 1,
          reviewScopeSnapshotId: '3'.repeat(64),
          sourceExcerptDigest: `${index + 4}`.repeat(64),
          expectedRelation: 'new' as const,
          expectedTargetFindingId: null,
          expectedTargetPreconditionClass: 'absent' as const,
        };
        return {
          ...requestWithoutId,
          restatementRequestId: computeRestatementRequestId(requestWithoutId),
        };
      });
      const context = createFindingReviewPresentationContextV2({
        reviewScopeSnapshotId: '3'.repeat(64),
        restatementRequests: requests,
      });
      expect(context.restatementRequests.map(({ anomalyId }) => anomalyId)).toEqual(['a', 'b']);
      expect(context.presentedReviewerAnomalyIds).toEqual(['a', 'b']);
      expect(() => assertFindingReviewPresentationContext({
        ...context,
        contextDigest: '0'.repeat(64),
      })).toThrow(/digest/);

      const publication = createFindingReviewPublication({
        identity: {
          scopeIdentity: 'scope-fc',
          callNamespace: '',
          parentStepName: 'reviewers',
          stepIteration: 1,
          reviewerStepName: 'architecture-review',
          reportName: 'architecture-review.md',
        },
        protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
        reportContent: sourceReport(context),
        rawFindings: [],
        presentationContext: context,
      });
      persistFindingReviewPublication(reportDir, { publication, reviewerExecutionIdentity: { provider: 'codex' } });
      persistFindingReviewPublication(reportDir, { publication, reviewerExecutionIdentity: { provider: 'codex' } });
      expect(listFindingReviewPublications(reportDir)).toHaveLength(1);
      expect(listFindingReviewPublications(reportDir)[0]!.presentationContext.presentedReviewerAnomalyIds)
        .toEqual(['a', 'b']);
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it('reads revision-1 publications only as empty legacy context and rejects mixed V1/V2 records', () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-fc-legacy-publication-'));
    try {
      const identity = {
        scopeIdentity: 'scope-fc-legacy',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 1,
        reviewerStepName: 'architecture-review',
        reportName: 'architecture-review.md',
      };
      const context = createFindingReviewPresentationContextV2({
        reviewScopeSnapshotId: '8'.repeat(64),
        restatementRequests: [],
      });
      const publication = createFindingReviewPublication({
        identity,
        protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
        reportContent: sourceReport(context),
        rawFindings: [],
        presentationContext: context,
      });
      persistFindingReviewPublication(reportDir, {
        publication,
        reviewerExecutionIdentity: { provider: 'codex' },
      });
      const path = join(
        reportDir,
        REPORT_INTERNAL_NAMESPACE,
        FINDING_REVIEW_PUBLICATIONS_INTERNAL_DIRECTORY,
        `${publication.publicationId}.json`,
      );
      const stored = JSON.parse(readFileSync(path, 'utf8')) as {
        publication: {
          protocol: { protocolRevision: number };
          presentationContext: unknown;
        };
      };
      stored.publication.protocol.protocolRevision = 1;
      stored.publication.presentationContext = context;
      writeFileSync(path, JSON.stringify(stored));
      expect(() => loadFindingReviewPublication(
        reportDir,
        identity,
        STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      )).toThrow(/Legacy finding review publication protocol/);

      stored.publication.presentationContext = {
        revision: 1,
        restatementRequests: [],
        presentedReviewerAnomalyIds: [],
      };
      writeFileSync(path, JSON.stringify(stored));
      const loaded = loadFindingReviewPublication(
        reportDir,
        identity,
        STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      );
      expect(loaded?.publication.protocol.protocolRevision).toBe(1);
      expect(loaded?.publication.presentationContext.revision).toBe(1);
      expect(listFindingReviewPublications(reportDir)[0]?.presentationContext.revision).toBe(1);
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it('injects only the reviewer-owned restatement batch into the contract instruction', () => {
    const requestWithoutId = {
      anomalyId: 'RA-REQUEST',
      reviewer: 'architecture-review',
      presentationOrdinal: 1,
      reviewScopeSnapshotId: '6'.repeat(64),
      sourceExcerptDigest: '7'.repeat(64),
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    const context = createFindingReviewPresentationContextV2({
      reviewScopeSnapshotId: requestWithoutId.reviewScopeSnapshotId,
      restatementRequests: [{
        ...requestWithoutId,
        restatementRequestId: computeRestatementRequestId(requestWithoutId),
      }],
    });
    const instruction = buildFindingContractInstruction({
      contract: {
        ledgerSummary: { findings: [] },
        hasOpenFindings: false,
        hasWaivedFindings: false,
        hasDismissedFindings: false,
        reviewer: {
          mode: 'structured',
          rawFindingsStructuredOutput: { schemaRef: 'test', schema: { type: 'object' } },
          reviewScopeSnapshotId: context.reviewScopeSnapshotId,
          presentationContext: context,
        },
      },
      language: 'en',
      renderFencedJsonBlock: (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
    });

    expect(instruction).toContain('RA-REQUEST');
    expect(instruction).toContain('restatementRequestId');
  });

  it('fails before publication when remaining workflow capacity cannot present every anomaly', () => {
    const raw = incompleteRaw('raw-capacity');
    const canonical = canonicalItem(raw);
    const defect = {
      observationClass: 'claim-bearing' as const,
      classificationAuthorityId: 'system/intake_observation_classification_v1',
      reasonCodes: ['claim-evidence-missing'] as const,
      missingRequirements: ['claimEvidence'] as const,
      presentationOwnerReviewer: raw.reviewer,
      presentationLimit: 2,
    };
    const anomalySpec = createReviewerAnomalySpec({
      wire: raw,
      canonical: canonical.canonical,
      anomalyKind: 'intake-contract-incomplete',
      reason: 'No remaining presentation capacity',
      intakeContract: defect,
    });
    const ledger = applyReviewerAnomalySpecsToLedger(emptyLedger(), [anomalySpec], {
      workflowName: 'peer-review',
      stepName: observedAt.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    });
    expect(() => assertFindingReviewPresentationCapacity({
      ledger,
      presentationCounts: new Map(),
      maxSteps: 1,
      currentIteration: 1,
      stepName: 'reviewers',
    })).not.toThrow();
    let error: unknown;
    try {
      assertFindingReviewPresentationCapacity({
        ledger,
        presentationCounts: new Map(),
        maxSteps: 0,
        currentIteration: 0,
        stepName: 'reviewers',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FindingReviewCapacityError);
    expect((error as FindingReviewCapacityError).failure.details?.reviewIntegrity).toMatchObject({
      code: 'review_integrity_unresolved_unpresented',
      unpresentedIds: [expect.any(String)],
      publicationIds: [],
    });
  });

  it('reclassifies evidence-less pre-admission holding only through allowlist B', () => {
    const { ledger, findingId } = evidenceLessLegacyHolding('raw-adjudication-unresolved');
    const result = migrateLegacyIntakeProvisionalFindings({
      ledger,
      observation: { ...observedAt, timestamp: '2026-08-05T00:02:00.000Z' },
      presentationLimit: 2,
    });

    expect(result.migratedFindingIds).toEqual([findingId]);
    expect(result.ledger.findings[0]!.reviewerAnomalyReclassification).toMatchObject({
      bindingAuthorizationIds: [expect.any(String)],
      bindingDecisionIds: ['d'.repeat(64)],
    });
    expect(result.ledger.reviewerAnomalies?.[0]?.sourceRawFindingIds).toEqual([
      'raw-legacy-raw-adjudication-unresolved',
    ]);

    const marker = result.ledger.findings[0]!.reviewerAnomalyReclassification!;
    const hasMarkerViolation = (candidate: FindingLedger): boolean => (
      collectFindingLedgerProjectionInvariantViolations(candidate).some(({ path }) => (
        path[0] === 'findings'
          && path[2] === 'reviewerAnomalyReclassification'
      ))
    );
    expect(hasMarkerViolation(result.ledger)).toBe(false);
    for (const tamperedMarker of [
      { ...marker, rawCanonicalSnapshotIds: [] },
      { ...marker, terminalAttemptIds: ['a'.repeat(64)] },
      { ...marker, scopeBindingIds: ['b'.repeat(64)] },
    ]) {
      const tamperedLedger: FindingLedger = {
        ...result.ledger,
        findings: result.ledger.findings.map((finding) => (
          finding.id === findingId
            ? { ...finding, reviewerAnomalyReclassification: tamperedMarker }
            : finding
        )),
      };
      expect(hasMarkerViolation(tamperedLedger)).toBe(true);
    }

    const withoutAuthorization = evidenceLessLegacyHolding('raw-adjudication-unresolved').ledger;
    withoutAuthorization.evidenceRecords = withoutAuthorization.evidenceRecords.map((record) => (
      record.kind === 'engine_proof'
        ? {
            ...record,
            subject: {
              ...record.subject,
              claimBindingAuthorizationReferences: [],
            },
          }
        : record
    ));
    expect(migrateLegacyIntakeProvisionalFindings({
      ledger: withoutAuthorization,
      observation: { ...observedAt, timestamp: '2026-08-05T00:03:00.000Z' },
      presentationLimit: 2,
    }).migratedFindingIds).toEqual([]);
  });

  it('reclassifies only an exact legacy isolation graph and preserves the old holding audit marker', () => {
    const raw = incompleteRaw('raw-legacy');
    const snapshot = rawCanonicalSnapshotFixture(raw, observedAt);
    snapshot.canonicalProvenance = {
      ...snapshot.canonicalProvenance,
      ambiguityOrigin: true,
      ambiguityCodes: ['missing-required-field'],
    };
    const caseSnapshotId = '4'.repeat(64);
    const caseId = '5'.repeat(64);
    const providerCallId = '6'.repeat(64);
    const attemptId = '7'.repeat(64);
    const findingId = 'F-0001';
    const findingHead = {
      entityKind: 'finding' as const,
      entityId: findingId,
      revision: 1,
      eventId: '8'.repeat(64),
      projectionDigest: '9'.repeat(64),
    };
    const ledger: FindingLedger = {
      ...emptyLedger(),
      findings: [{
        id: findingId,
        status: 'open',
        lifecycle: 'new',
        target: raw.target,
        targetIdentityHash: raw.targetIdentityHash,
        claimIdentityHash: raw.claimIdentityHash,
        semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
        severity: null,
        title: null,
        evidenceIds: [],
        reviewers: [raw.reviewer],
        rawFindingIds: [raw.rawFindingId],
        firstSeen: observedAt,
        lastSeen: observedAt,
        revision: 1,
        provisional: {
          kind: 'raw-meaning-ambiguous',
          stableKey: 'a'.repeat(64),
          lineageKey: 'b'.repeat(64),
          sourceRawFindingIds: [raw.rawFindingId],
          reason: 'missing required field',
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          gateEffect: 'block',
          firstObservedRound: 1,
        },
      }],
      rawFindings: [raw],
      rawCanonicalSnapshots: [snapshot],
      interpretationCaseSnapshots: [{
        caseSnapshotId,
        caseId,
        cohortId: 'a'.repeat(64),
        roundIdentity: 'b'.repeat(64),
        lineageKey: snapshot.lineageKey,
        policyClass: 'general',
        semanticProjectionDigest: 'c'.repeat(64),
        memberRawFindingIds: [raw.rawFindingId],
        memberObservationDigests: ['d'.repeat(64)],
        originSnapshotSetDigest: 'e'.repeat(64),
        createdAt: observedAt,
      }],
      interpretationRawObservations: [{
        observationDigest: 'd'.repeat(64),
        rawFindingId: raw.rawFindingId,
        rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
        caseId,
        cohortId: 'a'.repeat(64),
        caseSnapshotId,
        lineageKey: snapshot.lineageKey,
        semanticProjectionDigest: 'c'.repeat(64),
        originSnapshotDigests: [snapshot.rawCanonicalSnapshotId],
        recoveryOriginBindingIds: [],
      }],
      interpretationAttempts: [{
        attemptId,
        caseSnapshotId,
        caseId,
        cohortId: 'a'.repeat(64),
        lineageKey: snapshot.lineageKey,
        semanticProjectionDigest: 'c'.repeat(64),
        attemptOrdinal: 1,
        retryOrdinal: 0,
        rawFindingIds: [raw.rawFindingId],
        providerCallId,
        stage: 'completed',
        startedAt: observedAt,
        completedAt: observedAt,
        decision: { kind: 'provisional', reason: 'not enough identity' },
      }],
      rawInterpretationOutcomes: [{
        rawFindingId: raw.rawFindingId,
        kind: 'provisional',
        provisionalFindingId: findingId,
        landingEventId: 'f'.repeat(64),
      }],
      evidenceRecords: [{
        evidenceId: '0'.repeat(64),
        kind: 'engine_proof',
        purpose: 'lifecycle_authority',
        verifierId: 'takt.finding-lifecycle-policy',
        verifierVersion: '1',
        workflowName: 'peer-review',
        runId: observedAt.runId,
        scopeIdentity: 'scope',
        snapshotId: '1'.repeat(64),
        claimIdentityHash: raw.claimIdentityHash,
        targetFindingId: findingId,
        subject: {
          kind: 'finding_provisional_isolation',
          findingId,
          provisionalKind: 'raw-meaning-ambiguous',
          stableKey: 'a'.repeat(64),
          claimBindingAuthorizationReferences: [],
        },
        dependencyDigests: [findingHead.projectionDigest],
        resultDigest: '2'.repeat(64),
        issuedAt: observedAt.timestamp,
      } as never],
      evidenceBindings: [{
        bindingId: '3'.repeat(64),
        evidenceId: '0'.repeat(64),
        claimIdentityHash: raw.claimIdentityHash,
        sourceRawFindingId: raw.rawFindingId,
        sourceRawIntegrityDigest: null,
        contributionOrigin: { kind: 'external' },
        operation: 'update_provisional',
        target: { entityKind: 'finding', entityId: findingId, expectedHead: findingHead },
      }],
      lifecycleEvents: [{
        eventId: findingHead.eventId,
        mutationId: '4'.repeat(64),
        reservationId: '5'.repeat(64),
        operation: 'update_provisional',
        transitions: [{ before: null, after: findingHead }],
        evidenceBindingIds: ['3'.repeat(64)],
        outcome: { kind: 'projection_applied' },
        resultDigest: '6'.repeat(64),
        occurredAt: observedAt,
      }],
    };
    const result = migrateLegacyIntakeProvisionalFindings({
      ledger,
      observation: { ...observedAt, timestamp: '2026-08-05T00:01:00.000Z' },
      presentationLimit: 2,
    });

    expect(result.migratedFindingIds).toEqual([findingId]);
    expect(result.ledger.reviewerAnomalies?.[0]).toMatchObject({
      kind: 'intake-contract-incomplete',
      sourceRawFindingIds: [raw.rawFindingId],
    });
    expect(result.ledger.findings[0]!.reviewerAnomalyReclassification).toMatchObject({
      kind: 'reclassified_to_reviewer_anomaly',
      reason: 'product_claim_not_adjudicated',
    });
    expect(computeRawPayloadDigest(raw)).toBe(snapshot.rawPayloadDigest);
    expect(captureFindingLifecycleHead(result.ledger, 'finding', findingId)).toEqual(findingHead);
  });

  it.skipIf(!existsSync(
    '/Users/nrs/work/git/takt-worktrees/20260804T2312-pr-komento-no-wodaunroodoshite-e4f343d5b676a1dc/.takt/runs/20260805-005547-implement-using-only-the-files-fcgafa/reports/findings-ledger.json',
  ))('replays the archived FC ledger through current schema and migration guards', () => {
    const archivePath = '/Users/nrs/work/git/takt-worktrees/20260804T2312-pr-komento-no-wodaunroodoshite-e4f343d5b676a1dc/.takt/runs/20260805-005547-implement-using-only-the-files-fcgafa/reports/findings-ledger.json';
    const ledger = parseFindingLedger(JSON.parse(readFileSync(archivePath, 'utf8')));
    const provisionalKinds = ledger.findings
      .map((finding) => finding.provisional?.kind)
      .filter((kind): kind is string => kind !== undefined);
    expect(ledger.findings.length).toBeGreaterThanOrEqual(15);
    expect(ledger.rawFindings.length).toBeGreaterThanOrEqual(80);
    expect(provisionalKinds.filter((kind) => kind === 'raw-meaning-ambiguous')).toHaveLength(6);
    expect(provisionalKinds.filter((kind) => kind === 'raw-adjudication-unresolved')).toHaveLength(4);
    const migration = migrateLegacyIntakeProvisionalFindings({
      ledger,
      observation: { ...observedAt, timestamp: '2026-08-05T00:04:00.000Z' },
      presentationLimit: 2,
    });
    expect(migration.migratedFindingIds).toEqual(
      expect.arrayContaining(['F-0007', 'F-0008', 'F-0009', 'F-0010']),
    );
    expect(() => parseFindingLedger(migration.ledger)).not.toThrow();
  });
});

function sourceReport(context: unknown): string {
  return `Restatement context ${JSON.stringify(context)}`;
}
