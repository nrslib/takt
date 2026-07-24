import { describe, expect, it } from 'vitest';
import { buildLoopMonitorFindingsSummaryData, renderLoopMonitorFindingsSummary } from '../core/workflow/findings/loop-monitor-summary.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { computeReviewerStableKey, computeLineageKey, computeProvisionalStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';

function provisionalEntry(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: '必須品質ゲートの実行証跡がない',
    reviewers: ['coding-review'],
    rawFindingIds: ['raw-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    provisional: {
      kind: 'unverified-locationless',
      stableKey: 'stable-1',
      lineageKey: 'lineage-1',
      sourceRawFindingIds: ['raw-1'],
      reason: 'locationless claim',
      firstObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      lastObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      interpretationEpochs: 0,
      gateEffect: 'block',
      firstObservedRound: 1,
    },
    ...overrides,
  };
}

function makeLedger(findings: FindingLedgerEntry[], roundMarkers: string[] = []): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    rawFindings: [],
    conflicts: [],
    findings,
    ...(roundMarkers.length > 0
      ? { stopBudget: { roundMarkers, firstRoundAt: '2026-07-01T00:00:00.000Z', exhausted: false } }
      : {}),
  };
}

describe('renderLoopMonitorFindingsSummary', () => {
  it('完了ゲート充足状況・滞留ラウンド数・解消経路を構造として導出する', () => {
    const ledger = makeLedger(
      [
        provisionalEntry(),
        provisionalEntry({
          id: 'F-0002',
          provisional: {
            ...provisionalEntry().provisional!,
            kind: 'reviewer-output-overflow',
            stableKey: 'stable-2',
            firstObservedRound: 5,
          },
        }),
        { ...provisionalEntry({ id: 'F-0003' }), provisional: undefined },
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
      // firstObservedRound=1、6ラウンド完了 → 6ラウンド滞留。locationless は裁定可能
      expect.objectContaining({ id: 'F-0001', kind: 'unverified-locationless', stalledRounds: 6, dismissable: true }),
      // overflow 系は処理失敗の証跡なので裁定不可（clean 証拠のみが解消経路）
      expect.objectContaining({ id: 'F-0002', kind: 'reviewer-output-overflow', stalledRounds: 2, dismissable: false }),
    ]);
  });

  it('firstObservedRound の無い既存台帳の provisional は滞留不明（undefined）になる', () => {
    const legacy = provisionalEntry();
    delete legacy.provisional!.firstObservedRound;
    const data = buildLoopMonitorFindingsSummaryData(makeLedger([legacy], ['r1']), {});

    expect(data.openProvisional).toEqual([
      expect.objectContaining({ id: 'F-0001', stalledRounds: undefined }),
    ]);
  });

  it('レンダリングは構造の全要素（ID・種類・件数）を欠落なく反映する', () => {
    const ledger = makeLedger([provisionalEntry()], ['r1']);
    const data = buildLoopMonitorFindingsSummaryData(ledger, {});
    const summary = renderLoopMonitorFindingsSummary(ledger, {}, 'en');

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

  it.each(['ja', 'en'] as const)('anomaly-only 状態を %s の構造化データへ反映する', (language) => {
    const observation = {
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-07-01T00:00:00.000Z',
    };
    const ledger: FindingLedger = {
      ...makeLedger([]),
      reviewerAnomalies: [
        {
          id: 'RA-OUTSTANDING',
          kind: 'quote-mismatch',
          stableKey: 'outstanding',
          lineageKey: 'lineage-outstanding',
          sourceRawFindingIds: ['raw-outstanding'],
          reviewers: ['coding-review'],
          title: 'unverified claim',
          claimedExcerpt: 'UNVERIFIED_CLAIM_CONTENT',
          mismatchReason: 'quote mismatch',
          firstObserved: observation,
          lastObserved: observation,
          occurrences: 1,
        },
        {
          id: 'RA-PROMOTED',
          kind: 'quote-mismatch',
          stableKey: 'promoted',
          lineageKey: 'lineage-promoted',
          sourceRawFindingIds: ['raw-promoted'],
          reviewers: ['coding-review'],
          title: 'verified later',
          mismatchReason: 'quote mismatch',
          firstObserved: observation,
          lastObserved: observation,
          occurrences: 1,
          promotedFindingId: 'F-0001',
        },
      ],
      reviewIntegrity: {
        roundMarkers: ['r1'],
        firstRoundAt: '2026-07-01T00:00:00.000Z',
        exhausted: true,
      },
    };

    const data = buildLoopMonitorFindingsSummaryData(ledger, {});
    const summary = renderLoopMonitorFindingsSummary(ledger, {}, language);

    expect(data).toMatchObject({
      openCount: 0,
      openSubstantiveCount: 0,
      openProvisional: [],
      activeConflictCount: 0,
      reviewerAnomalies: {
        count: 1,
        budgetExhausted: true,
      },
    });
    expect(summary).not.toContain('UNVERIFIED_CLAIM_CONTENT');
  });
});

describe('provisional firstObservedRound persistence', () => {
  it('新規 provisional の作成時に現在ラウンド序数（記録済みラウンド + 1）を刻む', () => {
    const reviewerStableKey = computeReviewerStableKey({
      reviewer: 'coding-review',
      title: 'locationless demand',
      normalizedPathKey: '',
    });
    const lineageKey = computeLineageKey({ reviewer: 'coding-review', normalizedPathKey: '' });
    const next = reconcileFindingLedger({
      previousLedger: makeLedger([], ['r1', 'r2', 'r3']),
      rawFindings: [{
        rawFindingId: 'raw-9',
        stepName: 'reviewers',
        reviewer: 'coding-review',
        familyTag: 'gate',
        severity: 'medium',
        title: 'locationless demand',
        description: 'demand',
      }],
      managerOutput: createEmptyManagerOutput(),
      provisionalFindings: [{
        kind: 'unverified-locationless',
        stableKey: computeProvisionalStableKey({
          reviewerStableKey,
          lineageKey,
          provisionalKind: 'unverified-locationless',
        }),
        lineageKey,
        sourceRawFindingIds: ['raw-9'],
        reason: 'locationless claim',
        title: 'locationless demand',
        severity: 'medium',
        reviewers: ['coding-review'],
      }],
      context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-02T00:00:00.000Z' },
    });

    const created = next.findings.find((finding) => finding.provisional !== undefined)!;
    expect(created.provisional!.firstObservedRound).toBe(4);
  });
});
