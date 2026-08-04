import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const allocationHash = vi.hoisted(() => ({ forceCollision: false }));

// duplicate rawFindingId allocation describe 用: ハッシュ衝突を強制できる
// 条件付きモック。既定はパススルーで、他の describe は実ハッシュのまま。
vi.mock('../core/workflow/findings/raw-finding-id-allocation-hash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/raw-finding-id-allocation-hash.js')>();
  return {
    ...actual,
    hashRawFindingIdAllocationContent: (
      ...args: Parameters<typeof actual.hashRawFindingIdAllocationContent>
    ) => (allocationHash.forceCollision
      ? 'forced-collision'
      : actual.hashRawFindingIdAllocationContent(...args)),
  };
});
import { buildAdjudicationEvidenceSnapshot, computeAdjudicationEvidenceHash } from '../core/workflow/findings/adjudication-evidence.js';
import { assembleManagerOutput } from '../core/workflow/findings/decision-assembly.js';
import { serializeFindingManagerValidationReport } from '../core/workflow/findings/manager-report-content.js';
import { foldRawFindingEvidence } from '../core/workflow/findings/finding-evidence-fold.js';
import { intakeReviewerOutputs } from '../core/workflow/findings/manager-intake.js';
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
  RawAmbiguityCode,
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
  rawFindings: [],
  conflicts: [],
  interpretations: [],
};

const REVIEWER_CONTEXT = {
  workflowName: 'peer-review',
  callNamespace: '',
  parentStepName: 'reviewers',
  stepIteration: 1,
  runId: 'run-1',
  reviewerPersonaKey: 'architecture-review',
  reviewerStepName: 'architecture-review',
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
  const canonicals = createReviewerRawFindingCandidates(items, REVIEWER_CONTEXT)
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
    provisionalFindings: [],
    rawFindingDispositions: [],
    rawProvenanceByRawFindingId: new Map(canonicals.map((canonical) => [
      canonical.rawFindingId,
      {
        reviewerStableKey: canonical.reviewerStableKey,
        lineageKey: canonical.lineageKey,
        claimIdentityHash: canonical.evidenceHash,
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
    location: `src/${title}.ts:1`,
    description: `Evidence for ${title}`,
    relation: 'new',
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
    relation: 'new',
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

  it('serializes manager report keys, dispositions, and recovery settlements canonically', () => {
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
      rawFindingDispositions: ordered.map((id) => ({
        rawFindingId: id,
        outcome: 'audit_only',
        reason: id,
      })),
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

describe('binary string decision order', () => {
  it.each([
    ['NFC and decomposed accents', 'raw-é', 'raw-e\u0301'],
    ['letter case', 'raw-A', 'raw-a'],
    ['supplementary code points', 'raw-\u{1F600}', 'raw-\u{1F601}'],
  ])('never treats distinct %s as equal and is independent of input order', (
    _case,
    left,
    right,
  ) => {
    expect(left).not.toBe(right);
    expect(compareBinaryStrings(left, right)).not.toBe(0);
    expect(compareBinaryStrings(right, left))
      .toBe(-compareBinaryStrings(left, right));

    const forward = [left, right].sort(compareBinaryStrings);
    const reversed = [right, left].sort(compareBinaryStrings);
    expect(forward).toEqual(reversed);

    const forwardEvidence = foldRawFindingEvidence([
      rawFinding(left),
      rawFinding(right),
    ]);
    const reversedEvidence = foldRawFindingEvidence([
      rawFinding(right),
      rawFinding(left),
    ]);
    expect(forwardEvidence).toEqual(reversedEvidence);
    expect(forwardEvidence.description).toBe(`Evidence for ${forward[0]}`);
  });
});

describe('duplicate rawFindingId allocation under hash collision', () => {
  beforeEach(() => {
    allocationHash.forceCollision = true;
  });

  afterEach(() => {
    allocationHash.forceCollision = false;
  });

  const COLLISION_CONTEXT = {
    workflowName: 'peer-review',
    callNamespace: '',
    parentStepName: 'reviewers',
    stepIteration: 1,
    runId: 'run-1',
    reviewerPersonaKey: 'arch-review',
    reviewerStepName: 'arch-review',
  } as const;

  function project(items: readonly unknown[]) {
    const candidates = createReviewerRawFindingCandidates(items, COLLISION_CONTEXT);
    const priorCodesByRawId: Record<string, RawAmbiguityCode[]> = {
      'z-clarification': ['relation-target-mismatch'],
    };
    const canonicals = candidates.map((candidate) => {
      const priorCodes = candidate.reviewerRawFindingId !== undefined
        ? priorCodesByRawId[candidate.reviewerRawFindingId]
        : undefined;
      return canonicalizeReviewerRawFinding(candidate, {
        ledger: EMPTY_LEDGER,
        clarificationAttempted: true,
        ...(priorCodes !== undefined ? { priorAmbiguityCodes: priorCodes } : {}),
      }).canonical;
    });
    const rawFindings = canonicals.map(toLedgerRawFinding);
    return {
      idsByTitle: Object.fromEntries(candidates.map((candidate) => [
        candidate.title,
        candidate.reviewerRawFindingId,
      ])),
      intakeIdsByTitle: Object.fromEntries(candidates.map((candidate) => [
        candidate.title,
        candidate.intakeId,
      ])),
      clarification: candidates.find(
        (candidate) => candidate.reviewerRawFindingId === 'z-clarification',
      ),
      clarificationCanonical: canonicals.find(
        (canonical) => canonical.title === 'Clarification',
      ),
      evidence: foldRawFindingEvidence(rawFindings),
    };
  }

  const first = {
    rawFindingId: 'duplicate',
    familyTag: 'correctness',
    severity: 'high',
    title: 'Alpha',
    location: 'src/alpha.ts:1',
    description: 'Alpha evidence',
    suggestion: 'Fix alpha',
    relation: 'new',
    evidenceKind: 'source_quote',
    verbatimExcerpt: 'const alpha = true;',
    snapshotId: 'snapshot-1',
  };
  const second = {
    rawFindingId: 'duplicate',
    familyTag: 'correctness',
    severity: 'medium',
    title: 'Beta',
    location: 'src/beta.ts:2',
    description: 'Beta evidence',
    suggestion: 'Fix beta',
    relation: 'new',
    evidenceKind: 'source_quote',
    verbatimExcerpt: 'const beta = true;',
    snapshotId: 'snapshot-1',
  };
  const clarification = {
    rawFindingId: 'z-clarification',
    familyTag: 'correctness',
    severity: 'low',
    title: 'Clarification',
    description: 'Clarification evidence',
    relation: 'new',
    evidenceKind: 'locationless',
  };

  it('uses complete normalized content after the hash before input index', () => {
    const forward = project([first, second, clarification]);
    const reversed = project([second, first, clarification]);

    expect(forward.idsByTitle).toEqual(reversed.idsByTitle);
    expect(forward.evidence).toEqual(reversed.evidence);
    expect(forward.clarification?.reviewerRawFindingId).toBe('z-clarification');
    expect(forward.clarificationCanonical?.provenance.ambiguityOrigin).toBe(true);
    expect(forward.clarificationCanonical?.provenance.ambiguityCodes)
      .toContain('relation-target-mismatch');
  });

  it.each([
    ['NFC and decomposed accents', 'é', 'e\u0301'],
    ['letter case', 'Alpha', 'alpha'],
    ['supplementary code points', '\u{1F600}', '\u{1F601}'],
  ])('allocates colliding %s by content independently of input order', (
    _case,
    leftTitle,
    rightTitle,
  ) => {
    const left = { ...first, title: leftTitle };
    const right = { ...second, title: rightTitle };
    const forward = project([left, right, clarification]);
    const reversed = project([right, left, clarification]);

    expect(forward.idsByTitle).toEqual(reversed.idsByTitle);
    expect(new Set(Object.values(forward.idsByTitle)).size).toBe(3);
  });

  it('uses input index only when normalized contents are identical', () => {
    const candidates = createReviewerRawFindingCandidates([
      { ...first },
      { ...first },
    ], COLLISION_CONTEXT);

    expect(candidates.map((candidate) => candidate.reviewerRawFindingId))
      .toEqual(['duplicate', 'duplicate-dup2']);
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
  });

  it('allocates missing IDs by complete content under a hash collision', () => {
    const firstWithoutId = { ...first, rawFindingId: undefined };
    const secondWithoutId = { ...second, rawFindingId: undefined };

    const forward = project([firstWithoutId, secondWithoutId]);
    const reversed = project([secondWithoutId, firstWithoutId]);

    expect(forward.intakeIdsByTitle).toEqual(reversed.intakeIdsByTitle);
    expect(new Set(Object.values(forward.intakeIdsByTitle)).size).toBe(2);
  });

  it('uniquifies completely identical missing-ID candidates with the final input-position tie break', () => {
    const identicalWithoutId = { ...first, rawFindingId: undefined };
    const candidates = createReviewerRawFindingCandidates([
      { ...identicalWithoutId },
      { ...identicalWithoutId },
    ], COLLISION_CONTEXT);

    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
    expect(candidates[0]?.intakeId.endsWith('item-forced-collision')).toBe(true);
    expect(candidates[1]?.intakeId.endsWith('item-forced-collision-dup2')).toBe(true);
  });

  it('preserves an existing explicit suffixed ID while allocating duplicates', () => {
    const candidates = createReviewerRawFindingCandidates([
      first,
      {
        ...second,
        rawFindingId: 'duplicate-dup2',
        title: 'Existing suffix',
      },
      second,
    ], COLLISION_CONTEXT);
    const idsByTitle = Object.fromEntries(candidates.map((candidate) => [
      candidate.title,
      candidate.reviewerRawFindingId,
    ]));

    expect(idsByTitle['Existing suffix']).toBe('duplicate-dup2');
    expect(new Set(candidates.map((candidate) => candidate.reviewerRawFindingId)).size)
      .toBe(3);
  });
});

describe('createReviewerRawFindingCandidates の rawFindingId 一意性', () => {
  const context = {
    workflowName: 'peer-review',
    callNamespace: '',
    parentStepName: 'reviewers',
    reviewerPersonaKey: 'arch-review',
    reviewerStepName: 'arch-review',
  } as never;

  it('同一 reviewer 内の重複 ID を決定的にサフィックスして一意化する', () => {
    const candidates = createReviewerRawFindingCandidates([
      { rawFindingId: 'x', title: 'a', severity: 'low', description: 'a' },
      { rawFindingId: 'x', title: 'b', severity: 'low', description: 'b' },
      { rawFindingId: 'x-dup2', title: 'c', severity: 'low', description: 'c' },
    ], context);

    const reviewerIds = candidates.map((candidate) => candidate.reviewerRawFindingId);
    expect(new Set(reviewerIds).size).toBe(3);
    expect(reviewerIds).toContain('x');
    expect(candidates.find((candidate) => candidate.title === 'c')?.reviewerRawFindingId)
      .toBe('x-dup2');
    const intakeIds = candidates.map((candidate) => candidate.intakeId);
    expect(new Set(intakeIds).size).toBe(3);
  });

  it('内容の異なる重複明示 ID は入力順を反転しても同じ canonical projection を作る', () => {
    const rawA = {
      rawFindingId: 'x',
      title: 'A',
      severity: 'low',
      description: 'A evidence',
      relation: 'new',
    };
    const rawB = {
      rawFindingId: 'x',
      title: 'B',
      severity: 'low',
      description: 'B evidence',
      relation: 'new',
    };
    const project = (items: readonly unknown[]) => {
      const candidates = createReviewerRawFindingCandidates(items, context);
      const rawFindings = candidates
        .map((candidate) => canonicalizeReviewerRawFinding(candidate, {
          ledger: EMPTY_LEDGER,
        }).canonical)
        .map(toLedgerRawFinding);
      return {
        titlesInInputOrder: candidates.map((candidate) => candidate.title),
        idsByTitle: Object.fromEntries(
          candidates.map((candidate) => [
            candidate.title,
            candidate.reviewerRawFindingId,
          ]),
        ),
        evidence: foldRawFindingEvidence(rawFindings),
      };
    };

    const forward = project([rawA, rawB]);
    const reversed = project([rawB, rawA]);
    expect(forward.titlesInInputOrder).toEqual(['A', 'B']);
    expect(reversed.titlesInInputOrder).toEqual(['B', 'A']);
    expect(forward.idsByTitle).toEqual(reversed.idsByTitle);
    expect(forward.evidence).toEqual(reversed.evidence);
  });

  it('内容が完全に同じ重複明示 ID も出力順を保ったまま一意化する', () => {
    const item = {
      rawFindingId: 'x',
      title: 'same',
      severity: 'low',
      description: 'same',
    };
    const candidates = createReviewerRawFindingCandidates([
      { ...item },
      { ...item },
    ], context);

    expect(candidates.map((candidate) => candidate.title)).toEqual(['same', 'same']);
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
  });

  it('内容安定の内部 ID と一意な明示 ID をそれぞれ保持する', () => {
    // 明示 ID の改名は clarification の priorAmbiguityCodesByRawId 相関を壊し、
    // 訂正済み raw の taint（ambiguityOrigin）が外れて clean 権限を得てしまう。
    // ずれるのは常に内部採番の側でなければならない。
    const candidates = createReviewerRawFindingCandidates([
      { title: 'a', severity: 'low', description: 'a' },
      { rawFindingId: 'item-1', title: 'b', severity: 'low', description: 'b' },
    ], context);

    expect(candidates[0]!.reviewerRawFindingId).toBeUndefined();
    expect(candidates[1]!.reviewerRawFindingId).toBe('item-1');
    expect(candidates[0]!.intakeId).toMatch(/:item-[0-9a-f]{64}$/);
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
  });

  it('ID 未指定の項目は従来どおり reviewerRawFindingId を持たない', () => {
    const candidates = createReviewerRawFindingCandidates([
      { title: 'a', severity: 'low', description: 'a' },
      { title: 'b', severity: 'low', description: 'b' },
    ], context);

    expect(candidates.every((candidate) => candidate.reviewerRawFindingId === undefined)).toBe(true);
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
  });

  it('未信頼 provider item の実行コードを呼ばず、悪性 item だけを寛容な rejection に落とす', () => {
    let getterReads = 0;
    let toJsonCalls = 0;
    let proxyReads = 0;
    const getterItem = Object.defineProperty({
      rawFindingId: 'getter',
    }, 'title', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'getter title';
      },
    });
    const toJsonItem = {
      rawFindingId: 'to-json',
      toJSON() {
        toJsonCalls += 1;
        return { rawFindingId: 'forged' };
      },
    };
    const proxyItem = new Proxy({ rawFindingId: 'proxy' }, {
      get(target, key, receiver) {
        proxyReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const symbolItem = { rawFindingId: 'symbol' };
    Object.defineProperty(symbolItem, Symbol('hidden'), {
      enumerable: true,
      value: 'hidden',
    });
    const nonEnumerableItem = { rawFindingId: 'non-enumerable' };
    Object.defineProperty(nonEnumerableItem, 'hidden', {
      enumerable: false,
      value: 'hidden',
    });
    const extraItem = { rawFindingId: 'extra', unexpected: 'value' };
    const cyclicItem: Record<string, unknown> = { rawFindingId: 'cycle' };
    cyclicItem.description = cyclicItem;
    const sharedValue = { nested: 'shared' };
    const sharedReferenceItem = {
      rawFindingId: 'shared-reference',
      title: sharedValue,
      description: sharedValue,
    };
    const validItem = {
      rawFindingId: 'valid',
      relation: 'new',
      familyTag: 'bug',
      severity: 'low',
      title: 'valid title',
      description: 'valid description',
    };

    const intake = intakeReviewerOutputs({
      subResults: [{
        subStep: {
          name: 'arch-review',
          persona: 'arch-review',
        } as never,
        response: {
          status: 'done',
          content: '',
          structuredOutput: {
            rawFindings: [
              getterItem,
              toJsonItem,
              proxyItem,
              symbolItem,
              nonEnumerableItem,
              extraItem,
              cyclicItem,
              sharedReferenceItem,
              validItem,
            ],
          },
        },
      }],
      previousLedger: EMPTY_LEDGER,
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-provider-items',
    });

    expect(getterReads).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(proxyReads).toBe(0);
    expect(intake.items).toHaveLength(9);
    expect(intake.items.filter(({ wire }) => wire.title === 'valid title')).toHaveLength(1);
    expect(intake.items.filter(({ canonical }) => canonical.provenance.ambiguityOrigin))
      .toHaveLength(8);
  });
});
