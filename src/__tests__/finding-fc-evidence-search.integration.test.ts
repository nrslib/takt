import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { buildFindingEvidenceSearchRequest } from '../core/workflow/findings/evidence-search.js';
import { StepExecutor } from '../core/workflow/engine/StepExecutor.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';

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
  it('uses only the digest-bound snapshot and presents every window when the source has no anchor', () => {
    const { source, anomalyId } = buildAnomaly();
    const snapshotContent = Array.from(
      { length: 401 },
      (_, index) => `${index + 1}-${'snapshot-only '.repeat(4)}`,
    ).join('\n');
    const snapshot = {
      reviewScopeSnapshotId: 'a'.repeat(64),
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [{
        path: targetPath,
        kind: 'file',
        content: Buffer.from(snapshotContent, 'utf8'),
        contentDigest: 'b'.repeat(64),
        coverage: 'complete' as const,
      }],
      changedPaths: [targetPath],
    };
    const request = buildFindingEvidenceSearchRequest({
      snapshot,
      ownerReviewerStepName: 'architecture-review',
      anomaly: {
        ...buildAnomaly().ledger.reviewerAnomalies![0]!,
        id: anomalyId,
      },
      sourceRaw: source,
      request: {
        anomalyId,
        reviewer: 'architecture-review',
        presentationOrdinal: 2,
        reviewScopeSnapshotId: snapshot.reviewScopeSnapshotId,
        sourceExcerptDigest: source.sourceBinding.excerptDigest,
        claimedExcerpt: claim,
        targetPaths: [targetPath],
        missingRequirements: ['claimEvidence'],
        expectedRelation: 'new',
        expectedTargetFindingId: null,
        expectedTargetPreconditionClass: 'absent',
        restatementRequestId: 'c'.repeat(64),
      },
      presentationCount: 1,
    });

    expect(request?.reportContent).toContain('snapshot-only');
    expect(request?.reportContent).toContain(`[FILE ${targetPath} lines 1-127]`);
    expect(request?.reportContent).toContain(`[FILE ${targetPath} lines 128-251]`);
    expect(request?.reportContent).toContain(`[FILE ${targetPath} lines 252-375]`);
    expect(request?.reportContent).toContain(`[FILE ${targetPath} lines 376-401]`);
    expect(request?.reportContent).not.toContain('import {');
  });

  it('passes a byte-exact evidence-search candidate through admission and records its origin', () => {
    const { ledger, source, anomalyId } = buildAnomaly();
    const snapshot = captureReviewScopeProofSnapshot(process.cwd());
    const firstLine = readFileSync(targetPath, 'utf8').split('\n')[0]!;
    expect(firstLine).toBeTruthy();
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

  it('does not promote an evidence-search quote when the claim atom is different', () => {
    const { ledger, source, anomalyId } = buildAnomaly();
    const snapshot = captureReviewScopeProofSnapshot(process.cwd());
    const publication = evidenceSearchPublication({
      anomalyId,
      snapshotId: snapshot.reviewScopeSnapshotId,
      reportName: 'evidence-search-unrelated-claim',
      repairOrigin: 'evidence-search',
      rawFindings: [reviewerRawExtractionFixture({
        rawFindingId: 'evidence-search-unrelated-claim',
        familyTag: 'evidence-search',
        severity: 'high',
        title: 'Claim is supported by the implementation',
        description: `${claim} with an unrelated conclusion`,
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
      restatementRequestBindings: [{
        request: publication.presentationContext.restatementRequests[0]!,
        publicationId: publication.publicationId,
        reportDigest: publication.reportDigest,
        repairOrigin: 'evidence-search',
      }],
    });
    const admitted = admission.cleanAdmitted[0]!.wire;
    const linked = linkPromotedReviewerAnomalies({
      ...ledger,
      rawFindings: [...ledger.rawFindings, admitted],
      findings: [{
        id: 'F-SEARCH-UNRELATED',
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

    expect(linked.reviewerAnomalies?.[0]?.promotedFindingId).toBeUndefined();
  });

  it('uses the real StepExecutor path to persist publication, resume without a provider call, and retain a crash reservation', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-fc-evidence-search-'));
    try {
      const runPaths = buildRunPaths(projectCwd, 'evidence-search-step-executor');
      mkdirSync(runPaths.reportsAbs, { recursive: true });
      const ownerStep = {
        name: 'architecture-review',
        kind: 'agent',
        persona: 'architecture-review',
        outputContracts: [{ name: 'architecture-review.md', format: 'Owner report format.' }],
      } as AgentWorkflowStep;
      const ledgerStore = { ledgerIdentity: 'scope-evidence-search-step-executor' };
      const requestWithoutId = {
        anomalyId: 'RA-STEP-EXECUTOR',
        reviewer: ownerStep.name,
        presentationOrdinal: 2,
        reviewScopeSnapshotId: 'd'.repeat(64),
        sourceExcerptDigest: 'e'.repeat(64),
        claimedExcerpt: claim,
        targetPaths: [targetPath],
        missingRequirements: ['claimEvidence'] as const,
        expectedRelation: 'new' as const,
        expectedTargetFindingId: null,
        expectedTargetPreconditionClass: 'absent' as const,
      };
      const request = {
        ...requestWithoutId,
        restatementRequestId: computeRestatementRequestId(requestWithoutId),
      };
      const evidenceRequest = {
        ownerReviewerStepName: ownerStep.name,
        request,
        reportContent: `Evidence search report\n${claim}`,
      };
      const normalizeFindingIntake = vi.fn().mockResolvedValue({
        persona: 'finding-intake-normalizer',
        status: 'done',
        content: '',
        structuredOutput: { rawFindings: [] },
        timestamp: new Date('2026-08-09T00:00:01.000Z'),
      });
      const makeExecutor = (
        structuredCaller: typeof normalizeFindingIntake,
        withNormalizerFallback = false,
      ) => new StepExecutor({
        optionsBuilder: {
          resolveStepProviderModel: (step: AgentWorkflowStep) => ({
            provider: 'mock',
            model: step.name === ownerStep.name && withNormalizerFallback
              ? 'owner-model'
              : step.model ?? 'test-model',
            ...(step.name === ownerStep.name && withNormalizerFallback
              ? { escalation: { provider: 'mock' as const, model: 'fallback-model' } }
              : {}),
          }),
        } as never,
        getCwd: () => projectCwd,
        getProjectCwd: () => projectCwd,
        getReportDir: () => runPaths.reportsAbs,
        getRunPaths: () => runPaths,
        getLanguage: () => 'en',
        getInteractive: () => false,
        getWorkflowSteps: () => [ownerStep],
        getWorkflowName: () => 'evidence-search-step-executor',
        getTask: () => 'Review the implementation.',
        getWorkflowDescription: () => undefined,
        getRetryNote: () => undefined,
        getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
        structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
        structuredCaller: { normalizeFindingIntake: structuredCaller } as never,
        workflowProvider: 'mock',
        workflowModel: 'test-model',
        findingLedgerStore: ledgerStore as never,
        findingManagerAuthority: {} as never,
        refreshFindingsState: vi.fn(),
        emitEvent: vi.fn(),
        recordSynthesizedAgentUsage: vi.fn(),
        getRunId: () => 'evidence-search-step-executor',
        getFindingCallNamespace: () => '',
      } as never);
      const input = {
        ownerStep,
        parentStepName: 'reviewers',
        stepIteration: 1,
        state: { iteration: 1 },
        reviewScopeSnapshotId: request.reviewScopeSnapshotId,
        request: evidenceRequest,
      } as never;

      const first = await makeExecutor(normalizeFindingIntake).runFindingEvidenceSearch(input);
      expect(first.kind).toBe('published');
      expect(normalizeFindingIntake).toHaveBeenCalledTimes(1);

      const resumed = await makeExecutor(vi.fn().mockRejectedValue(new Error('must not call')))
        .runFindingEvidenceSearch(input);
      expect(resumed.kind).toBe('published');
      expect(normalizeFindingIntake).toHaveBeenCalledTimes(1);

      const crashRequest = {
        ...evidenceRequest,
        request: {
          ...request,
          anomalyId: 'RA-STEP-EXECUTOR-CRASH',
          restatementRequestId: computeRestatementRequestId({
            ...requestWithoutId,
            anomalyId: 'RA-STEP-EXECUTOR-CRASH',
          }),
        },
      };
      const crashingNormalizer = vi.fn().mockRejectedValue(new Error('process crashed after reservation'));
      const crashInput = { ...input, request: crashRequest } as never;
      const crashed = await makeExecutor(crashingNormalizer).runFindingEvidenceSearch(crashInput);
      expect(crashed).toMatchObject({ kind: 'terminal', response: { status: 'error' } });
      const resumedAfterCrash = await makeExecutor(vi.fn().mockResolvedValue({
        persona: 'finding-intake-normalizer',
        status: 'done',
        content: '',
        structuredOutput: { rawFindings: [] },
        timestamp: new Date(),
      })).runFindingEvidenceSearch(crashInput);
      expect(resumedAfterCrash.kind).toBe('already-attempted');

      const transientRequest = {
        ...evidenceRequest,
        request: {
          ...request,
          anomalyId: 'RA-STEP-EXECUTOR-RATE-LIMITED',
          restatementRequestId: computeRestatementRequestId({
            ...requestWithoutId,
            anomalyId: 'RA-STEP-EXECUTOR-RATE-LIMITED',
          }),
        },
      };
      const rateLimitedNormalizer = vi.fn()
        .mockResolvedValueOnce({
          persona: 'finding-intake-normalizer',
          status: 'rate_limited',
          content: 'retry later',
          timestamp: new Date(),
        })
        .mockResolvedValueOnce({
          persona: 'finding-intake-normalizer',
          status: 'done',
          content: '',
          structuredOutput: { rawFindings: [] },
          timestamp: new Date(),
        });
      const transientInput = { ...input, request: transientRequest } as never;
      const rateLimited = await makeExecutor(rateLimitedNormalizer, true)
        .runFindingEvidenceSearch(transientInput);
      expect(rateLimited.kind).toBe('published');
      expect(rateLimitedNormalizer).toHaveBeenCalledTimes(2);

      const exhaustedRateNormalizer = vi.fn().mockResolvedValue({
        persona: 'finding-intake-normalizer',
        status: 'rate_limited',
        content: 'retry later',
        timestamp: new Date(),
      });
      const exhausted = await makeExecutor(exhaustedRateNormalizer)
        .runFindingEvidenceSearch({
          ...transientInput,
          request: {
            ...transientRequest,
            request: {
              ...transientRequest.request,
              anomalyId: 'RA-STEP-EXECUTOR-RATE-LIMITED-EXHAUSTED',
              restatementRequestId: computeRestatementRequestId({
                ...requestWithoutId,
                anomalyId: 'RA-STEP-EXECUTOR-RATE-LIMITED-EXHAUSTED',
              }),
            },
          },
        });
      expect(exhausted).toMatchObject({ kind: 'terminal', response: { status: 'error' } });
      expect(exhausted).toMatchObject({
        terminalOperation: {
          origin: { stage: 'finding_intake_normalizer', reviewerStepName: ownerStep.name },
        },
      });

      const retriedNormalizer = vi.fn().mockResolvedValue({
        persona: 'finding-intake-normalizer',
        status: 'done',
        content: '',
        structuredOutput: { rawFindings: [] },
        timestamp: new Date(),
      });
      const retried = await makeExecutor(retriedNormalizer).runFindingEvidenceSearch({
        ...transientInput,
        request: {
          ...transientRequest,
          request: {
            ...transientRequest.request,
            anomalyId: 'RA-STEP-EXECUTOR-RATE-LIMITED-EXHAUSTED',
            restatementRequestId: computeRestatementRequestId({
              ...requestWithoutId,
              anomalyId: 'RA-STEP-EXECUTOR-RATE-LIMITED-EXHAUSTED',
            }),
          },
        },
      });
      expect(retried.kind).toBe('published');
      expect(retriedNormalizer).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
    }
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
      kind: 'published',
      result: {
        subStep: ownerStep,
        publication: {},
        reviewEvidence: 'none',
        repairOrigin: 'evidence-search',
      },
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

  it('ingests earlier evidence-search publications before returning a later terminal result', async () => {
    const ownerStep = {
      name: 'architecture-review',
      kind: 'agent',
      persona: 'architecture-review',
      outputContracts: [{ name: 'architecture-review.md', format: 'Owner report format.' }],
    } as AgentWorkflowStep;
    const firstResult = {
      subStep: ownerStep,
      publication: { publicationId: 'evidence-publication-1' },
      reviewEvidence: 'none',
      repairOrigin: 'evidence-search',
    };
    const runFindingEvidenceSearch = vi.fn()
      .mockResolvedValueOnce({ kind: 'published', result: firstResult })
      .mockResolvedValueOnce({
        kind: 'terminal',
        response: { persona: ownerStep.name, status: 'rate_limited', content: '', timestamp: new Date() },
        providerInfo: { provider: 'mock', model: 'test-model' },
        terminalOperation: {
          origin: { kind: 'reviewer', stepName: ownerStep.name },
          providerInfo: { provider: 'mock', model: 'test-model' },
        },
      });
    const ingest = vi.fn().mockResolvedValue(undefined);
    const outcome = await runFindingRestatementSlot({
      ownerReviewerSteps: [ownerStep],
      buildSlotContexts: () => new Map(),
      buildEvidenceSearchRequests: () => [
        { ownerReviewerStepName: ownerStep.name, request: {} as never, reportContent: 'first' },
        { ownerReviewerStepName: ownerStep.name, request: {} as never, reportContent: 'second' },
      ],
      ingest,
      reviewScopeSnapshotId: 'a'.repeat(64),
      parentStepName: 'reviewers',
      stepIteration: 1,
      state: { iteration: 1 } as never,
      task: 'Review',
      maxSteps: 5,
      optionsBuilder: {
        resolveStepProviderModel: () => ({ provider: 'mock', model: 'test-model' }),
      } as never,
      stepExecutor: {
        runFindingEvidenceSearch,
        resumeFindingReviewPublication: vi.fn().mockResolvedValue(undefined),
      } as never,
      updatePersonaSession: vi.fn(),
      presentationLimit: 1,
    });

    expect(outcome).toMatchObject({ kind: 'terminal', response: { status: 'rate_limited' } });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0]).toEqual([firstResult]);
  });
});
