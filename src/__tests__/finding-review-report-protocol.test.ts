/**
 * 報告側原因の正規化失敗（review-report-protocol.ts）。
 *
 * 実走行で観測した欠陥: FC レビュアーが「markdown で書け」を無視して報告本文そのものを
 * JSON（rawFindings 形式）で出力し、正規化係がそこから文を取り出したため rawExcerpt が
 * 報告本文へ byte-exact で束縛できず（source binding ゼロ一致）、訂正1回でも解消せず
 * ラン全体が fail-loud で死んだ。
 */
import { describe, expect, it } from 'vitest';
import type { FindingContractConfig } from '../core/models/types.js';
import { isOutstandingReviewerAnomaly } from '../core/workflow/findings/reviewer-anomalies.js';
import {
  recordReviewReportProtocolAnomalies,
  REVIEW_REPORT_PROTOCOL_ANOMALY_KIND,
  reviewReportProtocolAnomalySpec,
} from '../core/workflow/findings/review-report-protocol.js';
import { computeRoundMarker } from '../core/workflow/findings/round-marker.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';

const REVIEWER = 'security-review';
const JSON_REPORT = '{"rawFindings":[{"rawExcerpt":"The token is logged in plain text."}]}';
const FINDING_CONTRACT: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'findings-manager',
    outputContract: 'findings-manager',
  },
  reviewBudget: { maxReviewRounds: 2 },
};

function makeLedger(): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 1,
    updatedAt: '2026-08-07T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
  };
}

function makeStore(): { store: FindingLedgerStore; current: () => FindingLedger } {
  let ledger = makeLedger();
  const store = {
    runId: 'run-1',
    ledgerIdentity: 'finding-storage:db:authority',
    workflowName: 'peer-review',
    loadLedger: () => ledger,
    updateLedger: async <Result>(
      mutator: (current: FindingLedger) => { ledger: FindingLedger; result: Result },
    ) => {
      const mutation = mutator(ledger);
      ledger = mutation.ledger;
      return mutation;
    },
  } as unknown as FindingLedgerStore;
  return { store, current: () => ledger };
}

const REJECTION = {
  reviewerStepName: REVIEWER,
  reviewerPersonaKey: 'security-reviewer',
  reportContent: JSON_REPORT,
  reason: 'report text could not be bound after one correction (initial: X; corrected: X)',
};

describe('reviewReportProtocolAnomalySpec', () => {
  it('uses the existing protocol-anomaly kind and carries the report as the claim excerpt', () => {
    const spec = reviewReportProtocolAnomalySpec({
      rejection: REJECTION,
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
    });

    expect(spec.kind).toBe(REVIEW_REPORT_PROTOCOL_ANOMALY_KIND);
    expect(spec.kind).toBe('protocol-anomaly');
    expect(spec.reviewers).toEqual([REVIEWER]);
    // claim は1件も成立していないので raw 由来の lineage は無い。
    expect(spec.sourceRawFindingIds).toEqual([]);
    expect(spec.sourceIntakeIds).toEqual([]);
    expect(spec.claimedExcerpt).toBe(JSON_REPORT);
  });

  it('tells the reviewer to rewrite the report as ordinary Markdown prose', () => {
    const spec = reviewReportProtocolAnomalySpec({
      rejection: REJECTION,
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
    });

    // 言い直し要求へそのまま載る文面。報告形式の是正が伝わらないと同じ失敗を繰り返す。
    expect(spec.mismatchReason).toContain('ordinary Markdown prose');
    expect(spec.mismatchReason).toContain('not JSON');
    expect(spec.mismatchReason).toContain('quote it verbatim');
    // 正規化係が返した具体的理由も残す。
    expect(spec.mismatchReason).toContain(REJECTION.reason);
  });
});

describe('recordReviewReportProtocolAnomalies', () => {
  const roundInput = {
    findingContract: FINDING_CONTRACT,
    runId: 'run-1',
    callNamespace: '',
    parentStepName: 'reviewers',
    stepIteration: 1,
    timestamp: '2026-08-07T00:00:00.000Z',
  };

  it('records an outstanding anomaly instead of failing the run', async () => {
    const { store, current } = makeStore();
    let refreshed = 0;

    const specs = await recordReviewReportProtocolAnomalies({
      ...roundInput,
      ledgerStore: store,
      rejections: [REJECTION],
      publicationIds: [],
      refreshFindingsState: () => { refreshed += 1; },
    });

    expect(specs).toHaveLength(1);
    const anomalies = current().reviewerAnomalies ?? [];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.kind).toBe('protocol-anomaly');
    expect(isOutstandingReviewerAnomaly(anomalies[0]!)).toBe(true);
    expect(refreshed).toBe(1);
  });

  it('advances the review-integrity budget with the round marker the manager would use', async () => {
    const { store, current } = makeStore();

    await recordReviewReportProtocolAnomalies({
      ...roundInput,
      ledgerStore: store,
      rejections: [REJECTION],
      publicationIds: [],
      refreshFindingsState: () => {},
    });

    // 全レビュアーが報告側原因で落ちたラウンドは manager が走らない。ここで
    // 進めないと review_budget が永久に減らず max_steps まで再レビューを焼く。
    expect(current().reviewIntegrity?.roundMarkers).toEqual([
      computeRoundMarker({
        runId: 'run-1',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 1,
        publicationIds: [],
      }),
    ]);
  });

  it('derives the same round marker as the manager when publications exist', async () => {
    const { store, current } = makeStore();
    const publicationIds = ['b'.repeat(64), 'a'.repeat(64)];

    await recordReviewReportProtocolAnomalies({
      ...roundInput,
      ledgerStore: store,
      rejections: [REJECTION],
      publicationIds,
      refreshFindingsState: () => {},
    });

    // 成立した publication があるラウンドは manager も同じ marker を進める。
    // 値が食い違うと同じラウンドが review_budget に二重計上される。
    expect(current().reviewIntegrity?.roundMarkers).toEqual([
      computeRoundMarker({
        runId: 'run-1',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 1,
        publicationIds,
      }),
    ]);
  });

  it('fails fast when the finding ledger store is unavailable', async () => {
    await expect(recordReviewReportProtocolAnomalies({
      ...roundInput,
      ledgerStore: undefined,
      rejections: [REJECTION],
      publicationIds: [],
      refreshFindingsState: () => {},
    })).rejects.toThrow(/finding ledger store is not available/u);
  });

  it('is a no-op without rejections', async () => {
    const { store, current } = makeStore();
    let refreshed = 0;

    const specs = await recordReviewReportProtocolAnomalies({
      ...roundInput,
      ledgerStore: store,
      rejections: [],
      publicationIds: [],
      refreshFindingsState: () => { refreshed += 1; },
    });

    expect(specs).toEqual([]);
    expect(current().reviewerAnomalies ?? []).toHaveLength(0);
    expect(refreshed).toBe(0);
  });
});
