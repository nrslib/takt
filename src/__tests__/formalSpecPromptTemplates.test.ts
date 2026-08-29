import { describe, expect, it } from 'vitest';
import { buildSummaryPrompt } from '../features/interactive/interactive-summary.js';
import { buildInteractiveSystemPrompt } from '../features/interactive/conversationPlan.js';
import {
  buildFormalSpecGenerationPrompt,
  buildFormalSpecGenerationSystemPrompt,
  buildFormalSpecInterpretationSystemPrompt,
} from '../features/interactive/formalSpecPrompts.js';

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

describe('formal specification naming guidance', () => {
  it.each([
    ['interactive', (lang: 'en' | 'ja') => renderInteractivePrompt(lang, true)],
    ['task instruction', (lang: 'en' | 'ja') => lang === 'en'
      ? renderEnglishSummaryPrompt(true)
      : renderJapaneseSummaryPrompt(true)],
  ] as const)('requires invariant, temporal, and Alloy check naming in the %s prompt for both languages', (_name, renderPrompt) => {
    for (const lang of ['en', 'ja'] as const) {
      const prompt = renderPrompt(lang);

      if (lang === 'en') {
        expect(prompt).toMatch(/Name every Quint invariant with the `inv` prefix/i);
        expect(prompt).toMatch(/every temporal property with the `prop` prefix/i);
        expect(prompt).toMatch(/a `check` command for every Alloy property/i);
      } else {
        expect(prompt).toMatch(/Quint の不変条件には `inv` プレフィックス/i);
        expect(prompt).toMatch(/時相プロパティには `prop` プレフィックス/i);
        expect(prompt).toMatch(/各プロパティには `check` コマンド/i);
      }
    }
  });

  it.each(['en', 'ja'] as const)('requires the same naming contract in the /verify generation prompt for %s', (lang) => {
    const prompt = buildFormalSpecGenerationPrompt(lang);

    if (lang === 'en') {
      expect(prompt).toMatch(/Prefix every Quint invariant name with inv/i);
      expect(prompt).toMatch(/every temporal property name with prop/i);
      expect(prompt).toMatch(/a check command for every Alloy property to verify/i);
    } else {
      expect(prompt).toMatch(/Quintの不変条件名はinvで始め/i);
      expect(prompt).toMatch(/時相プロパティ名はpropで始め/i);
      expect(prompt).toMatch(/Alloyの検証対象には必ずcheckコマンド/i);
    }
  });
});

describe('formal specification role prompts', () => {
  it.each(['en', 'ja'] as const)('keeps generation and interpretation roles separate for %s', (lang) => {
    const generationSystemPrompt = buildFormalSpecGenerationSystemPrompt(lang);
    const interpretationSystemPrompt = buildFormalSpecInterpretationSystemPrompt(lang);

    expect(generationSystemPrompt).not.toBe(interpretationSystemPrompt);
    expect(generationSystemPrompt).toMatch(/Quint|形式仕様/i);
    expect(interpretationSystemPrompt).toMatch(/verify|検証/i);
    expect(interpretationSystemPrompt).not.toMatch(/ordinary task implementation|通常のタスク実装/);
  });

  it.each(['en', 'ja'] as const)('passes the initial user agreement as quoted generation data for %s', (lang) => {
    const prompt = buildFormalSpecGenerationPrompt(lang, 'ACP対応を追加する');

    expect(prompt).toContain('<initial-user-input>');
    expect(prompt).toContain('ACP対応を追加する');
    expect(prompt).toContain('</initial-user-input>');
  });
});
