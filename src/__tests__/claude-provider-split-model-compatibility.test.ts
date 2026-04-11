import { describe, expect, it } from 'vitest';
import { validateProviderModelCompatibility } from '../core/workflow/provider-model-compatibility.js';

describe('validateProviderModelCompatibility (Claude split)', () => {
  it('Given codex provider and Claude model alias, When validate, Then error mentions claude-sdk', () => {
    expect(() => validateProviderModelCompatibility('codex', 'sonnet')).toThrow(/claude-sdk/);
  });

  it('Given opencode provider and Claude model alias, When validate, Then error mentions claude-sdk', () => {
    expect(() => validateProviderModelCompatibility('opencode', 'opus')).toThrow(/claude-sdk/);
  });
});
