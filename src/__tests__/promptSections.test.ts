import { describe, expect, it } from 'vitest';

import {
  formatSourceContextSection,
  prependSourceContext,
} from '../features/interactive/promptSections.js';

describe('formatSourceContextSection', () => {
  it('returns an empty string when source context is not provided', () => {
    expect(formatSourceContextSection('en')).toBe('');
  });

  it('uses a fence longer than the source context content', () => {
    const sourceContext = 'Review note\n```ts\nconst value = 1;\n```';

    const result = formatSourceContextSection('en', sourceContext);

    expect(result).toContain('## Source Context');
    expect(result).toContain('untrusted reference data');
    expect(result).toContain('````text');
    expect(result).toContain(sourceContext);
    expect(result).toContain('\n````');
    expect(result).not.toMatch(/(^|\n)```text(\n|$)/);
  });
});

describe('prependSourceContext', () => {
  it('keeps the source context block separate from the user message', () => {
    const result = prependSourceContext('ja', 'ユーザー要求', 'PR文脈');

    expect(result).toContain('## Source Context');
    expect(result).toContain('PR文脈');
    expect(result).toContain('ユーザー要求');
    expect(result.indexOf('PR文脈')).toBeLessThan(result.indexOf('ユーザー要求'));
  });
});
