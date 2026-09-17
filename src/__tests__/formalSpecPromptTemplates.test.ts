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
  expect(prompt).toContain(constraints);
  expect(constraints).toContain('--max-steps 20');
  expect(constraints).toContain('Int.oneOf()');
  expect(constraints).toMatch(/1\.\. steps/iu);
  expect(constraints).toMatch(/exists[\s\S]*forall[\s\S]*filter[\s\S]*map/iu);
  if (lang === 'ja') {
    expect(constraints).toMatch(/`action init` と `action step` を持つ main module を1つ作る/iu);
    expect(constraints).toMatch(/`inv` で始まる `val` 不変条件と `prop` で始まる `temporal` 時相プロパティはすべて同じ module 内に置く/iu);
    expect(constraints).toMatch(/`inv` で始まる `val` 不変条件/iu);
    expect(constraints).toMatch(/`prop` で始まる `temporal` 時相プロパティ/iu);
    expect(constraints).toMatch(/`prop\*`[^。\n]*Quint は TLC に切り替わり/iu);
    expect(constraints).toMatch(/`--max-steps 20` は TLC の探索範囲を制限しない/iu);
    expect(constraints).toMatch(/時相プロパティ内で `next\(` やプライム付き状態変数参照を使わない/iu);
    expect(constraints).toMatch(/常に有効な無操作または stuttering のトレースが最終到達の結果に違反できない/iu);
    expect(constraints).toMatch(/有限のトレース長を指定した `check` コマンド/iu);
    expect(constraints).toMatch(/検証するすべての Alloy プロパティに/iu);
    expect(constraints).toMatch(/`check` コマンドだけで、`run` コマンドは決して実行しない/iu);
    expect(constraints).toMatch(/すべての状態変数[^。\n]*有限範囲に有界化/iu);
    expect(constraints).toMatch(/組み込み演算子名[^。\n]*exists[^。\n]*forall[^。\n]*filter[^。\n]*map[^。\n]*(?:def|val|action)[^。\n]*再定義しない/iu);
    expect(constraints).toMatch(/parse[^。\n]*typecheck[^。\n]*run[^。\n]*60 秒/iu);
    expect(constraints).toMatch(/モデル検査段階[^。\n]*既定 5 分/iu);
  } else {
    expect(constraints).toMatch(/Put `action init` and `action step` in one main module/iu);
    expect(constraints).toMatch(/every `val` invariant whose name starts with `inv` and every `temporal` property whose name starts with `prop` in that same module/iu);
    expect(constraints).toMatch(/every `val` invariant whose name starts with `inv`/iu);
    expect(constraints).toMatch(/every `temporal` property whose name starts with `prop`/iu);
    expect(constraints).toMatch(/When any `prop\*` temporal property is present, Quint switches to TLC/iu);
    expect(constraints).toMatch(/`--max-steps 20` does not limit TLC's exploration/iu);
    expect(constraints).toMatch(/In temporal properties, do not use `next\(` or primed state-variable references/iu);
    expect(constraints).toMatch(/always-enabled no-op or stuttering trace cannot violate an eventual outcome/iu);
    expect(constraints).toMatch(/finite trace scope such as `for 3 but 8 steps`/iu);
    expect(constraints).toMatch(/For every Alloy property that must be verified, include a `check` command/iu);
    expect(constraints).toMatch(/TAKT executes `check` commands only and never executes `run` commands/iu);
    expect(constraints).toMatch(/bound every state variable[^.\n]*finite ranges/iu);
    expect(constraints).toMatch(/Do not redefine Quint built-in operator names[^.\n]*exists[^.\n]*forall[^.\n]*filter[^.\n]*map/iu);
    expect(constraints).toMatch(/parse[^.\n]*typecheck[^.\n]*run[^.\n]*60 seconds/iu);
    expect(constraints).toMatch(/model-check stage[^.\n]*5 minutes by default/iu);
  }
  const temporalPrimeRules = constraints.split('\n').filter((line) => (
    /primed state-variable references|プライム付き状態変数参照/iu.test(line)
  ));
  expect(temporalPrimeRules).toHaveLength(1);
  expect(temporalPrimeRules[0]).toMatch(
    lang === 'ja' ? /時相プロパティ内で/iu : /In temporal properties/iu,
  );
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
      expect(prompt).not.toContain('--max-steps 20');
      expect(prompt).not.toMatch(/1\.\. steps/iu);
      expect(prompt).not.toContain('Int.oneOf()');
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
