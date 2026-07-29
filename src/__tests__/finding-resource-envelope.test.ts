import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../shared/utils/canonical-json.js';
import {
  createReviewerRawFindingCandidates,
  projectReviewerRawStructuredOutputWithEnvelope,
} from '../core/workflow/findings/raw-canonicalization.js';
import { intakeReviewerOutputs } from '../core/workflow/findings/manager-intake.js';
import { RAW_FINDING_LIMITS } from '../core/workflow/findings/raw-finding-limits.js';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import { reviewerRawExtractionFixture } from './helpers/finding-lifecycle-fixture.js';

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

const context = {
  workflowName: 'peer-review',
  callNamespace: '',
  parentStepName: 'reviewers',
  stepIteration: 1,
  runId: 'run-1',
  reviewerStepName: 'reviewer',
  reviewerPersonaKey: 'reviewer',
  reviewReport: raw.rawExcerpt,
  issueEvidenceRequests: () => ({
    evidence: [],
    engineProofRecords: [],
    coverageGaps: [],
  }),
};

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
      relation: 'new',
      target: { kind: 'code', paths: ['src/a.ts'] },
    });
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

    const intake = intakeReviewerOutputs({
      subResults: [{
        subStep: {
          kind: 'agent',
          name: 'reviewer',
          persona: 'reviewer',
          edit: false,
        } as WorkflowStep,
        response: {
          persona: 'reviewer',
          status: 'done',
          content: '',
          structuredOutput: projected.structuredOutput,
          timestamp: new Date('2026-07-28T00:00:00.000Z'),
        } as AgentResponse,
        reviewerRawResourceEnvelope: projected.resourceEnvelope,
      }],
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

    expect(intake.intakeProvisionalSpecs).toHaveLength(1);
    expect(intake.items).toHaveLength(0);
    expect(intake.overflowReports[0]?.reason).toContain('per-reviewer limit');
  });
});
