import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  FindingLedger,
  ReviewerAnomalyAcknowledgement,
  ReviewerAnomalyApprovalReference,
} from '../core/models/finding-types.js';
import { parseFindingLedger } from '../core/models/finding-schemas.js';
import {
  appendReviewerAnomalyAcknowledgements,
  assertReviewerAnomalyAcknowledgementLedgerInvariant,
  buildOutstandingReviewerAnomalyEvidenceReferences,
  buildReviewerAnomalyEvidenceReferencesForInvocation,
  computeReviewerAnomalyAcknowledgementId,
  selectOutstandingReviewerAnomalies,
} from '../core/workflow/findings/reviewer-anomaly-acknowledgement.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import { buildFindingsRuleContext } from '../core/workflow/findings/context.js';
import { computeReviewScopeSnapshotId } from '../core/workflow/findings/snapshot.js';

const SNAPSHOT = 'snapshot-1';
const ISSUER_WORKFLOW_REF = `builtin:sha256:${'a'.repeat(64)}`;
const observation = {
  runId: 'run-1',
  stepName: 'reviewer',
  timestamp: '2026-07-24T00:00:00.000Z',
};
const approvals: [ReviewerAnomalyApprovalReference, ReviewerAnomalyApprovalReference] = [
  {
    stepName: 'merge-readiness-review',
    matchedRuleIndex: 0,
    condition: 'approved && when(findings.open.count == 0)',
    observedAt: { ...observation, stepName: 'merge-readiness-review' },
  },
  {
    stepName: 'supervise',
    matchedRuleIndex: 0,
    condition: 'approved && when(findings.open.count == 0)',
    observedAt: { ...observation, stepName: 'supervise' },
  },
];

function makeLedger(): FindingLedger {
  return {
    version: 1,
    workflowName: 'workflow',
    nextId: 1,
    updatedAt: observation.timestamp,
    findings: [],
    rawFindings: [],
    conflicts: [],
    reviewerAnomalies: [{
      id: 'RA-1',
      kind: 'quote-mismatch',
      stableKey: 'stable-1',
      lineageKey: 'lineage-1',
      sourceRawFindingIds: ['raw-1'],
      reviewers: ['reviewer'],
      title: 'Unverified quote',
      claimedLocation: 'src/example.ts:10',
      claimedExcerpt: 'const unsafe = true;',
      mismatchReason: 'quote mismatch',
      firstObserved: observation,
      lastObserved: observation,
      occurrences: 1,
    }],
  };
}

function appendInput(
  ledger: FindingLedger,
  overrides: {
    snapshot?: string;
    currentSnapshot?: string;
    invocationId?: string;
  } = {},
) {
  return {
    evidenceReferences: buildOutstandingReviewerAnomalyEvidenceReferences(
      ledger,
      overrides.snapshot ?? SNAPSHOT,
    ),
    reviewScopeSnapshotId: overrides.snapshot ?? SNAPSHOT,
    currentReviewScopeSnapshotId: overrides.currentSnapshot ?? SNAPSHOT,
    gate: {
      invocationId: overrides.invocationId ?? 'gate-1',
      issuerWorkflowRef: ISSUER_WORKFLOW_REF,
      workflowName: 'final-gate',
      callStepName: 'final-gate',
      startedAt: { ...observation, stepName: 'final-gate' },
    },
    completedAt: { ...observation, stepName: 'supervise' },
    approvals,
  };
}

function recomputeAcknowledgement(
  acknowledgement: ReviewerAnomalyAcknowledgement,
): ReviewerAnomalyAcknowledgement {
  const { id: _id, ...content } = acknowledgement;
  return {
    ...content,
    id: computeReviewerAnomalyAcknowledgementId(content),
  };
}

function tamperAcknowledgementPath(
  acknowledgement: ReviewerAnomalyAcknowledgement,
  path: readonly (string | number)[],
): ReviewerAnomalyAcknowledgement {
  const clone = structuredClone(acknowledgement) as unknown;
  let target = clone as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) {
    target = target[segment] as Record<string | number, unknown>;
  }
  const finalSegment = path.at(-1)!;
  const current = target[finalSegment];
  target[finalSegment] = typeof current === 'number' ? current + 1 : `${String(current)}-tampered`;
  return clone as ReviewerAnomalyAcknowledgement;
}

function expectStoreLoadAndSelectToReject(ledger: FindingLedger): void {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-ack-integrity-'));
  const ledgerPath = join(cwd, '.takt', 'findings', 'ledger.json');
  const reportDir = join(cwd, '.takt', 'runs', 'test', 'reports');
  mkdirSync(join(cwd, '.takt', 'findings'), { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  const store = createFindingLedgerStore({
    projectCwd: cwd,
    reportDir,
    workflowName: ledger.workflowName,
    ledgerPath: '.takt/findings/ledger.json',
    rawFindingsPath: '.takt/findings/raw',
  });
  try {
    expect(() => store.loadLedger()).toThrow();
    expect(() => selectOutstandingReviewerAnomalies(ledger, SNAPSHOT)).toThrow();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('reviewer anomaly acknowledgement', () => {
  it('同一 input の replay は append せず eligible のまま履歴を一件に保つ', () => {
    const ledger = makeLedger();
    const input = appendInput(ledger);

    const first = appendReviewerAnomalyAcknowledgements(ledger, input);
    const replay = appendReviewerAnomalyAcknowledgements(first.ledger, input);

    expect(first.eligible).toBe(true);
    expect(first.appended).toBe(1);
    expect(replay.eligible).toBe(true);
    expect(replay.appended).toBe(0);
    expect(replay.ledger.reviewerAnomalyAcknowledgements).toHaveLength(1);
    expect(selectOutstandingReviewerAnomalies(replay.ledger, SNAPSHOT)).toHaveLength(0);
    expect(replay.ledger.reviewerAnomalies).toEqual(ledger.reviewerAnomalies);
    expect(replay.ledger.reviewerAnomalyAcknowledgements?.[0]?.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('同一 invocation の再実行は保存済み ack から開始時 evidence を復元し、再承認時刻が変わっても冪等に完了する', () => {
    const ledger = makeLedger();
    const firstInput = appendInput(ledger);
    const first = appendReviewerAnomalyAcknowledgements(ledger, firstInput);
    const replayEvidenceReferences = buildReviewerAnomalyEvidenceReferencesForInvocation(
      first.ledger,
      SNAPSHOT,
      firstInput.gate.invocationId,
    );
    const replayInput = {
      ...firstInput,
      evidenceReferences: replayEvidenceReferences,
      gate: {
        ...firstInput.gate,
        startedAt: {
          ...firstInput.gate.startedAt,
          timestamp: '2026-07-24T00:10:00.000Z',
        },
      },
      approvals: firstInput.approvals.map((approval, index) => ({
        ...approval,
        observedAt: {
          ...approval.observedAt,
          timestamp: `2026-07-24T00:1${index + 1}:00.000Z`,
        },
      })) as [ReviewerAnomalyApprovalReference, ReviewerAnomalyApprovalReference],
      completedAt: {
        ...firstInput.completedAt,
        timestamp: '2026-07-24T00:13:00.000Z',
      },
    };

    const replay = appendReviewerAnomalyAcknowledgements(first.ledger, replayInput);

    expect(replayEvidenceReferences).toEqual(firstInput.evidenceReferences);
    expect(replay).toMatchObject({ appended: 0, eligible: true });
    expect(replay.ledger.reviewerAnomalyAcknowledgements).toEqual(
      first.ledger.reviewerAnomalyAcknowledgements,
    );
  });

  it('同一 invocation の復元 evidence でも snapshot または evidence が変わった replay は拒否する', () => {
    const ledger = makeLedger();
    const firstInput = appendInput(ledger);
    const acknowledged = appendReviewerAnomalyAcknowledgements(ledger, firstInput).ledger;
    const replayEvidenceReferences = buildReviewerAnomalyEvidenceReferencesForInvocation(
      acknowledged,
      'snapshot-changed',
      firstInput.gate.invocationId,
    );
    const snapshotChanged = appendReviewerAnomalyAcknowledgements(acknowledged, {
      ...firstInput,
      evidenceReferences: replayEvidenceReferences,
      reviewScopeSnapshotId: 'snapshot-changed',
      currentReviewScopeSnapshotId: 'snapshot-changed',
    });
    const evidenceChanged = appendReviewerAnomalyAcknowledgements({
      ...acknowledged,
      reviewerAnomalies: acknowledged.reviewerAnomalies?.map((anomaly) => ({
        ...anomaly,
        occurrences: anomaly.occurrences + 1,
      })),
    }, {
      ...firstInput,
      evidenceReferences: replayEvidenceReferences,
    });

    expect(snapshotChanged).toMatchObject({ appended: 0, eligible: false });
    expect(evidenceChanged).toMatchObject({ appended: 0, eligible: false });
  });

  it.each([
    ['snapshot', (acknowledgement) => ({
      ...acknowledgement,
      reviewScopeSnapshotId: 'snapshot-tampered',
    })],
    ['evidence', (acknowledgement) => ({
      ...acknowledgement,
      anomalyEvidenceHash: 'evidence-tampered',
    })],
    ['gate', (acknowledgement) => ({
      ...acknowledgement,
      gate: { ...acknowledgement.gate, workflowName: 'gate-tampered' },
    })],
    ['approval', (acknowledgement) => ({
      ...acknowledgement,
      approvals: [
        {
          ...acknowledgement.approvals[0],
          condition: 'approved && when(findings.open.count == 1)',
        },
        acknowledgement.approvals[1],
      ],
    })],
    ['completedAt', (acknowledgement) => ({
      ...acknowledgement,
      gate: {
        ...acknowledgement.gate,
        completedAt: {
          ...acknowledgement.gate.completedAt,
          timestamp: '2026-07-24T00:01:00.000Z',
        },
      },
    })],
  ] satisfies Array<[
    string,
    (acknowledgement: ReviewerAnomalyAcknowledgement) => ReviewerAnomalyAcknowledgement,
  ]>)('同じ invocationId の既存 %s 改ざん replay は fail-closed にする', (_field, tamper) => {
    const ledger = makeLedger();
    const input = appendInput(ledger);
    const first = appendReviewerAnomalyAcknowledgements(ledger, input);
    const tamperedLedger: FindingLedger = {
      ...first.ledger,
      reviewerAnomalyAcknowledgements: first.ledger.reviewerAnomalyAcknowledgements?.map(tamper),
    };

    expect(() => appendReviewerAnomalyAcknowledgements(tamperedLedger, input))
      .toThrow(/acknowledgement id does not match canonical content/);
  });

  it.each([
    ['domain'],
    ['version'],
    ['anomalyStableKey'],
    ['anomalyEvidenceHash'],
    ['reviewScopeSnapshotId'],
    ['gate', 'invocationId'],
    ['gate', 'issuerWorkflowRef'],
    ['gate', 'workflowName'],
    ['gate', 'callStepName'],
    ['gate', 'startedAt', 'runId'],
    ['gate', 'startedAt', 'stepName'],
    ['gate', 'startedAt', 'timestamp'],
    ['gate', 'completedAt', 'runId'],
    ['gate', 'completedAt', 'stepName'],
    ['gate', 'completedAt', 'timestamp'],
    ['approvals', 0, 'stepName'],
    ['approvals', 0, 'matchedRuleIndex'],
    ['approvals', 0, 'condition'],
    ['approvals', 0, 'observedAt', 'runId'],
    ['approvals', 0, 'observedAt', 'stepName'],
    ['approvals', 0, 'observedAt', 'timestamp'],
    ['approvals', 1, 'stepName'],
    ['approvals', 1, 'matchedRuleIndex'],
    ['approvals', 1, 'condition'],
    ['approvals', 1, 'observedAt', 'runId'],
    ['approvals', 1, 'observedAt', 'stepName'],
    ['approvals', 1, 'observedAt', 'timestamp'],
  ] as const)('canonical field %j の改ざんを load と select の両方で拒否する', (...path) => {
    const ledger = makeLedger();
    const acknowledged = appendReviewerAnomalyAcknowledgements(ledger, appendInput(ledger)).ledger;
    const acknowledgement = acknowledged.reviewerAnomalyAcknowledgements![0]!;
    const tampered = tamperAcknowledgementPath(acknowledgement, path);

    expectStoreLoadAndSelectToReject({
      ...acknowledged,
      reviewerAnomalyAcknowledgements: [tampered],
    });
  });

  it('snapshot 変更と anomaly 再観測で過去 ack を失効させ、改変前 input の replay を拒否する', () => {
    const ledger = makeLedger();
    const firstInput = appendInput(ledger);
    const acknowledged = appendReviewerAnomalyAcknowledgements(ledger, firstInput).ledger;

    expect(selectOutstandingReviewerAnomalies(acknowledged, 'snapshot-2')).toHaveLength(1);

    const reobserved: FindingLedger = {
      ...acknowledged,
      reviewerAnomalies: acknowledged.reviewerAnomalies?.map((anomaly) => ({
        ...anomaly,
        sourceRawFindingIds: [...anomaly.sourceRawFindingIds, 'raw-2'],
        occurrences: anomaly.occurrences + 1,
        lastObserved: {
          runId: 'run-2',
          stepName: 'reviewer',
          timestamp: '2026-07-24T00:10:00.000Z',
        },
      })),
    };
    expect(selectOutstandingReviewerAnomalies(reobserved, SNAPSHOT)).toHaveLength(1);

    const replay = appendReviewerAnomalyAcknowledgements(reobserved, firstInput);
    expect(replay.eligible).toBe(false);
    expect(replay.appended).toBe(0);
    expect(replay.ledger.reviewerAnomalyAcknowledgements).toHaveLength(1);

    const secondInput = appendInput(reobserved, { invocationId: 'gate-2' });
    const second = appendReviewerAnomalyAcknowledgements(reobserved, secondInput);
    expect(second.appended).toBe(1);
    expect(second.ledger.reviewerAnomalyAcknowledgements).toHaveLength(2);
    expect(selectOutstandingReviewerAnomalies(second.ledger, SNAPSHOT)).toHaveLength(0);
  });

  it('gate 開始後に evidence が変わった候補は一件も ack しない', () => {
    const ledger = makeLedger();
    const input = appendInput(ledger);
    const changed: FindingLedger = {
      ...ledger,
      reviewerAnomalies: ledger.reviewerAnomalies?.map((anomaly) => ({
        ...anomaly,
        sourceRawFindingIds: [...anomaly.sourceRawFindingIds, 'raw-after-start'],
        occurrences: 2,
        lastObserved: {
          runId: 'run-2',
          stepName: 'supervise',
          timestamp: '2026-07-24T00:05:00.000Z',
        },
      })),
    };

    const result = appendReviewerAnomalyAcknowledgements(changed, input);

    expect(result.eligible).toBe(false);
    expect(result.appended).toBe(0);
    expect(result.ledger.reviewerAnomalyAcknowledgements).toBeUndefined();
  });

  it('gate 開始後に outstanding anomaly が増えた場合は開始時分も一件も ack しない', () => {
    const ledger = makeLedger();
    const input = appendInput(ledger);
    const changed: FindingLedger = {
      ...ledger,
      reviewerAnomalies: [
        ...ledger.reviewerAnomalies!,
        {
          ...ledger.reviewerAnomalies![0]!,
          id: 'RA-2',
          stableKey: 'stable-2',
          lineageKey: 'lineage-2',
          sourceRawFindingIds: ['raw-2'],
          title: 'New anomaly during gate',
        },
      ],
    };

    const result = appendReviewerAnomalyAcknowledgements(changed, input);

    expect(result.eligible).toBe(false);
    expect(result.appended).toBe(0);
    expect(result.ledger.reviewerAnomalyAcknowledgements).toBeUndefined();
    expect(selectOutstandingReviewerAnomalies(result.ledger, SNAPSHOT)).toHaveLength(2);
  });

  it('同一 input の replay 前に新しい anomaly が増えた場合は追記しない', () => {
    const ledger = makeLedger();
    const input = appendInput(ledger);
    const first = appendReviewerAnomalyAcknowledgements(ledger, input);
    const changed: FindingLedger = {
      ...first.ledger,
      reviewerAnomalies: [
        ...first.ledger.reviewerAnomalies!,
        {
          ...first.ledger.reviewerAnomalies![0]!,
          id: 'RA-2',
          stableKey: 'stable-2',
          lineageKey: 'lineage-2',
          sourceRawFindingIds: ['raw-2'],
          title: 'New anomaly before replay',
        },
      ],
    };

    const replay = appendReviewerAnomalyAcknowledgements(changed, input);

    expect(replay.eligible).toBe(false);
    expect(replay.appended).toBe(0);
    expect(replay.ledger.reviewerAnomalyAcknowledgements).toHaveLength(1);
    expect(selectOutstandingReviewerAnomalies(replay.ledger, SNAPSHOT)).toHaveLength(1);
  });

  it('別 invocationId では過去 gate の開始時 evidence 参照を replay できない', () => {
    const ledger = makeLedger();
    const firstInput = appendInput(ledger);
    const first = appendReviewerAnomalyAcknowledgements(ledger, firstInput);
    expect(buildReviewerAnomalyEvidenceReferencesForInvocation(
      first.ledger,
      SNAPSHOT,
      'gate-2',
    )).toEqual([]);
    const otherInvocationInput = {
      ...firstInput,
      gate: {
        ...firstInput.gate,
        invocationId: 'gate-2',
      },
    };

    const replay = appendReviewerAnomalyAcknowledgements(first.ledger, otherInvocationInput);

    expect(replay.eligible).toBe(false);
    expect(replay.appended).toBe(0);
    expect(replay.ledger.reviewerAnomalyAcknowledgements)
      .toEqual(first.ledger.reviewerAnomalyAcknowledgements);
  });

  it('承認観測が同一 run の正順かつ gate の時間範囲内でなければ一件も ack しない', () => {
    const ledger = makeLedger();
    const baseInput = appendInput(ledger);
    const stale = appendReviewerAnomalyAcknowledgements(ledger, {
      ...baseInput,
      gate: {
        ...baseInput.gate,
        startedAt: { ...baseInput.gate.startedAt, timestamp: '2026-07-24T00:01:00.000Z' },
      },
    });
    const reversed = appendReviewerAnomalyAcknowledgements(ledger, {
      ...baseInput,
      approvals: [
        {
          ...baseInput.approvals[0],
          observedAt: {
            ...baseInput.approvals[0].observedAt,
            timestamp: '2026-07-24T00:02:00.000Z',
          },
        },
        {
          ...baseInput.approvals[1],
          observedAt: {
            ...baseInput.approvals[1].observedAt,
            timestamp: '2026-07-24T00:01:00.000Z',
          },
        },
      ],
      completedAt: { ...baseInput.completedAt, timestamp: '2026-07-24T00:03:00.000Z' },
    });
    const otherRun = appendReviewerAnomalyAcknowledgements(ledger, {
      ...baseInput,
      approvals: [
        baseInput.approvals[0],
        {
          ...baseInput.approvals[1],
          observedAt: { ...baseInput.approvals[1].observedAt, runId: 'other-run' },
        },
      ],
    });

    for (const result of [stale, reversed, otherRun]) {
      expect(result.eligible).toBe(false);
      expect(result.appended).toBe(0);
      expect(result.ledger.reviewerAnomalyAcknowledgements).toBeUndefined();
    }
  });

  it.each([
    ['id', (anomaly) => ({ ...anomaly, id: 'RA-changed' })],
    ['kind', (anomaly) => ({ ...anomaly, kind: 'stale-snapshot' as const })],
    ['lineageKey', (anomaly) => ({ ...anomaly, lineageKey: 'lineage-changed' })],
    ['sourceRawFindingIds', (anomaly) => ({
      ...anomaly,
      sourceRawFindingIds: [...anomaly.sourceRawFindingIds, 'raw-2'],
    })],
    ['reviewers', (anomaly) => ({ ...anomaly, reviewers: [...anomaly.reviewers, 'reviewer-2'] })],
    ['title', (anomaly) => ({ ...anomaly, title: 'Changed title' })],
    ['claimedLocation', (anomaly) => ({ ...anomaly, claimedLocation: 'src/other.ts:20' })],
    ['claimedExcerpt', (anomaly) => ({ ...anomaly, claimedExcerpt: 'const changed = true;' })],
    ['mismatchReason', (anomaly) => ({ ...anomaly, mismatchReason: 'changed mismatch reason' })],
    ['firstObserved', (anomaly) => ({
      ...anomaly,
      firstObserved: { ...anomaly.firstObserved, timestamp: '2026-07-23T23:59:00.000Z' },
    })],
    ['lastObserved', (anomaly) => ({
      ...anomaly,
      lastObserved: { ...anomaly.lastObserved, timestamp: '2026-07-24T00:01:00.000Z' },
    })],
    ['occurrences', (anomaly) => ({ ...anomaly, occurrences: anomaly.occurrences + 1 })],
  ] satisfies Array<[
    string,
    (anomaly: NonNullable<FindingLedger['reviewerAnomalies']>[number]) =>
      NonNullable<FindingLedger['reviewerAnomalies']>[number],
  ]>)('%s の変更で既存 ack を失効させる', (_field, mutate) => {
    const ledger = makeLedger();
    const acknowledged = appendReviewerAnomalyAcknowledgements(ledger, appendInput(ledger)).ledger;
    const changed = {
      ...acknowledged,
      reviewerAnomalies: acknowledged.reviewerAnomalies?.map(mutate),
    };

    expect(selectOutstandingReviewerAnomalies(changed, SNAPSHOT)).toHaveLength(1);
  });

  it('source raw IDs と reviewers の並び順だけでは canonical evidence hash を変えない', () => {
    const ledger = makeLedger();
    ledger.reviewerAnomalies![0] = {
      ...ledger.reviewerAnomalies![0]!,
      sourceRawFindingIds: ['raw-2', 'raw-1'],
      reviewers: ['reviewer-2', 'reviewer-1'],
    };
    const acknowledged = appendReviewerAnomalyAcknowledgements(ledger, appendInput(ledger)).ledger;
    const reordered = {
      ...acknowledged,
      reviewerAnomalies: acknowledged.reviewerAnomalies?.map((anomaly) => ({
        ...anomaly,
        sourceRawFindingIds: [...anomaly.sourceRawFindingIds].reverse(),
        reviewers: [...anomaly.reviewers].reverse(),
      })),
    };

    expect(selectOutstandingReviewerAnomalies(reordered, SNAPSHOT)).toHaveLength(0);
  });

  it('promotedFindingId は evidence hash ではなく outstanding 判定で扱う', () => {
    const ledger = makeLedger();
    const acknowledged = appendReviewerAnomalyAcknowledgements(ledger, appendInput(ledger)).ledger;
    const promoted = {
      ...acknowledged,
      reviewerAnomalies: acknowledged.reviewerAnomalies?.map((anomaly) => ({
        ...anomaly,
        promotedFindingId: 'F-0001',
      })),
    };

    expect(selectOutstandingReviewerAnomalies(promoted, SNAPSHOT)).toHaveLength(0);
  });

  it('full-shape ID の不一致と、ID 再計算済みの semantic 不正を拒否する', () => {
    const ledger = makeLedger();
    const acknowledged = appendReviewerAnomalyAcknowledgements(ledger, appendInput(ledger)).ledger;
    const acknowledgement = acknowledged.reviewerAnomalyAcknowledgements![0]!;
    const wrongId = {
      ...acknowledgement,
      id: '0'.repeat(64),
    };
    const semanticInvalid = recomputeAcknowledgement({
      ...acknowledgement,
      approvals: [
        {
          ...acknowledgement.approvals[0],
          condition: 'needs_fix',
        },
        acknowledgement.approvals[1],
      ],
    });

    expect(() => assertReviewerAnomalyAcknowledgementLedgerInvariant({
      ...acknowledged,
      reviewerAnomalyAcknowledgements: [wrongId],
    })).toThrow(/id does not match canonical content/);
    expect(() => assertReviewerAnomalyAcknowledgementLedgerInvariant({
      ...acknowledged,
      reviewerAnomalyAcknowledgements: [semanticInvalid],
    })).toThrow(/not canonical approved semantics/);
  });

  it.each([
    ' approved && when(findings.open.count == 0)',
    'approved && when(',
  ])('ID を再計算しても condition の非 canonical/parse 不正を拒否する: %s', (condition) => {
    const ledger = makeLedger();
    const acknowledged = appendReviewerAnomalyAcknowledgements(ledger, appendInput(ledger)).ledger;
    const acknowledgement = acknowledged.reviewerAnomalyAcknowledgements![0]!;
    const invalid = recomputeAcknowledgement({
      ...acknowledgement,
      approvals: [
        { ...acknowledgement.approvals[0], condition },
        acknowledgement.approvals[1],
      ],
    });

    expect(() => assertReviewerAnomalyAcknowledgementLedgerInvariant({
      ...acknowledged,
      reviewerAnomalyAcknowledgements: [invalid],
    })).toThrow(/approval condition/);
  });

  it('ID、eligibility tuple、invocation contract、orphan、anomaly stableKey の重複・不整合を拒否する', () => {
    const twoAnomalyLedger: FindingLedger = {
      ...makeLedger(),
      reviewerAnomalies: [
        ...makeLedger().reviewerAnomalies!,
        {
          ...makeLedger().reviewerAnomalies![0]!,
          id: 'RA-2',
          stableKey: 'stable-2',
          lineageKey: 'lineage-2',
          sourceRawFindingIds: ['raw-2'],
        },
      ],
    };
    const acknowledged = appendReviewerAnomalyAcknowledgements(
      twoAnomalyLedger,
      appendInput(twoAnomalyLedger),
    ).ledger;
    const [first, second] = acknowledged.reviewerAnomalyAcknowledgements!;
    const duplicateEligibility = recomputeAcknowledgement({
      ...first!,
      gate: {
        ...first!.gate,
        invocationId: 'other-invocation',
      },
    });
    const inconsistentInvocation = recomputeAcknowledgement({
      ...second!,
      approvals: [
        {
          ...second!.approvals[0],
          matchedRuleIndex: second!.approvals[0].matchedRuleIndex + 1,
        },
        second!.approvals[1],
      ],
    });
    const orphan = recomputeAcknowledgement({
      ...first!,
      anomalyStableKey: 'missing-stable-key',
    });
    const cases: FindingLedger[] = [
      {
        ...acknowledged,
        reviewerAnomalyAcknowledgements: [first!, first!],
      },
      {
        ...acknowledged,
        reviewerAnomalyAcknowledgements: [first!, duplicateEligibility],
      },
      {
        ...acknowledged,
        reviewerAnomalyAcknowledgements: [first!, inconsistentInvocation],
      },
      {
        ...acknowledged,
        reviewerAnomalyAcknowledgements: [orphan],
      },
      {
        ...acknowledged,
        reviewerAnomalies: [
          acknowledged.reviewerAnomalies![0]!,
          {
            ...acknowledged.reviewerAnomalies![1]!,
            stableKey: acknowledged.reviewerAnomalies![0]!.stableKey,
          },
        ],
      },
    ];

    for (const invalid of cases) {
      expect(() => assertReviewerAnomalyAcknowledgementLedgerInvariant(invalid)).toThrow();
    }
  });

  it.each([
    ['same run', (acknowledgement: ReviewerAnomalyAcknowledgement) => ({
      ...acknowledgement,
      gate: {
        ...acknowledgement.gate,
        completedAt: { ...acknowledgement.gate.completedAt, runId: 'other-run' },
      },
    })],
    ['chronology', (acknowledgement: ReviewerAnomalyAcknowledgement) => ({
      ...acknowledgement,
      approvals: [
        {
          ...acknowledgement.approvals[0],
          observedAt: {
            ...acknowledgement.approvals[0].observedAt,
            timestamp: '2026-07-24T00:02:00.000Z',
          },
        },
        acknowledgement.approvals[1],
      ],
    })],
    ['step consistency', (acknowledgement: ReviewerAnomalyAcknowledgement) => ({
      ...acknowledgement,
      gate: {
        ...acknowledgement.gate,
        completedAt: { ...acknowledgement.gate.completedAt, stepName: 'other-step' },
      },
    })],
    ['two distinct approvals', (acknowledgement: ReviewerAnomalyAcknowledgement) => ({
      ...acknowledgement,
      approvals: [
        acknowledgement.approvals[0],
        {
          ...acknowledgement.approvals[1],
          stepName: acknowledgement.approvals[0].stepName,
          observedAt: {
            ...acknowledgement.approvals[1].observedAt,
            stepName: acknowledgement.approvals[0].stepName,
          },
        },
      ],
      gate: {
        ...acknowledgement.gate,
        completedAt: {
          ...acknowledgement.gate.completedAt,
          stepName: acknowledgement.approvals[0].stepName,
        },
      },
    })],
  ])('ID を再計算しても %s の execution 不正を拒否する', (_name, mutate) => {
    const ledger = makeLedger();
    const acknowledged = appendReviewerAnomalyAcknowledgements(ledger, appendInput(ledger)).ledger;
    const invalid = recomputeAcknowledgement(mutate(acknowledged.reviewerAnomalyAcknowledgements![0]!));

    expect(() => assertReviewerAnomalyAcknowledgementLedgerInvariant({
      ...acknowledged,
      reviewerAnomalyAcknowledgements: [invalid],
    })).toThrow(/Invalid reviewer anomaly acknowledgement execution/);
  });

  it('context の count は常に outstanding + acknowledged と一致する', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-ack-context-'));
    try {
      execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd, stdio: 'ignore' });
      writeFileSync(join(cwd, 'tracked.txt'), 'initial');
      execFileSync('git', ['add', 'tracked.txt'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'ignore' });
      const ledger = makeLedger();
      const snapshot = computeReviewScopeSnapshotId(cwd);
      const acknowledged = appendReviewerAnomalyAcknowledgements(
        ledger,
        appendInput(ledger, { snapshot, currentSnapshot: snapshot }),
      ).ledger;
      const current = buildFindingsRuleContext(acknowledged, cwd).reviewerAnomalies;
      expect(current.count).toBe(current.outstanding + current.acknowledged);
      expect(current).toMatchObject({ count: 1, outstanding: 0, acknowledged: 1 });

      writeFileSync(join(cwd, 'tracked.txt'), 'changed');
      const stale = buildFindingsRuleContext(acknowledged, cwd).reviewerAnomalies;
      expect(stale.count).toBe(stale.outstanding + stale.acknowledged);
      expect(stale).toMatchObject({ count: 1, outstanding: 1, acknowledged: 0 });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('open finding、provisional、active conflict は acknowledgement より優先する', () => {
    const ledger = makeLedger();
    const input = appendInput(ledger);
    const openFinding = {
      id: 'F-0001',
      status: 'open' as const,
      lifecycle: 'new' as const,
      severity: 'high' as const,
      title: 'Actionable finding',
      reviewers: ['reviewer'],
      rawFindingIds: ['raw-product'],
      firstSeen: observation,
      lastSeen: observation,
    };
    const blockedLedgers: FindingLedger[] = [
      { ...ledger, findings: [openFinding] },
      {
        ...ledger,
        findings: [{
          ...openFinding,
          provisional: {
            kind: 'raw-meaning-ambiguous',
            stableKey: 'provisional-1',
            lineageKey: 'provisional-lineage',
            sourceRawFindingIds: ['raw-product'],
            reason: 'ambiguous',
            firstObservedAt: observation,
            lastObservedAt: observation,
            interpretationEpochs: 0,
            gateEffect: 'block',
          },
        }],
      },
      {
        ...ledger,
        conflicts: [{
          id: 'C-0001',
          status: 'active',
          findingIds: [],
          rawFindingIds: ['raw-conflict'],
          description: 'Unresolved conflict',
          firstSeen: observation,
          lastSeen: observation,
        }],
      },
    ];

    for (const blocked of blockedLedgers) {
      const result = appendReviewerAnomalyAcknowledgements(blocked, input);
      expect(result.eligible).toBe(false);
      expect(result.ledger.reviewerAnomalyAcknowledgements).toBeUndefined();
    }
  });

  it('ack フィールドのない旧 ledger を migration なしで読み、未 ack として扱う', () => {
    const parsed = parseFindingLedger(makeLedger());

    expect(parsed.reviewerAnomalyAcknowledgements).toBeUndefined();
    expect(selectOutstandingReviewerAnomalies(parsed, SNAPSHOT)).toHaveLength(1);
    expect(() => parseFindingLedger({
      ...makeLedger(),
      reviewerAnomalyAcknowledgements: [{ anomalyStableKey: 'incomplete' }],
    })).toThrow();
  });
});
