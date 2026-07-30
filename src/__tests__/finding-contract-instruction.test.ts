import { describe, expect, it } from 'vitest';
import {
  buildFindingContractInstruction,
  buildFindingContractReportInstruction,
} from '../core/workflow/instruction/finding-contract-instruction.js';
import type { FindingContractInstructionContext } from '../core/workflow/instruction/instruction-context.js';

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

const REVIEWER_STRUCTURED_OUTPUT = { schemaRef: 'test.raw-findings', schema: { type: 'object' } };
// codex 対策#4: 本物の reviewer context では WorkflowEngineSetup が
// rawFindingsStructuredOutput と同時に必ず設定する（snapshot.ts の
// computeReviewScopeSnapshotId）。ここでは実際のハッシュ形状は問わないため
// 固定文字列を使う。
const REVIEWER_SNAPSHOT_ID = 'snap-test-0000000000000000000000000000000000000000000000000000000000000000';
const REVIEWER = {
  mode: 'structured' as const,
  rawFindingsStructuredOutput: REVIEWER_STRUCTURED_OUTPUT,
  reviewScopeSnapshotId: REVIEWER_SNAPSHOT_ID,
};
const FREEFORM_REVIEWER = {
  mode: 'freeform' as const,
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
      expect(rendered).toContain('構造化 raw finding として報告してください');
    });

    it('injects canonical claim grammar only for freeform reviewers in both languages', () => {
      for (const language of ['en', 'ja'] as const) {
        for (const render of [build, buildReport]) {
          const freeform = render({
            contract: { reviewer: FREEFORM_REVIEWER, hasOpenFindings: true },
            language,
          });
          expect(freeform).toContain('<!-- TAKT_FINDING_CLAIM_BEGIN -->');
          expect(freeform).toContain(
            'Relation: <new | persists | resolution_confirmation | reopened>',
          );
          expect(freeform).toContain('<!-- TAKT_FINDING_CLAIM_END -->');

          const structured = render({
            contract: { reviewer: REVIEWER, hasOpenFindings: true },
            language,
          });
          expect(structured).not.toContain('<!-- TAKT_FINDING_CLAIM_BEGIN -->');
          expect(structured).not.toContain('canonical block protocol');
          expect(structured).not.toContain('canonical block');
          expect(structured).not.toContain('typed evidence matrix');
          expect(structured).toContain('structured output');
          expect(structured).toContain('resolution_confirmation');
          expect(structured).toContain('targetFindingIds');
          expect(structured).toMatch(/one-to-one|1対1/u);
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

    // rawFindingId / familyTag / relation / targetFindingId は manager-runner /
    // manager-output-validation が英語リテラルで照合する raw finding のフィールド名。
    // ja テンプレートでも英語のまま出ることを確認する。
    it('keeps raw finding protocol field names in English for ja', () => {
      const rendered = build({
        contract: {
          reviewer: REVIEWER,
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

    it('requires current exact evidence requests without reviewer-issued proof fields in both languages', () => {
      const structuredEn = build({
        contract: { reviewer: REVIEWER, hasOpenFindings: true },
      });
      const structuredJa = build({
        contract: { reviewer: REVIEWER, hasOpenFindings: true },
        language: 'ja',
      });
      expect(structuredEn).toContain('code confirmation needs `file_quote`');
      expect(structuredEn).toContain('structure confirmation needs `repository_manifest`');
      expect(structuredEn).toContain('absence confirmation needs `repository_query` plus `authoritative_quote`');
      expect(structuredJa).toContain('code の確認は `file_quote`');
      expect(structuredJa).toContain('structure の確認は `repository_manifest`');
      expect(structuredJa).toContain('absence の確認は `repository_query` と `authoritative_quote`');

      const freeformEn = build({
        contract: { reviewer: FREEFORM_REVIEWER, hasOpenFindings: true },
      });
      const freeformJa = build({
        contract: { reviewer: FREEFORM_REVIEWER, hasOpenFindings: true },
        language: 'ja',
      });
      expect(freeformEn).toContain('code confirmation needs File Quote');
      expect(freeformEn).toContain('structure confirmation needs Repository Manifest');
      expect(freeformEn).toContain('absence confirmation needs Repository Query plus Authoritative Quote');
      expect(freeformJa).toContain('code の確認は File Quote');
      expect(freeformJa).toContain('structure の確認は Repository Manifest');
      expect(freeformJa).toContain('absence の確認は Repository Query と Authoritative Quote');

      for (const rendered of [structuredEn, structuredJa, freeformEn, freeformJa]) {
        expect(rendered).toMatch(/Do not output snapshotId|snapshotId・runId・proofId/u);
        expect(rendered).not.toContain(REVIEWER_SNAPSHOT_ID);
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
