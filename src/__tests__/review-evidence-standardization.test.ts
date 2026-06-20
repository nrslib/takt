import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REVIEW_CONTRACTS = [
  'architecture-review',
  'qa-review',
  'testing-review',
  'security-review',
  'pure-review',
] as const;

const LANGUAGE_SPECS = {
  ja: {
    evidenceHeading: '## 検証証跡',
    buildLine: '- ビルド: {確認対象・確認内容・結果。未確認ならその旨}',
    testLine: '- テスト: {確認対象・確認内容・結果。未確認ならその旨}',
    functionalLine: '- 動作確認: {確認対象・確認内容・結果。未確認ならその旨}',
    supervisePath: '../../builtins/ja/facets/instructions/supervise.md',
    prioritizeEvidenceSection: /(?:`検証証跡`[\s\S]{0,160}優先|優先[\s\S]{0,160}`検証証跡`)/,
    evidenceFieldsAndUnverified: /`検証証跡`[\s\S]{0,220}確認対象・確認内容・結果[\s\S]{0,220}未確認/,
  },
  en: {
    evidenceHeading: '## Verification Evidence',
    buildLine: '- Build: {Verified target, what was checked, and observed result; or state that it was unverified}',
    testLine: '- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}',
    functionalLine:
      '- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}',
    supervisePath: '../../builtins/en/facets/instructions/supervise.md',
    prioritizeEvidenceSection:
      /(?:`Verification Evidence`[\s\S]{0,200}(prioritize|prefer)|(prioritize|prefer)[\s\S]{0,200}`Verification Evidence`)/i,
    evidenceFieldsAndUnverified:
      /`Verification Evidence`[\s\S]{0,260}verified target, what was checked, and observed result[\s\S]{0,220}unverified/i,
  },
} as const;

function readBuiltin(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('review evidence output contracts', () => {
  for (const [language, spec] of Object.entries(LANGUAGE_SPECS)) {
    it(`keeps the standardized verification evidence section in all ${language} review contracts`, () => {
      for (const contract of REVIEW_CONTRACTS) {
        const content = readBuiltin(`../../builtins/${language}/facets/output-contracts/${contract}.md`);

        expect(content).toContain(spec.evidenceHeading);
        expect(content).toContain(spec.buildLine);
        expect(content).toContain(spec.testLine);
        expect(content).toContain(spec.functionalLine);
      }
    });
  }
});

describe('supervisor review evidence guidance', () => {
  for (const [language, spec] of Object.entries(LANGUAGE_SPECS)) {
    it(`tells the ${language} supervisor instructions to prioritize the standardized evidence section`, () => {
      const content = readBuiltin(spec.supervisePath);

      expect(content).toMatch(spec.prioritizeEvidenceSection);
      expect(content).toMatch(spec.evidenceFieldsAndUnverified);
    });
  }
});
