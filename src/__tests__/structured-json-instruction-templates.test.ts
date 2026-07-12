import { describe, expect, it } from 'vitest';
import { loadTemplate } from '../shared/prompts/index.js';

/**
 * structured JSON 指示テンプレートの出力契約を固定する。
 *
 * これらのテンプレートは provider にネイティブ structured output が無いときの
 * フォールバック経路で使われ、「fenced JSON block がちょうど1つ・前後に余計な
 * テキストを出さない」という機械契約をモデルに課す。散文のローカライズや
 * MD031 対応（fence 前後の空行）で契約部分が壊れないことを ja/en 両方で検証する。
 */

const CONTRACT_SENTENCE = {
  en: 'Do not include any text before or after the JSON block.',
  ja: 'JSON block の前後に余計なテキストを含めないでください。',
} as const;

function countJsonFences(rendered: string): number {
  return (rendered.match(/```json/g) ?? []).length;
}

describe('parts/structured_json_schema_instruction rendering contract', () => {
  // StepExecutor と同じ渡し方: schemaJson は整形済み JSON 文字列
  const schemaJson = JSON.stringify(
    { type: 'object', properties: { step: { type: 'number' } } },
    null,
    2,
  );

  it.each(['en', 'ja'] as const)('%s: embeds the schema in exactly one fenced JSON block with the no-extra-text contract', (lang) => {
    const rendered = loadTemplate('parts/structured_json_schema_instruction', lang, {
      instruction: 'INSTRUCTION_MARKER',
      schemaJson,
    });

    expect(rendered).toContain('INSTRUCTION_MARKER');
    expect(rendered).toContain(schemaJson);
    expect(countJsonFences(rendered)).toBe(1);
    expect(rendered).toContain(CONTRACT_SENTENCE[lang]);
  });
});

describe('parts/structured_json_step_instruction rendering contract', () => {
  it.each(['en', 'ja'] as const)('%s: shows the step shape in exactly one fenced JSON block with the no-extra-text contract', (lang) => {
    const rendered = loadTemplate('parts/structured_json_step_instruction', lang, {
      baseInstruction: 'BASE_INSTRUCTION_MARKER',
    });

    expect(rendered).toContain('BASE_INSTRUCTION_MARKER');
    expect(rendered).toContain('{"step": 1}');
    expect(countJsonFences(rendered)).toBe(1);
    expect(rendered).toContain(CONTRACT_SENTENCE[lang]);
  });
});
