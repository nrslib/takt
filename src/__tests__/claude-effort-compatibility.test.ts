import { describe, expect, it } from 'vitest';
import { validateClaudeEffortCompatibility } from '../core/workflow/claude-effort-compatibility.js';

describe('validateClaudeEffortCompatibility', () => {
  it('Given undefined model or effort, When validate, Then no throw', () => {
    expect(() => validateClaudeEffortCompatibility(undefined, undefined)).not.toThrow();
    expect(() => validateClaudeEffortCompatibility(undefined, 'xhigh')).not.toThrow();
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-7', undefined)).not.toThrow();
  });

  it('Given alias model with xhigh, When validate, Then no throw (SDK-resolved)', () => {
    expect(() => validateClaudeEffortCompatibility('opus', 'xhigh')).not.toThrow();
    expect(() => validateClaudeEffortCompatibility('sonnet', 'xhigh')).not.toThrow();
    expect(() => validateClaudeEffortCompatibility('haiku', 'xhigh')).not.toThrow();
  });

  it('Given Opus 4.7 with any effort, When validate, Then no throw', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(() => validateClaudeEffortCompatibility('claude-opus-4-7', effort)).not.toThrow();
    }
  });

  it('Given Opus 4.6 with xhigh, When validate, Then throw with helpful message', () => {
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-6', 'xhigh'))
      .toThrow(/'xhigh' is not supported by model 'claude-opus-4-6'/);
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-6', 'xhigh'))
      .toThrow(/Opus 4\.7/);
  });

  it('Given Opus 4.6 with max, When validate, Then no throw', () => {
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-6', 'max')).not.toThrow();
  });

  it('Given Sonnet 4.6 with xhigh, When validate, Then throw', () => {
    expect(() => validateClaudeEffortCompatibility('claude-sonnet-4-6', 'xhigh'))
      .toThrow(/not supported/);
  });

  it('Given Haiku 4.5 with xhigh, When validate, Then throw', () => {
    expect(() => validateClaudeEffortCompatibility('claude-haiku-4-5', 'xhigh'))
      .toThrow(/not supported/);
  });

  it('Given date-pinned Opus 4.7 with xhigh, When validate, Then no throw (prefix match)', () => {
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-7-20260101', 'xhigh')).not.toThrow();
  });

  it('Given date-pinned Opus 4.6 with xhigh, When validate, Then throw (prefix match)', () => {
    expect(() => validateClaudeEffortCompatibility('claude-opus-4-6-20260101', 'xhigh'))
      .toThrow(/not supported/);
  });

  it('Given unknown model with xhigh, When validate, Then no throw (forward compatible)', () => {
    expect(() => validateClaudeEffortCompatibility('claude-opus-5-0', 'xhigh')).not.toThrow();
    expect(() => validateClaudeEffortCompatibility('claude-future-model', 'xhigh')).not.toThrow();
  });
});
