import { describe, expect, it } from 'vitest';
import { findingContentAddress } from '../core/models/finding-contract-identity.js';
import { createEngineProofRecord } from '../core/models/finding-evidence-record.js';
import { buildLoopMonitorFindingsSummaryData, renderLoopMonitorFindingsSummary } from '../core/workflow/findings/loop-monitor-summary.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { applyFindingLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import { computeReviewerStableKey, computeLineageKey, computeProvisionalStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  RawFinding,
  ReviewerAnomalyEntry,
} from '../core/workflow/findings/types.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';

function provisionalEntry(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: '必須品質ゲートの実行証跡がない',
    evidenceIds: [],
    reviewers: ['coding-review'],
    rawFindingIds: ['raw-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    provisional: {
      kind: 'raw-meaning-ambiguous',
      stableKey: 'stable-1',
      lineageKey: 'lineage-1',
      sourceRawFindingIds: ['raw-1'],
      reason: 'claim has no mechanically verified evidence',
      firstObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      lastObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      gateEffect: 'block',
      firstObservedRound: 1,
    },
    ...overrides,
  };
}

function rawFindingFixtures(findings: FindingLedgerEntry[]): RawFinding[] {
  return [...new Set(findings.flatMap((finding) => finding.rawFindingIds))]
    .map((rawFindingId) => {
      const source = findings.find((finding) => finding.rawFindingIds.includes(rawFindingId));
      if (source === undefined) {
        throw new Error(`Missing fixture finding for raw finding "${rawFindingId}"`);
      }
      const reviewer = source.reviewers[0];
      if (reviewer === undefined) {
        throw new Error(`Missing fixture reviewer for raw finding "${rawFindingId}"`);
      }
      return canonicalRawFindingFixture({
        rawFindingId,
        stepName: 'reviewers',
        reviewer,
        familyTag: source.provisional === undefined ? 'product' : source.provisional.kind,
        severity: source.severity,
        title: source.title,
        description: source.description === undefined ? source.title : source.description,
        suggestion: source.suggestion === undefined ? null : source.suggestion,
        relation: 'new',
        targetFindingId: null,
        target: { kind: 'code', paths: [`fixtures/${source.id}.ts`] },
        evidence: [],
      });
    });
}

function attachProvisionalProvenance(
  ledger: FindingLedger,
  finding: FindingLedgerEntry,
): FindingLedger {
  const expectedHead = captureFindingLifecycleHead(ledger, 'finding', finding.id);
  if (expectedHead === undefined || finding.provisional === undefined) {
    throw new Error(`Missing provisional fixture head for finding "${finding.id}"`);
  }
  const proof = createEngineProofRecord({
    kind: 'engine_proof',
    purpose: 'lifecycle_authority',
    verifierId: 'takt.finding-lifecycle-policy',
    verifierVersion: '1',
    workflowName: ledger.workflowName,
    runId: finding.lastSeen.runId,
    scopeIdentity: 'loop-monitor-summary-fixture',
    snapshotId: findingContentAddress('loop-monitor-summary-snapshot', { findingId: finding.id }),
    claimIdentityHash: finding.claimIdentityHash,
    targetFindingId: finding.id,
    subject: {
      kind: 'finding_provisional_isolation',
      findingId: finding.id,
      provisionalKind: finding.provisional.kind,
      stableKey: finding.provisional.stableKey,
      claimBindingAuthorizationReferences: [],
    },
    dependencyDigests: [expectedHead.projectionDigest],
    resultDigest: findingContentAddress('loop-monitor-summary-proof', { findingId: finding.id }),
    issuedAt: finding.lastSeen.timestamp,
  });
  const { revision: _revision, ...change } = finding;
  void _revision;
  return applyFindingLifecycleCommands({
    ledger: {
      ...ledger,
      evidenceRecords: [...ledger.evidenceRecords, proof],
    },
    commands: [{
      operation: 'update_provisional',
      changes: {
        findings: [{
          ...change,
          evidenceIds: [...new Set([...finding.evidenceIds, proof.evidenceId])].sort(),
        }],
        conflicts: [],
      },
      authority: { kind: 'verified_evidence' },
      evidenceSourcesByTarget: new Map([[
        `finding\0${finding.id}`,
        {
          sourceRawFindingIds: [...finding.provisional.sourceRawFindingIds],
          authorityEvidenceIds: [proof.evidenceId],
        },
      ]]),
    }],
    occurredAt: finding.lastSeen,
  });
}

function makeLedger(findings: FindingLedgerEntry[], roundMarkers: string[] = []): FindingLedger {
  let ledger = authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    evidenceRecords: [],
    rawFindings: rawFindingFixtures(findings),
    conflicts: [],
    findings,
    ...(roundMarkers.length > 0
      ? { stopBudget: { roundMarkers, firstRoundAt: '2026-07-01T00:00:00.000Z', exhausted: false } }
      : {}),
  });
  for (const finding of ledger.findings) {
    if (finding.provisional !== undefined) {
      ledger = attachProvisionalProvenance(ledger, finding);
    }
  }
  return ledger;
}

function reviewerAnomaly(overrides: Partial<ReviewerAnomalyEntry> = {}): ReviewerAnomalyEntry {
  const observation = {
    runId: 'run-1',
    stepName: 'reviewers',
    timestamp: '2026-07-01T00:00:00.000Z',
  };
  return {
    id: 'RA-0001',
    kind: 'quote-mismatch',
    stableKey: 'reviewer-anomaly-stable-key',
    lineageKey: 'reviewer-anomaly-lineage-key',
    sourceRawFindingIds: ['raw-anomaly-1'],
    sourceIntakeIds: [],
    reviewers: ['coding-review'],
    title: 'Unverified reviewer claim',
    mismatchReason: 'The quoted source did not match',
    firstObserved: observation,
    lastObserved: observation,
    occurrences: 1,
    ...overrides,
  };
}

describe('renderLoopMonitorFindingsSummary', () => {
  it('完了ゲート充足状況・滞留ラウンド数・解消経路を構造として導出する', () => {
    const ledger = makeLedger(
      [
        provisionalEntry({ revision: 1 }),
        provisionalEntry({ revision: 1,
          id: 'F-0002',
          rawFindingIds: ['raw-2'],
          provisional: {
            ...provisionalEntry({ revision: 1 }).provisional!,
            kind: 'reviewer-output-overflow',
            stableKey: 'stable-2',
            sourceRawFindingIds: ['raw-2'],
            firstObservedRound: 5,
          },
        }),
        provisionalEntry({
          revision: 1,
          id: 'F-0003',
          rawFindingIds: ['raw-3'],
          provisional: undefined,
        }),
      ],
      ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
    );

    const data = buildLoopMonitorFindingsSummaryData(ledger, {});

    expect(data).toMatchObject({
      openCount: 3,
      openSubstantiveCount: 1,
      activeConflictCount: 0,
      roundsCompleted: 6,
      maxRounds: 40,
      reviewerAnomalies: {
        count: 0,
        budgetExhausted: false,
      },
    });
    expect(data.openProvisional).toEqual([
      // firstObservedRound=1、6ラウンド完了 → 6ラウンド滞留。意味曖昧 raw は裁定可能
      expect.objectContaining({ id: 'F-0001', kind: 'raw-meaning-ambiguous', stalledRounds: 6, dismissable: true }),
      // overflow 系は処理失敗の証跡なので裁定不可（clean 証拠のみが解消経路）
      expect.objectContaining({ id: 'F-0002', kind: 'reviewer-output-overflow', stalledRounds: 2, dismissable: false }),
    ]);
  });

  it('必須の firstObservedRound から滞留ラウンド数を直接算出する', () => {
    const entry = provisionalEntry({
      revision: 1,
      provisional: {
        ...provisionalEntry({ revision: 1 }).provisional!,
        firstObservedRound: 3,
      },
    });

    const data = buildLoopMonitorFindingsSummaryData(
      makeLedger([entry], ['r1', 'r2', 'r3', 'r4', 'r5']),
      {},
    );

    expect(data.openProvisional).toEqual([
      expect.objectContaining({ id: 'F-0001', stalledRounds: 3 }),
    ]);
  });

  it('レンダリングは構造の全要素（ID・種類・件数）を欠落なく反映する', () => {
    const ledger = makeLedger([provisionalEntry({ revision: 1 })], ['r1']);
    const data = buildLoopMonitorFindingsSummaryData(ledger, {});
    const summary = renderLoopMonitorFindingsSummary(ledger, {});

    // 文言は固定しない — データ構造から導出した識別子・数値が全て現れることだけを検証する。
    for (const provisional of data.openProvisional) {
      expect(summary).toContain(provisional.id);
      expect(summary).toContain(provisional.kind);
    }
    expect(summary).toContain(String(data.openCount));
    expect(summary).toContain(`${data.roundsCompleted}/${data.maxRounds}`);
  });

  it('provisional が無ければ暫定リストは空になる', () => {
    const data = buildLoopMonitorFindingsSummaryData(makeLedger([]), {});
    expect(data.openProvisional).toEqual([]);
  });

  it('anomaly のみの台帳では未昇格件数を product finding と分離して要約する', () => {
    const ledger: FindingLedger = {
      ...makeLedger([]),
      reviewerAnomalies: [reviewerAnomaly()],
    };

    const data = buildLoopMonitorFindingsSummaryData(ledger, {});
    const summary = renderLoopMonitorFindingsSummary(ledger, {});

    expect(data.openCount).toBe(0);
    expect(data.reviewerAnomalies).toEqual({
      count: 1,
      budgetExhausted: false,
    });
    expect(summary).toContain('findings.reviewerAnomalies.count: 1');
  });

  it('promoted/settled/outstanding anomaly が混在しても未決着だけを数える', () => {
    const ledger: FindingLedger = {
      ...makeLedger([]),
      reviewerAnomalies: [
        reviewerAnomaly({ id: 'RA-UNPROMOTED' }),
        reviewerAnomaly({
          id: 'RA-PROMOTED',
          stableKey: 'promoted-stable-key',
          promotedFindingId: 'F-0001',
        }),
        reviewerAnomaly({
          id: 'RA-SETTLED',
          stableKey: 'settled-stable-key',
          settlement: {
            kind: 'target_resolved_by_verified_evidence',
            findingId: 'F-0002',
            lifecycleEventId: 'event-1',
          },
        }),
      ],
    };

    const data = buildLoopMonitorFindingsSummaryData(ledger, {});
    const summary = renderLoopMonitorFindingsSummary(ledger, {});

    expect(data.reviewerAnomalies.count).toBe(1);
    expect(summary).toContain('findings.reviewerAnomalies.count: 1');
    expect(summary).not.toContain('RA-UNPROMOTED');
    expect(summary).not.toContain('RA-PROMOTED');
    expect(summary).not.toContain('RA-SETTLED');
  });

  it.each([false, true])(
    'review-integrity budget exhaustion=%s をそのまま要約する',
    (budgetExhausted) => {
      const ledger: FindingLedger = {
        ...makeLedger([]),
        reviewerAnomalies: [reviewerAnomaly()],
        reviewIntegrity: {
          roundMarkers: ['review-round-1'],
          firstRoundAt: '2026-07-01T00:00:00.000Z',
          exhausted: budgetExhausted,
        },
      };

      const data = buildLoopMonitorFindingsSummaryData(ledger, {});
      const summary = renderLoopMonitorFindingsSummary(ledger, {});

      expect(data.reviewerAnomalies.budgetExhausted).toBe(budgetExhausted);
      expect(summary).toContain(
        `findings.reviewerAnomalies.budgetExhausted: ${budgetExhausted}`,
      );
    },
  );

  it('anomaly の claimed content と raw reviewer text をプロンプト要約へ出さない', () => {
    const ledger: FindingLedger = {
      ...makeLedger([]),
      reviewerAnomalies: [reviewerAnomaly({
        id: 'SECRET_ANOMALY_ID',
        title: 'SECRET_REVIEWER_TITLE',
        claimedLocation: 'SECRET_CLAIMED_LOCATION',
        claimedExcerpt: 'SECRET_CLAIMED_EXCERPT',
        mismatchReason: 'SECRET_MISMATCH_REASON',
        sourceRawFindingIds: ['SECRET_RAW_FINDING_ID'],
        reviewers: ['SECRET_REVIEWER_NAME'],
      })],
    };

    const summary = renderLoopMonitorFindingsSummary(ledger, {});

    for (const secret of [
      'SECRET_ANOMALY_ID',
      'SECRET_REVIEWER_TITLE',
      'SECRET_CLAIMED_LOCATION',
      'SECRET_CLAIMED_EXCERPT',
      'SECRET_MISMATCH_REASON',
      'SECRET_RAW_FINDING_ID',
      'SECRET_REVIEWER_NAME',
    ]) {
      expect(summary).not.toContain(secret);
    }
  });

  it('anomaly を repairable finding と表現せず fix routing を禁止する', () => {
    const ledger: FindingLedger = {
      ...makeLedger([]),
      reviewerAnomalies: [reviewerAnomaly()],
    };

    const summary = renderLoopMonitorFindingsSummary(ledger, {});

    expect(summary).toContain('reviewer anomalies are unverified reviewer claims');
    expect(summary).toContain('not repairable product findings');
    expect(summary).toContain('Never route a reviewer anomaly to fix');
    expect(summary).toContain('only actionable open findings may be routed to fix');
  });
});

describe('provisional firstObservedRound persistence', () => {
  it('新規 provisional の作成時に現在ラウンド序数（記録済みラウンド + 1）を刻む', () => {
    const reviewerStableKey = computeReviewerStableKey({
      reviewer: 'coding-review',
      title: 'evidence-free demand',
      normalizedPathKey: '',
    });
    const lineageKey = computeLineageKey({ reviewer: 'coding-review', normalizedPathKey: '' });
    const rawFinding = canonicalRawFindingFixture({
      rawFindingId: 'raw-9',
      stepName: 'reviewers',
      reviewer: 'coding-review',
      familyTag: 'gate',
      severity: 'medium' as const,
      title: 'evidence-free demand',
      description: 'demand',
      suggestion: null,
      relation: 'new' as const,
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/evidence-free-demand.ts'] },
      evidence: [],
    });
    const next = reconcileFindingLedger({
      previousLedger: makeLedger([], ['r1', 'r2', 'r3']),
      rawFindings: [rawFinding],
      managerOutput: createEmptyManagerOutput(),
      entityProvisionalMutations: [],
      terminalEntityAttachmentFindingIds: new Set(),
      provisionalFindings: [{
        kind: 'raw-meaning-ambiguous',
        stableKey: computeProvisionalStableKey({
          reviewerStableKey,
          lineageKey,
          provisionalKind: 'raw-meaning-ambiguous',
        }),
        lineageKey,
        sourceRawFindingIds: ['raw-9'],
        reason: 'claim has no mechanically verified evidence',
        title: 'evidence-free demand',
        severity: 'medium',
        reviewers: ['coding-review'],
      }],
      verifiedEvidenceRecordsByRawFindingId: new Map(),
      rawProvenanceByRawFindingId: new Map([[
        'raw-9',
        storedRawReconcileProvenance(rawFinding, reviewerStableKey, lineageKey),
      ]]),
      context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-02T00:00:00.000Z' },
    });

    const created = next.findings.find((finding) => finding.provisional !== undefined)!;
    expect(created.provisional!.firstObservedRound).toBe(4);
  });
});
