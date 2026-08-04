import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentWorkflowStep } from '../core/models/types.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';

vi.mock('../shared/utils/private-file.js', async () => {
  const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>(
    '../shared/utils/private-file.js',
  );
  return {
    ...actual,
    readRegularFileNoFollow: vi.fn(() => {
      throw new Error('injected EIO');
    }),
  };
});

import { issueFindingEvidenceRequests } from '../core/workflow/findings/evidence-request-issuer.js';
import { intakeReviewerOutputs } from '../core/workflow/findings/manager-intake.js';
import { evaluateRawAdmission } from '../core/workflow/findings/manager-admission.js';
import {
  createFindingReviewPublication,
  STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';

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

describe('finding evidence request issuer I/O failure', () => {
  it('fails closed when digest-bound source re-reading fails', ({ onTestFinished }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-quote-io-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(join(cwd, 'src'));
    const content = Buffer.from('source\n');
    writeFileSync(join(cwd, 'src/a.ts'), content);
    const reviewScopeSnapshot = {
      reviewScopeSnapshotId: 'a'.repeat(64),
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [{
        path: 'src/a.ts',
        kind: 'file',
        contentDigest: createHash('sha256').update(content).digest('hex'),
        coverage: 'complete' as const,
      }],
    };

    const result = issueFindingEvidenceRequests({
      cwd,
      snapshot: reviewScopeSnapshot,
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Fix the code.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: { kind: 'code', paths: ['src/a.ts'], symbol: null },
      claimIdentityHash: 'c'.repeat(64),
      targetFindingId: null,
      requests: [{ kind: 'file_quote', path: 'src/a.ts', startLine: 1, endLine: 1 }],
      quoteByteBudget: {
        reviewerRemainingBytes: 256 * 1024,
        stepRemainingBytes: 512 * 1024,
      },
    });

    expect(result.evidence).toEqual([]);
    expect(result.materializedQuoteBytes).toBe(0);
    expect(result.coverageGaps).toEqual([
      'source file "src/a.ts" could not be read: injected EIO',
    ]);
    expect(result.quoteFailureReasons).toEqual([]);

    const previousLedger = emptyLedger();
    const rawExcerpt = 'The source behavior remains incorrect.';
    const subStep: AgentWorkflowStep = {
      kind: 'agent',
      name: 'reviewer',
      persona: 'reviewer',
      edit: false,
    };
    const intake = intakeReviewerOutputs({
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
          reportContent: rawExcerpt,
          rawFindings: [{
            rawExcerpt,
            candidate: {
              rawFindingId: 'io-failure',
              relation: 'new',
              targetFindingIds: [],
              familyTag: 'bug',
              severity: 'high',
              title: 'Source behavior remains incorrect',
              description: rawExcerpt,
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
      cwd,
      scopeIdentity: 'scope',
      issuedAt: '2026-07-29T00:00:00.000Z',
      reviewScopeSnapshot,
    });
    const admission = evaluateRawAdmission({
      cwd,
      reviewScopeSnapshotId: reviewScopeSnapshot.reviewScopeSnapshotId,
      runId: 'run',
      scopeIdentity: 'scope',
      previousLedger,
      intake,
      reviewScopeSnapshot,
      workflowTask: 'Fix the code.',
    });

    expect(admission.admissionProvisionalSpecs).toHaveLength(1);
    expect(admission.admissionAnomalySpecs).toEqual([]);
  });
});
