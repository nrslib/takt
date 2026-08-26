import { describe, expect, it } from 'vitest';
import { buildSummaryPrompt } from '../features/interactive/interactive-summary.js';
import { buildInteractiveSystemPrompt } from '../features/interactive/conversationPlan.js';

const EXPECTED_INVESTIGATION_POLICIES = {
  assistant: {
    currentStateScope: 'current-state-and-prerequisites',
    implementationInvestigationOwner: 'workflow-execution',
  },
  grillMe: {
    currentStateScope: 'requirements-decisions-only',
    implementationInvestigationOwner: 'workflow-execution',
  },
} as const;

function renderInteractivePrompt(
  lang: 'en' | 'ja',
  formalSpec: boolean,
  grillMe = false,
): string {
  return buildInteractiveSystemPrompt(lang, {
    formalSpec,
    grillMe,
  });
}

function parseInvestigationPolicy(prompt: string): unknown {
  const match = prompt.match(
    /<takt-investigation-policy>\s*([\s\S]*?)\s*<\/takt-investigation-policy>/,
  );
  if (match === null) {
    throw new Error('interactive investigation policy metadata is missing');
  }
  return JSON.parse(match[1]) as unknown;
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

describe('interactive investigation policy template wiring', () => {
  it.each([
    ['en', false, EXPECTED_INVESTIGATION_POLICIES.assistant],
    ['en', true, EXPECTED_INVESTIGATION_POLICIES.grillMe],
    ['ja', false, EXPECTED_INVESTIGATION_POLICIES.assistant],
    ['ja', true, EXPECTED_INVESTIGATION_POLICIES.grillMe],
  ] as const)(
    'renders the structured policy for %s when grillMe is %s',
    (lang, grillMe, expectedPolicy) => {
      const prompt = renderInteractivePrompt(lang, false, grillMe);

      expect(parseInvestigationPolicy(prompt)).toEqual(expectedPolicy);
    },
  );
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
