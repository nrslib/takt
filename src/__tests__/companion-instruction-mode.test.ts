import { describe, expect, it } from 'vitest';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';
import type { CompanionReviewMode } from '../core/models/companion-types.js';
import type { Language } from '../core/models/config-types.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

const POLLING_TRIGGERS = ['fileCompletion', 'beforeTests', 'beforeCompletion'] as const;
type PollingTrigger = typeof POLLING_TRIGGERS[number];

const COMPANION_SECTION_HEADINGS: Record<Language, string> = {
  en: '## Companion inbox',
  ja: '## Companion 受信箱',
};

const POLLING_OPERATION_PATTERNS: Record<Language, RegExp> = {
  en: /\b(?:check|inspect|look\s+at|monitor|poll|read)\b/u,
  ja: /(?:確認|チェック|参照|監視|ポーリング|読む)/u,
};

const POLLING_TARGET_PATTERNS: Record<Language, RegExp> = {
  en: /\b(?:mailbox|inbox|record(?:s)?)\b/u,
  ja: /(?:メールボックス|受信箱|レコード|記録)/u,
};

const POLLING_TRIGGER_PATTERNS: Record<Language, Record<PollingTrigger, RegExp>> = {
  en: {
    fileCompletion: /(?:after|once|when|upon)\s+(?:(?:finishing|completing)\s+(?:each|a|one)?\s*file|(?:each|a|one)\s+file\s+is\s+(?:done|complete|finished))/u,
    beforeTests: /(?:before|prior\s+to)\s+(?:running\s+)?tests?/u,
    beforeCompletion: /(?:before|prior\s+to)\s+(?:declaring\s+)?completion/u,
  },
  ja: {
    fileCompletion: /(?:各ファイルの(?:実装)?完了後|ファイルを(?:1つ|一つ)?終えるたびに|ファイル(?:が(?:1つ|一つ)?終わったら|完了後))/u,
    beforeTests: /(?:テスト(?:実行)?前|テストの前|テストを実行する前)/u,
    beforeCompletion: /(?:作業完了宣言の(?:直前|前)|完了宣言の(?:直前|前)|完了を宣言する前)/u,
  },
};

const POLLING_NEGATION_PATTERNS: Record<Language, RegExp> = {
  en: /(?:do\s+not|don't|never|no\s+need\s+to|not\s+necessary\s+to)/u,
  ja: /(?:必要はありません|必要ありません|しないでください|不要|禁止)/u,
};

const FOLLOW_UP_DELIVERY_PATTERNS: Record<Language, readonly RegExp[]> = {
  en: [
    /\bfindings?\b/u,
    /follow[-\s]?up\s+prompt/u,
    /after\s+your\s+response\s+is\s+complete/u,
  ],
  ja: [
    /指摘/u,
    /follow[-\s]?up\s+prompt/u,
    /応答完了後/u,
    /届けられ/u,
  ],
};

function normalizeInstruction(text: string, language: Language): string {
  const locale = language === 'en' ? 'en-US' : 'ja-JP';
  return text.replace(/\s+/gu, ' ').trim().toLocaleLowerCase(locale);
}

function companionSectionHeading(language: Language): string {
  return COMPANION_SECTION_HEADINGS[language];
}

function extractCompanionSection(prompt: string, language: Language): string {
  const instructionsHeading = '\n## Instructions\n';
  const instructionsStart = prompt.lastIndexOf(instructionsHeading);
  const headingLine = `\n${companionSectionHeading(language)}\n`;
  const headingStart = prompt.lastIndexOf(headingLine);

  if (instructionsStart < 0 || headingStart <= instructionsStart) {
    throw new Error(`Missing ${companionSectionHeading(language)} section in the instruction prompt`);
  }

  const sectionStart = headingStart + headingLine.length;
  const remainder = prompt.slice(sectionStart);
  const nextHeading = /^## (?!#)/mu.exec(remainder);
  return remainder.slice(0, nextHeading?.index ?? remainder.length).trim();
}

function companionSectionClauses(section: string, language: Language): string[] {
  return normalizeInstruction(section, language)
    .split(/[.!?。！？]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function findPollingClause(
  clauses: readonly string[],
  language: Language,
  trigger: PollingTrigger,
): string | undefined {
  return clauses.find((clause) => (
    POLLING_OPERATION_PATTERNS[language].test(clause)
    && POLLING_TARGET_PATTERNS[language].test(clause)
    && POLLING_TRIGGER_PATTERNS[language][trigger].test(clause)
    && !POLLING_NEGATION_PATTERNS[language].test(clause)
  ));
}

function assertNoPositivePollingRequests(section: string, language: Language): void {
  const clauses = companionSectionClauses(section, language);
  for (const trigger of POLLING_TRIGGERS) {
    expect(
      findPollingClause(clauses, language, trigger),
      `${language} completion instruction must not request polling at ${trigger}`,
    ).toBeUndefined();
  }
}

function assertPositivePollingRequest(section: string, language: Language, trigger: PollingTrigger): void {
  const clauses = companionSectionClauses(section, language);
  expect(
    findPollingClause(clauses, language, trigger),
    `${language} live instruction must request polling at ${trigger}`,
  ).toBeDefined();
}

function assertPollingProhibition(section: string, language: Language): void {
  const clauses = companionSectionClauses(section, language);
  const prohibition = clauses.find((clause) => (
    POLLING_OPERATION_PATTERNS[language].test(clause)
    && POLLING_TARGET_PATTERNS[language].test(clause)
    && POLLING_NEGATION_PATTERNS[language].test(clause)
  ));
  expect(prohibition, `${language} completion instruction must state the polling prohibition`).toBeDefined();
}

function assertFollowUpDelivery(section: string, language: Language): void {
  const normalized = normalizeInstruction(section, language);
  for (const pattern of FOLLOW_UP_DELIVERY_PATTERNS[language]) {
    expect(normalized).toMatch(pattern);
  }
}

function assertCompletionInstructionContract(prompt: string, language: Language): void {
  const section = extractCompanionSection(prompt, language);
  assertNoPositivePollingRequests(section, language);
  assertPollingProhibition(section, language);
  assertFollowUpDelivery(section, language);
}

function insertIntoCompanionSection(prompt: string, language: Language, instruction: string): string {
  const headingLine = `\n${companionSectionHeading(language)}\n`;
  const headingStart = prompt.lastIndexOf(headingLine);
  if (headingStart < 0) {
    throw new Error(`Missing ${companionSectionHeading(language)} section in the instruction prompt`);
  }
  const insertionPoint = headingStart + headingLine.length;
  return `${prompt.slice(0, insertionPoint)}${instruction}\n${prompt.slice(insertionPoint)}`;
}

function context(reviewMode: CompanionReviewMode, language: Language, task = 'test task'): InstructionContext {
  return {
    ...makeInstructionContext({ language, task }),
    companion: {
      mailboxDirectory: '/tmp/takt-mailbox',
      reviewMode,
    },
  };
}

function build(reviewMode: CompanionReviewMode, language: Language, task = 'test task'): string {
  return new InstructionBuilder(makeStep({
    instruction: 'Implement the requested change.',
    edit: true,
    companion: { fixed: ['reviewer'], pool: [] },
  }), context(reviewMode, language, task)).build();
}

describe('companion implementation instructions', () => {
  it('does not ask English completion mode agents to poll at any live trigger', () => {
    assertCompletionInstructionContract(build('completion', 'en'), 'en');
  });

  it('does not ask Japanese completion mode agents to poll at any live trigger', () => {
    assertCompletionInstructionContract(build('completion', 'ja'), 'ja');
  });

  it.each([
    ['en', 'Please CHECK the inbox once a file is done.'],
    ['ja', 'ファイルを1つ終えるたびに受信箱をチェックしてください。'],
  ] as const)('detects polling reintroduction inside the %s Companion section', (language, instruction) => {
    const prompt = insertIntoCompanionSection(build('completion', language), language, instruction);

    expect(() => assertCompletionInstructionContract(prompt, language)).toThrow();
  });

  it.each([
    ['en', 'Please CHECK the inbox once a file is done.'],
    ['ja', 'ファイルを1つ終えるたびに受信箱をチェックしてください。'],
  ] as const)('ignores the same polling wording outside the %s Companion section', (language, instruction) => {
    expect(() => assertCompletionInstructionContract(build('completion', language, instruction), language))
      .not.toThrow();
  });

  it.each(['en', 'ja'] as const)('fails fast when the %s Companion heading is missing', (language) => {
    const prompt = build('completion', language).replace(companionSectionHeading(language), '## Other section');

    expect(() => extractCompanionSection(prompt, language)).toThrow(/Missing/);
  });

  it('keeps each English live mode mailbox polling trigger', () => {
    const section = extractCompanionSection(build('live', 'en'), 'en');

    for (const trigger of POLLING_TRIGGERS) {
      assertPositivePollingRequest(section, 'en', trigger);
    }
  });

  it('keeps each Japanese live mode mailbox polling trigger', () => {
    const section = extractCompanionSection(build('live', 'ja'), 'ja');

    for (const trigger of POLLING_TRIGGERS) {
      assertPositivePollingRequest(section, 'ja', trigger);
    }
  });
});
