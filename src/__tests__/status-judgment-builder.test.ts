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

  it.each(['report', 'response'] as const)('keeps %s judgment material separate from phase instructions', (inputSource) => {
    const builder = new StatusJudgmentBuilder(step, {
      language: 'ja',
      inputSource,
      reportContent: '# report.md\n\napproved',
      lastResponse: 'approved',
      workflowAssignment: { stepName: 'review', stepIteration: 2, iteration: 11, maxSteps: 51 },
    });

    expect(builder.buildJudgmentInput()).toBe(inputSource === 'report'
      ? '# report.md\n\napproved'
      : '\n## Agent Response\n\napproved');
    expect(builder.build()).toContain('## 担当とフェーズ');
  });

  it.each([
    { language: 'ja' as const, onlyInput: 'この指示に含まれる入力', noInspection: 'ファイル・コード・テスト結果を読んだり', noExternal: '入力の外の資料を調べない' },
    { language: 'en' as const, onlyInput: 'inputs included in this instruction', noInspection: 'read files, code, or test results', noExternal: 'do not inspect materials outside the input' },
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
        expect(prompt).toContain(structuredOutput ? onlyInput : language === 'ja' ? '入力に書かれた内容だけ' : 'only what is written in the input');
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
