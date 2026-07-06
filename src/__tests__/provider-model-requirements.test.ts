import { describe, expect, it } from 'vitest';
import { validateProviderModelRequirements } from '../core/workflow/provider-model-requirements.js';

describe('validateProviderModelRequirements', () => {
  it('Given codex provider and arbitrary model name, When validate, Then downstream provider decides support', () => {
    expect(() => validateProviderModelRequirements('codex', 'sonnet')).not.toThrow();
    expect(() => validateProviderModelRequirements('codex', 'opus')).not.toThrow();
  });

  it('Given opencode provider and bare model, When validate, Then provider/model validation fails', () => {
    expect(() => validateProviderModelRequirements('opencode', 'big-pickle')).toThrow(/provider\/model/);
  });
});
