/**
 * typed evidence protocol の軽量な admission・canonicalization・review-integrity 単体テスト。
 * 実Gitを使う review scope snapshot 群は finding-evidence-protocol.integration.test.ts
 * で serial integration として実行する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failingPath = vi.hoisted(() => ({
  suffix: '',
  beforeOpen: undefined as (() => void) | undefined,
}));

const fsControl = vi.hoisted(() => ({
  beforeOpenPath: undefined as string | undefined,
  beforeOpen: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const beforeOpen = failingPath.beforeOpen;
      failingPath.beforeOpen = undefined;
      beforeOpen?.();
      if (fsControl.beforeOpenPath === String(args[0])) {
        fsControl.beforeOpenPath = undefined;
        const beforeOpenForPath = fsControl.beforeOpen;
        fsControl.beforeOpen = undefined;
        beforeOpenForPath?.();
      }
      return actual.openSync(...args);
    },
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (failingPath.suffix.length > 0 && typeof args[0] === 'number') {
        throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      }
      return actual.readFileSync(...args);
    },
  };
});

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

import {
  MAX_EVIDENCE_SOURCE_FILE_BYTES,
  MAX_SOURCE_QUOTE_LINES,
  validateLocationAdmission,
  verifySourceQuoteEvidence,
} from '../core/workflow/findings/admission-validation.js';
import { evaluateRawAdmission } from '../core/workflow/findings/manager-admission.js';
import { computeInvalidLocationCandidates } from '../core/workflow/findings/manager-utils.js';
import {
  canonicalizeReviewerRawFinding,
  createReviewerRawFindingCandidates,
  resolveRawFindingEvidence,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
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
import type { AgentResponse, FindingContractConfig, WorkflowStep } from '../core/models/types.js';
import { computeReviewScopeSnapshotId } from '../core/workflow/findings/snapshot.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { createFindingManagerPublicationDouble, RevisionedFindingLedgerTestRepository } from './helpers/finding-manager-publication.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { assembleManagerOutput } from '../core/workflow/findings/decision-assembly.js';
import { reconcileFindingLedger as reconcileFindingLedgerStrict } from '../core/workflow/findings/reconciler.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import { computeLineageKey, computeReviewerStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import { createFindingAdjudicationReservation } from './helpers/finding-adjudication-reservation.js';
import { observeFindingLedgerMutations } from './helpers/finding-manager-publication.js';
import type { FindingManagerDecisions, RawFinding } from '../core/workflow/findings/types.js';

function makeFinding(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
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
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    findings: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
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

describe('source quote filesystem failures', () => {
  let cwd: string;

  afterEach(() => {
    failingPath.suffix = '';
    failingPath.beforeOpen = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('EIO を quote-mismatch に変換せず unverifiable として返す', () => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-evidence-eio-'));
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'const value = 1;\n');
    failingPath.suffix = join('src', 'a.ts');

    expect(verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'const value = 1;',
      snapshotId: 'snapshot',
    }, 'snapshot')).toMatchObject({
      outcome: 'unverifiable',
      reason: expect.stringContaining('injected read failure'),
    });
  });

  it('検査後の祖先差し替えでは外部ファイルを読まず unverifiable にする', () => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-evidence-swap-'));
    const sourceDir = join(cwd, 'src');
    const movedSourceDir = join(cwd, 'original-src');
    const outsideDir = join(cwd, 'outside');
    mkdirSync(sourceDir);
    mkdirSync(outsideDir);
    writeFileSync(join(sourceDir, 'a.ts'), 'const inside = 1;\n');
    writeFileSync(join(outsideDir, 'a.ts'), 'const outside = 2;\n');
    failingPath.beforeOpen = () => {
      renameSync(sourceDir, movedSourceDir);
      symlinkSync(outsideDir, sourceDir, 'dir');
    };

    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'const outside = 2;',
      snapshotId: 'snapshot',
    }, 'snapshot');

    expect(result).toMatchObject({
      outcome: 'unverifiable',
      reason: expect.stringContaining('identity changed'),
    });
    expect(readFileSync(join(outsideDir, 'a.ts'), 'utf-8')).toBe('const outside = 2;\n');
  });
});

describe('unverifiable propagation (manager-admission.ts / manager-utils.ts)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-unverifiable-propagation-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), 'const value = 1;\n');
  });

  afterEach(() => {
    failingPath.suffix = '';
    rmSync(cwd, { recursive: true, force: true });
  });

  it('manager admission は source quote の検証不能を anomaly に変換せず停止する', () => {
    writeFileSync(
      join(cwd, 'src', 'big.ts'),
      Buffer.alloc(MAX_EVIDENCE_SOURCE_FILE_BYTES + 1, 0x61),
    );
    const ledger = makeLedger({
      findings: [makeFinding({ revision: 1, location: 'src/a.ts:1', rawFindingIds: [] })],
    });
    const [candidate] = createReviewerRawFindingCandidates([{
      rawFindingId: 'raw-1',
      relation: 'new',
      title: 'New issue',
      description: 'description',
      severity: 'high',
      familyTag: 'bug',
      location: 'src/big.ts:1',
      evidenceKind: 'source_quote',
      verbatimExcerpt: 'a',
      snapshotId: 'snapshot',
    }], {
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-1',
      reviewerStepName: 'reviewer',
      reviewerPersonaKey: 'reviewer',
    });
    const { canonical } = canonicalizeReviewerRawFinding(candidate!, { ledger });

    expect(() => evaluateRawAdmission({
      cwd,
      reviewScopeSnapshotId: 'snapshot',
      previousLedger: ledger,
      intake: {
        items: [{ canonical, wire: toLedgerRawFinding(canonical) }],
        overflowRawFindingIds: new Set(),
        overflowSpecs: [],
        overflowReports: [],
        clarifications: [],
        rawNormalizations: [],
        healthyReviewerStableKeys: new Set(),
      },
    })).toThrow(/could not be verified: .*evidence inspection limit/);
    expect(ledger.findings[0]?.status).toBe('open');
  });

  it('manager の invalidate 候補へ検証不能な open finding を入れない', () => {
    writeFileSync(
      join(cwd, 'src', 'oversized.ts'),
      Buffer.alloc(MAX_EVIDENCE_SOURCE_FILE_BYTES + 1, 0x61),
    );
    const findings = [makeFinding({ revision: 1, location: 'src/oversized.ts:1', rawFindingIds: [] })];

    expect(computeInvalidLocationCandidates(cwd, findings)).toEqual(new Map());
    expect(findings[0]?.status).toBe('open');
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

const FINDING_CONTRACT: FindingContractConfig = {
  ledgerPath: '.takt/findings/peer-review.json',
  rawFindingsPath: '.takt/findings/raw',
  manager: {
    persona: 'findings-manager',
    instruction: 'Reconcile findings.',
    outputContract: 'Return JSON.',
  },
};

describe('reviewScopeSnapshotId correctness determines admission outcome (manager-runner.ts)', () => {
  let cwd: string;
  let reportDir: string;

  beforeEach(() => {
    fsControl.beforeOpenPath = undefined;
    fsControl.beforeOpen = undefined;
    cwd = mkdtempSync(join(tmpdir(), 'takt-review-scope-snapshot-admission-'));
    reportDir = mkdtempSync(join(tmpdir(), 'takt-review-scope-snapshot-reports-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'example.ts'),
      Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n',
    );
    initializeGitFixture(cwd, ['src/example.ts']);
  });

  afterEach(() => {
    fsControl.beforeOpenPath = undefined;
    fsControl.beforeOpen = undefined;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
  });

  function makeLedgerStore(): { store: FindingLedgerStore; current: () => FindingLedger } {
    const ledgerRepository = new RevisionedFindingLedgerTestRepository({
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-13T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });
    const reservations = new Set<string>();
    const store: FindingLedgerStore = {
      ledgerIdentity: '/test/finding-review-scope-snapshot-admission/ledger.json',
      workflowName: 'peer-review',
      loadLedger: () => ledgerRepository.loadLedger(),
      updateLedger: (mutator) => ledgerRepository.updateLedger(mutator),
      claimAdjudicationReservation: (token) => {
        if (reservations.has(token)) return false;
        reservations.add(token);
        return true;
      },
      releaseAdjudicationReservation: (token) => { reservations.delete(token); },
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: () => {},
      ...createFindingManagerPublicationDouble(
        (report) => join(reportDir, `findings-manager-validation.${report.stepName}.json`),
        ledgerRepository,
      ),
      saveConflictAdjudicationReport: () => {},
    };
    return { store, current: () => ledgerRepository.loadLedger() };
  }

  /**
   * quote 自体（path/行範囲/verbatimExcerpt）は常に正しい実在の引用にする。
   * 変えるのは snapshotId だけ — これは「ParallelRunner が reviewer instruction
   * へ何を渡したか」に対応する変数であり、この関数の1変数だけが admission の
   * 結果を分けることを示す。
   */
  async function runManagerWithSnapshotId(store: FindingLedgerStore, snapshotId: string) {
    const quote = verifiedSourceQuoteFields(cwd, 'src/example.ts', 3);
    const optionsBuilder = {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider: 'claude', model: 'claude-sonnet' }),
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => {},
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
    return runFindingManagerForStep({
      contract: FINDING_CONTRACT as never,
      ledgerStore: store,
      optionsBuilder: optionsBuilder as never,
      stepExecutor: stepExecutor as never,
      cwd,
      parentStep,
      stepIteration: 1,
      subResults: [{
        subStep: { kind: 'agent', name: 'ai-antipattern-review', persona: 'ai-antipattern-reviewer', edit: false } as WorkflowStep,
        response: {
          status: 'done',
          content: '',
          structuredOutput: {
            rawFindings: [{
              rawFindingId: 'finding-1',
              familyTag: 'bug',
              severity: 'high',
              title: 'Suspicious pattern in example.ts',
              location: quote.location,
              description: 'A real observation quoting an existing line verbatim.',
              suggestion: 'Fix it.',
              relation: 'new',
              evidenceKind: quote.evidenceKind,
              verbatimExcerpt: quote.verbatimExcerpt,
              snapshotId,
            }],
          },
        } as unknown as AgentResponse,
      }],
      workflowName: 'peer-review',
      runId: 'test-run',
      callNamespace: '',
      timestamp: '2026-07-13T00:00:00.000Z',
    });
  }

  it('admits a source_quote finding as a real product finding when the reviewer echoes the correct reviewScopeSnapshotId (post-fix ParallelRunner behavior)', async () => {
    const { store, current } = makeLedgerStore();
    const correctSnapshotId = computeReviewScopeSnapshotId(cwd);

    const result = await runManagerWithSnapshotId(store, correctSnapshotId);

    expect(result.status).toBe('updated');
    const ledger = current();
    expect(ledger.findings).toHaveLength(1);
    expect(ledger.findings[0]?.title).toBe('Suspicious pattern in example.ts');
    expect(ledger.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('rejects the identical quote into a reviewer anomaly when reviewScopeSnapshotId is empty — the exact wire shape the pre-fix ParallelRunner bug produced', async () => {
    const { store, current } = makeLedgerStore();

    // pre-fix ParallelRunner built the finding-contract instruction context
    // inline without reviewScopeSnapshotId. finding-contract-instruction.ts's
    // `contract.reviewScopeSnapshotId ?? ''` then rendered an empty token into
    // the reviewer-facing instruction, so a compliant reviewer echoed back ''.
    const result = await runManagerWithSnapshotId(store, '');

    expect(result.status).toBe('updated');
    const ledger = current();
    // 引用そのものは完全に正確でも admit されない。空文字は raw-canonicalization.ts の
    // pickString が「未指定」として弾くため evidence が source_quote として
    // 構築されず、verifySourceQuoteEvidence の stale-snapshot 判定にすら届かず
    // 「検証済み evidence が無い new claim」として quote-mismatch に落ちる —
    // どちらの経路でも共通しているのは「product finding へは絶対に昇格しない」こと。
    expect(ledger.findings).toHaveLength(0);
    const anomalies = ledger.reviewerAnomalies ?? [];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.kind).toBe('quote-mismatch');
  });

  it('rejects the identical quote into a stale-snapshot reviewer anomaly when reviewScopeSnapshotId is a non-empty but wrong value (the working tree moved on since the reviewer read it)', async () => {
    const { store, current } = makeLedgerStore();

    const result = await runManagerWithSnapshotId(store, 'some-other-round-snapshot-id');

    expect(result.status).toBe('updated');
    const ledger = current();
    // verbatimExcerpt は現在のファイルと完全一致するが、snapshotId が違うため
    // verifySourceQuoteEvidence は内容の一致/不一致を判定する前に stale-snapshot で
    // 弾く（幻覚した引用が偶然一致しても match と誤判定しないための設計 —
    // finding-evidence-protocol.integration.test.ts 参照）。
    expect(ledger.findings).toHaveLength(0);
    const anomalies = ledger.reviewerAnomalies ?? [];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.kind).toBe('stale-snapshot');
  });

  it('rejects admission when the source file is replaced after inspection and leaves the substitute unchanged', () => {
    const sourcePath = join(cwd, 'src', 'example.ts');
    const originalPath = join(cwd, 'src', 'original-example.ts');
    const outsidePath = join(cwd, 'outside-example.ts');
    const outsideContent = '// substituted outside content\n';
    const quote = verifiedSourceQuoteFields(cwd, 'src/example.ts', 3);
    writeFileSync(outsidePath, outsideContent);
    fsControl.beforeOpenPath = sourcePath;
    fsControl.beforeOpen = () => {
      renameSync(sourcePath, originalPath);
      linkSync(outsidePath, sourcePath);
    };

    const verification = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/example.ts',
      startLine: 3,
      endLine: 3,
      verbatimExcerpt: quote.verbatimExcerpt,
      snapshotId: quote.snapshotId,
    }, quote.snapshotId);

    expect(verification).toMatchObject({
      outcome: 'unverifiable',
      reason: expect.stringMatching(/identity changed/),
    });
    expect(readFileSync(outsidePath, 'utf-8')).toBe(outsideContent);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(outsideContent);
    expect(readFileSync(originalPath, 'utf-8')).toContain('// line 3');
  });
});

describe('raw admission validation and invalidate (finding-convergence 由来)', () => {
  function makeRawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
      rawFindingId: 'raw-current',
      stepName: 'architecture-review',
      reviewer: 'architecture-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Current issue',
      description: 'The issue is present in the current review.',
      relation: 'new',
      ...overrides,
    };
  }

  function makeFinding(
    overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
  ): FindingLedgerEntry {
    return {
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Existing issue',
      location: 'src/a.ts:10',
      reviewers: ['architecture-review'],
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
      rawFindings: [makeRawFinding({ rawFindingId: 'raw-existing' })],
      conflicts: [],
      interpretations: [],
      findings: [makeFinding({ revision: 1 })],
      ...overrides,
    };
  }

  type TestReconcileInput = Omit<
    Parameters<typeof reconcileFindingLedgerStrict>[0],
    'provisionalFindings' | 'rawFindingDispositions' | 'rawProvenanceByRawFindingId'
  >;

  function reconcileFindingLedger(input: TestReconcileInput): FindingLedger {
    return reconcileFindingLedgerStrict({
      ...input,
      provisionalFindings: [],
      rawFindingDispositions: [],
      rawProvenanceByRawFindingId: new Map(input.rawFindings.map((rawFinding) => [
        rawFinding.rawFindingId,
        storedRawReconcileProvenance(
          rawFinding,
          computeReviewerStableKey({
            workflowName: input.context.workflowName,
            callNamespace: '',
            parentStepName: input.context.stepName,
            reviewerPersonaKey: rawFinding.reviewer,
          }),
          computeLineageKey({
            ...(rawFinding.targetFindingId !== undefined
              ? { targetFindingId: rawFinding.targetFindingId }
              : {}),
            ...(rawFinding.location !== undefined ? { location: rawFinding.location } : {}),
            title: rawFinding.title,
            familyTag: rawFinding.familyTag,
          }),
        ),
      ])),
    });
  }

  function makeDecisions(overrides: Partial<FindingManagerDecisions> = {}): FindingManagerDecisions {
    return {
      rawDecisions: [],
      disputeDecisions: [],
      conflictDecisions: [],
      invalidateDecisions: [],
      duplicateDecisions: [],
      dismissDecisions: [],
      ...overrides,
    };
  }

  function buildFindingsRuleContext(ledger: FindingLedger) {
    return buildFindingsRuleContextWithCwd(ledger, process.cwd());
  }

  describe('item 1/4: raw admission validation and invalidate', () => {
    let projectDir: string;
    let reportDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), 'takt-findings-admission-'));
      reportDir = mkdtempSync(join(tmpdir(), 'takt-findings-admission-reports-'));
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src/real.ts'), `${Array.from({ length: 5 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
      initializeGitFixture(projectDir, ['src/real.ts']);
      executeAgentMock.mockReset();
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
    });

    it('Given a location whose path does not exist When validated Then it is inadmissible', () => {
      const result = validateLocationAdmission(projectDir, 'src/does-not-exist.ts:1');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('does not exist');
    });

    it('Given a location whose line is out of range When validated Then it is inadmissible', () => {
      const result = validateLocationAdmission(projectDir, 'src/real.ts:9999');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('out of range');
    });

    it('Given a location that exists and is in range When validated Then it is admissible', () => {
      expect(validateLocationAdmission(projectDir, 'src/real.ts:3')).toEqual({ ok: true });
    });

    // B1: 末尾改行は「最終行の終端」であって空行ではない。5行 + 末尾改行の
    // ファイルで、ちょうど最終行（:5）は範囲内、最終行+1（:6）は範囲外。
    // 素朴な split('\n').length は :6 を範囲内と誤判定していた（codex 再現）。
    it('Given a file with a trailing newline When the exact last line is cited Then it is admissible, and last line + 1 is not', () => {
      // src/real.ts は5行 + 末尾改行（beforeEach 参照）。
      expect(validateLocationAdmission(projectDir, 'src/real.ts:5')).toEqual({ ok: true });
      const overByOne = validateLocationAdmission(projectDir, 'src/real.ts:6');
      expect(overByOne.ok).toBe(false);
      expect(overByOne.reason).toContain('file has 5 lines');
    });

    it('Given a file without a trailing newline When the exact last line is cited Then it is admissible, and last line + 1 is not', () => {
      writeFileSync(join(projectDir, 'src/no-trailing.ts'), 'line 1\nline 2\nline 3');
      expect(validateLocationAdmission(projectDir, 'src/no-trailing.ts:3')).toEqual({ ok: true });
      const overByOne = validateLocationAdmission(projectDir, 'src/no-trailing.ts:4');
      expect(overByOne.ok).toBe(false);
      expect(overByOne.reason).toContain('file has 3 lines');
    });

    it('Given an empty file When line 1 is cited Then it is inadmissible', () => {
      writeFileSync(join(projectDir, 'src/empty.ts'), '');
      const result = validateLocationAdmission(projectDir, 'src/empty.ts:1');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('file has 0 lines');
    });

    // B1: 字句的な resolve() はプロジェクト内に見えるパスの symlink 脱出を検出
    // できない（codex 再現: node_modules/... の symlink 実体が受理された）。
    // realpath で解決した実体パスがプロジェクト root 配下にあることを検証する。
    it('Given a symlink inside the project pointing outside it When validated Then it is inadmissible', () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'takt-findings-outside-'));
      try {
        writeFileSync(join(outsideDir, 'outside.ts'), 'line 1\nline 2\n');
        symlinkSync(join(outsideDir, 'outside.ts'), join(projectDir, 'src/escape.ts'));
        const result = validateLocationAdmission(projectDir, 'src/escape.ts:1');
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('outside the project');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('Given a symlinked directory inside the project pointing outside it When a file under it is cited Then it is inadmissible', () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'takt-findings-outside-dir-'));
      try {
        writeFileSync(join(outsideDir, 'module.ts'), 'line 1\n');
        symlinkSync(outsideDir, join(projectDir, 'vendored'));
        const result = validateLocationAdmission(projectDir, 'vendored/module.ts:1');
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('outside the project');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('Given a symlink inside the project pointing at another file inside the project When validated Then it is admissible', () => {
      symlinkSync(join(projectDir, 'src/real.ts'), join(projectDir, 'src/alias.ts'));
      expect(validateLocationAdmission(projectDir, 'src/alias.ts:1')).toEqual({ ok: true });
    });

    it('Given no location When validated Then it is admissible (nothing to check)', () => {
      expect(validateLocationAdmission(projectDir, undefined)).toEqual({ ok: true });
    });

    it('keeps an inaccessible existing location unverifiable instead of classifying it as invalid', () => {
      const restrictedDir = join(projectDir, 'restricted');
      mkdirSync(restrictedDir);
      writeFileSync(join(restrictedDir, 'real.ts'), 'line 1\n');
      chmodSync(restrictedDir, 0o000);
      try {
        const result = validateLocationAdmission(projectDir, 'restricted/real.ts:1');
        expect(result).toMatchObject({ ok: false, outcome: 'unverifiable' });
      } finally {
        chmodSync(restrictedDir, 0o700);
      }
    });

    function makeHarness(initialLedger: FindingLedger): {
      savedLedgers: FindingLedger[];
      savedValidationReports: unknown[];
      currentLedger: () => FindingLedger;
      run: (input: { reviewerRawFindings: Array<Record<string, unknown>>; priorStepResponseText?: string }) => ReturnType<typeof runFindingManagerForStep>;
    } {
      const ledgerRepository = new RevisionedFindingLedgerTestRepository(initialLedger);
      const savedLedgers: FindingLedger[] = [];
      const savedValidationReports: unknown[] = [];
      const publicationDouble = createFindingManagerPublicationDouble((report) => {
        savedValidationReports.push(report);
        return join(reportDir, `findings-manager-validation.${report.stepName}.json`);
      }, ledgerRepository);
      const observedMutations = observeFindingLedgerMutations(
        ledgerRepository,
        publicationDouble,
        (ledger) => {
          savedLedgers.push(ledger);
        },
      );
      const ledgerStore: FindingLedgerStore = {
        ledgerIdentity: '/test/finding-convergence/ledger.json',
        workflowName: 'peer-review',
        loadLedger: () => ledgerRepository.loadLedger(),
        ...createFindingAdjudicationReservation(),
        saveLedgerSnapshot: () => {},
        saveRawFindings: () => {},
        saveManagerValidationReport: (report) => {
          savedValidationReports.push(report);
        },
        ...publicationDouble,
        ...observedMutations,
      };
      const optionsBuilder = {
        buildAgentOptions: () => ({}),
        resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
      };
      const stepExecutor = {
        buildPhase1Instruction: (instruction: string) => instruction,
        recordSynthesizedAgentUsage: () => {},
        normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
      };
      const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
      const contract = {
        ledgerPath: '.takt/findings/ledger.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'Reconcile findings.', outputContract: 'Return JSON.' },
      };
      return {
        savedLedgers,
        savedValidationReports,
        currentLedger: () => ledgerRepository.loadLedger(),
        run: (input) => runFindingManagerForStep({
          contract: contract as never,
          ledgerStore,
          optionsBuilder: optionsBuilder as never,
          stepExecutor: stepExecutor as never,
          cwd: projectDir,
          parentStep,
          stepIteration: 1,
          subResults: [{
            subStep: { kind: 'agent', name: 'architecture-review', persona: 'arch', edit: false } as WorkflowStep,
            response: { status: 'done', content: '', structuredOutput: { rawFindings: input.reviewerRawFindings } } as unknown as AgentResponse,
          }],
          workflowName: 'peer-review',
          runId: 'run-1',
          callNamespace: '',
          timestamp: '2026-07-10T00:00:00.000Z',
          priorStepResponseText: input.priorStepResponseText,
        }),
      };
    }

    it('Given a critical raw finding whose location does not exist When run Then it is never promoted to a confirmed finding and lands as a non-blocking reviewer anomaly, not a gate-blocking provisional (codex 対策#4, supersedes B3)', async () => {
      const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }));
      const result = await harness.run({
        reviewerRawFindings: [{
          rawFindingId: 'raw-hallucinated',
          familyTag: 'security',
          severity: 'critical',
          title: 'Hallucinated critical finding',
          location: 'src/does-not-exist.ts:99',
          description: 'This location does not correspond to any file in the reviewed code.',
          suggestion: '',
          relation: 'new',
          targetFindingId: '',
        }],
      });

      expect(result.status).toBe('updated');
      expect(executeAgentMock).not.toHaveBeenCalled();
      const savedLedger = harness.currentLedger();
      // 確定 finding には昇格しない（幻覚 location を confirmed に載せない）。
      // codex 対策#4 以前は「location 証拠の不成立」を product gate 側の
      // provisional として保持していたが、typed evidence protocol 導入後は
      // review-integrity 側の reviewer anomaly（quote-mismatch）へ隔離する —
      // 引用不成立は欠陥の虚偽そのものを証明しないため、観測は監査に残しつつ
      // product gate は塞がない（三分類・§C）。
      expect(savedLedger?.findings.some((f) => f.title === 'Hallucinated critical finding')).toBe(false);
      const anomaly = savedLedger?.reviewerAnomalies?.find((a) => a.sourceRawFindingIds.some((id) => id.endsWith(':raw-hallucinated')));
      expect(anomaly?.kind).toBe('quote-mismatch');
      expect(anomaly?.promotedFindingId).toBeUndefined();
      expect(harness.savedValidationReports).toHaveLength(1);
      const report = harness.savedValidationReports[0] as { rawAdmissionRejections?: Array<{ rawFindingId: string; reason: string }> };
      expect(report.rawAdmissionRejections).toHaveLength(1);
      expect(report.rawAdmissionRejections?.[0]?.rawFindingId).toContain('raw-hallucinated');
      // codex 検証ブロッカー#2 以降、admission は location の実在ではなく検証可能な
      // 証跡（source_quote の verbatimExcerpt 一致）の有無で判定する — 実在しても
      // 引用が無ければ不採用。理由文言もそれを述べる。
      expect(report.rawAdmissionRejections?.[0]?.reason).toContain('no verifiable source_quote evidence');
    });

    it('Given an existing critical open finding whose stored location does not exist When the manager invalidates it from the engine-offered candidate list Then it becomes invalidated and drops out of the blocking open set', async () => {
      const criticalFinding = makeFinding({ revision: 1,
        id: 'F-0012',
        severity: 'critical',
        title: 'Hallucinated critical finding',
        location: 'src/does-not-exist.ts:5',
        rawFindingIds: ['raw-existing'],
      });
      const ledger = makeLedger({ nextId: 13, findings: [criticalFinding] });
      const harness = makeHarness(ledger);

      executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
        // 候補リストに F-0012 が挙げられていることを確認してから invalidate する。
        if (!instruction.includes('F-0012')) {
          throw new Error('Test setup error: F-0012 not offered as an invalidate candidate');
        }
        return {
          status: 'done',
          content: '',
          structuredOutput: {
            rawDecisions: [],
            disputeDecisions: [],
            conflictDecisions: [],
            invalidateDecisions: [{ findingId: 'F-0012', evidence: 'Confirmed the cited file does not exist in the reviewed code.' }],
            duplicateDecisions: [],
            dismissDecisions: [],
          },
        } as unknown as AgentResponse;
      });

      const result = await harness.run({ reviewerRawFindings: [] });

      expect(result.status).toBe('updated');
      expect(executeAgentMock).toHaveBeenCalledTimes(1);
      const savedLedger = harness.currentLedger();
      const finding = savedLedger?.findings.find((f) => f.id === 'F-0012');
      expect(finding?.status).toBe('invalidated');
      expect(finding?.lifecycle).toBe('invalidated');
      expect(finding?.invalidatedEvidence).toContain('does not exist');

      const ruleContext = buildFindingsRuleContext(savedLedger!);
      expect(ruleContext.open.count).toBe(0);
    });

    // 保存直前の再照合（freshAssembly）は invalidate 候補を fresh 台帳・現 cwd で
    // 再計算する。初回判断の時点では不在だったファイルが保存時には存在する
    // （並列子の生成物や fix ステップの成果物）とき、stale な invalidate を
    // そのまま適用せず不採用として検証レポートに残す。
    it('Given the invalidated location becomes valid between the manager judgment and the save When run Then the stale invalidate is rejected and the finding stays open', async () => {
      const candidateFinding = makeFinding({ revision: 1,
        id: 'F-0012',
        title: 'Location appears later',
        location: 'src/appears-later.ts:2',
        rawFindingIds: ['raw-existing'],
      });
      const ledger = makeLedger({ nextId: 13, findings: [candidateFinding] });
      const harness = makeHarness(ledger);

      executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
        if (!instruction.includes('F-0012')) {
          throw new Error('Test setup error: F-0012 not offered as an invalidate candidate');
        }
        // LLM 呼び出し中にファイルが生まれる（初回候補計算の後・保存の前）。
        writeFileSync(join(projectDir, 'src/appears-later.ts'), 'line 1\nline 2\nline 3\n');
        return {
          status: 'done',
          content: '',
          structuredOutput: {
            rawDecisions: [],
            disputeDecisions: [],
            conflictDecisions: [],
            invalidateDecisions: [{ findingId: 'F-0012', evidence: 'The cited file does not exist in the reviewed code.' }],
            duplicateDecisions: [],
            dismissDecisions: [],
          },
        } as unknown as AgentResponse;
      });

      const result = await harness.run({ reviewerRawFindings: [] });

      expect(result.status).toBe('updated');
      const savedLedger = harness.currentLedger();
      const finding = savedLedger?.findings.find((f) => f.id === 'F-0012');
      expect(finding?.status).toBe('open');
      expect(finding?.invalidatedEvidence).toBeUndefined();

      // stale な invalidate は staleRejections として検証レポートに残る。
      expect(harness.savedValidationReports).toHaveLength(1);
      const report = harness.savedValidationReports[0] as {
        ledgerUpdated: boolean;
        attempts: Array<{ validationErrors: string[] }>;
      };
      expect(report.ledgerUpdated).toBe(true);
      const errors = report.attempts.flatMap((attempt) => attempt.validationErrors).join(' ');
      expect(errors).toContain('F-0012');
      expect(errors).toContain('did not confirm');
    });

    it('Given the manager tries to invalidate a finding NOT in the engine-offered candidate list When assembled Then it is rejected (LLM claim alone is not enough)', () => {
      // 対象 finding の location は実在する（=候補集合に含まれない）ため、
      // manager が invalidate を主張しても採用されない。
      const validFinding = makeFinding({ revision: 1, id: 'F-0001', location: 'src/a.ts:10' });
      const ledger = makeLedger({ findings: [validFinding] });
      const result = assembleManagerOutput({
        previousLedger: ledger,
        residualRawFindings: [],
        decisions: makeDecisions({
          invalidateDecisions: [{ findingId: 'F-0001', evidence: 'I think this is fake.' }],
        }),
        // eligibleFindingIds は空 — エンジンはこの finding を候補として提示していない。
        invalidLocationCandidateFindingIds: new Set(),
      });
      expect(result.output.invalidatedFindings).toEqual([]);
      expect(result.rejectedInvalidateDecisions).toHaveLength(1);
      expect(result.rejectedInvalidateDecisions[0]?.reason).toContain('did not confirm');
    });

    it('Given a critical finding invalidate decision within the candidate set When assembled and reconciled Then critical severity does not block invalidation (unlike waive)', () => {
      const criticalFinding = makeFinding({ revision: 1, id: 'F-0012', severity: 'critical' });
      const ledger = makeLedger({ nextId: 13, findings: [criticalFinding] });
      const assembly = assembleManagerOutput({
        previousLedger: ledger,
        residualRawFindings: [],
        decisions: makeDecisions({
          invalidateDecisions: [{ findingId: 'F-0012', evidence: 'src/a.ts:10 does not exist' }],
        }),
        invalidLocationCandidateFindingIds: new Set(['F-0012']),
      });
      expect(assembly.rejectedInvalidateDecisions).toEqual([]);
      expect(assembly.output.invalidatedFindings).toEqual([{ findingId: 'F-0012', evidence: 'src/a.ts:10 does not exist' }]);

      const next = reconcileFindingLedger({
        previousLedger: ledger,
        rawFindings: [],
        managerOutput: assembly.output,
        context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-10T00:00:00.000Z' },
      });
      expect(next.findings.find((f) => f.id === 'F-0012')?.status).toBe('invalidated');
    });

    // B2: 明示参照付き raw（relation persists/reopened）は、manager の判断が再問い
    // 合わせ後もなお不採用のとき、エンジンの「強制 new 化」フォールバックの対象に
    // ならない。強制すると根拠不成立の再報告が新規 finding として台帳に混入する。
    it('Given a relation "persists" raw targeting a non-open finding When run Then it goes through the ambiguous ladder and lands as a gate-blocking provisional (never forced to new)', async () => {
      // 対象 F-0001 を resolved にして、persists の機械分類（open target 前提）に
      // 掛からず manager 送りになるようにする。
      const ledger = makeLedger({
        findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved', location: 'src/real.ts:2' })],
      });
      const harness = makeHarness(ledger);

      // manager は2回とも 'new' を返す（B2 で reject される判断）。
      executeAgentMock.mockImplementation(async (_persona: string, instruction: string) => {
        const match = /"rawFindingId":\s*"([^"]+)"/.exec(instruction);
        const rawFindingId = match?.[1];
        if (rawFindingId === undefined) {
          throw new Error('Test setup error: rawFindingId not found in manager instruction');
        }
        return {
          status: 'done',
          content: '',
          structuredOutput: {
            rawDecisions: [{ rawFindingId, decision: 'new', findingId: '', evidence: 'Treating it as fresh.' }],
            disputeDecisions: [],
            conflictDecisions: [],
            invalidateDecisions: [],
            duplicateDecisions: [],
            dismissDecisions: [],
          },
        } as unknown as AgentResponse;
      });

      const result = await harness.run({
        reviewerRawFindings: [{
          rawFindingId: 'p-1',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue still present',
          description: 'Claims the already-resolved F-0001 still persists.',
          suggestion: '',
          relation: 'persists',
          targetFindingId: 'F-0001',
          // 機械照合済み evidence（typed evidence protocol、codex 対策#4）で
          // admission を通し、この試験の主眼（ambiguous ladder が manager の
          // 壊れた応答をどう扱うか）を admission gate と独立に検証できるようにする。
          ...verifiedSourceQuoteFields(projectDir, 'src/real.ts', 2),
        }],
      });

      expect(result.status).toBe('updated');
      // 対象が open でない persists は ambiguous（persists-target-not-open）と
      // して解釈フェーズへ進む。decisions manager は呼ばれない（clean residual 0）。
      // この mock は decisions 形しか返さないため解釈 parse に失敗し、raw は
      // provisional として着地する（強制 new 化も drop もされない）。
      expect(executeAgentMock).toHaveBeenCalledTimes(1);
      const savedLedger = harness.currentLedger();
      expect(savedLedger?.findings.find((f) => f.id === 'F-0001')?.status).toBe('resolved');
      const landed = savedLedger?.findings.find((f) => f.title === 'Existing issue still present');
      expect(landed?.status).toBe('open');
      expect(landed?.provisional).toMatchObject({ kind: 'raw-meaning-ambiguous', gateEffect: 'block' });
      // 監査記録: 先行保存（write-ahead の正規化監査）+ 最終保存の2件。最終保存に
      // provisionalLandings が残る。
      expect(harness.savedValidationReports).toHaveLength(2);
      const report = harness.savedValidationReports.at(-1) as {
        provisionalLandings?: Array<{ kind: string; reason: string; sourceRawFindingIds: string[] }>;
      };
      expect(report.provisionalLandings?.some((landing) => (
        landing.sourceRawFindingIds.some((id) => id.includes('p-1'))
      ))).toBe(true);
    });
  });
});
