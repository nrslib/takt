import { describe, expect, it } from 'vitest';
import { validateClaudeEffortCompatibility } from '../core/workflow/claude-effort-compatibility.js';

describe('validateClaudeEffortCompatibility', () => {
  it('Given undefined model or effort, When validate, Then no throw', () => {
    expect(() => validateClaudeEffortCompatibility(undefined, undefined)).not.toThrow();
    expect(() => validateClaudeEffortCompatibility(undefined, 'xhigh')).not.toThrow();
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-7', undefined)).not.toThrow();
  });

  it('Given alias model with xhigh, When validate, Then no throw (SDK-resolved)', () => {
    for (const alias of ['opus', 'sonnet', 'haiku', 'opusplan', 'default']) {
      expect(() => validateClaudeEffortCompatibility(alias, 'xhigh')).not.toThrow();
    }
  });

  it('Given Opus 4.7 with any effort, When validate, Then no throw', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(() => validateClaudeEffortCompatibility('claude-opus-4-7', effort)).not.toThrow();
    }
  });

  it('Given date-pinned Opus 4.7 with xhigh, When validate, Then no throw (prefix match)', () => {
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-7-20260101', 'xhigh')).not.toThrow();
  });

  it('Given Opus 4.6 with xhigh, When validate, Then throw with helpful message', () => {
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-6', 'xhigh'))
      .toThrow(/'xhigh' is not supported by model 'claude-opus-4-6'/);
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-6', 'xhigh'))
      .toThrow(/Opus 4\.7/);
  });

  it('Given Sonnet 4.6 with xhigh, When validate, Then throw', () => {
    expect(() => validateClaudeEffortCompatibility('claude-sonnet-4-6', 'xhigh'))
      .toThrow(/not supported/);
  });

  it('Given Sonnet 4.5 (date-pinned, documented example) with xhigh, When validate, Then throw', () => {
    expect(() => validateClaudeEffortCompatibility('claude-sonnet-4-5-20250929', 'xhigh'))
      .toThrow(/not supported/);
  });

  it('Given Haiku 4.5 with xhigh, When validate, Then throw', () => {
    expect(() => validateClaudeEffortCompatibility('claude-haiku-4-5', 'xhigh'))
      .toThrow(/not supported/);
    expect(() => validateClaudeEffortCompatibility('claude-haiku-4-5-20251001', 'xhigh'))
      .toThrow(/not supported/);
  });

  it('Given older Claude model with xhigh, When validate, Then throw', () => {
    expect(() => validateClaudeEffortCompatibility('claude-3-5-sonnet-20241022', 'xhigh'))
      .toThrow(/not supported/);
  });

  it('Given any claude-* model with non-xhigh effort, When validate, Then no throw', () => {
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      expect(() => validateClaudeEffortCompatibility('claude-opus-4-6', effort)).not.toThrow();
      expect(() => validateClaudeEffortCompatibility('claude-sonnet-4-5-20250929', effort)).not.toThrow();
      expect(() => validateClaudeEffortCompatibility('claude-haiku-4-5', effort)).not.toThrow();
    }
  });

  it('Given non-claude model id with xhigh, When validate, Then no throw (out of scope)', () => {
    expect(() => validateClaudeEffortCompatibility('gpt-foo', 'xhigh')).not.toThrow();
    expect(() => validateClaudeEffortCompatibility('some-other-model', 'xhigh')).not.toThrow();
  });
});
