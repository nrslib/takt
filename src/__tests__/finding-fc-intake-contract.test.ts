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
import { intakeReviewerOutputs } from '../core/workflow/findings/manager-intake.js';
import { captureReviewScopeProofSnapshot } from '../core/workflow/findings/snapshot.js';
import { applyReviewerAnomalySpecsToLedger, createReviewerAnomalySpec, linkPromotedReviewerAnomalies } from '../core/workflow/findings/reviewer-anomalies.js';
import {
  assertFindingReviewPresentationContext,
  computeRestatementRequestId,
  collectRestatementRequestBindings,
  createFindingReviewPresentationContextV2,
  createFindingReviewPublication,
  loadFindingReviewPublication,
  listFindingReviewPublications,
  persistFindingReviewPublication,
  STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { computeRawPayloadDigest } from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { collectFindingLedgerProjectionInvariantViolations } from '../core/models/finding-ledger-invariants.js';
import { buildFindingContractInstruction } from '../core/workflow/instruction/finding-contract-instruction.js';
import { renderFindingLedgerInstructionSummary } from '../core/workflow/findings/context.js';
import {
  rawCanonicalSnapshotFixture,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      relation: null,
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
      sourceBinding: {
        ...source.sourceBinding,
        reportDigest: 'e'.repeat(64),
        excerptDigest: '2'.repeat(64),
      },
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
    }, new Set());
    const anomaly = withAnomaly.reviewerAnomalies![0]!;
    const requestWithoutId = {
      anomalyId: anomaly.id,
      reviewer: source.reviewer,
      presentationOrdinal: 1,
      reviewScopeSnapshotId: '2'.repeat(64),
      sourceExcerptDigest: source.sourceBinding.excerptDigest,
      claimedExcerpt: sourceExcerpt,
      targetPaths: ['src/example.ts'] as const,
      missingRequirements: ['description'] as const,
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
      restatementRequestBindings: [{
        request: {
          ...requestWithoutId,
          restatementRequestId: computeRestatementRequestId(requestWithoutId),
        },
        publicationId: 'publication-direct',
        reportDigest: admitted.sourceBinding.reportDigest,
      }],
    }]);

    expect(linked.reviewerAnomalies![0]!.promotedFindingId).toBe('F-0001');
  });

  describe('escalation restatement correspondence', () => {
    const escalationCase = (admittedReviewer: string, requestReviewer: string) => {
      const sourceExcerpt = 'The escalated defect remains observable.';
      const source = incompleteRaw('raw-escalation-source', {
        rawExcerpt: sourceExcerpt,
        sourceBinding: {
          reportDigest: 'f'.repeat(64),
          startByte: 0,
          endByte: Buffer.byteLength(sourceExcerpt),
          excerptDigest: '8'.repeat(64),
        },
      });
      const admitted = canonicalRawFindingFixture({
        rawFindingId: 'raw-escalation-admitted',
        stepName: source.stepName,
        reviewer: admittedReviewer,
        familyTag: 'bug',
        severity: 'high',
        title: 'Escalated issue',
        description: sourceExcerpt,
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: source.target,
        sourceBinding: {
          ...source.sourceBinding,
          reportDigest: 'e'.repeat(64),
          excerptDigest: '9'.repeat(64),
        },
        evidence: [],
      });
      const sourceItem = canonicalItem(source);
      const spec = createReviewerAnomalySpec({
        wire: source,
        canonical: sourceItem.canonical,
        anomalyKind: 'intake-contract-incomplete',
        reason: 'The owner reviewer never restated a complete claim',
        intakeContract: {
          observationClass: 'claim-bearing' as const,
          classificationAuthorityId: 'system/intake_observation_classification_v1',
          reasonCodes: ['product-identity-incomplete'] as const,
          missingRequirements: ['title'] as const,
          presentationOwnerReviewer: source.reviewer,
          presentationLimit: 2,
        },
      });
      const withAnomaly = applyReviewerAnomalySpecsToLedger(emptyLedger(), [spec], {
        workflowName: 'peer-review',
        stepName: observedAt.stepName,
        runId: observedAt.runId,
        timestamp: observedAt.timestamp,
      }, new Set());
      const anomaly = withAnomaly.reviewerAnomalies![0]!;
      const requestWithoutId = {
        anomalyId: anomaly.id,
        reviewer: requestReviewer,
        presentationOrdinal: 2,
        reviewScopeSnapshotId: 'a'.repeat(64),
        sourceExcerptDigest: source.sourceBinding.excerptDigest,
        claimedExcerpt: sourceExcerpt,
        targetPaths: ['src/example.ts'] as const,
        missingRequirements: ['title'] as const,
        expectedRelation: 'new' as const,
        expectedTargetFindingId: null,
        expectedTargetPreconditionClass: 'absent' as const,
      };
      return linkPromotedReviewerAnomalies({
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
        restatementRequestBindings: [{
          request: {
            ...requestWithoutId,
            restatementRequestId: computeRestatementRequestId(requestWithoutId),
          },
          publicationId: 'publication-escalation',
          reportDigest: admitted.sourceBinding.reportDigest,
        }],
      }]);
    };

    it('promotes when the escalation reviewer restates an owner reviewer observation', () => {
      const linked = escalationCase('escalation-reviewer', 'escalation-reviewer');

      expect(linked.reviewerAnomalies![0]!.promotedFindingId).toBe('F-0001');
    });

    it('does not promote when a non-escalation request comes from a different reviewer', () => {
      const linked = escalationCase('escalation-reviewer', 'architecture-review');

      expect(linked.reviewerAnomalies![0]!.promotedFindingId).toBeUndefined();
    });
  });

  describe('restatement batch promotion (correspondence edges)', () => {
    const batchReportDigest = 'e'.repeat(64);
    const buildBatchCase = (
      suffix: string,
      claim: string,
      sourceExcerptDigestSeed: string,
      admittedExcerptDigestSeed: string,
    ): {
      source: ReturnType<typeof incompleteRaw>;
      admitted: ReturnType<typeof canonicalRawFindingFixture>;
    } => {
      const source = incompleteRaw(`raw-source-${suffix}`, {
        rawExcerpt: claim,
        sourceBinding: {
          reportDigest: 'f'.repeat(64),
          startByte: 0,
          endByte: Buffer.byteLength(claim),
          excerptDigest: sourceExcerptDigestSeed.repeat(64),
        },
      });
      const admitted = canonicalRawFindingFixture({
        rawFindingId: `raw-admitted-${suffix}`,
        stepName: source.stepName,
        reviewer: source.reviewer,
        familyTag: 'bug',
        severity: 'high',
        title: `Observed issue ${suffix}`,
        description: claim,
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: source.target,
        sourceBinding: {
          ...source.sourceBinding,
          reportDigest: batchReportDigest,
          excerptDigest: admittedExcerptDigestSeed.repeat(64),
        },
        evidence: [],
      });
      return { source, admitted };
    };
    const batchDefectFor = (source: ReturnType<typeof incompleteRaw>) => ({
      observationClass: 'claim-bearing' as const,
      classificationAuthorityId: 'system/intake_observation_classification_v1',
      reasonCodes: ['normalizer-extraction-loss'] as const,
      missingRequirements: ['description'] as const,
      presentationOwnerReviewer: source.reviewer,
      presentationLimit: 2,
    });
    const anomaliesFor = (cases: ReadonlyArray<{ source: ReturnType<typeof incompleteRaw> }>) => {
      const specs = cases.map(({ source }) => createReviewerAnomalySpec({
        wire: source,
        canonical: canonicalItem(source).canonical,
        anomalyKind: 'intake-contract-incomplete',
        reason: 'Normalizer lost the source-bound description',
        intakeContract: batchDefectFor(source),
      }));
      const ledger = applyReviewerAnomalySpecsToLedger(emptyLedger(), specs, {
        workflowName: 'peer-review',
        stepName: observedAt.stepName,
        runId: observedAt.runId,
        timestamp: observedAt.timestamp,
      }, new Set());
      const anomalyOf = (source: ReturnType<typeof incompleteRaw>) => ledger.reviewerAnomalies!
        .find((entry) => entry.sourceRawFindingIds.includes(source.rawFindingId))!;
      return { ledger, anomalyOf };
    };
    const batchRequestFor = (
      source: ReturnType<typeof incompleteRaw>,
      anomalyId: string,
      claim: string,
    ) => {
      const requestWithoutId = {
        anomalyId,
        reviewer: source.reviewer,
        presentationOrdinal: 1,
        reviewScopeSnapshotId: '2'.repeat(64),
        sourceExcerptDigest: source.sourceBinding.excerptDigest,
        claimedExcerpt: claim,
        targetPaths: ['src/example.ts'] as const,
        missingRequirements: ['description'] as const,
        expectedRelation: 'new' as const,
        expectedTargetFindingId: null,
        expectedTargetPreconditionClass: 'absent' as const,
      };
      return { ...requestWithoutId, restatementRequestId: computeRestatementRequestId(requestWithoutId) };
    };
    const batchFindingFor = (admitted: ReturnType<typeof canonicalRawFindingFixture>, id: string) => ({
      id,
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
    });
    // 曖昧グラフ用の claim atom ペア: 語間空白を1個/2個で変える。byte では別 excerpt
    // （別 anomaly stable key）だが normalizeClaimAtom では同一 atom になる。production
    // では bindReviewerReportExcerpt が前後空白の excerpt を拒否するため、末尾スペース
    // ではなく内部空白の揺れで normalize-equal を再現する。
    const duplicateClaim = 'The duplicated defect remains observable.';
    const duplicateClaimVariant = 'The duplicated  defect remains observable.';

    it('promotes every correspondence pair in one multi-request publication batch', () => {
      const first = buildBatchCase('a', 'The first defect remains observable.', '1', '8');
      const second = buildBatchCase('b', 'The second defect remains observable.', '2', '9');
      const { ledger, anomalyOf } = anomaliesFor([first, second]);
      const anomalyA = anomalyOf(first.source);
      const anomalyB = anomalyOf(second.source);
      // report 単位の binding 配布を再現: 各 admitted raw は同一 publication の
      // 全 request を binding として受け取る。
      const sharedBindings = [
        { request: batchRequestFor(first.source, anomalyA.id, 'The first defect remains observable.'), publicationId: 'publication-batch', reportDigest: batchReportDigest },
        { request: batchRequestFor(second.source, anomalyB.id, 'The second defect remains observable.'), publicationId: 'publication-batch', reportDigest: batchReportDigest },
      ];
      const linked = linkPromotedReviewerAnomalies({
        ...ledger,
        rawFindings: [first.source, second.source, first.admitted, second.admitted],
        findings: [batchFindingFor(first.admitted, 'F-0001'), batchFindingFor(second.admitted, 'F-0002')],
      }, [
        { lineageKey: 'lineage-a', rawFindingId: first.admitted.rawFindingId, restatementRequestBindings: sharedBindings },
        { lineageKey: 'lineage-b', rawFindingId: second.admitted.rawFindingId, restatementRequestBindings: sharedBindings },
      ]);

      expect(linked.reviewerAnomalies!.find((entry) => entry.id === anomalyA.id)!.promotedFindingId).toBe('F-0001');
      expect(linked.reviewerAnomalies!.find((entry) => entry.id === anomalyB.id)!.promotedFindingId).toBe('F-0002');
    });

    it('does not promote when one raw corresponds to two normalize-equal anomalies', () => {
      const dupFirst = buildBatchCase('dup-a', duplicateClaim, '3', '8');
      const dupSecond = buildBatchCase('dup-b', duplicateClaimVariant, '4', '9');
      const { ledger, anomalyOf } = anomaliesFor([dupFirst, dupSecond]);
      const dupAnomalyA = anomalyOf(dupFirst.source);
      const dupAnomalyB = anomalyOf(dupSecond.source);
      const dupBindings = [
        { request: batchRequestFor(dupFirst.source, dupAnomalyA.id, duplicateClaim), publicationId: 'publication-dup', reportDigest: batchReportDigest },
        { request: batchRequestFor(dupSecond.source, dupAnomalyB.id, duplicateClaim), publicationId: 'publication-dup', reportDigest: batchReportDigest },
      ];
      const linked = linkPromotedReviewerAnomalies({
        ...ledger,
        rawFindings: [dupFirst.source, dupSecond.source, dupFirst.admitted],
        findings: [batchFindingFor(dupFirst.admitted, 'F-0003')],
      }, [
        { lineageKey: 'lineage-dup', rawFindingId: dupFirst.admitted.rawFindingId, restatementRequestBindings: dupBindings },
      ]);

      // raw 側 exact-one 不成立（1 raw が2 anomaly に対応）→ どちらも昇格しない。
      for (const entry of linked.reviewerAnomalies!) {
        expect(entry.promotedFindingId).toBeUndefined();
      }

      // 正の対照: 同一 fixture のまま binding を anomaly A の1本に減らすと
      // raw 側の edge が exact-one になり昇格が成立する。これにより上の拒否が
      // fixture 起因ではなく「曖昧さ由来」であることを識別できる。
      const singleBindingLinked = linkPromotedReviewerAnomalies({
        ...ledger,
        rawFindings: [dupFirst.source, dupSecond.source, dupFirst.admitted],
        findings: [batchFindingFor(dupFirst.admitted, 'F-0003')],
      }, [
        { lineageKey: 'lineage-dup', rawFindingId: dupFirst.admitted.rawFindingId, restatementRequestBindings: [dupBindings[0]!] },
      ]);
      expect(singleBindingLinked.reviewerAnomalies!.find((entry) => entry.id === dupAnomalyA.id)!.promotedFindingId)
        .toBe('F-0003');
      expect(singleBindingLinked.reviewerAnomalies!.find((entry) => entry.id === dupAnomalyB.id)!.promotedFindingId)
        .toBeUndefined();
    });

    it('does not promote when two raws correspond to one anomaly', () => {
      const dupFirst = buildBatchCase('dup-a', duplicateClaim, '3', '8');
      const { ledger, anomalyOf } = anomaliesFor([dupFirst]);
      const dupAnomalyA = anomalyOf(dupFirst.source);
      const twinBindings = [
        { request: batchRequestFor(dupFirst.source, dupAnomalyA.id, duplicateClaim), publicationId: 'publication-twin', reportDigest: batchReportDigest },
      ];
      const twinSecondAdmitted = canonicalRawFindingFixture({
        rawFindingId: 'raw-admitted-twin',
        stepName: dupFirst.source.stepName,
        reviewer: dupFirst.source.reviewer,
        familyTag: 'bug',
        severity: 'high',
        title: 'Observed issue twin',
        description: duplicateClaim,
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: dupFirst.source.target,
        sourceBinding: { ...dupFirst.source.sourceBinding, reportDigest: batchReportDigest, excerptDigest: '7'.repeat(64) },
        evidence: [],
      });
      const linked = linkPromotedReviewerAnomalies({
        ...ledger,
        rawFindings: [dupFirst.source, dupFirst.admitted, twinSecondAdmitted],
        findings: [batchFindingFor(dupFirst.admitted, 'F-0004'), batchFindingFor(twinSecondAdmitted, 'F-0005')],
      }, [
        { lineageKey: 'lineage-twin-a', rawFindingId: dupFirst.admitted.rawFindingId, restatementRequestBindings: twinBindings },
        { lineageKey: 'lineage-twin-b', rawFindingId: twinSecondAdmitted.rawFindingId, restatementRequestBindings: twinBindings },
      ]);

      // anomaly 側 exact-one 不成立（2 raw が1 anomaly に対応）→ 昇格しない。
      expect(linked.reviewerAnomalies![0]!.promotedFindingId).toBeUndefined();

      // 正の対照: 同一 fixture のまま候補を1 raw に減らすと anomaly 側の edge が
      // exact-one になり昇格が成立する。上の拒否が「曖昧さ由来」であることの識別。
      const singleCandidateLinked = linkPromotedReviewerAnomalies({
        ...ledger,
        rawFindings: [dupFirst.source, dupFirst.admitted, twinSecondAdmitted],
        findings: [batchFindingFor(dupFirst.admitted, 'F-0004'), batchFindingFor(twinSecondAdmitted, 'F-0005')],
      }, [
        { lineageKey: 'lineage-twin-a', rawFindingId: dupFirst.admitted.rawFindingId, restatementRequestBindings: twinBindings },
      ]);
      expect(singleCandidateLinked.reviewerAnomalies!.find((entry) => entry.id === dupAnomalyA.id)!.promotedFindingId)
        .toBe('F-0004');
    });
  });

  it('promotes through reviewer output, normalizer, normalization, and admission without source-binding copying', () => {
    const claim = 'The same defect remains observable.';
    const snapshot = captureReviewScopeProofSnapshot(process.cwd());
    const firstPublication = createFindingReviewPublication({
      identity: {
        scopeIdentity: 'scope-fc-real-path',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 1,
        reviewerStepName: 'architecture-review',
        reportName: 'architecture-review-1.md',
      },
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: `Initial report\n\n${claim}`,
      rawFindings: [reviewerRawExtractionFixture({
        rawFindingId: 'source-weak',
        familyTag: null,
        severity: null,
        title: null,
        description: null,
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: { kind: 'code', paths: ['src/core/workflow/findings/intake-contract.ts'] },
        rawExcerpt: claim,
      })],
    });
    const firstIntake = intakeReviewerOutputs({
      subResults: [{ subStep: { name: 'architecture-review' } as never, publication: firstPublication }],
      previousLedger: emptyLedger(),
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: observedAt.runId,
      workflowTask: 'Review the implementation.',
      cwd: process.cwd(),
      scopeIdentity: 'scope-fc-real-path',
      issuedAt: observedAt.timestamp,
      reviewScopeSnapshot: snapshot,
    });
    const firstAdmission = evaluateRawAdmission({
      cwd: process.cwd(),
      reviewScopeSnapshotId: snapshot.reviewScopeSnapshotId,
      runId: observedAt.runId,
      scopeIdentity: 'scope-fc-real-path',
      previousLedger: emptyLedger(),
      intake: firstIntake,
      reviewScopeSnapshot: snapshot,
      workflowTask: 'Review the implementation.',
      presentationLimit: 2,
    });
    expect(firstIntake.items).toHaveLength(1);
    expect(firstAdmission.ladderAnomalySpecs).toHaveLength(1);
    expect(firstAdmission.admissionProvisionalSpecs).toHaveLength(0);
    const source = firstIntake.items[0]!.wire;
    const withAnomaly = applyReviewerAnomalySpecsToLedger(
      { ...emptyLedger(), rawFindings: [source] },
      firstAdmission.ladderAnomalySpecs,
      {
        workflowName: 'peer-review',
        stepName: observedAt.stepName,
        runId: observedAt.runId,
        timestamp: observedAt.timestamp,
      },
      new Set(),
    );
    const anomaly = withAnomaly.reviewerAnomalies![0]!;
    const requestWithoutId = {
      anomalyId: anomaly.id,
      reviewer: 'architecture-review',
      presentationOrdinal: 1,
      reviewScopeSnapshotId: snapshot.reviewScopeSnapshotId,
      sourceExcerptDigest: source.sourceBinding.excerptDigest,
      claimedExcerpt: anomaly.claimedExcerpt ?? claim,
      targetPaths: ['src/core/workflow/findings/intake-contract.ts'] as const,
      missingRequirements: anomaly.intakeContract!.missingRequirements,
      expectedRelation: 'new' as const,
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent' as const,
    };
    const context = createFindingReviewPresentationContextV2({
      reviewScopeSnapshotId: snapshot.reviewScopeSnapshotId,
      restatementRequests: [{
        ...requestWithoutId,
        restatementRequestId: computeRestatementRequestId(requestWithoutId),
      }],
    });
    const secondReport = `Restated report\n\n${claim}`;
    const secondPublication = createFindingReviewPublication({
      identity: {
        scopeIdentity: 'scope-fc-real-path',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 2,
        reviewerStepName: 'architecture-review',
        reportName: 'architecture-review-2.md',
      },
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: secondReport,
      rawFindings: [reviewerRawExtractionFixture({
        rawFindingId: 'admitted-restatement',
        familyTag: 'bug',
        severity: 'high',
        title: 'Observed issue',
        description: claim,
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: { kind: 'code', paths: ['src/core/workflow/findings/intake-contract.ts'] },
        evidenceRequests: [{
          kind: 'file_quote',
          path: 'src/core/workflow/findings/intake-contract.ts',
          startLine: 1,
          endLine: 1,
        }],
        rawExcerpt: claim,
      })],
      presentationContext: context,
    });
    const secondIntake = intakeReviewerOutputs({
      subResults: [{ subStep: { name: 'architecture-review' } as never, publication: secondPublication }],
      previousLedger: withAnomaly,
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 2,
      runId: observedAt.runId,
      workflowTask: 'Review the implementation.',
      cwd: process.cwd(),
      scopeIdentity: 'scope-fc-real-path',
      issuedAt: observedAt.timestamp,
      reviewScopeSnapshot: snapshot,
    });
    const secondAdmission = evaluateRawAdmission({
      cwd: process.cwd(),
      reviewScopeSnapshotId: snapshot.reviewScopeSnapshotId,
      runId: observedAt.runId,
      scopeIdentity: 'scope-fc-real-path',
      previousLedger: withAnomaly,
      intake: secondIntake,
      reviewScopeSnapshot: snapshot,
      workflowTask: 'Review the implementation.',
      presentationLimit: 2,
      restatementRequestBindings: collectRestatementRequestBindings([secondPublication]),
    });
    expect(secondAdmission.admissionAnomalySpecs).toHaveLength(0);
    expect(secondAdmission.cleanAdmitted).toHaveLength(1);
    expect(secondAdmission.verifiedEvidenceCandidates[0]?.restatementRequestBindings)
      .toHaveLength(1);
    const admitted = secondAdmission.cleanAdmitted[0]!.wire;
    const evidenceIds = secondAdmission.verifiedEvidenceRecordsByRawFindingId
      .get(admitted.rawFindingId)?.map(({ evidenceId }) => evidenceId) ?? [];
    const linked = linkPromotedReviewerAnomalies({
      ...withAnomaly,
      rawFindings: [...withAnomaly.rawFindings, admitted],
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
        evidenceIds,
        reviewers: [admitted.reviewer],
        rawFindingIds: [admitted.rawFindingId],
        firstSeen: observedAt,
        lastSeen: observedAt,
        revision: 1,
      }],
    }, secondAdmission.verifiedEvidenceCandidates);

    expect(source.sourceBinding.reportDigest).not.toBe(admitted.sourceBinding.reportDigest);
    expect(linked.reviewerAnomalies?.[0]?.promotedFindingId).toBe('F-0001');
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
      sourceBinding: {
        ...source.sourceBinding,
        reportDigest: 'e'.repeat(64),
        excerptDigest: '2'.repeat(64),
      },
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
    }, new Set());
    const anomaly = withAnomaly.reviewerAnomalies![0]!;
    const requestWithoutId = {
      anomalyId: anomaly.id,
      reviewer: source.reviewer,
      presentationOrdinal: 1,
      reviewScopeSnapshotId: '2'.repeat(64),
      sourceExcerptDigest: source.sourceBinding.excerptDigest,
      claimedExcerpt: sourceExcerpt,
      targetPaths: ['src/example.ts'] as const,
      missingRequirements: ['description'] as const,
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
        restatementRequestBindings: [{
          request: {
            ...requestWithoutId,
            restatementRequestId: computeRestatementRequestId(requestWithoutId),
          },
          publicationId: publication.publicationId,
          reportDigest: admitted.sourceBinding.reportDigest,
        }],
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
    }, new Set());
    const anomalyId = withAnomaly.reviewerAnomalies![0]!.id;
    const publications = [1, 2, 3].map((stepIteration) => {
      const requestWithoutId = {
        anomalyId,
        reviewer: source.reviewer,
        presentationOrdinal: stepIteration,
        reviewScopeSnapshotId: 'a'.repeat(64),
        sourceExcerptDigest: source.sourceBinding.excerptDigest,
        claimedExcerpt: source.claimedExcerpt ?? source.rawExcerpt ?? '',
        targetPaths: ['src/example.ts'] as const,
        missingRequirements: ['description'] as const,
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
          claimedExcerpt: `Claim ${anomalyId}`,
          targetPaths: [] as const,
          missingRequirements: [] as const,
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
      const ordinalContext = createFindingReviewPresentationContextV2({
        reviewScopeSnapshotId: '3'.repeat(64),
        restatementRequests: requests.map((request, index) => ({
          ...request,
          presentationOrdinal: index === 0 ? 10 : 2,
          restatementRequestId: computeRestatementRequestId({
            ...request,
            presentationOrdinal: index === 0 ? 10 : 2,
          }),
        })),
      });
      expect(ordinalContext.restatementRequests.map(({ presentationOrdinal }) => presentationOrdinal))
        .toEqual([2, 10]);
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
      claimedExcerpt: 'A bounded reviewer claim.',
      targetPaths: [] as const,
      missingRequirements: [] as const,
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

  it('wires outstanding reviewer anomalies into the reviewer ledger summary', () => {
    const raw = incompleteRaw('raw-instruction-anomaly', {
      rawExcerpt: 'The reviewer claim must be restated with evidence.',
    });
    const canonical = canonicalItem(raw);
    const anomaly = applyReviewerAnomalySpecsToLedger(emptyLedger(), [createReviewerAnomalySpec({
      wire: raw,
      canonical: canonical.canonical,
      anomalyKind: 'intake-contract-incomplete',
      reason: 'The normalized claim omitted evidence.',
      intakeContract: {
        observationClass: 'claim-bearing',
        classificationAuthorityId: 'system/intake_observation_classification_v1',
        reasonCodes: ['claim-evidence-missing'],
        missingRequirements: ['claimEvidence'],
        presentationOwnerReviewer: raw.reviewer,
        presentationLimit: 2,
      },
    })], {
      workflowName: 'peer-review',
      stepName: raw.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    }, new Set());
    const summary = JSON.parse(renderFindingLedgerInstructionSummary(anomaly)) as {
      reviewerAnomalies?: Array<{
        id: string;
        reviewer: string;
        claimedExcerpt?: string;
        missingRequirements: string[];
      }>;
    };

    expect(summary.reviewerAnomalies).toEqual([{
      id: anomaly.reviewerAnomalies![0]!.id,
      kind: 'intake-contract-incomplete',
      reviewer: raw.reviewer,
      title: anomaly.reviewerAnomalies![0]!.title,
      mismatchReason: 'The normalized claim omitted evidence.',
      claimedExcerpt: 'The reviewer claim must be restated with evidence.',
      observationClass: 'claim-bearing',
      reasonCodes: ['claim-evidence-missing'],
      missingRequirements: ['claimEvidence'],
    }]);
  });

  // 言い直し予算に乗らない kind でも、是正信号（kind と mismatchReason）は届ける。
  // 届かないと、レビュアーは同じ壊れ方を毎ラウンド繰り返す。ただし claim 本文は
  // 出さない — 予算の無い経路へ REJECT レポート全文を毎ラウンド流さないため。
  it('wires non-restatement reviewer anomalies into the summary without their claim body', () => {
    const raw = incompleteRaw('raw-instruction-non-intake', {
      rawExcerpt: 'verdict: needs_fix\n\nA very long REJECT report body.',
    });
    const canonical = canonicalItem(raw);
    const anomaly = applyReviewerAnomalySpecsToLedger(emptyLedger(), [createReviewerAnomalySpec({
      wire: raw,
      canonical: canonical.canonical,
      anomalyKind: 'verdict-claims-mismatch',
      reason: 'The non-approving verdict published zero structured raw findings.',
    })], {
      workflowName: 'peer-review',
      stepName: raw.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    }, new Set());
    const rendered = renderFindingLedgerInstructionSummary(anomaly);
    const summary = JSON.parse(rendered) as {
      reviewerAnomalies?: Array<Record<string, unknown>>;
      reviewerAnomaliesOmittedCount?: number;
    };

    // 露出制限は「特定文字列が出ない」ではなく、公開フィールド集合の完全一致で
    // 縛る。claim 本文を運ぶキー（claimedExcerpt / claimedLocation）や intake 専用の
    // 契約内訳が新設・再導入されたら、この一致で必ず落ちる。
    expect(summary.reviewerAnomalies).toEqual([{
      id: anomaly.reviewerAnomalies![0]!.id,
      kind: 'verdict-claims-mismatch',
      reviewers: [raw.reviewer],
      title: anomaly.reviewerAnomalies![0]!.title,
      mismatchReason: 'The non-approving verdict published zero structured raw findings.',
    }]);
    expect(Object.keys(summary.reviewerAnomalies![0]!).sort()).toEqual([
      'id',
      'kind',
      'mismatchReason',
      'reviewers',
      'title',
    ]);
    // 台帳側には claim が保持されているのに、提示側には出ていないことを対にして示す。
    expect(anomaly.reviewerAnomalies![0]!.claimedExcerpt).toContain('A very long REJECT report body.');
    expect(rendered).not.toContain('A very long REJECT report body.');
    expect(summary.reviewerAnomaliesOmittedCount).toBeUndefined();
  });

  // 非 intake は提示予算にも restatement 枠にも乗らないので、件数を独自に縛る。
  // 縛りは黙って落とさず、切り捨て件数を開示する。
  it('bounds the number of non-restatement reviewer anomalies and discloses the omitted count', () => {
    const total = 20;
    const specs = Array.from({ length: total }, (_, index) => {
      const suffix = String(index).padStart(2, '0');
      return {
        kind: 'quote-mismatch' as const,
        stableKey: `sk-bulk-${suffix}`,
        lineageKey: `lk-bulk-${suffix}`,
        sourceRawFindingIds: [],
        sourceIntakeIds: [`intake-bulk-${suffix}`],
        reviewers: ['arch-review'],
        title: `Quote mismatch ${suffix}`,
        mismatchReason: `Quote ${suffix} did not match.`,
      };
    });
    const anomaly = applyReviewerAnomalySpecsToLedger(emptyLedger(), specs, {
      workflowName: 'peer-review',
      stepName: 'reviewers',
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    }, new Set());
    const summary = JSON.parse(renderFindingLedgerInstructionSummary(anomaly)) as {
      reviewerAnomalies?: Array<Record<string, unknown>>;
      reviewerAnomaliesOmittedCount?: number;
    };

    expect(anomaly.reviewerAnomalies).toHaveLength(total);
    expect(summary.reviewerAnomalies).toHaveLength(16);
    expect(summary.reviewerAnomaliesOmittedCount).toBe(total - 16);
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
    }, new Set());
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
});

function sourceReport(context: unknown): string {
  return `Restatement context ${JSON.stringify(context)}`;
}
