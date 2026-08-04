import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentWorkflowStep } from '../core/models/types.js';
import { evaluateRawAdmission } from '../core/workflow/findings/manager-admission.js';
import { intakeReviewerOutputs } from '../core/workflow/findings/manager-intake.js';
import {
  createFindingReviewPublication,
  STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import type { FindingLedger, RawFindingEvidence } from '../core/workflow/findings/types.js';
import type { ReviewScopeProofSnapshot } from '../core/workflow/findings/snapshot.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';

const snapshotId = 'a'.repeat(64);
const quoteContent = Buffer.from(`${'x'.repeat(8192)}\n`);
const overLimitLineExcerpt = Array.from({ length: 201 }, () => 'x').join('\n');
const overLimitStoredQuoteCases = [
  {
    name: 'byte',
    content: Buffer.from(`${'x'.repeat(8193)}\n`),
    endLine: 1,
    verbatimExcerpt: 'x'.repeat(8193),
  },
  {
    name: 'line',
    content: Buffer.from(`${overLimitLineExcerpt}\n`),
    endLine: 201,
    verbatimExcerpt: overLimitLineExcerpt,
  },
] as const;

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function emptyLedger(): FindingLedger {
  return {
    workflowName: 'workflow',
    nextId: 1,
    updatedAt: '2026-07-29T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
  };
}

function existingIssueLedger(): {
  previousLedger: FindingLedger;
  target: { kind: 'code'; paths: string[] };
} {
  const target = { kind: 'code' as const, paths: ['src/a.ts'] };
  const seedRaw = canonicalRawFindingFixture({
    rawFindingId: 'seed',
    stepName: 'review',
    reviewer: 'reviewer',
    familyTag: 'bug',
    severity: 'high',
    title: 'Existing issue',
    description: 'The existing issue remains open.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target,
    evidence: [],
  });
  const observedAt = {
    runId: 'prior',
    stepName: 'review',
    timestamp: '2026-07-28T00:00:00.000Z',
  };
  return {
    target,
    previousLedger: {
      ...emptyLedger(),
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        target,
        targetIdentityHash: seedRaw.targetIdentityHash,
        claimIdentityHash: seedRaw.claimIdentityHash,
        semanticClaimIdentityHash: seedRaw.semanticClaimIdentityHash,
        severity: 'high',
        title: 'Existing issue',
        description: 'The existing issue remains open.',
        evidenceIds: [],
        reviewers: ['reviewer'],
        rawFindingIds: ['seed'],
        firstSeen: observedAt,
        lastSeen: observedAt,
        revision: 1,
      }],
      rawFindings: [seedRaw],
    },
  };
}

function reviewerResult(
  name: string,
  rawIds: readonly string[],
  evidenceRequests: (index: number) => Array<{
    kind: 'file_quote';
    path: string;
    startLine: number;
    endLine: number;
  }>,
) {
  const excerpts = rawIds.map((rawId) => `Finding ${rawId} remains.`);
  const subStep: AgentWorkflowStep = {
    kind: 'agent',
    name,
    persona: name,
    edit: false,
  };
  return {
    subStep,
    publication: createFindingReviewPublication({
      identity: {
        scopeIdentity: 'scope',
        callNamespace: '',
        parentStepName: 'review',
        stepIteration: 1,
        reviewerStepName: name,
        reportName: `${name}.md`,
      },
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: excerpts.join('\n'),
      rawFindings: rawIds.map((rawId, index) => ({
        rawExcerpt: excerpts[index],
        candidate: {
          rawFindingId: rawId,
          relation: 'new',
          targetFindingIds: [],
          familyTag: 'bug',
          severity: 'high',
          title: `Finding ${rawId}`,
          description: excerpts[index],
          suggestion: null,
          target: { kind: 'code', paths: ['src/a.ts'], symbol: null },
          evidenceRequests: evidenceRequests(index),
        },
      })),
    }),
  };
}

function singleReviewerResult(name: string, candidate: Record<string, unknown>) {
  const rawExcerpt = String(candidate.description);
  const subStep: AgentWorkflowStep = {
    kind: 'agent',
    name,
    persona: name,
    edit: false,
  };
  return {
    subStep,
    publication: createFindingReviewPublication({
      identity: {
        scopeIdentity: 'scope',
        callNamespace: '',
        parentStepName: 'review',
        stepIteration: 1,
        reviewerStepName: name,
        reportName: `${name}.md`,
      },
      protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: rawExcerpt,
      rawFindings: [{ rawExcerpt, candidate }],
    }),
  };
}

function intakeSingleCandidate(input: {
  cwd: string;
  previousLedger: FindingLedger;
  snapshot: ReviewScopeProofSnapshot;
  candidate: Record<string, unknown>;
}) {
  return intakeReviewerOutputs({
    subResults: [singleReviewerResult('reviewer', input.candidate)],
    previousLedger: input.previousLedger,
    workflowName: 'workflow',
    callNamespace: '',
    parentStepName: 'review',
    stepIteration: 1,
    runId: 'run',
    workflowTask: 'Fix the code.',
    cwd: input.cwd,
    scopeIdentity: 'scope',
    issuedAt: '2026-07-29T00:00:00.000Z',
    reviewScopeSnapshot: input.snapshot,
  });
}

function evaluateIntake(input: {
  cwd: string;
  previousLedger: FindingLedger;
  snapshot: ReviewScopeProofSnapshot;
  intake: ReturnType<typeof intakeSingleCandidate>;
}) {
  return evaluateRawAdmission({
    cwd: input.cwd,
    reviewScopeSnapshotId: input.snapshot.reviewScopeSnapshotId,
    runId: 'run',
    scopeIdentity: 'scope',
    previousLedger: input.previousLedger,
    intake: input.intake,
    reviewScopeSnapshot: input.snapshot,
    workflowTask: 'Fix the code.',
  });
}

function withStoredEvidenceForRevalidation(
  intake: ReturnType<typeof intakeSingleCandidate>,
  evidence: RawFindingEvidence,
): ReturnType<typeof intakeSingleCandidate> {
  const item = intake.items[0]!;
  return {
    ...intake,
    items: [{
      ...item,
      canonical: {
        ...item.canonical,
        evidence: [evidence],
        evidenceCoverageGaps: [],
        evidenceQuoteFailureReasons: [],
      },
      wire: { ...item.wire, evidence: [evidence] },
    }],
  };
}

describe('finding evidence issuance byte budgets', () => {
  it('resets 256 KiB per reviewer, shares 512 KiB across the step, and consumes in reviewer/candidate/request order', ({ onTestFinished }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-evidence-budget-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/a.ts'), quoteContent);
    const result = intakeReviewerOutputs({
      subResults: [
        reviewerResult('reviewer-a', ['a-1', 'a-2'], () => (
          Array.from({ length: 16 }, () => ({
            kind: 'file_quote',
            path: 'src/a.ts',
            startLine: 1,
            endLine: 1,
          }))
        )),
        reviewerResult('reviewer-b', ['b-1', 'b-2'], () => (
          Array.from({ length: 16 }, () => ({
            kind: 'file_quote',
            path: 'src/a.ts',
            startLine: 1,
            endLine: 1,
          }))
        )),
        reviewerResult('reviewer-c', ['c-1'], () => (
          Array.from({ length: 16 }, () => ({
            kind: 'file_quote',
            path: 'src/a.ts',
            startLine: 1,
            endLine: 1,
          }))
        )),
      ],
      previousLedger: emptyLedger(),
      workflowName: 'workflow',
      callNamespace: '',
      parentStepName: 'review',
      stepIteration: 1,
      runId: 'run',
      workflowTask: 'Fix the code.',
      cwd,
      scopeIdentity: 'scope',
      issuedAt: '2026-07-29T00:00:00.000Z',
      reviewScopeSnapshot: {
        reviewScopeSnapshotId: snapshotId,
        trackedDiff: undefined,
        untrackedEvidence: [],
        queryInventory: [{
          path: 'src/a.ts',
          kind: 'file',
          contentDigest: sha256(quoteContent),
          content: quoteContent,
          coverage: 'complete',
        }],
      },
    });

    expect(result.items).toHaveLength(5);
    for (const item of result.items.slice(0, 4)) {
      expect(item.canonical.evidenceCoverageGaps).toEqual([]);
      expect(item.wire.evidence).toHaveLength(1);
      expect(item.wire.evidence[0]).toMatchObject({
        kind: 'file_quote',
        verbatimExcerpt: 'x'.repeat(8192),
      });
    }
    expect(result.items[4]!.wire.evidence).toEqual([]);
    expect(result.items[4]!.canonical.evidenceCoverageGaps).toHaveLength(16);
    expect(new Set(result.items[4]!.canonical.evidenceCoverageGaps)).toEqual(new Set([
      'file_quote issuance exceeds the remaining step byte budget (0 bytes)',
    ]));

    const admission = evaluateRawAdmission({
      cwd,
      reviewScopeSnapshotId: snapshotId,
      runId: 'run',
      scopeIdentity: 'scope',
      previousLedger: emptyLedger(),
      intake: result,
      reviewScopeSnapshot: {
        reviewScopeSnapshotId: snapshotId,
        trackedDiff: undefined,
        untrackedEvidence: [],
        queryInventory: [{
          path: 'src/a.ts',
          kind: 'file',
          contentDigest: sha256(quoteContent),
          content: quoteContent,
          coverage: 'complete',
        }],
      },
      workflowTask: 'Fix the code.',
    });
    expect(admission.cleanAdmitted).toHaveLength(4);
    expect(admission.admissionRejectedItems).toHaveLength(1);
    expect(admission.admissionRejectedItems[0]!.wire.evidence).toEqual([]);
    expect(admission.admissionProvisionalSpecs).toHaveLength(1);
    expect(admission.admissionAnomalySpecs).toEqual([]);
  });

  it('rolls back tentative quote bytes for failed candidates so a later valid candidate can use the budget', ({ onTestFinished }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-evidence-budget-rollback-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/a.ts'), quoteContent);
    const failedRawIds = Array.from({ length: 32 }, (_, index) => `failed-${index + 1}`);
    const result = intakeReviewerOutputs({
      subResults: [reviewerResult(
        'reviewer',
        [...failedRawIds, 'valid-final'],
        (index) => index < failedRawIds.length
          ? [
              { kind: 'file_quote', path: 'src/a.ts', startLine: 1, endLine: 1 },
              { kind: 'file_quote', path: 'src/a.ts', startLine: 2, endLine: 2 },
            ]
          : [{ kind: 'file_quote', path: 'src/a.ts', startLine: 1, endLine: 1 }],
      )],
      previousLedger: emptyLedger(),
      workflowName: 'workflow',
      callNamespace: '',
      parentStepName: 'review',
      stepIteration: 1,
      runId: 'run',
      workflowTask: 'Fix the code.',
      cwd,
      scopeIdentity: 'scope',
      issuedAt: '2026-07-29T00:00:00.000Z',
      reviewScopeSnapshot: {
        reviewScopeSnapshotId: snapshotId,
        trackedDiff: undefined,
        untrackedEvidence: [],
        queryInventory: [{
          path: 'src/a.ts',
          kind: 'file',
          contentDigest: sha256(quoteContent),
          content: quoteContent,
          coverage: 'complete',
        }],
      },
    });

    expect(result.items).toHaveLength(33);
    expect(result.items.slice(0, 32).every((item) => item.wire.evidence.length === 0))
      .toBe(true);
    expect(result.items[32]!.canonical.evidenceCoverageGaps).toEqual([]);
    expect(result.items[32]!.wire.evidence).toEqual([expect.objectContaining({
      kind: 'file_quote',
      verbatimExcerpt: 'x'.repeat(8192),
    })]);
  });

  it('cleanly admits a digest-matching resource-capped file quote without a provisional', ({ onTestFinished }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-resource-cap-admission-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(join(cwd, 'src'));
    const content = Buffer.from('source\n');
    writeFileSync(join(cwd, 'src/a.ts'), content);
    const previousLedger = emptyLedger();
    const snapshot: ReviewScopeProofSnapshot = {
      reviewScopeSnapshotId: snapshotId,
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [{
        path: 'src/a.ts',
        kind: 'file',
        contentDigest: sha256(content),
        coverage: 'resource_cap',
      }],
    };
    const intake = intakeSingleCandidate({
      cwd,
      previousLedger,
      snapshot,
      candidate: {
        rawFindingId: 'resource-capped',
        relation: 'new',
        targetFindingIds: [],
        familyTag: 'bug',
        severity: 'high',
        title: 'Resource-capped evidence',
        description: 'The requested source quote could not be issued.',
        suggestion: null,
        target: { kind: 'code', paths: ['src/a.ts'], symbol: null },
        evidenceRequests: [{ kind: 'file_quote', path: 'src/a.ts', startLine: 1, endLine: 1 }],
      },
    });
    const admission = evaluateIntake({ cwd, previousLedger, snapshot, intake });

    expect(admission.cleanAdmitted).toHaveLength(1);
    expect(admission.admissionProvisionalSpecs).toEqual([]);
    expect(admission.admissionAnomalySpecs).toEqual([]);
  });

  it('lands correct stored quotes over byte or line limits as provisionals instead of reviewer anomalies', ({ onTestFinished }) => {
    for (const quoteCase of overLimitStoredQuoteCases) {
      const cwd = mkdtempSync(join(tmpdir(), `takt-evidence-revalidation-new-${quoteCase.name}-`));
      onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
      mkdirSync(join(cwd, 'src'));
      const previousLedger = emptyLedger();
      writeFileSync(join(cwd, 'src/a.ts'), quoteCase.content);
      const snapshot: ReviewScopeProofSnapshot = {
        reviewScopeSnapshotId: snapshotId,
        trackedDiff: undefined,
        untrackedEvidence: [],
        queryInventory: [{
          path: 'src/a.ts',
          kind: 'file',
          contentDigest: sha256(quoteCase.content),
          content: quoteCase.content,
          coverage: 'complete',
        }],
      };
      const issuedIntake = intakeSingleCandidate({
        cwd,
        previousLedger,
        snapshot,
        candidate: {
          rawFindingId: `quote-limit-${quoteCase.name}`,
          relation: 'new',
          targetFindingIds: [],
          familyTag: 'bug',
          severity: 'high',
          title: 'Quote exceeds the issuance limit',
          description: 'The requested source quote exceeds an issuance limit.',
          suggestion: null,
          target: { kind: 'code', paths: ['src/a.ts'], symbol: null },
          evidenceRequests: [{
            kind: 'file_quote',
            path: 'src/a.ts',
            startLine: 1,
            endLine: quoteCase.endLine,
          }],
        },
      });
      const intake = withStoredEvidenceForRevalidation(issuedIntake, {
        kind: 'file_quote',
        path: 'src/a.ts',
        startLine: 1,
        endLine: quoteCase.endLine,
        verbatimExcerpt: quoteCase.verbatimExcerpt,
        snapshotId,
      });
      const admission = evaluateIntake({ cwd, previousLedger, snapshot, intake });

      expect(admission.admissionProvisionalSpecs).toHaveLength(1);
      expect(admission.admissionAnomalySpecs).toEqual([]);
    }
  });

  it('lands an invalid quote locator as a quote-mismatch reviewer anomaly', () => {
    const previousLedger = emptyLedger();
    const content = Buffer.from('source\n');
    const snapshot: ReviewScopeProofSnapshot = {
      reviewScopeSnapshotId: snapshotId,
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [{
        path: 'src/a.ts',
        kind: 'file',
        contentDigest: sha256(content),
        content,
        coverage: 'complete',
      }],
    };
    const intake = intakeSingleCandidate({
      cwd: process.cwd(),
      previousLedger,
      snapshot,
      candidate: {
        rawFindingId: 'invalid-locator',
        relation: 'new',
        targetFindingIds: [],
        familyTag: 'bug',
        severity: 'high',
        title: 'Invalid quote locator',
        description: 'The requested line is outside the source file.',
        suggestion: null,
        target: { kind: 'code', paths: ['src/a.ts'], symbol: null },
        evidenceRequests: [{ kind: 'file_quote', path: 'src/a.ts', startLine: 2, endLine: 2 }],
      },
    });
    const admission = evaluateIntake({ cwd: process.cwd(), previousLedger, snapshot, intake });

    expect(admission.admissionProvisionalSpecs).toEqual([]);
    expect(admission.admissionAnomalySpecs).toEqual([expect.objectContaining({
      kind: 'quote-mismatch',
    })]);
  });

  it('lands lifecycle digest drift on the current target audit instead of a reviewer anomaly', () => {
    const { previousLedger, target } = existingIssueLedger();
    const content = Buffer.from('current\n');
    const snapshot: ReviewScopeProofSnapshot = {
      reviewScopeSnapshotId: snapshotId,
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [{
        path: 'src/a.ts',
        kind: 'file',
        contentDigest: 'f'.repeat(64),
        content,
        coverage: 'complete',
      }],
    };
    const intake = intakeSingleCandidate({
      cwd: process.cwd(),
      previousLedger,
      snapshot,
      candidate: {
        rawFindingId: 'digest-drift',
        relation: 'persists',
        targetFindingIds: ['F-0001'],
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue',
        description: 'The existing issue remains open.',
        suggestion: null,
        target: { ...target, symbol: null },
        evidenceRequests: [{ kind: 'file_quote', path: 'src/a.ts', startLine: 1, endLine: 1 }],
      },
    });
    const admission = evaluateIntake({ cwd: process.cwd(), previousLedger, snapshot, intake });

    expect(admission.admissionAnomalySpecs).toEqual([]);
    expect(admission.pendingRejectedObservations).toEqual([expect.objectContaining({
      targetFindingId: 'F-0001',
      destination: 'target_audit',
    })]);
  });

  it('lands correct stored lifecycle quotes over byte or line limits on the current target audit', ({ onTestFinished }) => {
    for (const quoteCase of overLimitStoredQuoteCases) {
      const cwd = mkdtempSync(join(tmpdir(), `takt-evidence-revalidation-lifecycle-${quoteCase.name}-`));
      onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
      mkdirSync(join(cwd, 'src'));
      const { previousLedger, target } = existingIssueLedger();
      writeFileSync(join(cwd, 'src/a.ts'), quoteCase.content);
      const snapshot: ReviewScopeProofSnapshot = {
        reviewScopeSnapshotId: snapshotId,
        trackedDiff: undefined,
        untrackedEvidence: [],
        queryInventory: [{
          path: 'src/a.ts',
          kind: 'file',
          contentDigest: sha256(quoteCase.content),
          content: quoteCase.content,
          coverage: 'complete',
        }],
      };
      const issuedIntake = intakeSingleCandidate({
        cwd,
        previousLedger,
        snapshot,
        candidate: {
          rawFindingId: `quote-limit-lifecycle-${quoteCase.name}`,
          relation: 'persists',
          targetFindingIds: ['F-0001'],
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          description: 'The existing issue remains open.',
          suggestion: null,
          target: { ...target, symbol: null },
          evidenceRequests: [{
            kind: 'file_quote',
            path: 'src/a.ts',
            startLine: 1,
            endLine: quoteCase.endLine,
          }],
        },
      });
      const intake = withStoredEvidenceForRevalidation(issuedIntake, {
        kind: 'file_quote',
        path: 'src/a.ts',
        startLine: 1,
        endLine: quoteCase.endLine,
        verbatimExcerpt: quoteCase.verbatimExcerpt,
        snapshotId,
      });
      const admission = evaluateIntake({ cwd, previousLedger, snapshot, intake });

      expect(admission.admissionAnomalySpecs).toEqual([]);
      expect(admission.pendingRejectedObservations).toEqual([expect.objectContaining({
        targetFindingId: 'F-0001',
        destination: 'target_audit',
      })]);
    }
  });

  it('keeps a known null ledger target authoritative and records an injected code target for audit only', () => {
    const observedAt = {
      runId: 'prior-run',
      stepName: 'review',
      timestamp: '2026-07-28T00:00:00.000Z',
    };
    const previousLedger: FindingLedger = {
      ...emptyLedger(),
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        target: null,
        targetIdentityHash: null,
        claimIdentityHash: null,
        semanticClaimIdentityHash: null,
        severity: 'high',
        title: 'Pending interpretation',
        evidenceIds: [],
        reviewers: ['reviewer'],
        rawFindingIds: [],
        firstSeen: observedAt,
        lastSeen: observedAt,
        revision: 1,
        provisional: {
          kind: 'raw-adjudication-unresolved',
          stableKey: 'stable-null-target',
          lineageKey: 'lineage-null-target',
          sourceRawFindingIds: [],
          reason: 'Target is not established',
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          gateEffect: 'block',
          firstObservedRound: 1,
        },
      }],
    };
    const excerpt = 'The pending finding still persists.';
    const subStep: AgentWorkflowStep = {
      kind: 'agent',
      name: 'reviewer',
      persona: 'reviewer',
      edit: false,
    };
    const result = intakeReviewerOutputs({
      subResults: [{
        subStep,
        publication: createFindingReviewPublication({
          identity: {
            scopeIdentity: 'scope',
            callNamespace: '',
            parentStepName: 'review',
            stepIteration: 1,
            reviewerStepName: 'reviewer',
            reportName: 'reviewer.md',
          },
          protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
          reportContent: excerpt,
          rawFindings: [{
            rawExcerpt: excerpt,
            candidate: {
              rawFindingId: 'null-target-injection',
              relation: 'persists',
              targetFindingIds: ['F-0001'],
              familyTag: 'bug',
              severity: 'high',
              title: 'Injected code target',
              description: excerpt,
              suggestion: null,
              target: { kind: 'code', paths: ['src/a.ts'], symbol: null },
              evidenceRequests: [{
                kind: 'file_quote',
                path: 'src/a.ts',
                startLine: 1,
                endLine: 1,
              }],
            },
          }],
        }),
      }],
      previousLedger,
      workflowName: 'workflow',
      callNamespace: '',
      parentStepName: 'review',
      stepIteration: 1,
      runId: 'run',
      workflowTask: 'Fix the code.',
      cwd: process.cwd(),
      scopeIdentity: 'scope',
      issuedAt: '2026-07-29T00:00:00.000Z',
      reviewScopeSnapshot: {
        reviewScopeSnapshotId: snapshotId,
        trackedDiff: undefined,
        untrackedEvidence: [],
        queryInventory: [],
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.wire).toMatchObject({
      relation: 'persists',
      targetFindingId: 'F-0001',
      target: { kind: 'review_scope' },
      evidence: [],
    });
    expect(result.items[0]!.canonical.evidenceCoverageGaps).toEqual([
      'Lifecycle target "F-0001" does not exactly match the authoritative ledger target',
      'Review-scope finding has no concrete target for typed evidence verification',
    ]);
    const admission = evaluateRawAdmission({
      cwd: process.cwd(),
      reviewScopeSnapshotId: snapshotId,
      runId: 'run',
      scopeIdentity: 'scope',
      previousLedger,
      intake: result,
      reviewScopeSnapshot: {
        reviewScopeSnapshotId: snapshotId,
        trackedDiff: undefined,
        untrackedEvidence: [],
        queryInventory: [],
      },
      workflowTask: 'Fix the code.',
    });
    expect(admission.cleanAdmitted).toEqual([]);
    expect(admission.pendingRejectedObservations).toHaveLength(1);
    expect(admission.pendingRejectedObservations[0]).toMatchObject({
      targetFindingId: 'F-0001',
      destination: 'target_audit',
    });
  });
});
