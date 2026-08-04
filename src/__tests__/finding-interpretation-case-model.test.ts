import { describe, expect, it } from 'vitest';
import type { CanonicalIntakeItem } from '../core/workflow/findings/manager-admission.js';
import {
  createInterpretationCases,
  validateInterpretationCaseDecision,
} from '../core/workflow/findings/interpretation-case-model.js';
import {
  canonicalizeReviewerRawFinding,
  createReviewerRawFindingCandidates,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { computeInterpretationCohortId } from '../core/models/finding-interpretation-identity.js';
import type {
  FindingLedger,
  InterpretationDecision,
} from '../core/workflow/findings/types.js';
import { compareBinaryStrings } from '../shared/utils/binary-string-comparator.js';
import { verifySameProofAgainstLedger } from '../core/workflow/findings/raw-capabilities.js';
import {
  authorizeFindingLedgerFixture,
  emptyFindingAuthorityProjection,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';

const OBSERVATION = {
  runId: 'run-case-model',
  stepName: 'reviewers',
  timestamp: '2026-08-02T00:00:00.000Z',
};

function ledger(targetRevision = 1): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'case-model',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'persists',
      severity: 'high',
      title: 'Existing target',
      description: 'Existing target description',
      evidenceIds: [],
      rawFindingIds: [],
      reviewers: ['reviewer'],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: targetRevision,
    }],
    rawFindings: [],
    conflicts: [],
    ...emptyFindingAuthorityProjection(),
  });
}

function ledgerWithTarget(
  targetRevision: number,
  overrides: Partial<FindingLedger['findings'][number]> = {},
): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'case-model',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'persists',
      severity: 'high',
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
      target: { kind: 'code', paths: ['src/shared.ts'] },
      evidenceIds: [],
      rawFindingIds: [],
      reviewers: ['reviewer'],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: targetRevision,
      ...overrides,
    }],
    rawFindings: [],
    conflicts: [],
    ...emptyFindingAuthorityProjection(),
  });
}

function exactMatchLedger(
  kinds: readonly ('product' | 'provisional')[],
): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'case-model',
    nextId: kinds.length + 1,
    updatedAt: OBSERVATION.timestamp,
    findings: kinds.map((kind, index) => ({
      id: `F-${String(index + 1).padStart(4, '0')}`,
      status: 'open' as const,
      lifecycle: 'persists' as const,
      severity: 'high' as const,
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
      target: { kind: 'code' as const, paths: ['src/shared.ts'] },
      evidenceIds: [],
      rawFindingIds: [],
      reviewers: ['reviewer'],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: 2,
      ...(kind === 'product'
        ? {}
        : {
            provisional: {
              kind: 'raw-meaning-ambiguous' as const,
              stableKey: `provisional-${index}`,
              lineageKey: `provisional-lineage-${index}`,
              sourceRawFindingIds: [],
              reason: 'Provisional exact match must not become proof authority.',
              firstObservedAt: OBSERVATION,
              lastObservedAt: OBSERVATION,
              gateEffect: 'block' as const,
              firstObservedRound: 1,
            },
          }),
    })),
    rawFindings: [],
    conflicts: [],
    ...emptyFindingAuthorityProjection(),
  });
}

function candidateTargetLedger(): FindingLedger {
  const finding = (
    id: string,
    title: string,
    description: string,
    path: string,
  ) => ({
    id,
    status: 'open' as const,
    lifecycle: 'persists' as const,
    severity: 'high' as const,
    title,
    description,
    target: { kind: 'code' as const, paths: [path] },
    evidenceIds: [],
    rawFindingIds: [],
    reviewers: ['reviewer'],
    firstSeen: OBSERVATION,
    lastSeen: OBSERVATION,
    revision: 2,
  });
  return authorizeFindingLedgerFixture({
    workflowName: 'case-model',
    nextId: 4,
    updatedAt: OBSERVATION.timestamp,
    findings: [
      finding('F-0001', 'Canonical relation target', 'Different claim.', 'src/shared.ts'),
      finding('F-0002', 'Shared semantic defect', 'The same defect remains observable.', 'src/shared.ts'),
      finding('F-0003', 'Unrelated open target', 'Not a candidate.', 'src/other.ts'),
    ],
    rawFindings: [],
    conflicts: [],
    ...emptyFindingAuthorityProjection(),
  });
}

type ContributionOrigin =
  | { kind: 'external' }
  | { kind: 'interpretation_case'; caseId: string };

function withTargetEvidence(input: {
  ledger: FindingLedger;
  records: FindingLedger['evidenceRecords'];
  originsByEvidenceId: ReadonlyMap<string, readonly ContributionOrigin[]>;
}): FindingLedger {
  const target = input.ledger.findings[0]!;
  const evidenceIds = input.records.map((record) => record.evidenceId);
  return {
    ...input.ledger,
    findings: [{
      ...target,
      evidenceIds: [...target.evidenceIds, ...evidenceIds],
    }, ...input.ledger.findings.slice(1)],
    evidenceRecords: [...input.ledger.evidenceRecords, ...input.records],
    evidenceBindings: [
      ...input.ledger.evidenceBindings,
      ...evidenceIds.flatMap((evidenceId) => (
      (input.originsByEvidenceId.get(evidenceId) ?? []).map((contributionOrigin, index) => ({
        bindingId: `${evidenceId}:${index}`,
        evidenceId,
        claimIdentityHash: target.claimIdentityHash,
        sourceRawFindingId: null,
        sourceRawIntegrityDigest: null,
        operation: 'persist_finding' as const,
        target: {
          entityKind: 'finding' as const,
          entityId: target.id,
          expectedHead: null,
        },
        contributionOrigin,
      }))
      )),
    ],
  };
}

function fileQuoteRecord(input: {
  evidenceId: string;
  verbatimExcerpt?: string;
  fileHash?: string;
}): FindingLedger['evidenceRecords'][number] {
  return {
    evidenceId: input.evidenceId,
    kind: 'file_quote',
    path: 'src/external.ts',
    startLine: 1,
    endLine: 1,
    verbatimExcerpt: input.verbatimExcerpt ?? 'external evidence',
    snapshotId: '1'.repeat(64),
    claimIdentityHash: '2'.repeat(64),
    fileHash: input.fileHash ?? '3'.repeat(64),
  };
}

function taintedItems(input: {
  rawFindingIds: readonly string[];
  currentLedger?: FindingLedger;
  description?: (rawFindingId: string) => string;
  relation?: 'new' | 'persists' | 'resolution_confirmation';
  targetFindingId?: string | null;
  reportPrefix?: string;
  evidenceLine?: (rawFindingId: string) => number;
  familyTag?: (rawFindingId: string) => string | null;
}): CanonicalIntakeItem[] {
  const currentLedger = input.currentLedger ?? ledger();
  const relation = input.relation ?? 'persists';
  const targetFindingId = input.targetFindingId === undefined ? 'F-0001' : input.targetFindingId;
  const extractions = input.rawFindingIds.map((rawFindingId) => (
    reviewerRawExtractionFixture({
      rawFindingId,
      familyTag: input.familyTag === undefined
        ? 'architecture'
        : input.familyTag(rawFindingId),
      severity: 'high',
      title: 'Shared semantic defect',
      description: input.description?.(rawFindingId)
        ?? 'The same defect remains observable.',
      suggestion: null,
      relation,
      targetFindingId,
      target: { kind: 'code', paths: ['src/shared.ts'] },
      evidenceRequests: [{
        kind: 'file_quote',
        path: 'src/shared.ts',
        startLine: input.evidenceLine?.(rawFindingId) ?? 1,
        endLine: input.evidenceLine?.(rawFindingId) ?? 1,
      }],
      rawExcerpt: `${input.reportPrefix ?? ''}${rawFindingId}: shared semantic defect`,
    })
  ));
  const candidates = createReviewerRawFindingCandidates(extractions, {
    workflowName: currentLedger.workflowName,
    callNamespace: '',
    parentStepName: 'reviewers',
    stepIteration: 1,
    runId: 'run-input',
    reviewerStepName: 'architecture-review',
    reviewerPersonaKey: 'architecture-reviewer',
    ledger: currentLedger,
    reviewReport: extractions.map((item) => item.rawExcerpt).join('\n'),
    issueEvidenceRequests: ({ requests }) => ({
      evidence: requests.flatMap((request) => (
        request.kind === 'file_quote'
          ? [{
              ...request,
              snapshotId: '1'.repeat(64),
              verbatimExcerpt: `line ${request.startLine}`,
            }]
          : []
      )),
      engineProofRecords: [],
      coverageGaps: [],
      materializedQuoteBytes: 0,
    }),
    commitEvidenceIssuance: () => {},
  }).candidates;
  return candidates.map((candidate) => {
    const { canonical } = canonicalizeReviewerRawFinding(candidate, {
      ledger: currentLedger,
      clarificationAttempted: true,
      priorAmbiguityCodes: ['missing-required-field'],
    });
    return { canonical, wire: toLedgerRawFinding(canonical) };
  });
}

describe('interpretation case model', () => {
  it('groups three equivalent raws into one provider case with deterministic members', () => {
    const currentLedger = ledger();
    const items = taintedItems({
      rawFindingIds: ['raw-c', 'raw-a', 'raw-b'],
      currentLedger,
    });
    const cases = createInterpretationCases({
      items,
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ kind: 'provider_case', policyClass: 'general' });
    expect(cases[0]!.members.map((member) => member.rawFindingId)).toEqual(
      items.map((item) => item.canonical.rawFindingId).sort(compareBinaryStrings),
    );
  });

  it('keeps a semantically mixed case whole and settles every member provisional', () => {
    const currentLedger = ledger();
    const items = taintedItems({
      rawFindingIds: ['raw-a', 'raw-b', 'raw-c'],
      currentLedger,
      evidenceLine: (rawFindingId) => (rawFindingId === 'raw-b' ? 2 : 1),
    });
    const cases = createInterpretationCases({
      items,
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      kind: 'case_provisional',
      reason: expect.stringContaining('mixed semantic projections'),
    });
    expect(cases[0]!.members.map((member) => member.rawFindingId)).toEqual(
      items.map((item) => item.canonical.rawFindingId).sort(compareBinaryStrings),
    );
  });

  it('derives projection from canonical raws and external ledger context', () => {
    const revisionOne = ledger(1);
    const changedTargetLedger: FindingLedger = {
      ...revisionOne,
      findings: [{
        ...revisionOne.findings[0]!,
        title: 'Changed external target meaning',
      }],
    };
    const first = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: revisionOne }),
      ledger: revisionOne,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const movedSource = createInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-moved'],
        currentLedger: revisionOne,
        reportPrefix: 'padding-before-source-',
      }),
      ledger: revisionOne,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const changedTarget = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: changedTargetLedger }),
      ledger: changedTargetLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(movedSource.caseId).toBe(first.caseId);
    expect(movedSource.semanticProjectionDigest).toBe(first.semanticProjectionDigest);
    expect(changedTarget.caseId).toBe(first.caseId);
    expect(changedTarget.semanticProjectionDigest).not.toBe(first.semanticProjectionDigest);
  });

  it('retains the provider-facing semantic decision context used by the digest', () => {
    const currentLedger = ledger();
    const planned = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-context'], currentLedger }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(Reflect.get(planned, 'decisionContext')).toBeDefined();
  });

  it('exposes only canonical relation targets to the provider and rejects conflicts outside them', () => {
    const currentLedger = candidateTargetLedger();
    const planned = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-targets'], currentLedger }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(planned.decisionContext).toMatchObject({
      candidateTargets: [
        { targetFindingId: 'F-0001' },
      ],
    });
    expect(validateInterpretationCaseDecision({
      plannedCase: planned,
      decision: { kind: 'open_conflict', targetFindingId: 'F-0003' },
      ledger: currentLedger,
    })).toMatchObject({ kind: 'provisional' });
  });

  it('disables open-conflict capability when no candidate target exists', () => {
    const currentLedger = ledger();
    const planned = createInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-new'],
        currentLedger,
        relation: 'new',
        targetFindingId: null,
      }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(planned.decisionContext).toMatchObject({
      candidateTargets: [],
      capabilities: { mayOpenConflict: false },
    });
    expect(validateInterpretationCaseDecision({
      plannedCase: planned,
      decision: { kind: 'open_conflict', targetFindingId: 'F-0001' },
      ledger: currentLedger,
    })).toMatchObject({ kind: 'provisional' });
  });

  it('disables open-conflict capability when every candidate target is closed', () => {
    const base = ledger();
    const currentLedger: FindingLedger = {
      ...base,
      findings: [{
        ...base.findings[0]!,
        status: 'resolved',
        lifecycle: 'resolved',
      }],
    };
    const planned = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-closed'], currentLedger }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(planned.decisionContext).toMatchObject({
      candidateTargets: [{ targetFindingId: 'F-0001', status: 'resolved' }],
      capabilities: { mayOpenConflict: false },
    });
    expect(validateInterpretationCaseDecision({
      plannedCase: planned,
      decision: { kind: 'open_conflict', targetFindingId: 'F-0001' },
      ledger: currentLedger,
    })).toMatchObject({ kind: 'provisional' });
  });

  it('exposes canonical ambiguity codes in the semantic decision context', () => {
    const currentLedger = ledger();
    const planned = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-codes'], currentLedger }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(planned.decisionContext).toMatchObject({
      ambiguityCodes: ['missing-required-field'],
    });
  });

  it('keeps the semantic digest stable across bookkeeping-only revision and raw attachment', () => {
    const before = ledgerWithTarget(2);
    const after: FindingLedger = {
      ...before,
      findings: [{
        ...before.findings[0]!,
        revision: 3,
        rawFindingIds: ['bookkeeping-only-raw'],
        lastSeen: {
          runId: 'other-run',
          stepName: 'other-step',
          timestamp: '2026-08-03T00:00:00.000Z',
        },
      }],
    };
    const first = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: before }),
      ledger: before,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const bookkeepingOnly = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-moved'], currentLedger: after }),
      ledger: after,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(bookkeepingOnly.decisionContext).toEqual(first.decisionContext);
    expect(bookkeepingOnly.semanticProjectionDigest).toBe(first.semanticProjectionDigest);
  });

  it.each([
    ['status', { status: 'resolved', lifecycle: 'resolved' }],
    ['title', { title: 'Changed external target meaning' }],
  ] as const)('changes the semantic digest when external target %s changes', (_field, overrides) => {
    const before = ledgerWithTarget(2);
    const after = ledgerWithTarget(2, overrides);
    const first = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: before }),
      ledger: before,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const changed = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: after }),
      ledger: after,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(changed.semanticProjectionDigest).not.toBe(first.semanticProjectionDigest);
  });

  it('changes the semantic digest when external evidence content changes under the same id', () => {
    const evidence = {
      evidenceId: 'E-shared',
      kind: 'file_quote',
      path: 'src/external.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'before',
      snapshotId: '1'.repeat(64),
      claimIdentityHash: '2'.repeat(64),
      fileHash: '3'.repeat(64),
    } satisfies FindingLedger['evidenceRecords'][number];
    const beforeBase = ledgerWithTarget(2);
    const externalOrigins = new Map([[evidence.evidenceId, [{ kind: 'external' as const }]]]);
    const before = withTargetEvidence({
      ledger: beforeBase,
      records: [evidence],
      originsByEvidenceId: externalOrigins,
    });
    const after = withTargetEvidence({
      ledger: beforeBase,
      records: [{ ...evidence, verbatimExcerpt: 'after' }],
      originsByEvidenceId: externalOrigins,
    });
    const first = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: before }),
      ledger: before,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const changed = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: after }),
      ledger: after,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(changed.semanticProjectionDigest).not.toBe(first.semanticProjectionDigest);
  });

  it('ignores an external evidence snapshot-id-only change', () => {
    const evidence = {
      evidenceId: 'E-shared',
      kind: 'file_quote',
      path: 'src/external.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'same content',
      snapshotId: '1'.repeat(64),
      claimIdentityHash: '2'.repeat(64),
      fileHash: '3'.repeat(64),
    } satisfies FindingLedger['evidenceRecords'][number];
    const base = ledgerWithTarget(2);
    const externalOrigins = new Map([[evidence.evidenceId, [{ kind: 'external' as const }]]]);
    const before = withTargetEvidence({
      ledger: base,
      records: [evidence],
      originsByEvidenceId: externalOrigins,
    });
    const after = withTargetEvidence({
      ledger: base,
      records: [{ ...evidence, snapshotId: '4'.repeat(64) }],
      originsByEvidenceId: externalOrigins,
    });
    const first = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: before }),
      ledger: before,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const snapshotOnly = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-moved'], currentLedger: after }),
      ledger: after,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(snapshotOnly.semanticProjectionDigest).toBe(first.semanticProjectionDigest);
  });

  it('ignores file-hash-only changes in typed file-quote evidence', () => {
    const base = ledgerWithTarget(2);
    const beforeRecord = fileQuoteRecord({ evidenceId: 'E-file', fileHash: '3'.repeat(64) });
    const afterRecord = fileQuoteRecord({ evidenceId: 'E-file', fileHash: '4'.repeat(64) });
    const origins = new Map([[beforeRecord.evidenceId, [{ kind: 'external' as const }]]]);
    const before = withTargetEvidence({ ledger: base, records: [beforeRecord], originsByEvidenceId: origins });
    const after = withTargetEvidence({ ledger: base, records: [afterRecord], originsByEvidenceId: origins });
    const first = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: before }),
      ledger: before,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const fileHashOnly = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-moved'], currentLedger: after }),
      ledger: after,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(fileHashOnly.semanticProjectionDigest).toBe(first.semanticProjectionDigest);
  });

  it('deduplicates equal typed evidence content independently of evidence ids', () => {
    const base = ledgerWithTarget(2);
    const firstRecord = fileQuoteRecord({ evidenceId: 'E-first' });
    const duplicateRecord = fileQuoteRecord({ evidenceId: 'E-duplicate' });
    const one = withTargetEvidence({
      ledger: base,
      records: [firstRecord],
      originsByEvidenceId: new Map([[firstRecord.evidenceId, [{ kind: 'external' }]]]),
    });
    const duplicated = withTargetEvidence({
      ledger: base,
      records: [duplicateRecord, firstRecord],
      originsByEvidenceId: new Map([
        [firstRecord.evidenceId, [{ kind: 'external' }]],
        [duplicateRecord.evidenceId, [{ kind: 'external' }]],
      ]),
    });
    const first = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: one }),
      ledger: one,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const duplicate = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-moved'], currentLedger: duplicated }),
      ledger: duplicated,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(duplicate.semanticProjectionDigest).toBe(first.semanticProjectionDigest);
  });

  it('projects transition proof semantics without lifecycle bookkeeping', () => {
    const transitionRecord = (overrides: {
      rawFindingId?: string;
      expectedRawFindingId?: string;
      integrityDigest?: string;
      dependencyDigests?: string[];
      provisionalStableKey?: string;
      provisionalLineageKey?: string;
      transitionPreconditionDigest?: string;
      expectedRevision?: number;
      expectedProjectionDigest?: string;
      materializedProductClaimDigest?: string;
    } = {}): FindingLedger['evidenceRecords'][number] => ({
      evidenceId: 'E-transition',
      proofId: 'P-transition',
      kind: 'engine_proof',
      verifierId: 'transition-verifier',
      verifierVersion: '1',
      workflowName: 'case-model',
      runId: 'run-bookkeeping',
      scopeIdentity: 'scope',
      snapshotId: '1'.repeat(64),
      targetFindingId: 'F-0001',
      dependencyDigests: overrides.dependencyDigests ?? ['dependency'],
      resultDigest: 'result',
      issuedAt: OBSERVATION.timestamp,
      purpose: 'lifecycle_authority',
      claimIdentityHash: null,
      subject: {
        kind: 'finding_provisional_product_transition',
        operation: 'promote_provisional',
        findingId: 'F-0001',
        provisionalStableKey: overrides.provisionalStableKey ?? 'stable',
        provisionalLineageKey: overrides.provisionalLineageKey ?? 'lineage',
        targetIdentityHash: 'target-identity',
        sourceRawFindings: [{
          rawFindingId: overrides.rawFindingId ?? 'raw-before',
          integrityDigest: overrides.integrityDigest ?? 'integrity-a',
        }],
        expectedProductRawFindingIds: [overrides.expectedRawFindingId ?? 'raw-before'],
        transitionPreconditionDigest: overrides.transitionPreconditionDigest ?? 'precondition',
        expectedIntermediateHead: {
          revision: overrides.expectedRevision ?? 7,
          projectionDigest: overrides.expectedProjectionDigest ?? 'projection',
        },
        materializedProductClaimDigest: overrides.materializedProductClaimDigest ?? 'materialized',
      },
    });
    const base = ledgerWithTarget(2);
    const origins = new Map([['E-transition', [{ kind: 'external' as const }]]]);
    const before = withTargetEvidence({
      ledger: base,
      records: [transitionRecord()],
      originsByEvidenceId: origins,
    });
    const bookkeepingChanged = withTargetEvidence({
      ledger: base,
      records: [transitionRecord({
        rawFindingId: 'raw-after',
        expectedRawFindingId: 'expected-after',
        integrityDigest: 'integrity-b',
        dependencyDigests: ['dependency-after'],
        provisionalStableKey: 'stable-after',
        provisionalLineageKey: 'lineage-after',
        transitionPreconditionDigest: 'precondition-after',
        expectedRevision: 99,
        expectedProjectionDigest: 'projection-after',
      })],
      originsByEvidenceId: origins,
    });
    const materializedChanged = withTargetEvidence({
      ledger: base,
      records: [transitionRecord({ materializedProductClaimDigest: 'materialized-after' })],
      originsByEvidenceId: origins,
    });
    const digestFor = (currentLedger: FindingLedger, rawFindingId: string) => (
      createInterpretationCases({
        items: taintedItems({ rawFindingIds: [rawFindingId], currentLedger }),
        ledger: currentLedger,
        provisionalOnlyRawFindingIds: new Set(),
      })[0]!.semanticProjectionDigest
    );
    const first = digestFor(before, 'raw-a');

    expect(digestFor(bookkeepingChanged, 'raw-moved')).toBe(first);
    expect(digestFor(materializedChanged, 'raw-moved')).not.toBe(first);
  });

  it('excludes proof target revision but includes proof identity capability', () => {
    const revisionTwo = ledgerWithTarget(2);
    const revisionThree: FindingLedger = {
      ...revisionTwo,
      findings: [{ ...revisionTwo.findings[0]!, revision: 3 }],
    };
    const changedIdentity = ledgerWithTarget(2, {
      target: { kind: 'code', paths: ['src/other.ts'] },
    });
    const first = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: revisionTwo }),
      ledger: revisionTwo,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const revisionOnly = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-moved'], currentLedger: revisionThree }),
      ledger: revisionThree,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const identityChanged = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: changedIdentity }),
      ledger: changedIdentity,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(first.members[0]!.proofBinding?.targetRevision).toBe(2);
    expect(revisionOnly.members[0]!.proofBinding?.targetRevision).toBe(3);
    expect(revisionOnly.semanticProjectionDigest).toBe(first.semanticProjectionDigest);
    expect(identityChanged.semanticProjectionDigest).not.toBe(first.semanticProjectionDigest);
  });

  it('does not issue a same proof when the only exact match is provisional', () => {
    const currentLedger = exactMatchLedger(['provisional']);
    const planned = createInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-provisional-only'],
        currentLedger,
        relation: 'new',
        targetFindingId: null,
      }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(planned.members[0]!.proofBinding).toBeUndefined();
  });

  it('rejects an already issued same proof when its target becomes provisional', () => {
    const currentLedger = exactMatchLedger(['product']);
    const planned = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-proof'], currentLedger }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const proof = planned.members[0]!.proofBinding;
    expect(proof).toBeDefined();
    const target = currentLedger.findings[0]!;
    const provisionalLedger: FindingLedger = {
      ...currentLedger,
      findings: [{
        ...target,
        provisional: {
          kind: 'raw-meaning-ambiguous',
          stableKey: '7'.repeat(64),
          lineageKey: '8'.repeat(64),
          sourceRawFindingIds: [],
          reason: 'Target is no longer product authority.',
          firstObservedAt: OBSERVATION,
          lastObservedAt: OBSERVATION,
          gateEffect: 'block',
          firstObservedRound: 1,
        },
      }],
    };

    expect(verifySameProofAgainstLedger(proof!, provisionalLedger))
      .toEqual({ ok: false, reason: 'target finding "F-0001" is not an open product finding' });
  });

  it('issues a same proof only for the product when product and provisional exact matches coexist', () => {
    const currentLedger = exactMatchLedger(['product', 'provisional']);
    const planned = createInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-product-and-provisional'],
        currentLedger,
        relation: 'new',
        targetFindingId: null,
      }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(planned.members[0]!.proofBinding?.targetFindingId).toBe('F-0001');
  });

  it('does not issue a same proof when multiple product findings are exact matches', () => {
    const currentLedger = exactMatchLedger(['product', 'product']);
    const planned = createInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-multiple-products'],
        currentLedger,
        relation: 'new',
        targetFindingId: null,
      }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(planned.members[0]!.proofBinding).toBeUndefined();
  });

  it('ignores provisional metadata-only changes in target semantic context', () => {
    const before = ledgerWithTarget(2, {
      provisional: {
        kind: 'raw-meaning-ambiguous',
        stableKey: 'metadata-only',
        lineageKey: 'metadata-only-lineage',
        sourceRawFindingIds: ['metadata-only-raw'],
        reason: 'Initial bookkeeping metadata',
        firstObservedAt: OBSERVATION,
        lastObservedAt: OBSERVATION,
        gateEffect: 'block',
        firstObservedRound: 1,
      },
    });
    const after: FindingLedger = {
      ...before,
      findings: [{
        ...before.findings[0]!,
        provisional: {
          ...before.findings[0]!.provisional!,
          reason: 'Bookkeeping metadata must not change provider semantics',
          lastObservedAt: OBSERVATION,
          firstObservedRound: 3,
        },
      }],
    };
    const first = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-a'], currentLedger: before }),
      ledger: before,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const metadataOnly = createInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-moved'], currentLedger: after }),
      ledger: after,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(metadataOnly.semanticProjectionDigest).toBe(first.semanticProjectionDigest);
  });

  it('derives confirmation and provisional-only policy classes in the engine', () => {
    const currentLedger = ledger();
    const confirmation = createInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['confirmation'],
        currentLedger,
        relation: 'resolution_confirmation',
      }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;
    const provisionalOnlyItems = taintedItems({
      rawFindingIds: ['restricted'],
      currentLedger,
    });
    const provisionalOnly = createInterpretationCases({
      items: provisionalOnlyItems,
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set([
        provisionalOnlyItems[0]!.canonical.rawFindingId,
      ]),
    })[0]!;

    expect(confirmation.policyClass).toBe('confirmation');
    expect(provisionalOnly.policyClass).toBe('provisional_only');
    expect(confirmation.caseId).not.toBe(provisionalOnly.caseId);
  });

  it.each([
    ['confirmation', { kind: 'create_independent' }],
    ['provisional_only', { kind: 'create_independent' }],
    ['provisional_only', { kind: 'open_conflict', targetFindingId: 'F-0001' }],
  ] as const)('makes forbidden %s decision case-wide provisional', (policyClass, decision) => {
    const currentLedger = ledger();
    const rawFindingId = `raw-${policyClass}`;
    const items = taintedItems({
      rawFindingIds: [rawFindingId],
      currentLedger,
      relation: policyClass === 'confirmation' ? 'resolution_confirmation' : 'persists',
    });
    const planned = createInterpretationCases({
      items,
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: policyClass === 'provisional_only'
        ? new Set([items[0]!.canonical.rawFindingId])
        : new Set(),
    })[0]!;

    expect(validateInterpretationCaseDecision({
      plannedCase: planned,
      decision: decision satisfies InterpretationDecision,
      ledger: currentLedger,
    })).toMatchObject({ kind: 'provisional' });
  });

  it('makes create-independent provisional when a required product field is absent', () => {
    const currentLedger = ledger();
    const planned = createInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-missing-family'],
        currentLedger,
        familyTag: () => null,
      }),
      ledger: currentLedger,
      provisionalOnlyRawFindingIds: new Set(),
    })[0]!;

    expect(validateInterpretationCaseDecision({
      plannedCase: planned,
      decision: { kind: 'create_independent' },
      ledger: currentLedger,
    })).toMatchObject({ kind: 'provisional' });
  });

});
