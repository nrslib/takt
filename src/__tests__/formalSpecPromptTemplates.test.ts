import { describe, expect, it } from 'vitest';
import { buildSummaryPrompt } from '../features/interactive/interactive-summary.js';
import { buildInteractiveSystemPrompt } from '../features/interactive/conversationPlan.js';
import {
  buildFormalSpecGenerationPrompt,
  buildFormalSpecGenerationSystemPrompt,
  buildFormalSpecInterpretationSystemPrompt,
  loadFormalSpecVerifierConstraints,
} from '../features/interactive/formalSpecPrompts.js';

const EXPECTED_INVESTIGATION_POLICY = {
  currentStateScope: 'current-state-and-prerequisites',
  implementationInvestigationOwner: 'workflow-execution',
} as const;

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

function parseInvestigationPolicy(prompt: string): unknown {
  const match = prompt.match(
    /<takt-investigation-policy>\s*([\s\S]*?)\s*<\/takt-investigation-policy>/,
  );
  if (match === null) {
    throw new Error('interactive investigation policy metadata is missing');
  }
  const serializedPolicy = match[1];
  if (serializedPolicy === undefined) {
    throw new Error('interactive investigation policy metadata is empty');
  }
  return JSON.parse(serializedPolicy) as unknown;
}

function parseStructuredPolicy(prompt: string, tagName: string): unknown {
  const openingTag = `<${tagName}>`;
  const closingTag = `</${tagName}>`;
  const openingIndex = prompt.indexOf(openingTag);
  if (openingIndex < 0) {
    throw new Error(`${tagName} metadata is missing`);
  }
  const contentStart = openingIndex + openingTag.length;
  const closingIndex = prompt.indexOf(closingTag, contentStart);
  if (closingIndex < 0) {
    throw new Error(`${tagName} metadata is not closed`);
  }
  return JSON.parse(prompt.slice(contentStart, closingIndex).trim()) as unknown;
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

function expectToolFreeVerificationInstruction(prompt: string, lang: 'en' | 'ja'): void {
  if (lang === 'ja') {
    expect(prompt).toMatch(/ツール[^。\n]*コマンド[^。\n]*(?:実行|使用|使わ)[^。\n]*(?:ない|ず|ません)/iu);
    expect(prompt).toMatch(/応答本文[^。\n]*(?:だけ|のみ)/iu);
    expect(prompt).toMatch(/検証[^。\n]*TAKT|TAKT[^。\n]*検証/iu);
  } else {
    expect(prompt).toMatch(/do not[^.\n]*(?:tools?)[^.\n]*(?:commands?)|do not[^.\n]*(?:commands?)[^.\n]*(?:tools?)/iu);
    expect(prompt).toMatch(/(?:only[^.\n]*response (?:body|text)|response (?:body|text)[^.\n]*only)/iu);
    expect(prompt).toMatch(/TAKT[^.\n]*verif|verif[^.\n]*TAKT/iu);
  }
}

function expectFormalSpecVerifierConstraints(prompt: string, lang: 'en' | 'ja'): void {
  const constraints = loadFormalSpecVerifierConstraints(lang);
  expect(constraints.trim().length).toBeGreaterThan(0);
  expect(prompt).toContain(constraints);
}

function expectNoUnexpandedTemplateVariables(prompt: string): void {
  expect(prompt).not.toMatch(/\{\{|\}\}/u);
}

describe('interactive investigation policy template wiring', () => {
  it.each([
    ['en', false, EXPECTED_INVESTIGATION_POLICY],
    ['en', true, EXPECTED_INVESTIGATION_POLICY],
    ['ja', false, EXPECTED_INVESTIGATION_POLICY],
    ['ja', true, EXPECTED_INVESTIGATION_POLICY],
  ] as const)(
    'renders the structured policy for %s when grillMe is %s',
    (lang, grillMe, expectedPolicy) => {
      const prompt = renderInteractivePrompt(lang, false, grillMe);

      expect(parseInvestigationPolicy(prompt)).toEqual(expectedPolicy);
    },
  );
});

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

describe('formal specification role policy wiring', () => {
  it.each(['en', 'ja'] as const)('keeps generation and interpretation policies stable for %s', (lang) => {
    expect(parseStructuredPolicy(
      buildFormalSpecGenerationSystemPrompt(lang),
      'takt-formal-spec-generation-policy',
    )).toEqual({
      role: 'formal-specification-generator',
      quint: {
        invariantPrefix: 'inv',
        temporalPropertyPrefix: 'prop',
      },
      alloy: {
        targetCommand: 'check',
      },
    });
    expect(parseStructuredPolicy(
      buildFormalSpecInterpretationSystemPrompt(lang),
      'takt-formal-spec-interpretation-policy',
    )).toEqual({
      role: 'formal-specification-interpreter',
      rerunPolicy: 'explicit-user-only',
    });
  });
});

describe('formal specification tool-free execution instructions', () => {
  it.each(['en', 'ja'] as const)('instructs the %s generation prompt to avoid tools and commands', (lang) => {
    expectToolFreeVerificationInstruction(buildFormalSpecGenerationSystemPrompt(lang), lang);
  });

  it.each(['en', 'ja'] as const)('instructs the %s interpretation prompt to avoid tools and commands', (lang) => {
    expectToolFreeVerificationInstruction(buildFormalSpecInterpretationSystemPrompt(lang), lang);
  });
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
    if (lang === 'ja') {
      expect(prompt).not.toMatch(/Quintの不変条件名はinvで始め|Alloyの検証対象には必ずcheckコマンド/iu);
    } else {
      expect(prompt).not.toMatch(/Prefix every Quint invariant name with inv|Include a check command for every Alloy property/iu);
    }
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
