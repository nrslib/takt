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
  verifySourceQuoteEvidence,
} from '../core/workflow/findings/admission-validation.js';
import { resolveRawFindingEvidence } from '../core/workflow/findings/raw-canonicalization.js';
import {
  applyReviewerAnomalySpecsToLedger,
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

function makeFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Existing issue',
    location: 'src/a.ts:10',
    description: 'Existing issue body.',
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-existing'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    revision: 1,
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    findings: [],
    rawFindings: [],
    conflicts: [],
    ...overrides,
  };
}

describe('verifySourceQuoteEvidence (admission-validation.ts)', () => {
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
    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
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
    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      verbatimExcerpt: '// line 2', // 内容は正しく一致する
      snapshotId: 'stale-snap',
    }, snapshotId);
    expect(result.outcome).toBe('stale-snapshot');
  });

  it('verbatimExcerpt が空文字なら quote-mismatch（空引用は不採用）', () => {
    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: '   ',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('startLine が endLine より後ろなら quote-mismatch（逆順の範囲は不採用）', () => {
    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 5,
      endLine: 2,
      verbatimExcerpt: 'anything',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it(`引用範囲が ${MAX_SOURCE_QUOTE_LINES} 行を超えると quote-mismatch（過度に広い引用は不採用）`, () => {
    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 1,
      endLine: MAX_SOURCE_QUOTE_LINES + 2,
      verbatimExcerpt: 'anything',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('path がプロジェクト外を指す（相対パスでの脱出）なら quote-mismatch', () => {
    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: '../outside.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'anything',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('行範囲がファイルの実際の行数を超えると quote-mismatch', () => {
    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 9,
      endLine: 999,
      verbatimExcerpt: 'anything',
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('verbatimExcerpt が該当行の一部分だけを恣意的に切り取ったものだと quote-mismatch（部分行の引用は構造的に排除される）', () => {
    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      verbatimExcerpt: '// line', // "// line 2" の部分文字列
      snapshotId,
    }, snapshotId);
    expect(result.outcome).toBe('quote-mismatch');
  });

  it('存在しない path なら quote-mismatch', () => {
    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
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

    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
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
describe('resolveRawFindingEvidence (raw-canonicalization.ts)', () => {
  it('evidenceKind が locationless なら description を explanation として使う', () => {
    const evidence = resolveRawFindingEvidence({
      evidenceKind: 'locationless',
      description: 'No single site; this is an architectural observation.',
    });
    expect(evidence).toEqual({ kind: 'locationless', explanation: 'No single site; this is an architectural observation.' });
  });

  it('evidenceKind が locationless で description も無ければ固定文言にフォールバックする（弱いモデルへ必須フィールドを増やさない設計判断）', () => {
    const evidence = resolveRawFindingEvidence({ evidenceKind: 'locationless' });
    expect(evidence).toEqual({ kind: 'locationless', explanation: '(no description)' });
  });

  it('evidenceKind が source_quote で verbatimExcerpt・snapshotId・単一行 location が揃っていれば組み立てる', () => {
    const evidence = resolveRawFindingEvidence({
      evidenceKind: 'source_quote',
      verbatimExcerpt: 'const x = 1;',
      snapshotId: 'snap-1',
      location: 'src/a.ts:7',
    });
    expect(evidence).toEqual({
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 7,
      endLine: 7,
      verbatimExcerpt: 'const x = 1;',
      snapshotId: 'snap-1',
    });
  });

  it('evidenceKind が source_quote で行範囲 location（path:start-end）でも組み立てる', () => {
    const evidence = resolveRawFindingEvidence({
      evidenceKind: 'source_quote',
      verbatimExcerpt: 'line 5\nline 6',
      snapshotId: 'snap-1',
      location: 'src/a.ts:5-6',
    });
    expect(evidence).toEqual({
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 5,
      endLine: 6,
      verbatimExcerpt: 'line 5\nline 6',
      snapshotId: 'snap-1',
    });
  });

  it('evidenceKind が source_quote でも verbatimExcerpt が無ければ undefined を返す（欠損を有利に解釈しない）', () => {
    const evidence = resolveRawFindingEvidence({
      evidenceKind: 'source_quote',
      snapshotId: 'snap-1',
      location: 'src/a.ts:7',
    });
    expect(evidence).toBeUndefined();
  });

  it('evidenceKind が source_quote でも snapshotId が無ければ undefined を返す', () => {
    const evidence = resolveRawFindingEvidence({
      evidenceKind: 'source_quote',
      verbatimExcerpt: 'const x = 1;',
      location: 'src/a.ts:7',
    });
    expect(evidence).toBeUndefined();
  });

  it('evidenceKind が source_quote でも location が解釈できない形（N/A・空）なら undefined を返す', () => {
    for (const location of ['N/A', '']) {
      const evidence = resolveRawFindingEvidence({
        evidenceKind: 'source_quote',
        verbatimExcerpt: 'const x = 1;',
        snapshotId: 'snap-1',
        location,
      });
      expect(evidence).toBeUndefined();
    }
  });

  it('カンマ区切りの複数 location は「末尾の :digits より前の全て」を1つの path として緩く解釈する（曖昧だが構造的には parse できてしまう） — 安全性は下流の verifySourceQuoteEvidence の path 実在チェックが担保する（本テストは curent 挙動の固定であって、この解釈を admission が admit することを意味しない）', () => {
    const evidence = resolveRawFindingEvidence({
      evidenceKind: 'source_quote',
      verbatimExcerpt: 'const x = 1;',
      snapshotId: 'snap-1',
      location: 'src/a.ts:5, src/b.ts:9',
    });
    expect(evidence).toEqual({
      kind: 'source_quote',
      path: 'src/a.ts:5, src/b.ts',
      startLine: 9,
      endLine: 9,
      verbatimExcerpt: 'const x = 1;',
      snapshotId: 'snap-1',
    });
  });

  it('evidenceKind が未指定・不明値なら undefined を返す（旧来の bare location raw は evidence なし扱い）', () => {
    expect(resolveRawFindingEvidence({ location: 'src/a.ts:7' })).toBeUndefined();
    expect(resolveRawFindingEvidence({ evidenceKind: 'bogus' as never, location: 'src/a.ts:7' })).toBeUndefined();
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

  it('異なる stableKey は別レコードとして共存する', () => {
    const ledger = applyReviewerAnomalySpecsToLedger(makeLedger(), [
      makeSpec({ stableKey: 'sk-a', lineageKey: 'lk-a' }),
      makeSpec({ stableKey: 'sk-b', lineageKey: 'lk-b' }),
    ], context);
    expect(ledger.reviewerAnomalies).toHaveLength(2);
  });

  it('ledger.findings には一切触れない（別配列への追記適用のみ）', () => {
    const preExisting = makeFinding();
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
    const finding = makeFinding({ id: 'F-0042', rawFindingIds: ['raw-verified'] });
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
    const firstFinding = makeFinding({ id: 'F-0001', rawFindingIds: ['raw-first'] });
    const alreadyPromoted = linkPromotedReviewerAnomalies(
      { ...withAnomaly, findings: [firstFinding] },
      [{ lineageKey: 'lk-shared', rawFindingId: 'raw-first' }],
    );
    expect(alreadyPromoted.reviewerAnomalies![0]!.promotedFindingId).toBe('F-0001');

    // 別ラウンドで同じ lineageKey が別 finding id に紐づく候補が来ても、
    // 既に昇格済みなら上書きしない。
    const secondFinding = makeFinding({ id: 'F-0002', rawFindingIds: ['raw-second'] });
    const reattempted = linkPromotedReviewerAnomalies(
      { ...alreadyPromoted, findings: [firstFinding, secondFinding] },
      [{ lineageKey: 'lk-shared', rawFindingId: 'raw-second' }],
    );
    expect(reattempted.reviewerAnomalies![0]!.promotedFindingId).toBe('F-0001');
  });

  it('linkPromotedReviewerAnomalies: reviewerAnomalies が無い/候補が空なら ledger をそのまま返す（no-op）', () => {
    const ledger = makeLedger({ findings: [makeFinding()] });
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
