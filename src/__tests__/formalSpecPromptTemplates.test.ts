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
  return JSON.parse(match[1]) as unknown;
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
