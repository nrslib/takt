import { describe, expect, it } from 'vitest';
import { buildSummaryPrompt } from '../features/interactive/interactive-summary.js';
import { buildInteractiveSystemPrompt } from '../features/interactive/conversationPlan.js';
import {
  buildFormalSpecGenerationPrompt,
  buildFormalSpecGenerationSystemPrompt,
  buildFormalSpecInterpretationSystemPrompt,
  loadFormalSpecVerifierConstraints,
} from '../features/interactive/formalSpecPrompts.js';

function renderInteractivePrompt(
  lang: 'en' | 'ja',
  formalSpec: boolean,
  grillMe = false,
  formalSpecComments = true,
): string {
  return buildInteractiveSystemPrompt(lang, {
    formalSpec,
    formalSpecComments,
    grillMe,
  });
}

function renderJapaneseSummaryPrompt(formalSpec: boolean, formalSpecComments = true): string {
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
    false,
    formalSpecComments,
  );
}

function renderEnglishSummaryPrompt(formalSpec: boolean, formalSpecComments = true): string {
  return buildSummaryPrompt(
    [{ role: 'user', content: 'Add a stateful feature' }],
    false,
    'en',
    'No transcript',
    'Conversation:',
    undefined,
    undefined,
    undefined,
    formalSpec,
    false,
    formalSpecComments,
  );
}

function expectFormalSpecVerifierConstraints(prompt: string, lang: 'en' | 'ja'): void {
  const constraints = loadFormalSpecVerifierConstraints(lang);
  expect(constraints.trim().length).toBeGreaterThan(0);
  expect(prompt).toContain(constraints);
}

function expectNoUnexpandedTemplateVariables(prompt: string): void {
  expect(prompt).not.toMatch(/\{\{|\}\}/u);
}

describe('interactive formal specification prompt template wiring', () => {
  it.each(['en', 'ja'] as const)(
    'applies formal specification and comment switches independently for %s',
    (lang) => {
      const withoutFormalSpec = renderInteractivePrompt(lang, false, false, false);
      const withoutFormalSpecButCommentsEnabled = renderInteractivePrompt(lang, false, false, true);
      const withoutComments = renderInteractivePrompt(lang, true, false, false);
      const withComments = renderInteractivePrompt(lang, true, false, true);
      const withDefaultComments = renderInteractivePrompt(lang, true);

      expect(withoutFormalSpecButCommentsEnabled).toBe(withoutFormalSpec);
      expect(withoutComments).not.toBe(withoutFormalSpec);
      expect(withComments).not.toBe(withoutComments);
      expect(withComments.length).toBeGreaterThan(withoutComments.length);
      expect(withDefaultComments).toBe(withComments);
    },
  );
});

describe('formal specification verifier constraint wiring', () => {
  it.each(['en', 'ja'] as const)('includes verifier constraints in generation and interpretation system prompts for %s', (lang) => {
    const generationPrompt = buildFormalSpecGenerationSystemPrompt(lang);
    const interpretationPrompt = buildFormalSpecInterpretationSystemPrompt(lang);
    expectFormalSpecVerifierConstraints(generationPrompt, lang);
    expectFormalSpecVerifierConstraints(interpretationPrompt, lang);
    expectNoUnexpandedTemplateVariables(generationPrompt);
    expectNoUnexpandedTemplateVariables(interpretationPrompt);
  });

  it.each(['en', 'ja'] as const)('includes verifier constraints in interactive and task instruction prompts for %s', (lang) => {
    const interactivePrompt = renderInteractivePrompt(lang, true);
    const summaryPrompt = lang === 'ja' ? renderJapaneseSummaryPrompt(true) : renderEnglishSummaryPrompt(true);
    expectFormalSpecVerifierConstraints(interactivePrompt, lang);
    expectFormalSpecVerifierConstraints(summaryPrompt, lang);
    expectNoUnexpandedTemplateVariables(interactivePrompt);
    expectNoUnexpandedTemplateVariables(summaryPrompt);
  });

  it.each(['en', 'ja'] as const)('omits verifier constraints and template placeholders when formalSpec is false for %s', (lang) => {
    const constraints = loadFormalSpecVerifierConstraints(lang);
    const interactivePrompt = renderInteractivePrompt(lang, false);
    const summaryPrompt = lang === 'ja' ? renderJapaneseSummaryPrompt(false) : renderEnglishSummaryPrompt(false);

    for (const prompt of [interactivePrompt, summaryPrompt]) {
      expect(prompt).not.toContain(constraints);
      expectNoUnexpandedTemplateVariables(prompt);
    }
  });
});

describe('formal specification generation user prompt boundaries', () => {
  it.each(['en', 'ja'] as const)('keeps generation-only fences without duplicating verifier constraints for %s', (lang) => {
    const prompt = buildFormalSpecGenerationPrompt(lang, `generation-context-${lang}`);

    expect(prompt).toContain('```quint');
    expect(prompt).toContain('```alloy');
    expect(prompt).not.toContain(loadFormalSpecVerifierConstraints(lang));
    expectNoUnexpandedTemplateVariables(prompt);
  });
});

describe('formal specification generation context wiring', () => {
  it.each(['en', 'ja'] as const)('preserves the unique initial agreement inside its stable delimiter for %s', (lang) => {
    const initialAgreement = `unique-initial-agreement-${lang}-8b7e2d`;
    const prompt = buildFormalSpecGenerationPrompt(lang, initialAgreement);

    expect(prompt).toContain(`<initial-user-input>\n${initialAgreement}\n</initial-user-input>`);
  });
});

describe('task instruction formal specification prompt template wiring', () => {
  it.each([
    ['en', renderEnglishSummaryPrompt],
    ['ja', renderJapaneseSummaryPrompt],
  ] as const)(
    'applies formal specification and comment switches independently for %s',
    (_lang, renderPrompt) => {
      const withoutFormalSpec = renderPrompt(false, false);
      const withoutFormalSpecButCommentsEnabled = renderPrompt(false, true);
      const withoutComments = renderPrompt(true, false);
      const withComments = renderPrompt(true, true);
      const withDefaultComments = renderPrompt(true);

      expect(withoutFormalSpecButCommentsEnabled).toBe(withoutFormalSpec);
      expect(withoutComments).not.toBe(withoutFormalSpec);
      expect(withComments).not.toBe(withoutComments);
      expect(withComments.length).toBeGreaterThan(withoutComments.length);
      expect(withDefaultComments).toBe(withComments);
    },
  );
});
