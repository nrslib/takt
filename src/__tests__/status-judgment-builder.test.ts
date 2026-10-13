import { describe, expect, it } from 'vitest';
import type { WorkflowStep } from '../core/models/types.js';
import { StatusJudgmentBuilder } from '../core/workflow/instruction/StatusJudgmentBuilder.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

describe('StatusJudgmentBuilder input boundaries', () => {
  const step: WorkflowStep = {
    name: 'review',
    personaDisplayName: 'Reviewer',
    instruction: 'Review',
    rules: [
      normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
      normalizeRule({ condition: 'needs_fix', next: 'fix' }),
    ],
  };

  it.each([
    { language: 'ja' as const, onlyInput: '入力に書かれた内容だけ', noInspection: 'ファイル・コード・テスト結果を読んだり', noExternal: '入力の外の資料を調べない' },
    { language: 'en' as const, onlyInput: 'only what is written in the input', noInspection: 'read files, code, or test results', noExternal: 'do not inspect materials outside the input' },
  ])('renders input-only judgment instructions in $language for both modes and input sources', ({ language, onlyInput, noInspection, noExternal }) => {
    for (const inputSource of ['report', 'response'] as const) {
      for (const structuredOutput of [true, false]) {
        const prompt = new StatusJudgmentBuilder(step, {
          language,
          inputSource,
          reportContent: 'INPUT_RESULT: approved',
          lastResponse: 'INPUT_RESULT: approved',
          structuredOutput,
        }).build();

        expect(prompt).toContain('INPUT_RESULT: approved');
        expect(prompt).toContain(onlyInput);
        expect(prompt).toContain(structuredOutput ? noInspection : noExternal);
        expect(prompt).toContain('approved');
        expect(prompt).toContain('needs_fix');
        if (structuredOutput) {
          expect(prompt).toContain('reason');
        }
        expect(prompt).toContain('[REVIEW:1]');
        expect(prompt).toContain('[REVIEW:2]');
        const outputHeading = language === 'ja' ? '## 出力フォーマット' : '## Output Format';
        expect(prompt.includes(outputHeading)).toBe(!structuredOutput);
        expect(prompt).not.toContain('{{');
        expect(prompt).not.toContain('template: perform_phase3_message');
      }
    }
  });
});
