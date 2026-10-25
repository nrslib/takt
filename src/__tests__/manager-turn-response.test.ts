import { describe, expect, it } from 'vitest';
import { assertStrictStructuredOutputSchema, validateStructuredOutputAgainstSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import { getManagerOutputSchema, parseManagerResponse } from '../features/manager/turnResponse.js';
import type { AgentResponse } from '../core/models/response.js';

const summary = { objective: 'CSVを出力する', outOfScope: ['JSON出力'],
  acceptanceCriteria: ['CSVを取得できる'], constraints: ['git commit 禁止'] };
function response(value: unknown, content?: string): AgentResponse {
  return { persona: 'manager', status: 'done', timestamp: new Date(),
    content: content ?? JSON.stringify(value), structuredOutput: value as AgentResponse['structuredOutput'] };
}
const parse = (value: unknown, provider: 'mock' | 'codex', content?: string) => parseManagerResponse(response(value, content), provider);

describe.each(['mock', 'codex'] as const)('manager response normalization with %s', (provider) => {
  it.each(['通常の返事です。', '[進捗] 調査を続けます。', '  \n[進捗] 調査を続けます。\n\t ',
    '  \n相談を続けます。\n次の確認を行います。\t ', '引用です。\n> ' + JSON.stringify(summary)])(
    'preserves plain content without inventing an approval target: %j', (content) => {
      expect(parseManagerResponse(response(undefined, content), provider)).toEqual({ message: content, summary: null });
    });

  it('accepts a JSON content response and its complete summary', () => {
    expect(parse(undefined, provider, JSON.stringify({ message: '確認', summary }))).toEqual({ message: '確認', summary });
  });

  it.each(['{"message":"壊れたJSON","summary":null,}', ' \n{"message":"閉じ括弧がない"', '[{"message":"閉じ括弧がない"}',
    '[]', '[ \n ]', '[{"message":"確認","summary":null}]', '["確認"]', '[0]', '[-1]', '[true]', '[false]', '[null]', '[[]]', '[', '[ \n',
    '{}', '{"message":"summaryがない"}', JSON.stringify({ message: '不正な要約', summary: { ...summary, acceptanceCriteria: [] } })])(
    'rejects malformed or schema-invalid content: %s', (content) => {
      expect(() => parse(undefined, provider, content)).toThrow();
    });

  it.each(['普通の文章', '[進捗] 調査を続けます。', '{broken JSON'])('prioritizes structured output over %s', (content) => {
    expect(parse({ message: '構造化した返事', summary }, provider, content)).toEqual({ message: '構造化した返事', summary });
  });

  it.each([{}, { message: '不正な要約', summary: { ...summary, objective: '' } }])(
    'rejects invalid structured output without falling back to valid content: %j', (invalid) => {
      expect(() => parse(invalid, provider, JSON.stringify({ message: '確認', summary }))).toThrow();
      expect(() => parse(invalid, provider, '[進捗] 調査を続けます。')).toThrow();
    });

  it.each(['structuredOutput', 'content'] as const)('preserves safe array values and branches from %s', (format) => {
    const safe = { ...summary, objective: 'CSV\n列名\t値', outOfScope: ['CSV', 'CSV; 通知', 'CSV","通知', 'CSV', 'CSV'],
      acceptanceCriteria: ['CSV\n通知\n配信', '次の項目'], startBranch: 'release', integrationBranch: 'main' };
    const value = { message: '\u001b[31m返事\u001b[0m', summary: safe };
    const parsed = format === 'content' ? parse(undefined, provider, JSON.stringify(value)) : parse(value, provider);
    expect(parsed).toEqual(value);
  });

  it.each(['structuredOutput', 'content'] as const)('rejects unsafe summaries from %s without modifying their strings', (format) => {
    for (const invalid of [
      { ...summary, objective: 'CSV\u0000出力' }, { ...summary, objective: '\u001b[31mCSVを出力する\u001b[0m' },
      { ...summary, objective: 'CSV\u001b]0;title\u0007出力' }, { ...summary, objective: 'CSV\u0085出力' },
      { ...summary, outOfScope: ['JSON出力', '通知\u0007'] }, { ...summary, acceptanceCriteria: ['CSVを取得できる', '列名\u001b['] },
      { ...summary, startBranch: 'release\u0085' }, { ...summary, integrationBranch: 'main\u0085' },
    ]) {
      const value = { message: '確認', summary: invalid };
      expect(() => format === 'content' ? parse(undefined, provider, JSON.stringify(value)) : parse(value, provider)).toThrow();
    }
  });

  it.each([7, 9])('preserves every one of %i large constraints', (count) => {
    const value = { message: '確認', summary: { ...summary,
      constraints: Array.from({ length: count }, (_, index) => String(index).padEnd(128 * 1024, 'a')) } };
    expect(parse(value, provider)).toEqual(value);
    expect(parse(undefined, provider, JSON.stringify(value))).toEqual(value);
  });
});

it('uses a strict Codex schema requiring both nullable branches and repository', () => {
  const schema = getManagerOutputSchema('codex');
  expect(() => assertStrictStructuredOutputSchema(schema)).not.toThrow();
  const wire = { ...summary, repositoryDirectory: null, startBranch: null, integrationBranch: null };
  expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: wire }, schema)).not.toThrow();
  expect(() => validateStructuredOutputAgainstSchema({ message: '相談', summary: null }, schema)).not.toThrow();
  for (const branch of ['repositoryDirectory', 'startBranch', 'integrationBranch'] as const) {
    const missing: Record<string, unknown> = { ...wire }; delete missing[branch];
    expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: missing }, schema)).toThrow();
    expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...wire, [branch]: 'release' } }, schema)).not.toThrow();
  }
});

describe.each(['structuredOutput', 'content'] as const)('Codex summaries from %s', (format) => {
  it.each([
    { branches: { repositoryDirectory: null, startBranch: null, integrationBranch: null }, expected: {} },
    { branches: { startBranch: null, integrationBranch: 'release' }, expected: { integrationBranch: 'release' } },
    { branches: { startBranch: 'release', integrationBranch: null }, expected: { startBranch: 'release' } },
    { branches: { startBranch: 'null', integrationBranch: 'main' }, expected: { startBranch: 'null', integrationBranch: 'main' } },
    { branches: {}, expected: {} },
  ])('normalizes only null optional fields: $branches', ({ branches, expected }) => {
    const value = { message: '確認', summary: { ...summary, ...branches } };
    const parsed = format === 'content' ? parse(undefined, 'codex', JSON.stringify(value)) : parse(value, 'codex');
    expect(parsed.summary).toEqual({ ...summary, ...expected });
  });

  it.each([
    { objective: null }, { objective: '' }, { objective: '   ' }, { objective: 'a'.repeat(128 * 1024 + 1) },
    { acceptanceCriteria: [] }, { objective: 'CSV\u0000出力' }, { integrationBranch: 'bad branch' }, { unexpected: 'value' },
  ])('retains validation after null normalization: %j', (invalid) => {
    const value = { message: '確認', summary: { ...summary, repositoryDirectory: null, startBranch: null, integrationBranch: null, ...invalid } };
    expect(() => format === 'content' ? parse(undefined, 'codex', JSON.stringify(value)) : parse(value, 'codex')).toThrow();
  });
});

it.each(['claude', 'claude-sdk'] as const)('preserves optional branches and validation in the %s provider schema', (provider) => {
  const schema = getManagerOutputSchema(provider);
  expect(schema).not.toHaveProperty('$schema');
  expect(schema).toMatchObject({ properties: { message: { minLength: 1 } } });
  for (const optional of [{}, { startBranch: 'release', integrationBranch: 'main' }]) {
    expect(() => validateStructuredOutputAgainstSchema({ message: '確認', summary: { ...summary, ...optional } }, schema)).not.toThrow();
  }
  for (const value of [
    { message: '', summary }, { message: '確認', summary: { ...summary, acceptanceCriteria: [] } },
    { message: '確認', summary: { ...summary, repositoryDirectory: null, startBranch: null, integrationBranch: null } },
    { message: '確認', summary: { ...summary, objective: 'a'.repeat(128 * 1024 + 1) } },
  ]) expect(() => validateStructuredOutputAgainstSchema(value, schema)).toThrow();
});
