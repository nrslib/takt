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
import type { FileQuoteEvidence } from '../core/models/finding-types.js';
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
import {
  applyReviewerAnomalySpecsToLedger,
  createReviewerAnomalySpec,
  isOutstandingReviewerAnomaly,
  linkPromotedReviewerAnomalies,
  restatementReassertionFailsCorrespondence,
  selectRestatementSourceClaimAtom,
} from '../core/workflow/findings/reviewer-anomalies.js';
import {
  assertFindingReviewPresentationContext,
  computeRestatementRequestId,
  collectRestatementRequestBindings,
  createFindingReviewPresentationContextV2,
  createFindingReviewPublication,
  loadFindingReviewPublication,
  listFindingReviewPublications,
  persistFindingReviewPublication,
  PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { computeRawPayloadDigest } from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { collectFindingLedgerProjectionInvariantViolations } from '../core/models/finding-ledger-invariants.js';
import { buildFindingContractInstruction } from '../core/workflow/instruction/finding-contract-instruction.js';
import {
  buildFindingsRuleContext,
  renderFindingLedgerInstructionSummary,
} from '../core/workflow/findings/context.js';
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
import {
  classifyIntakeReviewIntegrityFailure,
} from '../core/workflow/findings/review-integrity.js';
import {
  reviewerAnomalySettlementEligibilityViolation,
} from '../core/models/finding-reviewer-anomaly-settlement-policy.js';
import { computeWorkflowTaskDigest } from '../core/workflow/findings/task-scope-adjudication.js';

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

  it('terminates an intake anomaly whose observation carries no demandable claim atom', () => {
    // description も rawExcerpt も持たない観測。言い直し要求が作られないため提示に
    // よる終端にも到達せず、放置すると未決着のまま COMPLETE を永久に塞ぐ。
    const source = incompleteRaw('raw-undemandable', {
      description: null,
      rawExcerpt: '   ',
    });
    const spec = createReviewerAnomalySpec({
      wire: source,
      canonical: canonicalItem(source).canonical,
      anomalyKind: 'intake-contract-incomplete',
      reason: 'The normalized claim omitted every claim body',
      intakeContract: {
        observationClass: 'claim-bearing' as const,
        classificationAuthorityId: 'system/intake_observation_classification_v1',
        reasonCodes: ['normalizer-extraction-loss'] as const,
        missingRequirements: ['description'] as const,
        presentationOwnerReviewer: source.reviewer,
        presentationLimit: 3,
      },
    });
    const withAnomaly = applyReviewerAnomalySpecsToLedger(emptyLedger(), [spec], {
      workflowName: 'peer-review',
      stepName: observedAt.stepName,
      runId: observedAt.runId,
      timestamp: observedAt.timestamp,
    }, new Set());
    const ledgerWithSource = { ...withAnomaly, rawFindings: [source] };

    const committed = applyCommitLedgerStates({
      runInput: {
        workflowName: 'peer-review',
        parentStep: { name: 'reviewers' },
        runId: observedAt.runId,
        timestamp: observedAt.timestamp,
        subResults: [],
      } as never,
      freshLedger: ledgerWithSource,
      settledLedger: ledgerWithSource,
      baseAnomalySpecs: [],
      pendingRejectedObservations: [],
      verifiedEvidenceCandidates: [],
      anomalyAdjudications: [],
    });

    const terminal = committed.ledger.reviewerAnomalies![0]!.intakeContract!.terminalDisposition;
    // 提示を1回も行わずにその場で終端し、gate を塞がなくなる。
    // claim-bearing は「主張はあったのに機械可読な形で残らなかった」事実を
    // 可視的失敗として扱う（protocol-noise だけが静かに却下される）。
    expect(terminal).toMatchObject({
      kind: 'undemandable_claim_atom',
      workflowOutcome: 'review_integrity_unresolved',
    });
    expect(terminal?.terminalPublicationId).toBeUndefined();
    // claim-bearing は握りつぶさない。終端した（= 提示予算を待たずに決着経路へ
    // 入った）が未決着のままで、review-integrity gate の可視的失敗へ送られる。
    // 静かに落ちるのは protocol-noise だけ。
    expect(isOutstandingReviewerAnomaly(committed.ledger.reviewerAnomalies![0]!)).toBe(true);
  });

  describe('failed restatement reassertion', () => {
    const fileQuote = (overrides: Partial<FileQuoteEvidence> = {}): FileQuoteEvidence => ({
      kind: 'file_quote',
      path: 'src/example.ts',
      startLine: 10,
      endLine: 12,
      verbatimExcerpt: 'const target = false;',
      snapshotId: '5'.repeat(64),
      ...overrides,
    });
    const reassertionCase = (
      admittedDescription: string,
      quotes: { source?: readonly FileQuoteEvidence[]; admitted?: readonly FileQuoteEvidence[] } = {},
    ) => {
      const sourceExcerpt = 'The reasserted defect remains observable.';
      const source = incompleteRaw('raw-reassert-source', {
        rawExcerpt: sourceExcerpt,
        evidence: [...(quotes.source ?? [])],
        sourceBinding: {
          reportDigest: 'f'.repeat(64),
          startByte: 0,
          endByte: Buffer.byteLength(sourceExcerpt),
          excerptDigest: '3'.repeat(64),
        },
      });
      const spec = createReviewerAnomalySpec({
        wire: source,
        canonical: canonicalItem(source).canonical,
        anomalyKind: 'intake-contract-incomplete',
        reason: 'Normalizer lost the source-bound description',
        intakeContract: {
          observationClass: 'claim-bearing' as const,
          classificationAuthorityId: 'system/intake_observation_classification_v1',
          reasonCodes: ['normalizer-extraction-loss'] as const,
          missingRequirements: ['description'] as const,
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
      const admitted = canonicalRawFindingFixture({
        rawFindingId: 'raw-reassert-admitted',
        stepName: source.stepName,
        reviewer: source.reviewer,
        familyTag: 'bug',
        severity: 'high',
        title: 'Observed issue',
        description: admittedDescription,
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: source.target,
        sourceBinding: {
          ...source.sourceBinding,
          reportDigest: 'e'.repeat(64),
          excerptDigest: '4'.repeat(64),
        },
        evidence: [...(quotes.admitted ?? [])],
        reassertsReviewerAnomalyId: anomaly.id,
      });
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
      return {
        ledger: { ...withAnomaly, rawFindings: [source] },
        admitted,
        bindings: [{
          request: {
            ...requestWithoutId,
            restatementRequestId: computeRestatementRequestId(requestWithoutId),
          },
          publicationId: 'publication-reassert',
          reportDigest: admitted.sourceBinding.reportDigest,
        }],
      };
    };

    it('flags a reassertion whose claim atom does not reproduce the request', () => {
      const { ledger, admitted, bindings } = reassertionCase('A different claim entirely.');

      // 照合に失敗した再主張を新規 finding として鋳造すると、同じ主張が言い直しの
      // たびに別 finding として積み上がる。admission はこれを弾く。
      expect(restatementReassertionFailsCorrespondence({
        ledger,
        admittedRaw: admitted,
        bindings,
      })).toBe(true);
    });

    it('drops the echo when this call requested no restatement for that anomaly', () => {
      // anomaly は実在するが、この呼び出しではその言い直しを要求していない。
      // 要求していないものを「言い直しの失敗」とは判定できないので、echo を落として
      // 通常の新規 claim として評価させる（正当な新規指摘を殺さない）。
      const { ledger, admitted } = reassertionCase('A different claim entirely.');

      expect(restatementReassertionFailsCorrespondence({
        ledger,
        admittedRaw: admitted,
        bindings: [],
      })).toBe(false);
    });

    it('lets an exact reassertion through so it can still be promoted', () => {
      const { ledger, admitted, bindings } = reassertionCase('The reasserted defect remains observable.');

      expect(restatementReassertionFailsCorrespondence({
        ledger,
        admittedRaw: admitted,
        bindings,
      })).toBe(false);
    });

    it('lets a reassertion through when it reproduces every source file quote', () => {
      // 元の観測が file_quote を持つ場合、claim atom が一致しても quote を写して
      // いなければ言い直しとして受理しない。まず「全部写した」側を固定する。
      const { ledger, admitted, bindings } = reassertionCase(
        'The reasserted defect remains observable.',
        { source: [fileQuote()], admitted: [fileQuote()] },
      );

      expect(restatementReassertionFailsCorrespondence({
        ledger,
        admittedRaw: admitted,
        bindings,
      })).toBe(false);
    });

    // quote 照合は4項目すべての完全一致を要求する。どれか1つでも緩むと、別の場所を
    // 指す再主張が言い直しとして受理される。
    it.each([
      ['path', { path: 'src/other.ts' }],
      ['startLine', { startLine: 11 }],
      ['endLine', { endLine: 13 }],
      ['verbatimExcerpt', { verbatimExcerpt: 'const target = true;' }],
    ] as const)('flags a reassertion whose file quote differs in %s', (_field, override) => {
      const { ledger, admitted, bindings } = reassertionCase(
        'The reasserted defect remains observable.',
        { source: [fileQuote()], admitted: [fileQuote(override)] },
      );

      expect(restatementReassertionFailsCorrespondence({
        ledger,
        admittedRaw: admitted,
        bindings,
      })).toBe(true);
    });

    it('has no demandable atom when the observation carries neither description nor excerpt', () => {
      // 言い直しの照合が要求する claim 本文を選べない観測。request を作ると
      // 「見せた文をそのまま写しても受理されない」充足不能な要求になる。
      expect(selectRestatementSourceClaimAtom(
        { claimedExcerpt: '   ' },
        { description: undefined, rawExcerpt: '  ' },
      )).toBeUndefined();
      expect(selectRestatementSourceClaimAtom(
        { claimedExcerpt: undefined },
        { description: 'A claim body.', rawExcerpt: undefined },
      )).toBe('A claim body.');
    });
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

    // 実走行(2026-08)の言い直し失敗 263 件のうち 210 件(80%)がこれ: reviewer は
    // claim atom を「より正確に」書き直す。glm の実例は 400 字の atom へ
    // `（L113-116）` を挿入しただけで correspondence が落ちていた。
    //
    // この厳密さは意図的なもので、ここを substring 一致や類似度に緩めると別の
    // 指摘が同じ anomaly に吸着して lifecycle 同一性が壊れる。再提示ループを
    // 「緩めて直った」ことにできないよう、near-miss が落ちることを固定する。
    // 正しい対処は prompt 側の逐語コピー規則
    // (src/shared/prompts/{ja,en}/parts/finding_contract_instruction.md)。
    it('does not promote when the restatement only inserts a parenthetical into the claim atom', () => {
      const claim = 'The redaction regexp no longer matches the interpolated value.';
      const nearMiss = 'The redaction regexp (L113-116) no longer matches the interpolated value.';
      const base = buildBatchCase('near-miss', claim, '5', 'a');
      const { ledger, anomalyOf } = anomaliesFor([base]);
      const anomaly = anomalyOf(base.source);
      const bindings = [{
        request: batchRequestFor(base.source, anomaly.id, claim),
        publicationId: 'publication-near-miss',
        reportDigest: batchReportDigest,
      }];
      // echo 無し / echo 付きの両方で落ちることを見る。echo 無しだけだと、
      // hasValidRestatementEcho に「echo が一致したら correspondence を省略する」
      // ショートカットが入っても発火せず、near-miss の緩みを見逃す。
      for (const reassertsReviewerAnomalyId of [undefined, anomaly.id]) {
        const nearMissAdmitted = canonicalRawFindingFixture({
          ...base.admitted,
          description: nearMiss,
          ...(reassertsReviewerAnomalyId === undefined ? {} : { reassertsReviewerAnomalyId }),
        });

        const linked = linkPromotedReviewerAnomalies({
          ...ledger,
          rawFindings: [base.source, nearMissAdmitted],
          findings: [batchFindingFor(nearMissAdmitted, 'F-0010')],
        }, [{
          lineageKey: 'lineage-near-miss',
          rawFindingId: nearMissAdmitted.rawFindingId,
          restatementRequestBindings: bindings,
        }]);
        expect(
          linked.reviewerAnomalies![0]!.promotedFindingId,
          `echo=${String(reassertsReviewerAnomalyId)}`,
        ).toBeUndefined();
      }

      // 正の対照: 同じ fixture のまま description を逐語に戻すと昇格する。
      // 上の拒否が「atom 不一致由来」であって shape 由来でないことの識別。
      const verbatimLinked = linkPromotedReviewerAnomalies({
        ...ledger,
        rawFindings: [base.source, base.admitted],
        findings: [batchFindingFor(base.admitted, 'F-0010')],
      }, [{
        lineageKey: 'lineage-near-miss',
        rawFindingId: base.admitted.rawFindingId,
        restatementRequestBindings: bindings,
      }]);
      expect(verbatimLinked.reviewerAnomalies![0]!.promotedFindingId).toBe('F-0010');
    });

    /**
     * 実走行(2026-08-07)の停止事故。終端処分済みの anomaly が以後のラウンドでも
     * 提示され続け、最後の言い直しが照合を通った瞬間に promotedFindingId が付いて
     * 終端処分と同居し、台帳不変条件で run ごと落ちた。
     *
     * 形は実データそのまま: intake-contract-incomplete /
     * restatement_exhausted_claim_bearing / 旧契約語彙の missingRequirements。
     */
    it('does not promote an anomaly that already carries a terminal disposition', () => {
      const claim = 'The legacy signal setting no longer matches the requested contract.';
      const base = buildBatchCase('terminal', claim, '6', 'b');
      const { ledger, anomalyOf } = anomaliesFor([base]);
      const anomaly = anomalyOf(base.source);
      const bindings = [{
        request: batchRequestFor(base.source, anomaly.id, claim),
        publicationId: 'publication-terminal',
        reportDigest: batchReportDigest,
      }];
      const disposedLedger: FindingLedger = {
        ...ledger,
        rawFindings: [base.source, base.admitted],
        findings: [batchFindingFor(base.admitted, 'F-0011')],
        reviewerAnomalies: ledger.reviewerAnomalies!.map((entry) => ({
          ...entry,
          intakeContract: {
            ...entry.intakeContract!,
            // 実データの旧契約語彙（binary 昇順・重複なし）。
            missingRequirements: ['relation', 'severity'] as const,
            terminalDisposition: {
              kind: 'restatement_exhausted_claim_bearing' as const,
              workflowOutcome: 'review_integrity_unresolved' as const,
              decidedAt: observedAt,
              terminalPublicationId: 'publication-terminal-source',
              reason: 'Restatement presentation limit 2 was reached without verified correspondence',
            },
          },
        })),
      };
      // fixture は raw canonical snapshot を持たないため、この不変条件だけを見る。
      const anomalyViolations = (ledgerUnderTest: FindingLedger) => (
        collectFindingLedgerProjectionInvariantViolations(ledgerUnderTest)
          .filter((violation) => violation.path[0] === 'reviewerAnomalies')
      );
      expect(anomalyViolations(disposedLedger)).toEqual([]);

      const linked = linkPromotedReviewerAnomalies(disposedLedger, [{
        lineageKey: 'lineage-terminal',
        rawFindingId: base.admitted.rawFindingId,
        restatementRequestBindings: bindings,
      }]);

      expect(linked.reviewerAnomalies![0]!.promotedFindingId).toBeUndefined();
      expect(anomalyViolations(linked)).toEqual([]);

      // 正の対照: 同じ fixture から終端処分だけを外すと昇格が成立する。上の拒否が
      // 「終端処分由来」であって fixture 由来でないことの識別。
      const openLinked = linkPromotedReviewerAnomalies({
        ...ledger,
        rawFindings: [base.source, base.admitted],
        findings: [batchFindingFor(base.admitted, 'F-0011')],
      }, [{
        lineageKey: 'lineage-terminal',
        rawFindingId: base.admitted.rawFindingId,
        restatementRequestBindings: bindings,
      }]);
      expect(openLinked.reviewerAnomalies![0]!.promotedFindingId).toBe('F-0011');
    });
  });

  /**
   * 終端処分は決着であり、以後どの経路も触らない。ここでは「触らない」の残り2面
   * （upsert の取り込み先選定と、when() へ出す提示系カウンタ）を固定する。
   */
  describe('terminal disposition closes the episode', () => {
    const terminalDisposition = {
      kind: 'restatement_exhausted_claim_bearing' as const,
      workflowOutcome: 'review_integrity_unresolved' as const,
      decidedAt: observedAt,
      terminalPublicationId: 'publication-closed',
      reason: 'Restatement presentation limit 6 was reached without verified correspondence',
    };
    /** 実データの形の intake anomaly を1件だけ持つ台帳を作る。 */
    const disposedLedger = (rawFindingId: string) => {
      const wire = incompleteRaw(rawFindingId, {
        rawExcerpt: 'The closed defect remains observable.',
      });
      const spec = createReviewerAnomalySpec({
        wire,
        canonical: canonicalItem(wire).canonical,
        anomalyKind: 'intake-contract-incomplete',
        reason: 'Independent reviewer observation does not satisfy the product admission contract',
        intakeContract: {
          observationClass: 'claim-bearing',
          classificationAuthorityId: 'system/intake_observation_classification_v1',
          reasonCodes: ['product-identity-incomplete'],
          // 実データの旧契約語彙（binary 昇順・重複なし）。
          missingRequirements: ['relation', 'severity'],
          presentationOwnerReviewer: wire.reviewer,
          presentationLimit: 6,
        },
      });
      const ledger = applyReviewerAnomalySpecsToLedger(emptyLedger(), [spec], {
        workflowName: 'peer-review',
        stepName: observedAt.stepName,
        runId: observedAt.runId,
        timestamp: observedAt.timestamp,
      }, new Set());
      return {
        wire,
        spec,
        ledger: {
          ...ledger,
          rawFindings: [wire],
          reviewerAnomalies: ledger.reviewerAnomalies!.map((entry) => ({
            ...entry,
            intakeContract: { ...entry.intakeContract!, terminalDisposition },
          })),
        },
      };
    };

    it('lands a re-observation as a new episode instead of mutating the closed one', () => {
      const { wire, spec, ledger } = disposedLedger('raw-closed-source');
      const closed = ledger.reviewerAnomalies![0]!;
      // 同じ主張の再観測。stable key は sourceBinding の excerpt digest で決まるので
      // raw finding id だけが変わる（ラウンドごとの名前空間付き id を再現）。
      const reobserved = incompleteRaw('raw-closed-reobserved', {
        rawExcerpt: wire.rawExcerpt,
        sourceBinding: wire.sourceBinding,
      });
      const respec = createReviewerAnomalySpec({
        wire: reobserved,
        canonical: canonicalItem(reobserved).canonical,
        anomalyKind: 'intake-contract-incomplete',
        reason: 'Independent reviewer observation does not satisfy the product admission contract',
        // 取り込みが組む defect は分類結果だけを持つ。終端処分は台帳側の決着記録。
        intakeContract: spec.intakeContract!,
      });
      expect(respec.stableKey).toBe(closed.stableKey);

      const applied = applyReviewerAnomalySpecsToLedger({
        ...ledger,
        rawFindings: [wire, reobserved],
      }, [respec], {
        workflowName: 'peer-review',
        stepName: observedAt.stepName,
        runId: observedAt.runId,
        timestamp: '2026-08-05T01:00:00.000Z',
      }, new Set());

      // 決着済み episode は1バイトも動かない。
      expect(applied.reviewerAnomalies![0]).toEqual(closed);
      // 再観測は別 episode として着地する（観測は消えない）。
      expect(applied.reviewerAnomalies).toHaveLength(2);
      const fresh = applied.reviewerAnomalies![1]!;
      expect(fresh.id).not.toBe(closed.id);
      expect(fresh.sourceRawFindingIds).toEqual([reobserved.rawFindingId]);
      expect(fresh.intakeContract?.terminalDisposition).toBeUndefined();
      // 決着済みは live episode ではないので「未決着が複数」にはならない。
      expect(collectFindingLedgerProjectionInvariantViolations(applied)
        .filter((violation) => violation.path[0] === 'reviewerAnomalies'))
        .toEqual([]);
    });

    it('keeps a closed anomaly out of the counters that route back to presentation', () => {
      const { ledger } = disposedLedger('raw-closed-counter');
      const anomalyId = ledger.reviewerAnomalies![0]!.id;
      // 提示予算は残っている（1 回だけ提示済み / 上限 6）。修正が無いと
      // restatementReadyCount が 1 のまま needs_review へ送り続ける。
      const context = buildFindingsRuleContext(
        ledger,
        process.cwd(),
        new Map([[anomalyId, 1]]),
      ).reviewerAnomalies;

      expect(context.restatementReadyCount).toBe(0);
      expect(context.requiresGuaranteedPresentationCount).toBe(0);
      // 終端はゲートを塞ぎ続け、terminal adjudication ルートへ送る。
      expect(context.claimBearingTerminalCount).toBe(1);
      expect(context.count).toBe(1);
    });

    /**
     * 完了ゲートの診断が原因を指すこと。決着済みを「提示されていない（配線漏れ）」と
     * 報告すると、実際の原因（終端処分が未決着のまま残っている）が隠れる。
     */
    describe('completion gate diagnosis', () => {
      it('reports the exhausted cause for a terminally disposed anomaly instead of an unpresented one', () => {
        const { ledger } = disposedLedger('raw-closed-diagnosis');
        const classification = classifyIntakeReviewIntegrityFailure({
          anomalies: ledger.reviewerAnomalies!,
          // 提示は別の workflow_call 名前空間で行われたため、このゲートからは0件に見える。
          presentationCounts: new Map(),
        });

        expect(classification?.code).toBe('restatement_exhausted_claim_bearing');
        expect(classification?.unpresentedIds).toEqual([]);
        expect(classification?.reason).toContain('restatement limit was exhausted');
        expect(classification?.anomalyIds).toEqual([ledger.reviewerAnomalies![0]!.id]);
      });

      it('reports the exhausted cause for a terminal that never demanded a presentation', () => {
        // undemandable_claim_atom は提示を1回も行わずに終端する正規の kind。
        // 提示回数をどう数え直しても「提示済み」にはならないので、決着済みを
        // unpresented から外すことでしか正しく診断できない。
        const { ledger } = disposedLedger('raw-closed-undemandable');
        const undemandable = {
          ...ledger,
          reviewerAnomalies: ledger.reviewerAnomalies!.map((entry) => ({
            ...entry,
            intakeContract: {
              ...entry.intakeContract!,
              terminalDisposition: {
                kind: 'undemandable_claim_atom' as const,
                workflowOutcome: 'review_integrity_unresolved' as const,
                decidedAt: observedAt,
                reason: 'The recorded observation carries no claim body that a restatement request could ask back',
              },
            },
          })),
        };

        expect(classifyIntakeReviewIntegrityFailure({
          anomalies: undemandable.reviewerAnomalies,
          presentationCounts: new Map(),
        })?.code).toBe('restatement_exhausted_claim_bearing');
      });

      /**
       * 救済経路の全体像。終端処分済みは自動では決着せず、terminal adjudication の
       * 裁定却下だけが決着させる。決着したら完了ゲートは通る。
       */
      it('lets the completion gate pass once terminal adjudication dismissed the anomaly', () => {
        const { wire, ledger } = disposedLedger('raw-closed-adjudicated');
        const anomaly = ledger.reviewerAnomalies![0]!;
        const workflowTask = 'Rename the legacy signal fields under src/infra/config/runtime-provider/.';
        const settlement = {
          kind: 'dismissed_by_terminal_adjudication' as const,
          basis: 'outside_task_scope' as const,
          // workflow task の byte-exact 部分文字列。
          taskQuote: 'Rename the legacy signal fields',
          workflowTaskDigest: computeWorkflowTaskDigest(workflowTask),
          // anomaly が記録した claim 本文の byte-exact 部分文字列。
          claimQuote: wire.rawExcerpt!.slice(0, 20),
          adjudicationTaskId: 'd'.repeat(64),
          reason: 'The claim targets a module the task never asked to change',
          decidedAt: observedAt,
        };

        expect(reviewerAnomalySettlementEligibilityViolation({
          projection: ledger,
          anomaly,
          settlement,
          sourceHead: { kind: 'projection' },
          workflowTaskDigest: computeWorkflowTaskDigest(workflowTask),
        })).toBeUndefined();

        const settled = {
          ...ledger,
          reviewerAnomalies: [{ ...anomaly, settlement }],
        };
        // 台帳不変条件（成立条件つき）を通り、未決着でなくなり、完了ゲートも通る。
        expect(collectFindingLedgerProjectionInvariantViolations(settled)
          .filter((violation) => violation.path[0] === 'reviewerAnomalies'))
          .toEqual([]);
        expect(isOutstandingReviewerAnomaly(settled.reviewerAnomalies[0]!)).toBe(false);
        expect(classifyIntakeReviewIntegrityFailure({
          anomalies: settled.reviewerAnomalies.filter(isOutstandingReviewerAnomaly),
          presentationCounts: new Map(),
        })).toBeUndefined();
      });

      it.each([
        ['a claim quote that is not in the recorded claim', {
          claimQuote: 'a paraphrase the reviewer never wrote',
        }],
        ['a workflow task binding from another task', {
          workflowTaskDigest: 'e'.repeat(64),
        }],
      ] as const)('refuses an adjudication with %s', (_label, override) => {
        const { wire, ledger } = disposedLedger('raw-closed-refused');
        const workflowTask = 'Rename the legacy signal fields under src/infra/config/runtime-provider/.';

        expect(reviewerAnomalySettlementEligibilityViolation({
          projection: ledger,
          anomaly: ledger.reviewerAnomalies![0]!,
          settlement: {
            kind: 'dismissed_by_terminal_adjudication',
            basis: 'outside_task_scope',
            taskQuote: 'Rename the legacy signal fields',
            workflowTaskDigest: computeWorkflowTaskDigest(workflowTask),
            claimQuote: wire.rawExcerpt!.slice(0, 20),
            adjudicationTaskId: 'd'.repeat(64),
            reason: 'The claim targets a module the task never asked to change',
            decidedAt: observedAt,
            ...override,
          },
          sourceHead: { kind: 'projection' },
          workflowTaskDigest: computeWorkflowTaskDigest(workflowTask),
        })).toBeDefined();
      });

      it('keeps forbidding a non-adjudication settlement on a terminally disposed anomaly', () => {
        // 裁定却下だけが終端処分と同居できる。他の決着が同居できると、提示が
        // 止まらず昇格や取り下げが後付けされる実事故を捕まえた検査が緩む。
        const { ledger } = disposedLedger('raw-closed-forbidden');
        const anomaly = ledger.reviewerAnomalies![0]!;

        const withSettlement = (settlement: NonNullable<typeof anomaly.settlement>) => (
          collectFindingLedgerProjectionInvariantViolations({
            ...ledger,
            reviewerAnomalies: [{ ...anomaly, settlement }],
          }).filter((violation) => violation.path.at(-1) === 'terminalDisposition')
        );

        expect(withSettlement({
          kind: 'withdrawn_by_subsequent_review',
          supersedingPublications: [{ reviewer: anomaly.reviewers[0]!, publicationId: 'a'.repeat(64) }],
          decidedAt: observedAt,
        })).toHaveLength(1);
        expect(withSettlement({
          kind: 'target_resolved_by_verified_evidence',
          findingId: 'F-0001',
          lifecycleEventId: 'event-1',
        })).toHaveLength(1);
        expect(withSettlement({
          kind: 'target_dismissed_by_terminal_adjudication',
          findingId: 'F-0001',
          lifecycleEventId: 'event-1',
        })).toHaveLength(1);
      });

      it('refuses to adjudicate an anomaly whose restatement ladder is still open', () => {
        // 対象は終端処分済みだけ。ラダーの途中で裁定却下できると、言い直しの機会を
        // 奪ったうえに可視的失敗も消える。
        const raw = incompleteRaw('raw-open-adjudication', {
          rawExcerpt: 'The open defect remains observable.',
        });
        const workflowTask = 'Rename the legacy signal fields.';
        const openLedger = applyReviewerAnomalySpecsToLedger(emptyLedger(), [createReviewerAnomalySpec({
          wire: raw,
          canonical: canonicalItem(raw).canonical,
          anomalyKind: 'intake-contract-incomplete',
          reason: 'Independent reviewer observation does not satisfy the product admission contract',
          intakeContract: {
            observationClass: 'claim-bearing',
            classificationAuthorityId: 'system/intake_observation_classification_v1',
            reasonCodes: ['product-identity-incomplete'],
            missingRequirements: ['relation', 'severity'],
            presentationOwnerReviewer: raw.reviewer,
            presentationLimit: 6,
          },
        })], {
          workflowName: 'peer-review',
          stepName: observedAt.stepName,
          runId: observedAt.runId,
          timestamp: observedAt.timestamp,
        }, new Set());

        expect(reviewerAnomalySettlementEligibilityViolation({
          projection: { ...openLedger, rawFindings: [raw] },
          anomaly: openLedger.reviewerAnomalies![0]!,
          settlement: {
            kind: 'dismissed_by_terminal_adjudication',
            basis: 'outside_task_scope',
            taskQuote: 'Rename the legacy signal fields',
            workflowTaskDigest: computeWorkflowTaskDigest(workflowTask),
            claimQuote: 'The open defect',
            adjudicationTaskId: 'd'.repeat(64),
            reason: 'out of scope',
            decidedAt: observedAt,
          },
          sourceHead: { kind: 'projection' },
          workflowTaskDigest: computeWorkflowTaskDigest(workflowTask),
        })).toBe('terminal adjudication may only dismiss a claim-bearing anomaly whose restatement ladder terminated unresolved');
      });

      it('refuses to settle an anomaly that is already settled', () => {
        // 二重決着の禁止。決着済みの上書きは監査記録を壊す。
        const { wire, ledger } = disposedLedger('raw-closed-twice');
        const workflowTask = 'Rename the legacy signal fields under src/infra/config/runtime-provider/.';
        const settled = {
          ...ledger.reviewerAnomalies![0]!,
          settlement: {
            kind: 'dismissed_by_terminal_adjudication' as const,
            basis: 'outside_task_scope' as const,
            taskQuote: 'Rename the legacy signal fields',
            workflowTaskDigest: computeWorkflowTaskDigest(workflowTask),
            claimQuote: wire.rawExcerpt!.slice(0, 20),
            adjudicationTaskId: 'd'.repeat(64),
            reason: 'already decided',
            decidedAt: observedAt,
          },
        };

        expect(reviewerAnomalySettlementEligibilityViolation({
          projection: ledger,
          anomaly: settled,
          settlement: {
            kind: 'dismissed_by_terminal_adjudication',
            basis: 'outside_task_scope',
            taskQuote: 'Rename the legacy signal fields',
            workflowTaskDigest: computeWorkflowTaskDigest(workflowTask),
            claimQuote: wire.rawExcerpt!.slice(0, 20),
            adjudicationTaskId: 'e'.repeat(64),
            reason: 'a second decision',
            decidedAt: observedAt,
          },
          sourceHead: { kind: 'projection' },
          workflowTaskDigest: computeWorkflowTaskDigest(workflowTask),
        })).toBe('already settled anomalies cannot be settled again');
      });

      it('still reports the unpresented cause while the anomaly is open', () => {
        // 正の対照: 終端処分が無い anomaly は「提示されていない」＝配線漏れのまま。
        const raw = incompleteRaw('raw-open-diagnosis', {
          rawExcerpt: 'The open defect remains observable.',
        });
        const ledger = applyReviewerAnomalySpecsToLedger(emptyLedger(), [createReviewerAnomalySpec({
          wire: raw,
          canonical: canonicalItem(raw).canonical,
          anomalyKind: 'intake-contract-incomplete',
          reason: 'Independent reviewer observation does not satisfy the product admission contract',
          intakeContract: {
            observationClass: 'claim-bearing',
            classificationAuthorityId: 'system/intake_observation_classification_v1',
            reasonCodes: ['product-identity-incomplete'],
            missingRequirements: ['relation', 'severity'],
            presentationOwnerReviewer: raw.reviewer,
            presentationLimit: 6,
          },
        })], {
          workflowName: 'peer-review',
          stepName: observedAt.stepName,
          runId: observedAt.runId,
          timestamp: observedAt.timestamp,
        }, new Set());

        const classification = classifyIntakeReviewIntegrityFailure({
          anomalies: ledger.reviewerAnomalies!,
          presentationCounts: new Map(),
        });

        expect(classification?.code).toBe('review_integrity_unresolved_unpresented');
        expect(classification?.unpresentedIds).toEqual([ledger.reviewerAnomalies![0]!.id]);
      });
    });
  });

  /**
   * 充足不能な再提示要求の芽を潰す。
   *
   * request が reviewer へ提示する claim atom と correspondence が要求する
   * claim atom が別々に選ばれると、reviewer が提示文を1文字も違わずコピーしても
   * 昇格せず、presentationLimit 回だけ再提示されて毎回 new finding を増やす。
   * prompt では絶対に直せない種類の破綻なので、選択規則は
   * selectRestatementSourceClaimAtom 1箇所だけが持ち、request 構築
   * （buildRestatementRequests）もそこへ委譲する。
   */
  describe('restatement claim atom source agreement', () => {
    const anomalyFor = (description: string | null, rawExcerpt: string | null) => {
      const wire = incompleteRaw('raw-atom-agreement', {
        description,
        ...(rawExcerpt === null ? {} : { rawExcerpt }),
      });
      const spec = createReviewerAnomalySpec({
        wire,
        canonical: canonicalItem(wire).canonical,
        anomalyKind: 'intake-contract-incomplete',
        reason: 'Independent reviewer observation does not satisfy the product admission contract',
        intakeContract: {
          observationClass: 'claim-bearing',
          classificationAuthorityId: 'system/intake_observation_classification_v1',
          reasonCodes: ['product-identity-incomplete'],
          missingRequirements: ['severity'],
          presentationOwnerReviewer: wire.reviewer,
          presentationLimit: 6,
        },
      });
      const ledger = applyReviewerAnomalySpecsToLedger(emptyLedger(), [spec], {
        workflowName: 'peer-review',
        stepName: observedAt.stepName,
        runId: observedAt.runId,
        timestamp: observedAt.timestamp,
      }, new Set());
      return { wire, anomaly: ledger.reviewerAnomalies![0]! };
    };
    it('selects the claim body in one place for both the request and the gate', () => {
      for (const [description, rawExcerpt, expected] of [
        ['A stated defect.', 'A different stated defect.', 'A stated defect.'],
        [null, 'Only the excerpt carries the claim.', 'Only the excerpt carries the claim.'],
        ['   ', 'Blank description falls through to the excerpt.', 'Blank description falls through to the excerpt.'],
      ] as ReadonlyArray<readonly [string | null, string, string]>) {
        const { wire, anomaly } = anomalyFor(description, rawExcerpt);
        const label = `description=${JSON.stringify(description)}`;

        // request 側（buildRestatementRequests）はこの値をそのまま claimedExcerpt に
        // 使う。別経路で選び直すと提示文と要求文が食い違う。
        expect(selectRestatementSourceClaimAtom(anomaly, wire), label).toBe(expected);
      }
    });

    // claim 本文が一切無い観測には title へフォールバックしない。title で request を
    // 作ると「見せた文をそのまま写しても受理されない」充足不能な要求になるため、
    // request を作らず、その場で terminal disposition へ落とす（この describe の
    // 上にある undemandable_claim_atom のテストが終端側を固定する。request が
    // 作られないことは finding-fc-restatement-slot.test.ts が固定する）。
    it('demands nothing when no claim text exists at all', () => {
      const { wire, anomaly } = anomalyFor(null, null);

      expect(selectRestatementSourceClaimAtom(anomaly, wire)).toBeUndefined();
      expect(anomaly.title.length).toBeGreaterThan(0);
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
      protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
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
      protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
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
      protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
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
      anomalyAdjudications: [],
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
        protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
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
      anomalyAdjudications: [],
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
        protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
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

  it('rejects any publication whose protocol descriptor is not the single supported one', () => {
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
        protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
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
          protocol: { protocolRevision: number; format: string; generationMode: string };
        };
      };

      // 旧 revision も structured 形式も受け付けない。プロトコルは1種類だけ。
      stored.publication.protocol.protocolRevision = 1;
      writeFileSync(path, JSON.stringify(stored));
      expect(() => loadFindingReviewPublication(reportDir, identity))
        .toThrow(/unsupported protocol descriptor/u);

      stored.publication.protocol.protocolRevision = 2;
      stored.publication.protocol.generationMode = 'structured';
      stored.publication.protocol.format = 'structured-output';
      writeFileSync(path, JSON.stringify(stored));
      expect(() => loadFindingReviewPublication(reportDir, identity))
        .toThrow(/unsupported protocol descriptor/u);
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
