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
  it('selects English conditional Gherkin guidance without formal notation guidance when disabled', () => {
    const prompt = renderInteractivePrompt('en', false);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('whose deliverable is not an implementation, do not use Gherkin');
    expect(prompt).not.toContain('Quint');
    expect(prompt).not.toContain('Alloy');
  });

  it('selects Japanese conditional Gherkin guidance without formal notation guidance when disabled', () => {
    const prompt = renderInteractivePrompt('ja', false);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('実装を成果物としないタスクでは Gherkin を使用しない');
    expect(prompt).not.toContain('Quint');
    expect(prompt).not.toContain('Alloy');
  });

  it('selects English formal notation guidance when enabled', () => {
    const prompt = renderInteractivePrompt('en', true);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('Quint');
    expect(prompt).toContain('Alloy');
    expect(prompt).toContain('ASCII');
  });

  it('selects Japanese formal notation guidance when enabled', () => {
    const prompt = renderInteractivePrompt('ja', true);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('Quint');
    expect(prompt).toContain('Alloy');
    expect(prompt).toContain('ASCII');
  });
});

describe('Japanese task instruction formal specification prompt', () => {
  it('selects Gherkin guidance without formal notation guidance when disabled', () => {
    const prompt = renderJapaneseSummaryPrompt(false);

    expect(prompt).toContain('Gherkin');
    expect(prompt).not.toContain('Quint');
    expect(prompt).not.toContain('Alloy');
    expect(prompt).toContain('ASCII');
  });

  it('selects formal notation guidance when enabled', () => {
    const prompt = renderJapaneseSummaryPrompt(true);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('Quint');
    expect(prompt).toContain('Alloy');
    expect(prompt).toContain('ASCII');
    expect(prompt).toContain('非開発タスクには Gherkin を追加しない');
  });
});
