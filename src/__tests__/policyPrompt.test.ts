import { describe, expect, it } from 'vitest';

import { buildInteractivePolicyPrompt } from '../features/interactive/policyPrompt.js';

describe('buildInteractivePolicyPrompt', () => {
  it('builds the Japanese policy wrapper with the shared interactive policy template', () => {
    const result = buildInteractivePolicyPrompt('ja', 'ユーザー入力');

    expect(result).toContain('## Policy');
    expect(result).toContain('以下のポリシーは行動規範です。必ず遵守してください。');
    expect(result).toContain('対話モードポリシー');
    expect(result).toContain('ユーザー入力');
    expect(result).toContain('上記の Policy セクションで定義されたポリシー規範を遵守してください。');
  });

  it('builds the English policy wrapper with the shared interactive policy template', () => {
    const result = buildInteractivePolicyPrompt('en', 'User input');

    expect(result).toContain('## Policy');
    expect(result).toContain('The following policy defines behavioral guidelines. Please follow them.');
    expect(result).toContain('Interactive Mode Policy');
    expect(result).toContain('User input');
    expect(result).toContain('Please follow the policy guidelines defined in the Policy section above.');
  });

  it('includes source context before the user message when provided', () => {
    const buildPrompt = buildInteractivePolicyPrompt as unknown as (
      lang: 'en' | 'ja',
      userMessage: string,
      sourceContext?: string,
    ) => string;

    const result = buildPrompt('en', 'User input', 'PR context');

    expect(result).toContain('PR context');
    expect(result).toContain('User input');
    expect(result).toContain('untrusted external reference data');
    expect(result).toContain('```text');
    expect(result.indexOf('PR context')).toBeLessThan(result.indexOf('User input'));
  });

  it('keeps Japanese source context separate from the user message when provided', () => {
    const buildPrompt = buildInteractivePolicyPrompt as unknown as (
      lang: 'en' | 'ja',
      userMessage: string,
      sourceContext?: string,
    ) => string;

    const result = buildPrompt('ja', 'ユーザー入力', 'PR文脈');

    expect(result).toContain('PR文脈');
    expect(result).toContain('ユーザー入力');
    expect(result).toContain('外部由来の非信頼な参照データ');
    expect(result).toContain('```text');
    expect(result.indexOf('PR文脈')).toBeLessThan(result.indexOf('ユーザー入力'));
  });
});
