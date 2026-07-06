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

  it('Given opencode provider without model, When validate, Then model requirement fails', () => {
    expect(() => validateProviderModelRequirements('opencode', undefined)).toThrow(/requires model/);
  });

  it('Given opencode provider with provider/model format, When validate, Then no throw', () => {
    expect(() => validateProviderModelRequirements('opencode', 'opencode/big-pickle')).not.toThrow();
  });
});
