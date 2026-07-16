import { describe, expect, it } from 'vitest';
import {
  buildFindingContractInstruction,
  buildFindingContractReportInstruction,
} from '../core/workflow/instruction/finding-contract-instruction.js';
import type { FindingContractInstructionContext } from '../core/workflow/instruction/instruction-context.js';

const renderFencedJsonBlock = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function makeContract(overrides: Partial<FindingContractInstructionContext> = {}): FindingContractInstructionContext {
  return {
    ledgerCopyPath: '.takt/runs/r1/reports/findings-ledger.json',
    ledgerSummary: { findings: [] },
    hasOpenFindings: false,
    hasWaivedFindings: false,
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

const REVIEWER_SCHEMA = { type: 'object' };

describe('buildFindingContractInstruction', () => {
  it('never emits blank-line runs left behind by unused conditional blocks', () => {
    for (const language of ['en', 'ja'] as const) {
      for (const contract of [
        {},
        { hasOpenFindings: true },
        { rawFindingsJsonSchema: REVIEWER_SCHEMA },
        { rawFindingsJsonSchema: REVIEWER_SCHEMA, hasOpenFindings: true, hasWaivedFindings: true },
      ]) {
        const rendered = build({ contract, language });
        expect(rendered, `${language} ${JSON.stringify(contract)}`).not.toMatch(/\n{3}/);
        expect(rendered.startsWith('## Finding Contract')).toBe(true);
      }
    }
  });

  describe('reviewer instruction', () => {
    it('localizes the reviewer prose for ja', () => {
      const rendered = build({ contract: { rawFindingsJsonSchema: REVIEWER_SCHEMA }, language: 'ja' });
      expect(rendered).toContain('統合台帳のコピー');
      expect(rendered).toContain('構造化 raw finding として報告してください');
    });

    it('does not inject the dispute guide into reviewers', () => {
      const rendered = build({ contract: { rawFindingsJsonSchema: REVIEWER_SCHEMA, hasOpenFindings: true } });
      expect(rendered).not.toContain('Disputed Findings');
    });

    // rawFindingId / familyTag / kind / targetFindingId は manager-runner /
    // manager-output-validation が英語リテラルで照合する raw finding のフィールド名。
    // ja テンプレートでも英語のまま出ることを確認する。
    it('keeps raw finding protocol field names in English for ja', () => {
      const rendered = build({
        contract: { rawFindingsJsonSchema: REVIEWER_SCHEMA, hasOpenFindings: true, hasWaivedFindings: true },
        language: 'ja',
      });
      expect(rendered).toContain('rawFindingId');
      expect(rendered).toContain('familyTag');
      expect(rendered).toContain('kind');
      expect(rendered).toContain('targetFindingId');
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
      ledgerCopyPath: '.takt/runs/r1/reports/findings-ledger.json',
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
