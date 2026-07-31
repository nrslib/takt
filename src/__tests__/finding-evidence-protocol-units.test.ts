/**
 * typed evidence protocol の軽量な admission・canonicalization・review-integrity 単体テスト。
 * 実Gitを使う review scope snapshot 群は finding-evidence-protocol.integration.test.ts
 * で serial integration として実行する。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_EVIDENCE_SOURCE_FILE_BYTES,
  MAX_SOURCE_QUOTE_LINES,
  validateLocationAdmission,
  verifyFileQuoteEvidence,
} from '../core/workflow/findings/admission-validation.js';
import { FINDING_EVIDENCE_ISSUANCE_LIMITS } from '../core/models/finding-contract-limits.js';
import {
  applyReviewerAnomalySpecsToLedger,
  isOutstandingReviewerAnomaly,
  linkPromotedReviewerAnomalies,
  type ReviewerAnomalySpec,
} from '../core/workflow/findings/reviewer-anomalies.js';
import {
  DEFAULT_REVIEW_INTEGRITY_BUDGET,
  attachReviewIntegrityState,
  resolveReviewIntegrityLimits,
  reviewIntegrityRoundsCompleted,
} from '../core/workflow/findings/review-integrity.js';
import type { FindingLedger, FindingLedgerEntry, ReviewerAnomalyEntry } from '../core/workflow/findings/types.js';

function makeFinding(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Existing issue',
    evidenceIds: [],
    description: 'Existing issue body.',
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-existing'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
    ...overrides,
  };
}

describe('verifyFileQuoteEvidence (admission-validation.ts)', () => {
  let cwd: string;
  const snapshotId = 'snap-1';

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-verify-quote-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('path・行範囲・verbatimExcerpt・snapshotId が全て正しく一致すると match し、fileHash を返す', () => {
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/a.ts',
      startLine: 2,
      endLine: 3,
      verbatimExcerpt: '// line 2\n// line 3',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('match');
    expect(result.outcome === 'match' && result.fileHash.length).toBe(64); // sha256 hex
  });

  it('snapshotId が食い違うと内容の一致/不一致を判定する前に stale-snapshot になる（幻覚した引用が偶然一致しても match と誤判定しない）', () => {
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      verbatimExcerpt: '// line 2', // 内容は正しく一致する
      snapshotId: 'stale-snap',
    }, snapshotId);
    expect(result.outcome).toBe('stale-snapshot');
  });

  it('verbatimExcerpt が空文字なら quote-mismatch（空引用は不採用）', () => {
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: '   ',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('startLine が endLine より後ろなら quote-mismatch（逆順の範囲は不採用）', () => {
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/a.ts',
      startLine: 5,
      endLine: 2,
      verbatimExcerpt: 'anything',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it(`正しい引用範囲が ${MAX_SOURCE_QUOTE_LINES} 行を超えると resource_exhausted`, () => {
    const excerpt = Array.from(
      { length: MAX_SOURCE_QUOTE_LINES + 1 },
      (_, index) => `// wide line ${index + 1}`,
    ).join('\n');
    writeFileSync(join(cwd, 'src', 'wide.ts'), `${excerpt}\n`);
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/wide.ts',
      startLine: 1,
      endLine: MAX_SOURCE_QUOTE_LINES + 1,
      verbatimExcerpt: excerpt,
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('resource_exhausted');
  });

  it('正しい1行引用が quote byte 上限のみを超えると resource_exhausted', () => {
    const excerpt = 'x'.repeat(FINDING_EVIDENCE_ISSUANCE_LIMITS.maxFileQuoteBytes + 1);
    writeFileSync(join(cwd, 'src', 'wide-line.ts'), `${excerpt}\n`);
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/wide-line.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: excerpt,
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('resource_exhausted');
  });

  it('path がプロジェクト外を指す（相対パスでの脱出）なら quote-mismatch', () => {
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: '../outside.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'anything',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('行範囲がファイルの実際の行数を超えると quote-mismatch', () => {
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/a.ts',
      startLine: 9,
      endLine: 999,
      verbatimExcerpt: 'anything',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('verbatimExcerpt が該当行の一部分だけを恣意的に切り取ったものだと quote-mismatch（部分行の引用は構造的に排除される）', () => {
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      verbatimExcerpt: '// line', // "// line 2" の部分文字列
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('存在しない path なら quote-mismatch', () => {
    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/does-not-exist.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'anything',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('証跡ファイルが byte 上限を超える場合は全体を読み込まず unverifiable にする', () => {
    writeFileSync(
      join(cwd, 'src', 'oversized.ts'),
      Buffer.alloc(MAX_EVIDENCE_SOURCE_FILE_BYTES + 1, 0x61),
    );

    const result = verifyFileQuoteEvidence(cwd, {
      kind: 'file_quote',
      path: 'src/oversized.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'a',
      snapshotId,
    }, snapshotId);

    expect(result).toMatchObject({
      outcome: 'unverifiable',
      reason: expect.stringContaining('evidence inspection limit'),
    });
    expect(validateLocationAdmission(cwd, 'src/oversized.ts:1')).toMatchObject({
      ok: false,
      outcome: 'unverifiable',
      reason: expect.stringContaining('evidence inspection limit'),
    });
  });
});

describe('applyReviewerAnomalySpecsToLedger / linkPromotedReviewerAnomalies (reviewer-anomalies.ts, 設計書 D の安全不変条件)', () => {
  const context = { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-1', timestamp: '2026-07-12T00:00:00.000Z' };

  function makeSpec(overrides: Partial<ReviewerAnomalySpec> = {}): ReviewerAnomalySpec {
    return {
      kind: 'quote-mismatch',
      stableKey: 'sk-anomaly-1',
      lineageKey: 'lk-anomaly-1',
      sourceRawFindingIds: ['raw-1'],
      sourceIntakeIds: [],
      reviewers: ['ai-antipattern-reviewer'],
      title: 'Hallucinated finding',
      mismatchReason: 'the location does not exist',
      ...overrides,
    };
  }

  it('新規 stableKey は id 採番済みの新規レコードとして追記される（occurrences=1）', () => {
    const ledger = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context);
    expect(ledger.reviewerAnomalies).toHaveLength(1);
    const anomaly = ledger.reviewerAnomalies![0]!;
    expect(anomaly.id).toMatch(/^RA-[0-9A-F]{12}$/);
    expect(anomaly.occurrences).toBe(1);
    expect(anomaly.promotedFindingId).toBeUndefined();
  });

  it('同じ stableKey が再来すると新規レコードを増やさず既存を更新する（occurrences 加算、sourceRawFindingIds/reviewers は重複排除の和集合）', () => {
    const first = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context);
    const second = applyReviewerAnomalySpecsToLedger(first, [makeSpec({
      sourceRawFindingIds: ['raw-2'],
      reviewers: ['another-reviewer'],
      mismatchReason: 'the location changed but still does not exist',
    })], { ...context, runId: 'run-2', timestamp: '2026-07-12T01:00:00.000Z' });

    expect(second.reviewerAnomalies).toHaveLength(1);
    const anomaly = second.reviewerAnomalies![0]!;
    expect(anomaly.id).toBe(first.reviewerAnomalies![0]!.id);
    expect(anomaly.occurrences).toBe(2);
    expect(anomaly.sourceRawFindingIds.sort()).toEqual(['raw-1', 'raw-2']);
    expect(anomaly.reviewers.sort()).toEqual(['ai-antipattern-reviewer', 'another-reviewer']);
    // 最新の主張だけが監査値として残る（過去の主張を消したことにはならない —
    // firstObserved は変わらず保持されるため、いつ最初に観測されたかは失われない）。
    expect(anomaly.mismatchReason).toBe('the location changed but still does not exist');
    expect(anomaly.firstObserved).toEqual({ runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-12T00:00:00.000Z' });
    expect(anomaly.lastObserved).toEqual({ runId: 'run-2', stepName: 'reviewers', timestamp: '2026-07-12T01:00:00.000Z' });
  });

  it('settle済みstableKeyの新観測はsettlementを継承せず別episodeへ保存する', () => {
    const first = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context);
    const settled = {
      ...first,
      reviewerAnomalies: [{
        ...first.reviewerAnomalies![0]!,
        settlement: {
          kind: 'target_resolved_by_verified_evidence' as const,
          findingId: 'F-0001',
          lifecycleEventId: 'event-resolved',
        },
      }],
    };
    const nextSpec = makeSpec({ sourceRawFindingIds: ['raw-2'] });
    const observed = applyReviewerAnomalySpecsToLedger(settled, [nextSpec], {
      ...context,
      runId: 'run-2',
    });
    const replayed = applyReviewerAnomalySpecsToLedger(observed, [nextSpec], context);

    expect(observed.reviewerAnomalies).toHaveLength(2);
    expect(observed.reviewerAnomalies?.[0]).toEqual(settled.reviewerAnomalies[0]);
    expect(observed.reviewerAnomalies?.[1]).toMatchObject({
      stableKey: 'sk-anomaly-1',
      sourceRawFindingIds: ['raw-2'],
      occurrences: 1,
    });
    expect(observed.reviewerAnomalies?.[1]?.id)
      .not.toBe(observed.reviewerAnomalies?.[0]?.id);
    expect(observed.reviewerAnomalies?.[1]?.settlement).toBeUndefined();
    expect(isOutstandingReviewerAnomaly(observed.reviewerAnomalies![1]!)).toBe(true);
    expect(replayed.reviewerAnomalies).toEqual(observed.reviewerAnomalies);
  });

  it('crash/replay 冪等（codex 検証ブロッカー#3）: 同一 stableKey・同一 sourceRawFindingIds の再適用は occurrences を二重計上せず完全な no-op になる', () => {
    const first = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context);
    expect(first.reviewerAnomalies![0]!.occurrences).toBe(1);
    // 同一ラウンドの再コミット（crash/replay）を模す: 同じ raw finding id・
    // 同じ内容を、時刻だけ変えて再適用する。
    const replayed = applyReviewerAnomalySpecsToLedger(first, [makeSpec()], {
      ...context, timestamp: '2026-07-12T02:00:00.000Z',
    });
    const anomaly = replayed.reviewerAnomalies![0]!;
    // occurrences は据え置き、lastObserved も動かない（no-op）。
    expect(anomaly.occurrences).toBe(1);
    expect(anomaly.lastObserved).toEqual(first.reviewerAnomalies![0]!.lastObserved);
    // 何度再適用しても単調に据え置き。
    const replayedAgain = applyReviewerAnomalySpecsToLedger(replayed, [makeSpec()], context);
    expect(replayedAgain.reviewerAnomalies![0]!.occurrences).toBe(1);
    // ただし新しい raw finding id を持ち込む別ラウンドはちゃんと +1 される。
    const nextRound = applyReviewerAnomalySpecsToLedger(replayedAgain, [makeSpec({ sourceRawFindingIds: ['raw-next-round'] })], context);
    expect(nextRound.reviewerAnomalies![0]!.occurrences).toBe(2);
  });

  it('rawを生成できない観測はsourceIntakeIdsを冪等キーとしてupsertする', () => {
    const spec = makeSpec({
      sourceRawFindingIds: [],
      sourceIntakeIds: ['intake-1'],
    });
    const first = applyReviewerAnomalySpecsToLedger(makeLedger(), [spec], context);
    const replay = applyReviewerAnomalySpecsToLedger(first, [spec], {
      ...context,
      timestamp: '2026-07-12T02:00:00.000Z',
    });
    const next = applyReviewerAnomalySpecsToLedger(replay, [{
      ...spec,
      sourceIntakeIds: ['intake-2'],
    }], context);

    expect(replay.reviewerAnomalies?.[0]).toMatchObject({
      occurrences: 1,
      sourceRawFindingIds: [],
      sourceIntakeIds: ['intake-1'],
    });
    expect(next.reviewerAnomalies?.[0]).toMatchObject({
      occurrences: 2,
      sourceRawFindingIds: [],
      sourceIntakeIds: ['intake-1', 'intake-2'],
    });
  });

  it('異なる stableKey は別レコードとして共存する', () => {
    const ledger = applyReviewerAnomalySpecsToLedger(makeLedger(), [
      makeSpec({ stableKey: 'sk-a', lineageKey: 'lk-a' }),
      makeSpec({ stableKey: 'sk-b', lineageKey: 'lk-b' }),
    ], context);
    expect(ledger.reviewerAnomalies).toHaveLength(2);
  });

  it('ledger.findings には一切触れない（別配列への追記適用のみ）', () => {
    const preExisting = makeFinding({ revision: 1 });
    const before = makeLedger({ findings: [preExisting] });
    const after = applyReviewerAnomalySpecsToLedger(before, [makeSpec()], context);
    expect(after.findings).toEqual([preExisting]);
    expect(after.findings).toBe(before.findings); // 参照も変わらない = 触っていない
  });

  it('specs が空なら ledger をそのまま返す（no-op）', () => {
    const ledger = makeLedger();
    expect(applyReviewerAnomalySpecsToLedger(ledger, [], context)).toBe(ledger);
  });

  it('linkPromotedReviewerAnomalies: 同じ lineageKey を持つ product finding が後で見つかると promotedFindingId を張る（レコードは削除しない）', () => {
    const withAnomaly = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec({ lineageKey: 'lk-shared' })], context);
    const finding = makeFinding({ revision: 1, id: 'F-0042', rawFindingIds: ['raw-verified'] });
    const reconciled: FindingLedger = { ...withAnomaly, findings: [finding] };

    const linked = linkPromotedReviewerAnomalies(reconciled, [
      { lineageKey: 'lk-shared', rawFindingId: 'raw-verified' },
    ]);

    expect(linked.reviewerAnomalies).toHaveLength(1);
    const anomaly = linked.reviewerAnomalies![0]!;
    expect(anomaly.promotedFindingId).toBe('F-0042');
    // レコード自体は消えない・他フィールドは不変（観測消去の禁止）。
    expect(anomaly.stableKey).toBe('sk-anomaly-1');
    expect(anomaly.occurrences).toBe(1);
  });

  it('linkPromotedReviewerAnomalies: 一致する rawFindingId が finding 側に見つからなければ何も変えない', () => {
    const withAnomaly = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec({ lineageKey: 'lk-shared' })], context);
    const linked = linkPromotedReviewerAnomalies(withAnomaly, [
      { lineageKey: 'lk-shared', rawFindingId: 'raw-not-in-any-finding' },
    ]);
    expect(linked.reviewerAnomalies![0]!.promotedFindingId).toBeUndefined();
  });

  it('linkPromotedReviewerAnomalies: 既に昇格済みの anomaly は再上書きしない（最初に昇格した finding id を保持する）', () => {
    const withAnomaly = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec({ lineageKey: 'lk-shared' })], context);
    const firstFinding = makeFinding({ revision: 1, id: 'F-0001', rawFindingIds: ['raw-first'] });
    const alreadyPromoted = linkPromotedReviewerAnomalies(
      { ...withAnomaly, findings: [firstFinding] },
      [{ lineageKey: 'lk-shared', rawFindingId: 'raw-first' }],
    );
    expect(alreadyPromoted.reviewerAnomalies![0]!.promotedFindingId).toBe('F-0001');

    // 別ラウンドで同じ lineageKey が別 finding id に紐づく候補が来ても、
    // 既に昇格済みなら上書きしない。
    const secondFinding = makeFinding({ revision: 1, id: 'F-0002', rawFindingIds: ['raw-second'] });
    const reattempted = linkPromotedReviewerAnomalies(
      { ...alreadyPromoted, findings: [firstFinding, secondFinding] },
      [{ lineageKey: 'lk-shared', rawFindingId: 'raw-second' }],
    );
    expect(reattempted.reviewerAnomalies![0]!.promotedFindingId).toBe('F-0001');
  });

  it('linkPromotedReviewerAnomalies: settlement済みの同lineage anomalyはclean候補で昇格しない', () => {
    const withAnomaly = applyReviewerAnomalySpecsToLedger(
      makeLedger(),
      [makeSpec({ lineageKey: 'lk-settled' })],
      context,
    );
    const settledAnomaly = {
      ...withAnomaly.reviewerAnomalies![0]!,
      settlement: {
        kind: 'target_resolved_by_verified_evidence' as const,
        findingId: 'F-0001',
        lifecycleEventId: 'a'.repeat(64),
      },
    };
    const finding = makeFinding({
      revision: 1,
      id: 'F-0042',
      rawFindingIds: ['raw-clean'],
    });
    const settledLedger: FindingLedger = {
      ...withAnomaly,
      findings: [finding],
      reviewerAnomalies: [settledAnomaly],
    };

    const linked = linkPromotedReviewerAnomalies(settledLedger, [
      { lineageKey: 'lk-settled', rawFindingId: 'raw-clean' },
    ]);

    expect(linked).toBe(settledLedger);
    expect(linked.reviewerAnomalies![0]).toBe(settledAnomaly);
    expect(linked.reviewerAnomalies![0]!.promotedFindingId).toBeUndefined();
  });

  it('linkPromotedReviewerAnomalies: reviewerAnomalies が無い/候補が空なら ledger をそのまま返す（no-op）', () => {
    const ledger = makeLedger({ findings: [makeFinding({ revision: 1 })] });
    expect(linkPromotedReviewerAnomalies(ledger, [{ lineageKey: 'lk-x', rawFindingId: 'raw-existing' }])).toBe(ledger);

    const withAnomaly = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context);
    expect(linkPromotedReviewerAnomalies(withAnomaly, [])).toBe(withAnomaly);
  });
});

describe('review-integrity budget (review-integrity.ts, codex 検証ブロッカー#1)', () => {
  it('公開既定値を実行時にも変更不能にする', () => {
    expect(Object.isFrozen(DEFAULT_REVIEW_INTEGRITY_BUDGET)).toBe(true);
  });

  function makeAnomaly(overrides: Partial<ReviewerAnomalyEntry> = {}): ReviewerAnomalyEntry {
    return {
      id: 'RA-ABC',
      kind: 'quote-mismatch',
      stableKey: 'sk',
      lineageKey: 'lk',
      sourceRawFindingIds: ['raw-1'],
      sourceIntakeIds: [],
      reviewers: ['reviewer'],
      title: 'Unverifiable claim',
      mismatchReason: 'no verifiable evidence',
      firstObserved: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-12T00:00:00.000Z' },
      lastObserved: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-12T00:00:00.000Z' },
      occurrences: 1,
      ...overrides,
    };
  }

  const limits = resolveReviewIntegrityLimits(undefined);

  it('resolveReviewIntegrityLimits は省略時に DEFAULT を返し、指定値を尊重する', () => {
    expect(resolveReviewIntegrityLimits(undefined).maxReviewRounds).toBe(DEFAULT_REVIEW_INTEGRITY_BUDGET.maxReviewRounds);
    expect(resolveReviewIntegrityLimits({ maxReviewRounds: 2 }).maxReviewRounds).toBe(2);
  });

  it('未昇格 anomaly が残るラウンドはマーカーを記録し、上限に達すると exhausted になる', () => {
    const smallLimits = resolveReviewIntegrityLimits({ maxReviewRounds: 2 });
    const next = makeLedger({ reviewerAnomalies: [makeAnomaly()] });
    const round1 = attachReviewIntegrityState(makeLedger(), next, smallLimits, 'marker-1', '2026-07-12T00:00:00.000Z');
    expect(reviewIntegrityRoundsCompleted(round1)).toBe(1);
    expect(round1.reviewIntegrity?.exhausted).toBe(false);

    const round2 = attachReviewIntegrityState(round1, { ...next, reviewIntegrity: round1.reviewIntegrity }, smallLimits, 'marker-2', '2026-07-12T00:01:00.000Z');
    expect(reviewIntegrityRoundsCompleted(round2)).toBe(2);
    expect(round2.reviewIntegrity?.exhausted).toBe(true);
  });

  it('crash/replay 冪等: 同一マーカーの再適用はラウンド数を二重計上しない', () => {
    const next = makeLedger({ reviewerAnomalies: [makeAnomaly()] });
    const round1 = attachReviewIntegrityState(makeLedger(), next, limits, 'marker-1', '2026-07-12T00:00:00.000Z');
    const replay = attachReviewIntegrityState(round1, { ...next, reviewIntegrity: round1.reviewIntegrity }, limits, 'marker-1', '2026-07-12T00:02:00.000Z');
    expect(reviewIntegrityRoundsCompleted(replay)).toBe(1);
    expect(replay.reviewIntegrity?.firstRoundAt).toBe('2026-07-12T00:00:00.000Z'); // 起点は上書きしない
  });

  it('未昇格 anomaly が残らないラウンドは予算を消費せず、既存の予算状態を持ち越す', () => {
    const seeded = makeLedger({
      reviewIntegrity: { roundMarkers: ['marker-1'], firstRoundAt: '2026-07-12T00:00:00.000Z', exhausted: false },
    });
    // anomaly が無い（あるいは全て promote 済み）ラウンド。
    const cleanNext = makeLedger({ reviewerAnomalies: [makeAnomaly({ promotedFindingId: 'F-0001' })] });
    const after = attachReviewIntegrityState(seeded, cleanNext, limits, 'marker-2', '2026-07-12T00:03:00.000Z');
    // 新しいマーカーは足さず、既存の予算状態を持ち越す（巻き戻さない）。
    expect(reviewIntegrityRoundsCompleted(after)).toBe(1);
    expect(after.reviewIntegrity?.roundMarkers).toEqual(['marker-1']);
  });

  it('promote 済み anomaly だけの台帳は「未昇格なし」扱いで予算を消費しない', () => {
    const next = makeLedger({ reviewerAnomalies: [makeAnomaly({ promotedFindingId: 'F-0007' })] });
    const after = attachReviewIntegrityState(makeLedger(), next, limits, 'marker-1', '2026-07-12T00:00:00.000Z');
    expect(reviewIntegrityRoundsCompleted(after)).toBe(0);
    expect(after.reviewIntegrity).toBeUndefined();
  });
});
