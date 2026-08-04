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

const REVIEWER_STRUCTURED_OUTPUT = { schemaRef: 'test.raw-findings', schema: { type: 'object' } };
// codex 対策#4: 本物の reviewer context では WorkflowEngineSetup が
// rawFindingsStructuredOutput と同時に必ず設定する（snapshot.ts の
// computeReviewScopeSnapshotId）。ここでは実際のハッシュ形状は問わないため
// 固定文字列を使う。
const REVIEWER_SNAPSHOT_ID = 'snap-test-0000000000000000000000000000000000000000000000000000000000000000';

describe('buildFindingContractInstruction', () => {
  it('never emits blank-line runs left behind by unused conditional blocks', () => {
    for (const language of ['en', 'ja'] as const) {
      for (const contract of [
        {},
        { hasOpenFindings: true },
        { rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT, reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID },
        {
          rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT,
          reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
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
        contract: { rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT, reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID },
        language: 'ja',
      });
      expect(rendered).not.toContain('統合台帳のコピー');
      expect(rendered).toContain('構造化 raw finding として報告してください');
    });

    it('does not inject the dispute guide into reviewers', () => {
      const rendered = build({
        contract: { rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT, reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID, hasOpenFindings: true },
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

    // rawFindingId / familyTag / relation / targetFindingId は manager-runner /
    // manager-output-validation が英語リテラルで照合する raw finding のフィールド名。
    // ja テンプレートでも英語のまま出ることを確認する。
    it('keeps raw finding protocol field names in English for ja', () => {
      const rendered = build({
        contract: {
          rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT,
          reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
          hasOpenFindings: true,
          hasWaivedFindings: true,
        },
        language: 'ja',
      });
      expect(rendered).toContain('rawFindingId');
      expect(rendered).toContain('familyTag');
      expect(rendered).toContain('relation');
      expect(rendered).toContain('targetFindingId');
    });

    it('instructs reviewers to reopen dismissed findings in both languages', () => {
      const en = build({
        contract: {
          rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT,
          reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
          hasDismissedFindings: true,
        },
      });
      const ja = build({
        contract: {
          rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT,
          reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
          hasDismissedFindings: true,
        },
        language: 'ja',
      });

      expect(en).toContain('listed as dismissed');
      expect(en).toContain('relation "reopened"');
      expect(ja).toContain('dismissed になっている指摘');
      expect(ja).toContain('relation を "reopened"');
    });

    it('requires current exact single-range evidence for resolution confirmations in both languages', () => {
      const contract = {
        rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT,
        reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
        hasOpenFindings: true,
      };
      const en = build({ contract });
      const ja = build({ contract, language: 'ja' });

      expect(en).toContain('exactly one contiguous location');
      expect(en).toContain('exactly matches the complete current text');
      expect(en).toContain(REVIEWER_SNAPSHOT_ID);
      expect(ja).toContain('単一連続範囲');
      expect(ja).toContain('現在の全文と完全一致');
      expect(ja).toContain(REVIEWER_SNAPSHOT_ID);
    });
  });

  // codex 対策#4 の配線バグ回帰: rawFindingsStructuredOutput（reviewer step の目印）が
  // 立っているのに reviewScopeSnapshotId が欠落したまま `?? ''` でサイレントに
  // 空文字へ落ちると、reviewer は空の snapshotId を source_quote evidence に
  // echo し、manager 側の決定的検証（verifySourceQuoteEvidence）が必ず
  // stale-snapshot で弾く。ParallelRunner が instruction context を inline で
  // 複製していたために実際に発生した配線バグであり、このガードはその再発を防ぐ。
  describe('reviewScopeSnapshotId wiring guard', () => {
    it('throws when a reviewer contract is missing reviewScopeSnapshotId entirely', () => {
      expect(() => build({ contract: { rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT } }))
        .toThrow(/reviewScopeSnapshotId/);
    });

    it("throws when a reviewer contract has an empty-string reviewScopeSnapshotId (the pre-fix `?? ''` fallback shape)", () => {
      expect(() => build({
        contract: { rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT, reviewScopeSnapshotId: '' },
      })).toThrow(/reviewScopeSnapshotId/);
    });

    it('does not throw for non-reviewer contracts even without reviewScopeSnapshotId', () => {
      expect(() => build({ contract: {} })).not.toThrow();
      expect(() => build({ contract: { hasOpenFindings: true } })).not.toThrow();
    });

    it('does not throw for a correctly wired reviewer contract', () => {
      expect(() => build({
        contract: { rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT, reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID },
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
      reportLedgerSummary: { ids: ['F-0001'] },
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
  function openFinding(id: string, title: string, location?: string): FindingLedgerEntry {
    return {
      id,
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: 'medium',
      title,
      ...(location !== undefined ? { location } : {}),
      reviewers: ['coding-review'],
      rawFindingIds: [`raw-${id}`],
      firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
      lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    };
  }

  function ledgerWith(findings: FindingLedgerEntry[]): FindingLedger {
    return {
      workflowName: 'peer-review',
      nextId: findings.length + 1,
      updatedAt: '2026-07-01T00:00:00.000Z',
      rawFindings: [],
      conflicts: [],
      interpretations: [],
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
          ledgerPath: '.takt/findings/peer-review.json',
          rawFindingsPath: '.takt/findings/raw',
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
      expect(instruction).not.toContain('ledger copy path');
      expect(instruction).not.toContain('Raw findings path');
      expect(instruction).not.toContain('sqlite-run://');
    });
  });
});
