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
import { applyCommitLedgerStates } from '../core/workflow/findings/manager-commit-finalization.js';
import {
  createFindingReviewPublication,
  PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import { buildFindingsRuleContext } from '../core/workflow/findings/context.js';
import {
  reviewerAnomalySettlementEligibilityViolation,
} from '../core/models/finding-reviewer-anomaly-settlement-policy.js';
import {
  DEFAULT_REVIEW_INTEGRITY_BUDGET,
  attachReviewIntegrityState,
  resolveReviewIntegrityLimits,
  reviewIntegrityRoundsCompleted,
} from '../core/workflow/findings/review-integrity.js';
import { ReviewerAnomalyEntrySchema } from '../core/models/finding-schemas.js';
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
    const ledger = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context, new Set());
    expect(ledger.reviewerAnomalies).toHaveLength(1);
    const anomaly = ledger.reviewerAnomalies![0]!;
    expect(anomaly.id).toMatch(/^RA-[0-9A-F]{12}$/);
    expect(anomaly.occurrences).toBe(1);
    expect(anomaly.promotedFindingId).toBeUndefined();
  });

  it('同じ stableKey が再来すると新規レコードを増やさず既存を更新する（occurrences 加算、sourceRawFindingIds/reviewers は重複排除の和集合）', () => {
    const first = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context, new Set());
    const second = applyReviewerAnomalySpecsToLedger(first, [makeSpec({
      sourceRawFindingIds: ['raw-2'],
      reviewers: ['another-reviewer'],
      mismatchReason: 'the location changed but still does not exist',
    })], { ...context, runId: 'run-2', timestamp: '2026-07-12T01:00:00.000Z' }, new Set());

    expect(second.reviewerAnomalies).toHaveLength(1);
    const anomaly = second.reviewerAnomalies![0]!;
    expect(anomaly.id).toBe(first.reviewerAnomalies![0]!.id);
    expect(anomaly.occurrences).toBe(2);
    expect([...anomaly.sourceRawFindingIds].sort()).toEqual(['raw-1', 'raw-2']);
    expect([...anomaly.reviewers].sort()).toEqual(['ai-antipattern-reviewer', 'another-reviewer']);
    // 最新の主張だけが監査値として残る（過去の主張を消したことにはならない —
    // firstObserved は変わらず保持されるため、いつ最初に観測されたかは失われない）。
    expect(anomaly.mismatchReason).toBe('the location changed but still does not exist');
    expect(anomaly.firstObserved).toEqual({ runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-12T00:00:00.000Z' });
    expect(anomaly.lastObserved).toEqual({ runId: 'run-2', stepName: 'reviewers', timestamp: '2026-07-12T01:00:00.000Z' });
  });

  it('settle済みstableKeyの新観測はsettlementを継承せず別episodeへ保存する', () => {
    const first = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context, new Set());
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
    }, new Set());
    const replayed = applyReviewerAnomalySpecsToLedger(observed, [nextSpec], context, new Set());

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
    const first = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context, new Set());
    expect(first.reviewerAnomalies![0]!.occurrences).toBe(1);
    // 同一ラウンドの再コミット（crash/replay）を模す: 同じ raw finding id・
    // 同じ内容を、時刻だけ変えて再適用する。
    const replayed = applyReviewerAnomalySpecsToLedger(first, [makeSpec()], {
      ...context, timestamp: '2026-07-12T02:00:00.000Z',
    }, new Set());
    const anomaly = replayed.reviewerAnomalies![0]!;
    // occurrences は据え置き、lastObserved も動かない（no-op）。
    expect(anomaly.occurrences).toBe(1);
    expect(anomaly.lastObserved).toEqual(first.reviewerAnomalies![0]!.lastObserved);
    // 何度再適用しても単調に据え置き。
    const replayedAgain = applyReviewerAnomalySpecsToLedger(replayed, [makeSpec()], context, new Set());
    expect(replayedAgain.reviewerAnomalies![0]!.occurrences).toBe(1);
    // ただし新しい raw finding id を持ち込む別ラウンドはちゃんと +1 される。
    const nextRound = applyReviewerAnomalySpecsToLedger(replayedAgain, [makeSpec({ sourceRawFindingIds: ['raw-next-round'] })], context, new Set());
    expect(nextRound.reviewerAnomalies![0]!.occurrences).toBe(2);
  });

  it('rawを生成できない観測はsourceIntakeIdsを冪等キーとしてupsertする', () => {
    const spec = makeSpec({
      sourceRawFindingIds: [],
      sourceIntakeIds: ['intake-1'],
    });
    const first = applyReviewerAnomalySpecsToLedger(makeLedger(), [spec], context, new Set());
    const replay = applyReviewerAnomalySpecsToLedger(first, [spec], {
      ...context,
      timestamp: '2026-07-12T02:00:00.000Z',
    }, new Set());
    const next = applyReviewerAnomalySpecsToLedger(replay, [{
      ...spec,
      sourceIntakeIds: ['intake-2'],
    }], context, new Set());

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
    ], context, new Set());
    expect(ledger.reviewerAnomalies).toHaveLength(2);
  });

  it('ledger.findings には一切触れない（別配列への追記適用のみ）', () => {
    const preExisting = makeFinding({ revision: 1 });
    const before = makeLedger({ findings: [preExisting] });
    const after = applyReviewerAnomalySpecsToLedger(before, [makeSpec()], context, new Set());
    expect(after.findings).toEqual([preExisting]);
    expect(after.findings).toBe(before.findings); // 参照も変わらない = 触っていない
  });

  it('specs が空なら ledger をそのまま返す（no-op）', () => {
    const ledger = makeLedger();
    expect(applyReviewerAnomalySpecsToLedger(ledger, [], context, new Set())).toBe(ledger);
  });

  it('linkPromotedReviewerAnomalies: 同じ lineageKey を持つ product finding が後で見つかると promotedFindingId を張る（レコードは削除しない）', () => {
    const withAnomaly = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec({ lineageKey: 'lk-shared' })], context, new Set());
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
    const withAnomaly = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec({ lineageKey: 'lk-shared' })], context, new Set());
    const linked = linkPromotedReviewerAnomalies(withAnomaly, [
      { lineageKey: 'lk-shared', rawFindingId: 'raw-not-in-any-finding' },
    ]);
    expect(linked.reviewerAnomalies![0]!.promotedFindingId).toBeUndefined();
  });

  it('linkPromotedReviewerAnomalies: 既に昇格済みの anomaly は再上書きしない（最初に昇格した finding id を保持する）', () => {
    const withAnomaly = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec({ lineageKey: 'lk-shared' })], context, new Set());
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
      new Set(),
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

    const withAnomaly = applyReviewerAnomalySpecsToLedger(makeLedger(), [makeSpec()], context, new Set());
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

  it('promotionOrigin が設定されているとき、全 anomaly kind で promotedFindingId を要求する', () => {
    const anomaly = makeAnomaly({ promotionOrigin: 'evidence-search' });
    expect(ReviewerAnomalyEntrySchema.safeParse(anomaly).success).toBe(false);
    expect(ReviewerAnomalyEntrySchema.safeParse({
      ...anomaly,
      promotedFindingId: 'F-0001',
    }).success).toBe(true);
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

describe('後続レビュー登録による reviewer anomaly の決着ライフサイクル (implicit withdrawal)', () => {
  const observation = {
    runId: 'run-2',
    stepName: 'reviewers',
    timestamp: '2026-08-06T00:00:00.000Z',
  };

  function publicationFor(reviewer: string, stepIteration = 2, reportName = `${reviewer}.md`) {
    return createFindingReviewPublication({
      identity: {
        scopeIdentity: 'scope-withdrawal',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration,
        reviewerStepName: reviewer,
        reportName,
      },
      protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: `# ${reportName}\n`,
      rawFindings: [],
    });
  }

  function anomalySpec(overrides: Partial<ReviewerAnomalySpec> = {}): ReviewerAnomalySpec {
    return {
      kind: 'quote-mismatch',
      stableKey: 'sk-withdrawal-1',
      lineageKey: 'lk-withdrawal-1',
      sourceRawFindingIds: [],
      sourceIntakeIds: ['intake-1'],
      reviewers: ['arch-review'],
      title: 'Unverifiable reviewer claim',
      mismatchReason: 'the quoted excerpt does not exist',
      ...overrides,
    };
  }

  function seededLedger(overrides: Partial<ReviewerAnomalySpec> = {}): FindingLedger {
    return applyReviewerAnomalySpecsToLedger(makeLedger(), [anomalySpec(overrides)], {
      workflowName: 'peer-review',
      stepName: 'reviewers',
      runId: 'run-1',
      timestamp: '2026-08-05T00:00:00.000Z',
    }, new Set());
  }

  function commit(input: {
    ledger: FindingLedger;
    reviewers?: string[];
    /** 同一 reviewer キーで複数 publication が成立するラウンドを直接組むための入口。 */
    publications?: ReturnType<typeof publicationFor>[];
    baseAnomalySpecs?: ReviewerAnomalySpec[];
    verifiedEvidenceCandidates?: Array<{ lineageKey: string; rawFindingId: string }>;
  }): FindingLedger {
    const publications = input.publications
      ?? (input.reviewers ?? []).map((reviewer) => publicationFor(reviewer));
    return applyCommitLedgerStates({
      runInput: {
        workflowName: 'peer-review',
        parentStep: { name: 'reviewers' },
        runId: observation.runId,
        timestamp: observation.timestamp,
        subResults: publications.map((publication) => ({ publication })),
      } as never,
      freshLedger: input.ledger,
      settledLedger: input.ledger,
      baseAnomalySpecs: input.baseAnomalySpecs ?? [],
      pendingRejectedObservations: [],
      verifiedEvidenceCandidates: input.verifiedEvidenceCandidates ?? [],
      anomalyAdjudications: [],
    }).ledger;
  }

  it('同じレビュアー枠の次の完全なレビューが登録されると、言い直しの echo が無い anomaly は取り下げとして決着する', () => {
    const seeded = seededLedger();
    const committed = commit({ ledger: seeded, reviewers: ['arch-review'] });

    // レコードは消えない（観測消去の禁止）。settlement が足されるだけ。
    expect(committed.reviewerAnomalies).toHaveLength(1);
    const anomaly = committed.reviewerAnomalies![0]!;
    expect(anomaly.id).toBe(seeded.reviewerAnomalies![0]!.id);
    expect(anomaly.occurrences).toBe(1);
    expect(anomaly.promotedFindingId).toBeUndefined();
    expect(anomaly.settlement).toEqual({
      kind: 'withdrawn_by_subsequent_review',
      supersedingPublications: [
        { reviewer: 'arch-review', publicationId: publicationFor('arch-review').publicationId },
      ],
      decidedAt: observation,
    });
    expect(isOutstandingReviewerAnomaly(anomaly)).toBe(false);
  });

  it('1レビュアー枠が同一ラウンドに複数 publication を登録しても取り下げ根拠は全件残る', () => {
    // 格上げ再レビューは owner ごとに1呼び出しへ分かれるが reviewer キーは固定の
    // 'escalation-reviewer'。publication を reviewer キーで1件に潰すと、別 owner の
    // publication ID が根拠として記録され、監査でどちらの再レビューが決着させたのか
    // 再構成できなくなる。
    const seeded = seededLedger({ reviewers: ['escalation-reviewer'] });
    const forArchitecture = publicationFor(
      'escalation-reviewer',
      2,
      'escalation-reviewer-architecture-review.md',
    );
    const forSecurity = publicationFor(
      'escalation-reviewer',
      2,
      'escalation-reviewer-security-review.md',
    );
    expect(forArchitecture.publicationId).not.toBe(forSecurity.publicationId);

    const committed = commit({
      ledger: seeded,
      publications: [forArchitecture, forSecurity],
    });

    const anomaly = committed.reviewerAnomalies![0]!;
    const expectedIds = [forArchitecture.publicationId, forSecurity.publicationId].sort();
    expect(anomaly.settlement).toEqual({
      kind: 'withdrawn_by_subsequent_review',
      supersedingPublications: expectedIds.map((publicationId) => ({
        reviewer: 'escalation-reviewer',
        publicationId,
      })),
      decidedAt: observation,
    });
    // 台帳へ書ける形（schema）であり、settlement policy の適格性も満たす。
    expect(ReviewerAnomalyEntrySchema.safeParse(anomaly).success).toBe(true);
    expect(reviewerAnomalySettlementEligibilityViolation({
      projection: { anomalies: committed.reviewerAnomalies ?? [], findings: committed.findings },
      anomaly: { ...anomaly, settlement: undefined },
      settlement: anomaly.settlement!,
      sourceHead: { anomalies: committed.reviewerAnomalies ?? [] },
      workflowTaskDigest: null,
    } as never)).toBeUndefined();
  });

  it('同じ publication を二重計上した取り下げ根拠は settlement policy が拒否する', () => {
    const seeded = seededLedger({ reviewers: ['escalation-reviewer'] });
    const publication = publicationFor('escalation-reviewer');
    const committed = commit({ ledger: seeded, publications: [publication] });
    const anomaly = committed.reviewerAnomalies![0]!;

    expect(reviewerAnomalySettlementEligibilityViolation({
      projection: { anomalies: committed.reviewerAnomalies ?? [], findings: committed.findings },
      anomaly: { ...anomaly, settlement: undefined },
      settlement: {
        kind: 'withdrawn_by_subsequent_review',
        supersedingPublications: [
          { reviewer: 'escalation-reviewer', publicationId: publication.publicationId },
          { reviewer: 'escalation-reviewer', publicationId: publication.publicationId },
        ],
        decidedAt: observation,
      },
      sourceHead: { anomalies: committed.reviewerAnomalies ?? [] },
      workflowTaskDigest: null,
    } as never)).toBe('withdrawal must not record the same superseding publication twice');
  });

  it('決着した anomaly は when() のカウンタから外れ、ゲートを塞がなくなる', () => {
    const seeded = seededLedger();
    expect(buildFindingsRuleContext(seeded, '/cwd', new Map()).reviewerAnomalies.count).toBe(1);

    const committed = commit({ ledger: seeded, reviewers: ['arch-review'] });
    expect(buildFindingsRuleContext(committed, '/cwd', new Map()).reviewerAnomalies.count).toBe(0);
  });

  it('レビューを登録していないレビュアー枠の anomaly は決着せず生存する', () => {
    const committed = commit({ ledger: seededLedger(), reviewers: ['security-review'] });

    const anomaly = committed.reviewerAnomalies![0]!;
    expect(anomaly.settlement).toBeUndefined();
    expect(isOutstandingReviewerAnomaly(anomaly)).toBe(true);
  });

  it('複数の観測者を持つ anomaly は全員の後続レビューが登録されるまで決着しない', () => {
    const seeded = applyReviewerAnomalySpecsToLedger(
      seededLedger(),
      [anomalySpec({ sourceIntakeIds: ['intake-2'], reviewers: ['security-review'] })],
      {
        workflowName: 'peer-review',
        stepName: 'reviewers',
        runId: 'run-1',
        timestamp: '2026-08-05T00:01:00.000Z',
      },
      new Set(),
    );
    expect([...seeded.reviewerAnomalies![0]!.reviewers].sort()).toEqual(['arch-review', 'security-review']);

    // 片方だけが再レビューした状態では取り下げない（ゲートを緩めない安全側）。
    const partial = commit({ ledger: seeded, reviewers: ['arch-review'] });
    expect(partial.reviewerAnomalies![0]!.settlement).toBeUndefined();

    // 全観測者の後続レビューが揃って初めて決着する。根拠は観測者全員分を
    // binary 順で記録し、1人分に間引かない。
    const complete = commit({ ledger: seeded, reviewers: ['arch-review', 'security-review'] });
    expect(complete.reviewerAnomalies![0]!.settlement).toEqual({
      kind: 'withdrawn_by_subsequent_review',
      supersedingPublications: [
        { reviewer: 'arch-review', publicationId: publicationFor('arch-review').publicationId },
        { reviewer: 'security-review', publicationId: publicationFor('security-review').publicationId },
      ],
      decidedAt: observation,
    });
  });

  it('同ラウンドの再観測は決着する episode へ混ぜず、別 episode として着地してゲートを塞ぎ続ける', () => {
    const seeded = seededLedger();
    const committed = commit({
      ledger: seeded,
      reviewers: ['arch-review'],
      baseAnomalySpecs: [anomalySpec({ sourceIntakeIds: ['intake-2'] })],
    });

    expect(committed.reviewerAnomalies).toHaveLength(2);
    const [previous, current] = committed.reviewerAnomalies!;
    expect(previous!.settlement?.kind).toBe('withdrawn_by_subsequent_review');
    expect(previous!.occurrences).toBe(1);
    expect(current!.id).not.toBe(previous!.id);
    expect(current!.stableKey).toBe(previous!.stableKey);
    expect(current!.sourceIntakeIds).toEqual(['intake-2']);
    expect(isOutstandingReviewerAnomaly(current!)).toBe(true);
    expect(buildFindingsRuleContext(committed, '/cwd', new Map()).reviewerAnomalies.count).toBe(1);
  });

  it('言い直しが product finding として着地した場合は取り下げではなく昇格として決着する', () => {
    const seeded = seededLedger();
    const withFinding: FindingLedger = {
      ...seeded,
      findings: [makeFinding({ revision: 1, rawFindingIds: ['raw-restated'] })],
    };
    const committed = commit({
      ledger: withFinding,
      reviewers: ['arch-review'],
      verifiedEvidenceCandidates: [{
        lineageKey: 'lk-withdrawal-1',
        rawFindingId: 'raw-restated',
      }],
    });

    const anomaly = committed.reviewerAnomalies![0]!;
    expect(anomaly.promotedFindingId).toBe('F-0001');
    expect(anomaly.settlement).toBeUndefined();
  });

  it('intake-contract anomaly は言い直し契約側の決着経路を保ち、後続レビュー登録では取り下げない', () => {
    const seeded = seededLedger({
      kind: 'intake-contract-incomplete',
      intakeContract: {
        observationClass: 'claim-bearing',
        classificationAuthorityId: 'system/intake_observation_classification_v1',
        reasonCodes: ['claim-evidence-missing'],
        missingRequirements: ['claimEvidence'],
        presentationOwnerReviewer: 'arch-review',
        presentationLimit: 3,
      },
    });
    const committed = commit({ ledger: seeded, reviewers: ['arch-review'] });

    const anomaly = committed.reviewerAnomalies![0]!;
    expect(anomaly.settlement).toBeUndefined();
    expect(isOutstandingReviewerAnomaly(anomaly)).toBe(true);
  });

  it('決着の適格性判定は観測者集合の完全一致と言い直し契約の有無だけで決まる', () => {
    const anomaly = seededLedger().reviewerAnomalies![0]!;
    const settlement = {
      kind: 'withdrawn_by_subsequent_review' as const,
      supersedingPublications: [
        { reviewer: 'arch-review', publicationId: 'a'.repeat(64) },
      ],
      decidedAt: observation,
    };
    const projection = {
      findings: [],
      rawFindings: [],
      evidenceRecords: [],
      evidenceBindings: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
    };

    expect(reviewerAnomalySettlementEligibilityViolation({
      projection,
      anomaly,
      settlement,
      sourceHead: { kind: 'projection' },
      workflowTaskDigest: null,
    })).toBeUndefined();

    // 観測者でないレビュアーの根拠（過剰）は無効。
    expect(reviewerAnomalySettlementEligibilityViolation({
      projection,
      anomaly,
      settlement: {
        ...settlement,
        supersedingPublications: [{ reviewer: 'security-review', publicationId: 'a'.repeat(64) }],
      },
      sourceHead: { kind: 'projection' },
      workflowTaskDigest: null,
    })).toContain('every reviewer that observed the anomaly');

    // 観測者が2人いるのに1人分しか根拠が無い（部分集合）も無効。
    expect(reviewerAnomalySettlementEligibilityViolation({
      projection,
      anomaly: { ...anomaly, reviewers: ['arch-review', 'security-review'] },
      settlement,
      sourceHead: { kind: 'projection' },
      workflowTaskDigest: null,
    })).toContain('every reviewer that observed the anomaly');

    expect(reviewerAnomalySettlementEligibilityViolation({
      projection,
      anomaly: { ...anomaly, promotedFindingId: 'F-0001' },
      settlement,
      sourceHead: { kind: 'projection' },
      workflowTaskDigest: null,
    })).toContain('promoted');
  });
});
