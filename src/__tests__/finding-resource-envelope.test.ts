import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../shared/utils/canonical-json.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  createReviewerRawFindingCandidates,
  projectReviewerRawStructuredOutputWithEnvelope,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { RawFindingSchema } from '../core/models/finding-schemas.js';
import { intakeReviewerOutputs } from '../core/workflow/findings/manager-intake.js';
import { RAW_FINDING_LIMITS } from '../core/workflow/findings/raw-finding-limits.js';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import { reviewerRawExtractionFixture } from './helpers/finding-lifecycle-fixture.js';
import { findingReviewPublicationFixture } from './helpers/finding-review-publication.js';

const raw = reviewerRawExtractionFixture({
  rawFindingId: 'raw-1',
  familyTag: 'bug',
  severity: 'high',
  title: 'Issue',
  description: 'Description',
  suggestion: null,
  relation: 'new',
  targetFindingId: null,
  target: { kind: 'code', paths: ['src/a.ts'] },
  evidence: [],
  rawExcerpt: 'Description',
});

const ledger: FindingLedger = {
  workflowName: 'peer-review',
  nextId: 1,
  updatedAt: '2026-07-28T00:00:00.000Z',
  findings: [],
  evidenceRecords: [],
  rawFindings: [],
  conflicts: [],
  interpretations: [],
};

const context = {
  workflowName: 'peer-review',
  callNamespace: '',
  parentStepName: 'reviewers',
  stepIteration: 1,
  runId: 'run-1',
  reviewerStepName: 'reviewer',
  reviewerPersonaKey: 'reviewer',
  reviewReport: raw.rawExcerpt,
  ledger,
  issueEvidenceRequests: () => ({
    evidence: [],
    engineProofRecords: [],
    coverageGaps: [],
    materializedQuoteBytes: 0,
  }),
  commitEvidenceIssuance: () => {},
};

function intakeExtractions(
  reviewers: Array<{ name: string; extractions: unknown[] }>,
) {
  return intakeReviewerOutputs({
    subResults: reviewers.map(({ name, extractions }) => ({
      subStep: {
        kind: 'agent',
        name,
        persona: name,
        edit: false,
      } as WorkflowStep,
      publication: findingReviewPublicationFixture({
        scopeIdentity: '/test/finding-resource-envelope/ledger.json',
        parentStepName: 'reviewers',
        stepIteration: 1,
        reviewerStepName: name,
        rawFindings: extractions,
      }),
    })),
    previousLedger: ledger,
    workflowName: 'peer-review',
    callNamespace: '',
    parentStepName: 'reviewers',
    stepIteration: 1,
    runId: 'run-1',
    workflowTask: 'Review the project.',
    cwd: process.cwd(),
    scopeIdentity: '/test/finding-resource-envelope/ledger.json',
    issuedAt: '2026-07-28T00:00:00.000Z',
    reviewScopeSnapshot: {
      reviewScopeSnapshotId: 'a'.repeat(64),
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [],
    },
  });
}

describe('reviewer raw resource envelope', () => {
  it('preserves nullable candidate fields through projection before intake', () => {
    const nullableRaw = reviewerRawExtractionFixture({
      rawFindingId: null,
      familyTag: null,
      severity: null,
      title: null,
      description: 'Description',
      suggestion: null,
      relation: null,
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidence: [],
      rawExcerpt: 'Description',
    });
    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [nullableRaw],
    });

    expect(projected.structuredOutput.rawFindings).toEqual([nullableRaw]);

    const intake = createReviewerRawFindingCandidates(
      projected.structuredOutput.rawFindings as unknown[],
      context,
      projected.resourceEnvelope,
    );
    expect(intake.rejections).toEqual([]);
    expect(intake.candidates).toHaveLength(1);
    expect(intake.candidates[0]).toMatchObject({
      rawExcerpt: 'Description',
      target: { kind: 'code', paths: ['src/a.ts'] },
    });
    expect(intake.candidates[0]!.relation).toBeUndefined();
  });

  it('round-trips an unknown relation as durable null without inventing new', () => {
    const nullableRaw = reviewerRawExtractionFixture({
      rawFindingId: 'raw-unknown-relation',
      familyTag: 'bug',
      severity: 'high',
      title: 'Unknown relation',
      description: 'The reviewer did not establish a lifecycle relation.',
      suggestion: null,
      relation: null,
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidence: [],
      rawExcerpt: 'The reviewer did not establish a lifecycle relation.',
    });
    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [nullableRaw],
    });
    const intake = createReviewerRawFindingCandidates(
      projected.structuredOutput.rawFindings as unknown[],
      {
        ...context,
        reviewReport: nullableRaw.rawExcerpt,
      },
      projected.resourceEnvelope,
    );
    const firstCanonical = canonicalizeReviewerRawFinding(
      intake.candidates[0]!,
      { ledger },
    ).canonical;
    const persisted = RawFindingSchema.parse(
      toLedgerRawFinding(firstCanonical),
    );
    const rehydrated = candidateFromStoredRawFinding(
      persisted,
      firstCanonical.reviewerStableKey,
    );
    const secondCanonical = canonicalizeReviewerRawFinding(
      rehydrated,
      { ledger },
    ).canonical;

    expect(firstCanonical.relation).toBeNull();
    expect(persisted.relation).toBeNull();
    expect(rehydrated.relation).toBeUndefined();
    expect(secondCanonical.relation).toBeNull();
    expect(toLedgerRawFinding(secondCanonical).relation).toBeNull();
  });

  it('preserves a nullable target in the projected contract', () => {
    const raw = reviewerRawExtractionFixture({
      rawFindingId: 'raw-null-target',
      familyTag: 'design',
      severity: 'medium',
      title: 'Broad design concern',
      description: 'Description',
      suggestion: null,
      relation: null,
      targetFindingId: null,
      evidence: [],
      rawExcerpt: 'Description',
    });
    const nullableTarget = {
      ...raw,
      candidate: {
        ...raw.candidate,
        target: null,
      },
    };
    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [nullableTarget],
    });

    expect(projected.structuredOutput.rawFindings).toEqual([nullableTarget]);
  });

  it('rejects an invalid nullable-field enum during projection', () => {
    const raw = reviewerRawExtractionFixture({
      rawFindingId: 'raw-invalid-relation',
      familyTag: 'bug',
      severity: 'high',
      title: 'Issue',
      description: 'Description',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidence: [],
      rawExcerpt: 'Description',
    });
    const invalidRelation = {
      ...raw,
      candidate: {
        ...raw.candidate,
        relation: 'invalid',
      },
    };

    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [invalidRelation],
    });

    expect(projected.structuredOutput.rawFindings).toEqual([{
      rawExcerpt: 'Description',
      candidate: null,
    }]);
  });

  it('distinguishes explicit null severity from missing and invalid severity', () => {
    const base = reviewerRawExtractionFixture({
      rawFindingId: 'raw-severity-boundary',
      familyTag: 'bug',
      severity: null,
      title: 'Issue',
      description: 'Description',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidence: [],
      rawExcerpt: 'Description',
    });
    const { severity: _severity, ...withoutSeverity } = base.candidate!;
    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [
        base,
        { ...base, candidate: withoutSeverity },
        { ...base, candidate: { ...base.candidate, severity: 'Blocking' } },
      ],
    });

    expect(projected.structuredOutput.rawFindings).toEqual([
      base,
      { rawExcerpt: 'Description', candidate: null },
      { rawExcerpt: 'Description', candidate: null },
    ]);
    const intake = createReviewerRawFindingCandidates(
      projected.structuredOutput.rawFindings as unknown[],
      context,
      projected.resourceEnvelope,
    );
    expect(intake.candidates).toHaveLength(1);
    expect(intake.candidates.every((candidate) => candidate.severity === undefined)).toBe(true);
    expect(intake.rejections).toHaveLength(2);
  });

  it('measures each untrusted item once before projection and preserves sourceBytes', () => {
    const input = { rawFindings: [raw] };
    const projected = projectReviewerRawStructuredOutputWithEnvelope(input);
    const expectedItemBytes = Buffer.byteLength(canonicalJson(raw), 'utf-8');

    expect(projected.resourceEnvelope).toEqual({
      itemCount: 1,
      itemSourceBytes: [expectedItemBytes],
      jsonBytes: Buffer.byteLength(canonicalJson(input.rawFindings), 'utf-8'),
    });
    const candidates = createReviewerRawFindingCandidates(
      projected.structuredOutput.rawFindings as unknown[],
      context,
      projected.resourceEnvelope,
    );
    expect(candidates.candidates[0]?.sourceBytes).toBe(expectedItemBytes);
  });

  it('charges an unknown data property to the original reviewer byte budget', () => {
    const input = {
      rawFindings: [{
        ...raw,
        unknownPayload: 'x'.repeat(
          RAW_FINDING_LIMITS.maxReviewerRawFindingsJsonBytes,
        ),
      }],
    };
    const projected = projectReviewerRawStructuredOutputWithEnvelope(input);
    expect(projected.structuredOutput.rawFindings).toEqual([{}]);
    expect(projected.resourceEnvelope.jsonBytes)
      .toBeGreaterThan(RAW_FINDING_LIMITS.maxReviewerRawFindingsJsonBytes);

    expect(() => findingReviewPublicationFixture({
      scopeIdentity: '/test/finding-resource-envelope/ledger.json',
      parentStepName: 'reviewers',
      stepIteration: 1,
      reviewerStepName: 'reviewer',
      reportContent: 'oversized reviewer output',
      rawFindings: projected.structuredOutput.rawFindings as unknown[],
      reviewerRawResourceEnvelope: projected.resourceEnvelope,
    })).toThrow(/exceeded limits/);
  });

  it('rejects one extraction that would exceed the atomized reviewer limit', () => {
    const extraction = structuredClone(raw);
    extraction.candidate!.relation = 'persists';
    extraction.candidate!.targetFindingIds = Array.from(
      { length: RAW_FINDING_LIMITS.maxRawFindingsPerReviewer + 1 },
      (_, index) => `F-${String(index + 1).padStart(4, '0')}`,
    );
    expect(() => intakeExtractions([{ name: 'reviewer', extractions: [extraction] }]))
      .toThrow(/atomized raw findings/);
  });

  it('deduplicates target ids before enforcing the atomized boundary', () => {
    const extraction = structuredClone(raw);
    extraction.candidate!.relation = 'persists';
    extraction.candidate!.targetFindingIds = Array.from(
      { length: RAW_FINDING_LIMITS.maxTargetFindingIdsPerCandidate },
      () => 'F-0001',
    );
    const intake = intakeExtractions([{ name: 'reviewer', extractions: [extraction] }]);

    expect(intake.overflowReports).toEqual([]);
    expect(intake.items).toHaveLength(1);
  });

  it('enforces the step limit across atomized outputs from multiple reviewers', () => {
    const extractionFor = (prefix: string, count: number) => {
      const extraction = structuredClone(raw);
      extraction.rawExcerpt = `${prefix} observation`;
      extraction.candidate!.rawFindingId = prefix;
      extraction.candidate!.description = `${prefix} observation`;
      extraction.candidate!.relation = 'persists';
      extraction.candidate!.targetFindingIds = Array.from(
        { length: count },
        (_, index) => `${prefix}-${String(index + 1).padStart(4, '0')}`,
      );
      return extraction;
    };
    const intake = intakeExtractions([
      {
        name: 'reviewer-a',
        extractions: [extractionFor('A', RAW_FINDING_LIMITS.maxRawFindingsPerReviewer)],
      },
      {
        name: 'reviewer-b',
        extractions: [extractionFor('B', RAW_FINDING_LIMITS.maxRawFindingsPerReviewer)],
      },
      { name: 'reviewer-c', extractions: [extractionFor('C', 1)] },
    ]);

    expect(intake.items).toHaveLength(RAW_FINDING_LIMITS.maxRawFindingsPerStep);
    expect(intake.overflowReports).toEqual([
      expect.objectContaining({ reviewer: 'reviewer-c' }),
    ]);
  });
});
