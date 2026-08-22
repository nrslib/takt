import { describe, expect, it } from 'vitest';
import { loadTemplate } from '../shared/prompts/index.js';
import { buildSummaryPrompt } from '../features/interactive/interactive-summary.js';

function renderInteractivePrompt(lang: 'en' | 'ja', formalSpec: boolean): string {
  return loadTemplate('score_interactive_system_prompt', lang, {
    grillMe: false,
    formalSpec,
    hasWorkflowPreview: false,
    workflowStructure: '',
    stepDetails: '',
    hasRunSession: false,
    runTask: '',
    runWorkflow: '',
    runStatus: '',
    runStepLogs: '',
    runReports: '',
  });
}

function renderJapaneseSummaryPrompt(formalSpec: boolean): string {
  return buildSummaryPrompt(
    [{ role: 'user', content: '状態を更新する機能を追加する' }],
    false,
    'ja',
    '会話記録なし',
    '会話:',
    undefined,
    undefined,
    undefined,
    formalSpec,
  );
}

describe('interactive formal specification prompt templates', () => {
  it('keeps English Gherkin guidance enabled without Quint or Alloy guidance', () => {
    const prompt = renderInteractivePrompt('en', false);

    expect(prompt).toMatch(/Gherkin/);
    expect(prompt).toMatch(/observable behavior/i);
    expect(prompt).not.toMatch(/\bQuint\b/);
    expect(prompt).not.toMatch(/\bAlloy\b/);
  });

  it('keeps Japanese Gherkin guidance enabled without Quint or Alloy guidance', () => {
    const prompt = renderInteractivePrompt('ja', false);

    expect(prompt).toMatch(/Gherkin/);
    expect(prompt).toMatch(/観測.*振る舞い/);
    expect(prompt).not.toMatch(/\bQuint\b/);
    expect(prompt).not.toMatch(/\bAlloy\b/);
  });

  it('describes the English Quint, Alloy, and conversational ASCII boundaries when enabled', () => {
    const prompt = renderInteractivePrompt('en', true);

    expect(prompt).toMatch(/Quint/);
    expect(prompt).toMatch(/state transition|temporal propert/i);
    expect(prompt).toMatch(/Alloy/);
    expect(prompt).toMatch(/structural invariant|entit(?:y|ies).*relation/i);
    expect(prompt).toMatch(/applicable|only when/i);
    expect(prompt).toMatch(/do not require both|not require both/i);
    expect(prompt).toMatch(/do not duplicate|same requirement/i);
    expect(prompt).toMatch(/actual .*syntax|valid .*syntax/i);
    expect(prompt).toMatch(/ASCII/);
    expect(prompt).toMatch(/state machine/i);
    expect(prompt).toMatch(/violation trace/i);
    expect(prompt).toMatch(/relation instance/i);
  });

  it('describes the Japanese Quint, Alloy, and conversational ASCII boundaries when enabled', () => {
    const prompt = renderInteractivePrompt('ja', true);

    expect(prompt).toMatch(/Quint/);
    expect(prompt).toMatch(/状態遷移|時相/);
    expect(prompt).toMatch(/Alloy/);
    expect(prompt).toMatch(/構造.*不変|エンティティ.*関係/);
    expect(prompt).toMatch(/適用可能|該当/);
    expect(prompt).toMatch(/両方.*(?:強制|必須).*ない/);
    expect(prompt).toMatch(/重複.*ない/);
    expect(prompt).toMatch(/実際.*構文|有効.*構文/);
    expect(prompt).toMatch(/ASCII/);
    expect(prompt).toMatch(/状態機械/);
    expect(prompt).toMatch(/違反トレース/);
    expect(prompt).toMatch(/関係インスタンス/);
  });
});

describe('Japanese task instruction formal specification prompt', () => {
  it('keeps Gherkin enabled without Quint or Alloy guidance when disabled', () => {
    const prompt = renderJapaneseSummaryPrompt(false);

    expect(prompt).toMatch(/Gherkin/);
    expect(prompt).toMatch(/観測.*振る舞い|外部.*観測/);
    expect(prompt).not.toMatch(/\bQuint\b/);
    expect(prompt).not.toMatch(/\bAlloy\b/);
    expect(prompt).toMatch(/ASCII.*(?:含めない|使用しない)|(?:含めない|使用しない).*ASCII/);
  });

  it('adds applicable formal notations and forbids ASCII diagrams when enabled', () => {
    const prompt = renderJapaneseSummaryPrompt(true);

    expect(prompt).toMatch(/Quint/);
    expect(prompt).toMatch(/状態遷移|時相/);
    expect(prompt).toMatch(/Alloy/);
    expect(prompt).toMatch(/構造.*不変|エンティティ.*関係/);
    expect(prompt).toMatch(/適用可能|該当/);
    expect(prompt).toMatch(/両方.*(?:強制|必須).*ない/);
    expect(prompt).toMatch(/重複.*ない/);
    expect(prompt).toMatch(/実際.*構文|有効.*構文/);
    expect(prompt).toMatch(/ASCII.*(?:含めない|使用しない)|(?:含めない|使用しない).*ASCII/);
  });
});
