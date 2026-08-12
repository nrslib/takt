import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFindingContractInstruction,
  buildFindingContractReportInstruction,
} from '../core/workflow/instruction/finding-contract-instruction.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { makeStep } from './test-helpers.js';
import type { FindingContractInstructionContext } from '../core/workflow/instruction/instruction-context.js';
import {
  buildManagerInstruction,
  collectDuplicateLocusGroups,
} from '../core/workflow/findings/manager-agent.js';
import {
  PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION,
} from '../core/workflow/findings/manager-raw-decision-adapter.js';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';
import {
  computeRestatementRequestId,
  createFindingReviewPresentationContextV2,
} from '../core/workflow/findings/review-publication.js';

const renderFencedJsonBlock = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function makeContract(overrides: Partial<FindingContractInstructionContext> = {}): FindingContractInstructionContext {
  return {
    ledgerSummary: { findings: [] },
    hasOpenFindings: false,
    hasWaivedFindings: false,
    hasDismissedFindings: false,
    ...overrides,
  };
}

function build(overrides: {
  contract?: Partial<FindingContractInstructionContext>;
  language?: 'ja' | 'en';
} = {}): string {
  return buildFindingContractInstruction({
    contract: makeContract(overrides.contract),
    language: overrides.language ?? 'en',
    renderFencedJsonBlock,
  });
}

function buildReport(overrides: {
  contract?: Partial<FindingContractInstructionContext>;
  language?: 'ja' | 'en';
} = {}): string {
  return buildFindingContractReportInstruction({
    contract: makeContract(overrides.contract),
    language: overrides.language ?? 'en',
    renderFencedJsonBlock,
  });
}

// codex 対策#4: 本物の reviewer context では WorkflowEngineSetup が
// reviewScopeSnapshotId を必ず設定する（snapshot.ts の
// computeReviewScopeSnapshotId）。ここでは実際のハッシュ形状は問わないため
// 固定文字列を使う。
const REVIEWER_SNAPSHOT_ID = 'snap-test-0000000000000000000000000000000000000000000000000000000000000000';
const REVIEWER = {
  reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
};

/**
 * 実型の再提示 request で presentationContext を組む。`as never` の部分 fixture は
 * 必須項目と restatementRequestId の整合（buildFindingContractInstruction が検証する）
 * を型検査からも実行時からも落としてしまう。
 */
function restatementPresentationContext() {
  const requestWithoutId = {
    anomalyId: 'RA-RESTATEMENT',
    reviewer: 'architecture-review',
    presentationOrdinal: 1,
    reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
    sourceExcerptDigest: '2'.repeat(64),
    claimedExcerpt: 'A bounded reviewer claim.',
    targetPaths: [] as const,
    missingRequirements: [] as const,
    expectedRelation: 'new' as const,
    expectedTargetFindingId: null,
    expectedTargetPreconditionClass: 'absent' as const,
  };
  return createFindingReviewPresentationContextV2({
    reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
    restatementRequests: [{
      ...requestWithoutId,
      restatementRequestId: computeRestatementRequestId(requestWithoutId),
    }],
  });
}

describe('buildFindingContractInstruction', () => {
  it('never emits blank-line runs left behind by unused conditional blocks', () => {
    for (const language of ['en', 'ja'] as const) {
      for (const contract of [
        {},
        { hasOpenFindings: true },
        { reviewer: REVIEWER },
        {
          reviewer: REVIEWER,
          hasOpenFindings: true,
          hasWaivedFindings: true,
          hasDismissedFindings: true,
        },
      ]) {
        const rendered = build({ contract, language });
        expect(rendered, `${language} ${JSON.stringify(contract)}`).not.toMatch(/\n{3}/);
        expect(rendered.startsWith('## Finding Contract')).toBe(true);
      }
    }
  });

  describe('reviewer instruction', () => {
    it('localizes the reviewer prose for ja', () => {
      const rendered = build({
        contract: { reviewer: REVIEWER },
        language: 'ja',
      });
      expect(rendered).not.toContain('統合台帳のコピー');
      expect(rendered).toContain('通常の Markdown レビュー報告を書いてください');
    });

    it('asks every reviewer for ordinary explicit prose without output schemas', () => {
      for (const language of ['en', 'ja'] as const) {
        for (const render of [build, buildReport]) {
          const rendered = render({
            contract: {
              reviewer: REVIEWER,
              hasOpenFindings: true,
            },
            language,
          });
          expect(rendered).toMatch(/ordinary Markdown|通常の Markdown/u);
          expect(rendered).toMatch(/isolated extractor|隔離された抽出器/u);
          expect(rendered).toContain('resolution_confirmation');
          expect(rendered).toMatch(/architectural|アーキテクチャ上/u);
          expect(rendered).not.toContain('raw findings schema');
          expect(rendered).not.toContain('structured output matching');
        }
      }
    });

    // 呼び出し側の mode だけが「言い直しのみ」を決める。request 件数から導出すると、
    // 言い直し request 付きの完全な再レビューが言い直し専用指示に化け、その
    // publication で後続レビュー成立による取り下げが未検証のまま走る。
    it('keeps the ordinary review guidance when restatement requests ride along a full review', () => {
      for (const [language, reviewFragment, alongsideFragment] of [
        ['en', 'Write an ordinary Markdown review report', 'Alongside the review you are asked to perform'],
        ['ja', '通常の Markdown レビュー報告を書いてください', '指示されたレビューに加えて'],
      ] as ReadonlyArray<readonly ['en' | 'ja', string, string]>) {
        const rendered = build({
          contract: {
            reviewer: {
              ...REVIEWER,
              presentationContext: restatementPresentationContext(),
              mode: 'review',
            },
            hasOpenFindings: true,
          },
          language,
        });

        expect(rendered, language).toContain('## Restatement requests');
        expect(rendered, language).toContain('RA-RESTATEMENT');
        expect(rendered, language).toContain(reviewFragment);
        expect(rendered, language).toContain(alongsideFragment);
        // 「これは再提示専用レビューです」は出さない。
        expect(rendered, language).not.toMatch(/restatement-only review|再提示専用レビュー/u);
      }
    });

    it('omits the restatement section entirely when a review carries no requests', () => {
      const rendered = build({
        contract: { reviewer: { ...REVIEWER, mode: 'review' }, hasOpenFindings: true },
      });

      expect(rendered).not.toContain('## Restatement requests');
      expect(rendered).toContain('Write an ordinary Markdown review report');
    });

    it('does not inject the dispute guide into reviewers', () => {
      const rendered = build({
        contract: { reviewer: REVIEWER, hasOpenFindings: true },
      });
      expect(rendered).not.toContain('Disputed Findings');
    });

    // provisional は fixer が直接直せない system finding であることを明示する
    // （解釈梯子の配線要件）。
    it('explains provisional findings as unfixable system findings in both languages', () => {
      const en = build({ contract: { hasOpenFindings: true }, language: 'en' });
      expect(en).toContain('provisional');
      expect(en).toContain('system findings');

      const ja = build({ contract: { hasOpenFindings: true }, language: 'ja' });
      expect(ja).toContain('provisional');
      expect(ja).toContain('system finding');
    });

    // lifecycle の語は normalizer が報告本文から literal token として拾う契約値。
    // ja テンプレートでも英語のまま出ること、かつ「同じ文に finding ID を書く」
    // という抽出条件が併記されることを確認する（離すと新規指摘として読まれる）。
    it('keeps lifecycle protocol tokens in English for ja and demands one contiguous sentence', () => {
      const rendered = build({
        contract: {
          reviewer: REVIEWER,
          hasOpenFindings: true,
          hasWaivedFindings: true,
        },
        language: 'ja',
      });
      expect(rendered).toContain('`persists`');
      expect(rendered).toContain('`resolution_confirmation`');
      expect(rendered).toContain('`reopened`');
      expect(rendered).toContain('途切れのない同じ文');
    });

    // reviewer は観察専任なので、normalizer 内部の wire フィールドを書かせない。
    it('never asks the reviewer to fill normalizer wire fields', () => {
      for (const language of ['en', 'ja'] as const) {
        const rendered = build({
          contract: {
            reviewer: { ...REVIEWER, presentationContext: restatementPresentationContext() },
            hasOpenFindings: true,
            hasWaivedFindings: true,
            hasDismissedFindings: true,
          },
          language,
        });
        expect(rendered, language).not.toContain('targetFindingId');
        expect(rendered, language).not.toContain('file_quote');
        expect(rendered, language).not.toContain('verbatimExcerpt');
      }
    });

    it('instructs reviewers to reopen dismissed findings in both languages', () => {
      const en = build({
        contract: {
          reviewer: REVIEWER,
          hasDismissedFindings: true,
        },
      });
      const ja = build({
        contract: {
          reviewer: REVIEWER,
          hasDismissedFindings: true,
        },
        language: 'ja',
      });

      expect(en).toContain('listed as dismissed');
      expect(en).toContain('that dismissed finding ID and `reopened` in the same sentence');
      expect(ja).toContain('dismissed になっている指摘');
      expect(ja).toContain('dismissed finding ID と `reopened` を同じ文に');
    });

    it('never asks reviewers for structured output or echoes the review scope snapshot', () => {
      for (const language of ['en', 'ja'] as const) {
        for (const render of [build, buildReport]) {
          const rendered = render({
            contract: {
              reviewer: REVIEWER,
              hasOpenFindings: true,
              hasWaivedFindings: true,
              hasDismissedFindings: true,
            },
            language,
          });
          expect(rendered).not.toContain(REVIEWER_SNAPSHOT_ID);
          expect(rendered).not.toContain('rawFindingId');
          expect(rendered).not.toContain('rawExcerpt');
          expect(rendered).not.toContain('proofId');
          expect(rendered).not.toContain('structured raw finding');
        }
      }
    });

    // 再提示専用ラウンドは request だけを処理する。通常のレビュー指示が同時に
    // 出ると「observe した問題をすべて報告せよ」と矛盾する。
    it('suppresses the ordinary reviewer guidance during a restatement-only round', () => {
      const rendered = build({
        contract: {
          reviewer: { ...REVIEWER, presentationContext: restatementPresentationContext(), mode: 'restatement-only' as const },
          hasOpenFindings: true,
        },
      });
      expect(rendered).toContain('## Restatement requests');
      expect(rendered).not.toContain('Write an ordinary Markdown review report');
      expect(rendered).not.toContain('Each round, verify the open ledger findings');
      expect(rendered).not.toContain('{{');
      // レビュアーは観察専任。分類は正規化係が付けるので、言い直し枠でも severity を
      // 書かせない（書かせた結果が事務欠落による anomaly 量産だった）。
      expect(rendered).toContain('Do not state a severity');
    });

    it('forbids reviewer-side classification in a restatement-only round for ja as well', () => {
      const rendered = build({
        contract: {
          reviewer: { ...REVIEWER, presentationContext: restatementPresentationContext(), mode: 'restatement-only' as const },
          hasOpenFindings: true,
        },
        language: 'ja',
      });
      expect(rendered).toContain('## Restatement requests');
      expect(rendered).toContain('severity・重大度ラベル・問題系列タグは書かないでください');
      expect(rendered).not.toContain('通常の Markdown レビュー報告を書いてください');
      expect(rendered).not.toContain('{{');
    });

    // 実走行(2026-08)の計測: 言い直しの失敗 263 件中 210 件(80%)が「claim atom を
    // 書き直した」ことによる correspondence 不成立で、engine は description を
    // claimedExcerpt と完全一致で照合する。この逐語コピー規則が prompt から
    // 落ちると受理率はベースラインへ戻る(eval result-set `final`, n=20/arm,
    // output contract 同梱: baseline-ja 10% → shipped-ja 70%)。
    it('states the verbatim claim-atom rule in the restatement round', () => {
      for (const [language, expected] of [
        ['ja', [
          '1文字も変えずにコピー',
          '完全一致で照合',
          '要約・言い換え・行番号の追記',
        ]],
        ['en', [
          'copied character for character',
          'matches `Description` against `claimedExcerpt` exactly',
          'Summarising, rewording, adding line numbers',
        ]],
      ] as const) {
        const rendered = build({
          contract: {
            reviewer: { ...REVIEWER, presentationContext: restatementPresentationContext(), mode: 'restatement-only' as const },
            hasOpenFindings: true,
          },
          language,
        });
        for (const fragment of expected) {
          expect(rendered, `${language}: ${fragment}`).toContain(fragment);
        }
      }
    });

    // normalizer は label 付きの行に依存する。書式フェンスを外すと reviewer が
    // 素の散文を返し、atom を逐語で書いていても normalizer が候補を1件も
    // 抽出しない(eval a1: 20% が normalizer 側で消えた)。
    it('shows the labelled response shape fence in the restatement round', () => {
      for (const [language, expected] of [
        // プロトコルトークン（label）は ja でも英語のまま。散文だけを訳す。
        ['ja', ['### 返す形', '- **Reasserts Reviewer Anomaly ID**:', '- **Description**:', '- **Target files**:']],
        ['en', ['### Response shape', '- **Reasserts Reviewer Anomaly ID**:', '- **Description**:', '- **Target files**:']],
      ] as const) {
        const rendered = build({
          contract: {
            reviewer: { ...REVIEWER, presentationContext: restatementPresentationContext(), mode: 'restatement-only' as const },
            hasOpenFindings: true,
          },
          language,
        });
        for (const fragment of expected) {
          expect(rendered, `${language}: ${fragment}`).toContain(fragment);
        }
      }
    });

    // quote-mismatch anomaly は実測で 100% が「target.paths に無いファイルを
    // 引用した」ケース(仕様書・テスト・比較実装を根拠に挙げる)。
    // issueFindingEvidenceRequests が file_quote.path ∈ target.paths を要求する。
    /**
     * 再提示ラウンドの Phase 2 は、output contract の書式（結果行・チェック表・
     * 検証証跡）と engine の再提示規則が同じメッセージに並ぶ。再提示規則が
     * 「この応答には再提示エントリ以外を書くな」と言うと契約の必須節と正面から
     * 矛盾し、reviewer はどちらかを落とす。規則の適用範囲は
     * `## Finding Contract Claims` 節に限定されていなければならない。
     */
    it('does not contradict the output contract in the phase 2 report message', () => {
      for (const language of ['ja', 'en'] as const) {
        const contractFormat = readFileSync(
          join(
            process.cwd(),
            'builtins',
            language,
            'facets/output-contracts/security-review-finding-contract.md',
          ),
          'utf8',
        );
        const rendered = new ReportInstructionBuilder(
          makeStep({ outputContracts: [{ name: 'security-review.md', format: contractFormat }] }),
          {
            cwd: '/tmp/test',
            reportDir: '/tmp/test/reports',
            stepIteration: 1,
            language,
            targetFile: 'security-review.md',
            // ReportInstructionBuilder は本物の renderFencedJsonBlock を使うので、
            // このファイル冒頭のスタブと違い reportLedgerSummary の欠落を許さない。
            findingContract: makeContract({
              reportLedgerSummary: '[]',
              reviewer: { ...REVIEWER, presentationContext: restatementPresentationContext(), mode: 'restatement-only' as const },
              hasOpenFindings: true,
            }),
          },
        ).build();

        // 契約側の必須節が消えていない。
        expect(rendered, language).toContain('## Finding Contract Claims');
        expect(rendered, language).toContain(language === 'ja' ? '## 結果: APPROVE / REJECT' : '## Result: APPROVE / REJECT');
        expect(rendered, language).toContain(language === 'ja' ? '## 検証証跡' : '## Verification Evidence');

        // 再提示規則が Claims 節に限定されている。
        expect(rendered, language).toContain(
          language === 'ja'
            ? '`## Finding Contract Claims` 節には下の再提示エントリだけを書いてください'
            : 'put only the restatement entries below in its `## Finding Contract Claims` section',
        );

        // 応答全体を再提示エントリだけに絞る全面禁止が復活していない。
        expect(rendered, language).not.toContain('Write nothing in this response except');
        expect(rendered, language).not.toContain('この応答には下の再提示エントリ以外を書かないでください');
        expect(rendered, language).not.toMatch(/チェック表の記入もしないで|do not fill in checklist tables/u);

        // 逐語コピー規則は Phase 2 でも生きている。
        expect(rendered, language).toMatch(/1文字も変えずにコピー|copied character for character/u);
      }
    });

    it('states the quote/target coupling rule in the restatement round', () => {
      for (const [language, expected] of [
        ['ja', ['引用するファイルは必ず `Target files` にも列挙', '対象と無関係とみなし']],
        ['en', ['must also be listed under `Target files`', 'unrelated to the target']],
      ] as const) {
        const rendered = build({
          contract: {
            reviewer: { ...REVIEWER, presentationContext: restatementPresentationContext(), mode: 'restatement-only' as const },
            hasOpenFindings: true,
          },
          language,
        });
        for (const fragment of expected) {
          expect(rendered, `${language}: ${fragment}`).toContain(fragment);
        }
      }
    });
  });

  // codex 対策#4 の配線バグ回帰: rawFindingsStructuredOutput（reviewer step の目印）が
  // 立っているのに reviewScopeSnapshotId が欠落したまま `?? ''` でサイレントに
  // 空文字へ落ちると、reviewer は空の snapshotId を file_quote evidence に
  // echo し、manager 側の決定的検証（verifyFileQuoteEvidence）が必ず
  // stale-snapshot で弾く。ParallelRunner が instruction context を inline で
  // 複製していたために実際に発生した配線バグであり、このガードはその再発を防ぐ。
  describe('reviewScopeSnapshotId wiring guard', () => {
    it('throws when a reviewer contract is missing reviewScopeSnapshotId entirely', () => {
      expect(() => build({ contract: { reviewer: { ...REVIEWER, reviewScopeSnapshotId: undefined as never } } }))
        .toThrow(/reviewScopeSnapshotId/);
    });

    it("throws when a reviewer contract has an empty-string reviewScopeSnapshotId (the pre-fix `?? ''` fallback shape)", () => {
      expect(() => build({
        contract: { reviewer: { ...REVIEWER, reviewScopeSnapshotId: '' } },
      })).toThrow(/reviewScopeSnapshotId/);
    });

    it('does not throw for non-reviewer contracts even without reviewScopeSnapshotId', () => {
      expect(() => build({ contract: {} })).not.toThrow();
      expect(() => build({ contract: { hasOpenFindings: true } })).not.toThrow();
    });

    it('does not throw for a correctly wired reviewer contract', () => {
      expect(() => build({
        contract: { reviewer: REVIEWER },
      })).not.toThrow();
    });
  });

  describe('dispute guide', () => {
    it('is injected only when open findings exist', () => {
      expect(build()).not.toContain('Disputed Findings');
      expect(build({ contract: { hasOpenFindings: true } })).toContain('## Disputed Findings');
    });

    // 見出しとフィールド名は hasDisputeClaimsHeading() / hasDisputeClaimFor() が
    // 英語リテラルで照合する。ja でも英語のまま出さないと異議申告が成立しない。
    it('keeps the protocol tokens in English for ja while translating the prose', () => {
      const rendered = build({ contract: { hasOpenFindings: true }, language: 'ja' });
      expect(rendered).toContain('## Disputed Findings');
      expect(rendered).toContain('findingId:');
      expect(rendered).toContain('reason:');
      expect(rendered).toContain('evidence:');
      expect(rendered).toContain('見出しとフィールド名は英語のまま書いてください');
      expect(rendered).toContain('critical な指摘は決して waive できません');
    });

    it('tells the coder to dispute when the remedy is a forbidden operation', () => {
      expect(build({ contract: { hasOpenFindings: true } })).toContain('a remedy you are forbidden to perform');
      expect(build({ contract: { hasOpenFindings: true }, language: 'ja' })).toContain('実行を禁じられている操作');
    });
  });
});

describe('buildFindingContractReportInstruction', () => {
  function buildReport(language: 'ja' | 'en'): string {
    return buildFindingContractReportInstruction({
      contract: {
        ledgerSummary: { findings: [] },
        reportLedgerSummary: { ids: ['F-0001'] },
        hasOpenFindings: false,
        hasWaivedFindings: false,
        hasDismissedFindings: false,
      },
      language,
      renderFencedJsonBlock,
    });
  }

  it('never emits blank-line runs and starts with the Finding Contract heading', () => {
    for (const language of ['en', 'ja'] as const) {
      const rendered = buildReport(language);
      expect(rendered, language).not.toMatch(/\n{3}/);
      expect(rendered.startsWith('## Finding Contract')).toBe(true);
    }
  });

  it('does not inject reviewer or dispute guidance in the report phase', () => {
    for (const language of ['en', 'ja'] as const) {
      const rendered = buildReport(language);
      expect(rendered, language).not.toContain('Disputed Findings');
      expect(rendered, language).not.toContain('raw findings schema');
      expect(rendered, language).not.toContain('resolution_confirmation');
    }
  });

  it('uses the report-phase wording (inline ledger summary / ledger IDs)', () => {
    const en = buildReport('en');
    expect(en).toContain('Use existing finding IDs from the inline ledger summary');
    expect(en).toContain('Current finding ledger IDs:');

    const ja = buildReport('ja');
    expect(ja).toContain('インラインの台帳サマリ');
    expect(ja).toContain('現在の台帳 finding ID:');
  });
});

describe('manager instruction dedup (manager-agent.ts)', () => {
  const locationsByFindingId = new Map<string, string>();

  function openFinding(id: string, title: string, location?: string): FindingLedgerEntry {
    if (location !== undefined) locationsByFindingId.set(id, location);
    return {
      id,
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: 'medium',
      title,
      evidenceIds: location === undefined ? [] : [`evidence-${id}`],
      reviewers: ['coding-review'],
      rawFindingIds: [`raw-${id}`],
      firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    };
  }

  function ledgerWith(findings: FindingLedgerEntry[]): FindingLedger {
    const evidenceRecords = findings.flatMap((finding) => {
      const location = locationsByFindingId.get(finding.id);
      const match = location === undefined ? null : /^(.*):(\d+)(?:-(\d+))?$/.exec(location);
      if (match === null) return [];
      return [{
        evidenceId: `evidence-${finding.id}`,
        kind: 'file_quote' as const,
        path: match[1]!,
        startLine: Number(match[2]),
        endLine: Number(match[3] ?? match[2]),
        verbatimExcerpt: 'fixture',
        snapshotId: 'a'.repeat(64),
        claimIdentityHash: 'b'.repeat(64),
        fileHash: 'c'.repeat(64),
      }];
    });
    return {
      workflowName: 'peer-review',
      nextId: findings.length + 1,
      updatedAt: '2026-07-01T00:00:00.000Z',
      evidenceRecords,
      rawFindings: [],
      conflicts: [],
      findings,
    };
  }

  describe('collectDuplicateLocusGroups', () => {
    it('同一ファイルを引用する open finding が2件以上あるときグループとして抽出する（行範囲形式も同一ファイル扱い）', () => {
      const groups = collectDuplicateLocusGroups(ledgerWith([
        openFinding('F-0001', 'RFC 3339 の小数秒をミリ秒へ丸めて履歴順を逆転させる', 'src/core/models/rfc3339.ts:40'),
        openFinding('F-0002', 'RFC 3339 のミリ秒未満を失い裁定履歴の実時間順が逆転する', 'src/core/models/rfc3339.ts:55-60'),
        openFinding('F-0003', '別ファイルの単独指摘', 'src/core/workflow/findings/store.ts:10'),
      ]));

      expect([...groups.keys()]).toEqual(['src/core/models/rfc3339.ts']);
      expect(groups.get('src/core/models/rfc3339.ts')?.map((finding) => finding.id)).toEqual(['F-0001', 'F-0002']);
    });

    it('グループが無いときは抽出結果が空になる', () => {
      expect(collectDuplicateLocusGroups(ledgerWith([
        openFinding('F-0001', 'a', 'src/a.ts:1'),
        openFinding('F-0002', 'b', 'src/b.ts:1'),
      ])).size).toBe(0);
    });

    it.each([
      'unverified-locationless',
      'raw-meaning-ambiguous',
    ] as const)('%s provisional と closed の finding はグループ対象にしない', (kind) => {
      const provisional = {
        ...openFinding('F-0001', '暫定', 'src/a.ts:1'),
        provisional: {
          kind,
          stableKey: 's1',
          lineageKey: 'l1',
          sourceRawFindingIds: ['raw-F-0001'],
          reason: 'r',
          firstObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
          lastObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
          interpretationEpochs: 0,
          gateEffect: 'block' as const,
        },
      };
      const resolved = { ...openFinding('F-0002', '解消済み', 'src/a.ts:2'), status: 'resolved' as const };
      const open = openFinding('F-0003', 'open 単独', 'src/a.ts:3');

      expect(collectDuplicateLocusGroups(ledgerWith([provisional, resolved, open])).size).toBe(0);
    });
  });

  describe('buildManagerInstruction', () => {
    it('inlines ledger and raw findings without presenting storage references as file paths', () => {
      const instruction = buildManagerInstruction({
        contract: {
          manager: {
            persona: 'findings-manager',
            instruction: 'Reconcile findings.',
            outputContract: 'Return structured output.',
          },
        },
        previousLedger: ledgerWith([]),
        residualRawFindings: [],
        mechanicallyClassifiedCount: 0,
        invalidLocationCandidates: new Map(),
        dismissCandidates: new Map(),
      });

      expect(instruction).toContain('Previous ledger metadata:');
      expect(instruction).toContain('Raw findings:');
      expect(instruction).toContain(PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION);
      expect(instruction).not.toContain('ledger copy path');
      expect(instruction).not.toContain('Raw findings path');
      expect(instruction).not.toContain('sqlite-run://');
    });
  });
});
