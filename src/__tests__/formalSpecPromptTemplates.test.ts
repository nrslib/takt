import { describe, expect, it } from 'vitest';
import { loadTemplate } from '../shared/prompts/index.js';
import { buildSummaryPrompt } from '../features/interactive/interactive-summary.js';

function renderInteractivePrompt(
  lang: 'en' | 'ja',
  formalSpec: boolean,
  grillMe = false,
): string {
  return loadTemplate('score_interactive_system_prompt', lang, {
    grillMe,
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

describe('interactive codebase investigation boundaries', () => {
  it('allows sufficient current-state investigation in the English assistant mode', () => {
    const prompt = renderInteractivePrompt('en', false);

    expect(prompt).toContain('Perform sufficient read-only codebase investigation');
    expect(prompt).toContain('Inspect related code as needed');
    expect(prompt).toContain('Do not investigate how to implement the task');
    expect(prompt).toContain('identifying files to change');
    expect(prompt).toContain('analyzing dependencies or call paths for the change');
    expect(prompt).toContain('comparing fixes or designs');
    expect(prompt).toContain('preparing implementation steps');
    expect(prompt).not.toContain('Use the read-only inspection needed to challenge the requirements');
  });

  it('keeps English Grill Me focused on requirement decisions', () => {
    const prompt = renderInteractivePrompt('en', false, true);

    expect(prompt).toContain('Use the read-only inspection needed to challenge the requirements');
    expect(prompt).toContain('Do not investigate implementation');
    expect(prompt).toContain('identifying files to change');
    expect(prompt).toContain('analyzing dependencies or call paths for the change');
    expect(prompt).toContain('comparing fixes or designs');
    expect(prompt).toContain('preparing implementation steps');
    expect(prompt).not.toContain('Perform sufficient read-only codebase investigation');
  });

  it('allows sufficient current-state investigation in the Japanese assistant mode', () => {
    const prompt = renderInteractivePrompt('ja', false);

    expect(prompt).toContain('現状理解と要件明確化に必要なコードベース調査を');
    expect(prompt).toContain('関連箇所を必要な範囲で確認してよい');
    expect(prompt).toContain('実装方法を決めるための調査は行わない');
    expect(prompt).toContain('変更対象ファイルの特定');
    expect(prompt).toContain('変更のための依存関係や呼び出し経路の解析');
    expect(prompt).toContain('修正案や設計案の比較');
    expect(prompt).toContain('実装手順の作成');
    expect(prompt).not.toContain('要件を問い詰めるために必要な現行仕様');
  });

  it('keeps Japanese Grill Me focused on requirement decisions', () => {
    const prompt = renderInteractivePrompt('ja', false, true);

    expect(prompt).toContain('要件を問い詰めるために必要な現行仕様');
    expect(prompt).toContain('実装のための調査は行わない');
    expect(prompt).toContain('変更対象ファイルの特定');
    expect(prompt).toContain('依存関係や呼び出し経路の解析');
    expect(prompt).toContain('修正案や設計案の比較');
    expect(prompt).toContain('実装手順の作成');
    expect(prompt).not.toContain('現状理解と要件明確化に必要なコードベース調査を');
  });
});

describe('interactive formal specification prompt templates', () => {
  it('selects English conditional Gherkin guidance without formal notation guidance when disabled', () => {
    const prompt = renderInteractivePrompt('en', false);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('whose deliverable is not an implementation, do not use Gherkin');
    expect(prompt).toContain('where a misunderstanding would materially change the implementation result');
    expect(prompt).toContain('do not duplicate the same acceptance clause in Markdown and Gherkin');
    expect(prompt).toContain('keywords in English');
    expect(prompt).toContain('do not use a localized `# language` directive');
    expect(prompt).not.toContain('Quint');
    expect(prompt).not.toContain('Alloy');
  });

  it('selects Japanese conditional Gherkin guidance without formal notation guidance when disabled', () => {
    const prompt = renderInteractivePrompt('ja', false);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('実装を成果物としないタスクでは Gherkin を使用しない');
    expect(prompt).toContain('解釈の誤りが実装結果を実質的に変える');
    expect(prompt).toContain('同じ受け入れ条件を Markdown と Gherkin に重複して記述しない');
    expect(prompt).toContain('会話や指示書が日本語でも常に英語で記述');
    expect(prompt).toContain('`# language: ja` は使用しない');
    expect(prompt).not.toContain('Quint');
    expect(prompt).not.toContain('Alloy');
  });

  it('selects English formal notation guidance when enabled', () => {
    const prompt = renderInteractivePrompt('en', true);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('Quint');
    expect(prompt).toContain('Alloy');
    expect(prompt).toContain('ASCII');
    expect(prompt).toContain('keep the prohibition on duplicating acceptance clauses between Markdown and Gherkin');
  });

  it('selects Japanese formal notation guidance when enabled', () => {
    const prompt = renderInteractivePrompt('ja', true);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('Quint');
    expect(prompt).toContain('Alloy');
    expect(prompt).toContain('ASCII');
    expect(prompt).toContain('Markdown と Gherkin の重複禁止は維持する');
  });
});

describe('Japanese task instruction formal specification prompt', () => {
  it('selects Gherkin guidance without formal notation guidance when disabled', () => {
    const prompt = renderJapaneseSummaryPrompt(false);

    expect(prompt).toContain('Gherkin');
    expect(prompt).not.toContain('Quint');
    expect(prompt).not.toContain('Alloy');
    expect(prompt).toContain('ASCII');
    expect(prompt).toContain('指示書が日本語でも常に英語で記述');
    expect(prompt).toContain('`# language: ja` は使用しない');
  });

  it('selects formal notation guidance when enabled', () => {
    const prompt = renderJapaneseSummaryPrompt(true);

    expect(prompt).toContain('Gherkin');
    expect(prompt).toContain('Quint');
    expect(prompt).toContain('Alloy');
    expect(prompt).toContain('ASCII');
    expect(prompt).toContain('非開発タスクには Gherkin を追加しない');
    expect(prompt).toContain('Markdown と Gherkin の重複禁止は維持する');
  });
});
