import { describe, expect, it } from 'vitest';
import {
  buildFindingContractInstruction,
  buildFindingContractReportInstruction,
} from '../core/workflow/instruction/finding-contract-instruction.js';
import type { FindingContractInstructionContext } from '../core/workflow/instruction/instruction-context.js';
import {
  buildManagerInstruction,
  collectDuplicateLocusGroups,
} from '../core/workflow/findings/manager-agent.js';
import {
  PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION,
} from '../core/workflow/findings/manager-raw-decision-adapter.js';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';

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

    // relation / targetFindingId は manager-runner / manager-output-validation が
    // 英語リテラルで照合する raw finding のフィールド名。ja テンプレートでも
    // 英語のまま出ることを確認する。
    it('keeps raw finding protocol field names in English for ja', () => {
      const rendered = build({
        contract: {
          reviewer: REVIEWER,
          hasOpenFindings: true,
          hasWaivedFindings: true,
        },
        language: 'ja',
      });
      expect(rendered).toContain('relation');
      expect(rendered).toContain('targetFindingId');
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
      expect(en).toContain('relation "reopened"');
      expect(ja).toContain('dismissed になっている指摘');
      expect(ja).toContain('relation を "reopened"');
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
          reviewer: {
            ...REVIEWER,
            presentationContext: {
              revision: 2,
              reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
              restatementRequests: [{ anomalyId: 'A-1' }],
            },
          },
          hasOpenFindings: true,
        } as never,
      });
      expect(rendered).toContain('## Restatement requests');
      expect(rendered).not.toContain('Write an ordinary Markdown review report');
      expect(rendered).not.toContain('Each round, verify the open ledger findings');
      expect(rendered).not.toContain('{{');
      // severity 欠落こそが再提示ループの原因なので、明記要求は再提示ラウンドでも残す。
      expect(rendered).toContain('State a short title and a severity');
    });

    it('keeps the severity requirement in a restatement-only round for ja as well', () => {
      const rendered = build({
        contract: {
          reviewer: {
            ...REVIEWER,
            presentationContext: {
              revision: 2,
              reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
              restatementRequests: [{ anomalyId: 'A-1' }],
            },
          },
          hasOpenFindings: true,
        } as never,
        language: 'ja',
      });
      expect(rendered).toContain('## Restatement requests');
      expect(rendered).toContain('severity');
      expect(rendered).not.toContain('通常の Markdown レビュー報告を書いてください');
      expect(rendered).not.toContain('{{');
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

    it('provisional と closed の finding はグループ対象にしない', () => {
      const provisional = {
        ...openFinding('F-0001', '暫定', 'src/a.ts:1'),
        provisional: {
          kind: 'unverified-locationless' as const,
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
