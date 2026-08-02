import { describe, expect, it } from 'vitest';
import { buildAdjudicationEvidenceSnapshot, computeAdjudicationEvidenceHash } from '../core/workflow/findings/adjudication-evidence.js';
import { assembleManagerOutput } from '../core/workflow/findings/decision-assembly.js';
import { serializeFindingManagerValidationReport } from '../core/workflow/findings/manager-report-content.js';
import {
  canonicalizeReviewerRawFinding,
  canonicalRawIntegrityDigestOf,
  createReviewerRawFindingCandidates,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import {
  mergeResolutionRenotificationTransitions,
} from '../core/workflow/findings/resolution-renotification.js';
import type {
  CanonicalRawFinding,
  FindingLedger,
  FindingManagerDecisions,
  FindingManagerValidationReport,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { compareBinaryStrings } from '../shared/utils/binary-string-comparator.js';

const OBSERVATION = {
  runId: 'run-1',
  stepName: 'reviewers',
  timestamp: '2026-07-27T00:00:00.000Z',
};

const EMPTY_LEDGER: FindingLedger = {
  workflowName: 'peer-review',
  nextId: 1,
  updatedAt: OBSERVATION.timestamp,
  findings: [],
  evidenceRecords: [],
  rawFindings: [],
  conflicts: [],
};

const REVIEWER_CONTEXT = {
  workflowName: 'peer-review',
  callNamespace: '',
  parentStepName: 'reviewers',
  stepIteration: 1,
  runId: 'run-1',
  reviewerPersonaKey: 'architecture-review',
  reviewerStepName: 'architecture-review',
  ledger: EMPTY_LEDGER,
} as const;

function decisionsFor(rawFindings: readonly RawFinding[]): FindingManagerDecisions {
  return {
    rawDecisions: rawFindings.map((raw) => ({
      rawFindingId: raw.rawFindingId,
      decision: 'new' as const,
      evidence: raw.description,
    })),
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
  };
}

function canonicalize(items: readonly unknown[]): {
  canonicals: CanonicalRawFinding[];
  rawFindings: RawFinding[];
} {
  const canonicals = createReviewerRawFindingCandidates(items, REVIEWER_CONTEXT).candidates
    .map((candidate) => canonicalizeReviewerRawFinding(candidate, {
      ledger: EMPTY_LEDGER,
      clarificationAttempted: false,
    }).canonical);
  return {
    canonicals,
    rawFindings: canonicals.map(toLedgerRawFinding),
  };
}

function reconcileNewFindings(items: readonly unknown[]): Record<string, {
  findingId: string;
  rawFindingIds: string[];
}> {
  const { canonicals, rawFindings } = canonicalize(items);
  const assembly = assembleManagerOutput({
    previousLedger: EMPTY_LEDGER,
    residualRawFindings: rawFindings,
    decisions: decisionsFor(rawFindings),
  });
  const ledger = reconcileFindingLedger({
    previousLedger: EMPTY_LEDGER,
    rawFindings,
    managerOutput: assembly.output,
    entityProvisionalMutations: [],
    terminalEntityAttachmentFindingIds: new Set(),
    provisionalFindings: [],
    verifiedEvidenceRecordsByRawFindingId: new Map(),
    rawProvenanceByRawFindingId: new Map(canonicals.map((canonical) => [
      canonical.rawFindingId,
      {
        reviewerStableKey: canonical.reviewerStableKey,
        lineageKey: canonical.lineageKey,
        claimIdentityHash: canonical.claimIdentityHash,
        canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonical),
        canonicalProvenance: canonical.provenance,
      },
    ])),
    context: {
      workflowName: 'peer-review',
      ...OBSERVATION,
    },
  });
  return Object.fromEntries(ledger.findings.map((finding) => [
    finding.title,
    {
      findingId: finding.id,
      rawFindingIds: finding.rawFindingIds,
    },
  ]));
}

function reviewerFinding(title: string, rawFindingId?: string): Record<string, unknown> {
  return {
    ...(rawFindingId === undefined ? {} : { rawFindingId }),
    familyTag: 'correctness',
    severity: 'high',
    title,
    description: `Evidence for ${title}`,
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    evidence: [],
  };
}

function rawFinding(rawFindingId: string): RawFinding {
  return {
    rawFindingId,
    stepName: 'reviewers',
    reviewer: rawFindingId,
    familyTag: 'correctness',
    severity: 'medium',
    title: rawFindingId,
    description: `Evidence for ${rawFindingId}`,
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    evidence: [],
  };
}

describe('Finding deterministic contract', () => {
  it('binds missing raw IDs and F-IDs to content when independent new inputs are reversed', () => {
    const items = [
      reviewerFinding('é'),
      reviewerFinding('e\u0301'),
      reviewerFinding('A'),
      reviewerFinding('a'),
      reviewerFinding('\u{1F600}'),
      reviewerFinding('\u{1F601}'),
    ];

    expect(reconcileNewFindings(items)).toEqual(
      reconcileNewFindings([...items].reverse()),
    );
  });

  it('binds claimed-ID collision suffixes and F-IDs to content when decisions are reversed', () => {
    const items = [
      reviewerFinding('é', 'duplicate'),
      reviewerFinding('e\u0301', 'duplicate'),
      reviewerFinding('A', 'duplicate'),
      reviewerFinding('a', 'duplicate'),
      reviewerFinding('\u{1F600}', 'duplicate'),
      reviewerFinding('\u{1F601}', 'duplicate'),
    ];

    expect(reconcileNewFindings(items)).toEqual(
      reconcileNewFindings([...items].reverse()),
    );
  });

  it('uses binary ordering for adjudication evidence and keeps its hash input-order independent', () => {
    const rawFindingIds = ['raw-é', 'raw-e\u0301', 'raw-A', 'raw-a', 'raw-\u{1F600}', 'raw-\u{1F601}'];
    const makeLedger = (ids: string[]): FindingLedger => ({
      ...EMPTY_LEDGER,
      nextId: 2,
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Issue',
        evidenceIds: [],
        reviewers: ['reviewer'],
        rawFindingIds: ids,
        firstSeen: OBSERVATION,
        lastSeen: OBSERVATION,
        revision: 1,
      }],
      rawFindings: ids.map(rawFinding),
      conflicts: [{
        id: 'C-000000000001',
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: ids,
        description: 'Conflicting evidence',
        firstSeen: OBSERVATION,
        lastSeen: OBSERVATION,
      }],
    });
    const build = (ids: string[]) => buildAdjudicationEvidenceSnapshot({
      ledger: makeLedger(ids),
      conflictId: 'C-000000000001',
      reviewScopeSnapshot: {
        reviewScopeSnapshotId: 'snapshot-1',
        trackedDiff: '',
        untrackedEvidence: [],
      },
    });
    const forward = build(rawFindingIds);
    const reversed = build([...rawFindingIds].reverse());

    expect(forward.rawFindings.map((raw) => raw.rawFindingId))
      .toEqual([...rawFindingIds].sort(compareBinaryStrings));
    expect(computeAdjudicationEvidenceHash(forward))
      .toBe(computeAdjudicationEvidenceHash(reversed));
  });

  it('serializes manager report keys and recovery settlements canonically', () => {
    const ids = ['é', 'e\u0301', 'A', 'a', '\u{1F600}', '\u{1F601}'];
    const report = (ordered: string[]): FindingManagerValidationReport => ({
      version: 1,
      runId: 'run-1',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [{
        attempt: 1,
        managerOutput: {
          ...Object.fromEntries(ordered.map((id) => [id, id])),
          records: ids.map((id) => ({ id })),
        },
        validationErrors: [],
      }],
      interpretationRecoverySettlements: ordered.map((id) => ({
        provisionalFindingId: id,
        sourceRawFindingId: id,
        outcome: 'retained',
      })),
    });
    const forward = serializeFindingManagerValidationReport(report(ids));
    const reversed = serializeFindingManagerValidationReport(report([...ids].reverse()));
    const parsed = JSON.parse(forward) as {
      attempts: Array<{ managerOutput: Record<string, unknown> }>;
    };

    expect(forward).toBe(reversed);
    expect(Object.keys(parsed.attempts[0]!.managerOutput))
      .toEqual([...ids, 'records'].sort(compareBinaryStrings));
  });

  it('preserves manager output array indexes referenced by validation errors', () => {
    const report: FindingManagerValidationReport = {
      version: 1,
      runId: 'run-1',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: false,
      finalErrors: [],
      attempts: [{
        attempt: 1,
        managerOutput: {
          matches: [
            { findingId: 'F-0002', rawFindingIds: ['raw-2'], evidence: 'second' },
            { findingId: 'F-0001', rawFindingIds: ['raw-1'], evidence: 'first' },
          ],
          conflicts: [
            { findingIds: ['F-0002'], rawFindingIds: ['raw-2'], description: 'second' },
            { findingIds: ['F-0001'], rawFindingIds: ['raw-1'], description: 'first' },
          ],
        },
        validationErrors: [
          'managerOutput.matches[0] is stale',
          'managerOutput.conflicts[1] is invalid',
        ],
      }],
    };
    const serialized = serializeFindingManagerValidationReport(report);
    const parsed = JSON.parse(serialized) as FindingManagerValidationReport;

    expect(parsed.attempts[0]!.managerOutput).toEqual(report.attempts[0]!.managerOutput);
    expect(parsed.attempts[0]!.validationErrors).toEqual([
      'managerOutput.matches[0] is stale',
      'managerOutput.conflicts[1] is invalid',
    ]);
  });

  it('preserves attempt, validation error, and final error chronology', () => {
    const report: FindingManagerValidationReport = {
      version: 1,
      runId: 'run-1',
      stepName: 'reviewers',
      retryCount: 2,
      ledgerUpdated: false,
      finalErrors: ['last validation failed', 'publication was skipped'],
      attempts: [
        {
          attempt: 2,
          managerOutput: { sequence: ['second', 'first'] },
          validationErrors: ['z error happened first', 'a error happened second'],
        },
        {
          attempt: 1,
          managerOutput: { sequence: ['original'] },
          validationErrors: ['earlier attempt retained after retry'],
        },
      ],
    };

    const parsed = JSON.parse(
      serializeFindingManagerValidationReport(report),
    ) as FindingManagerValidationReport;

    expect(parsed.attempts).toEqual(report.attempts);
    expect(parsed.finalErrors).toEqual(report.finalErrors);
  });

  it('orders resolution/renotification recovery transitions by binary finding ID', () => {
    const findingIds = ['F-é', 'F-e\u0301', 'F-A', 'F-a', 'F-\u{1F600}', 'F-\u{1F601}'];
    const transitions = findingIds.map((findingId) => ({
      findingId,
      observed: {
        targetFindingId: findingId,
        targetRevision: 1,
        targetStatus: 'open' as const,
      },
      expectedTarget: {
        targetFindingId: findingId,
        targetRevision: 2,
        targetStatus: 'resolved' as const,
      },
      resolutionRawFindingIds: [`resolution-${findingId}`],
      renotificationRawFindingIds: [`renotification-${findingId}`],
    }));

    expect(mergeResolutionRenotificationTransitions([...transitions].reverse())
      .map((transition) => transition.findingId))
      .toEqual([...findingIds].sort(compareBinaryStrings));
  });
});
