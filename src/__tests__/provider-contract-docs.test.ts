import { describe, expect, it } from 'vitest';

import { program } from '../app/cli/program.js';
import { ProviderTypeSchema } from '../core/models/schema-base.js';

const providerValues = [
  'claude',
  'claude-sdk',
  'claude-terminal',
  'codex',
  'opencode',
  'cursor',
  'copilot',
  'kiro',
  'mock',
] as const;

const providerPipeList = providerValues.join('|');

describe('provider contract documentation', () => {
  it('keeps runtime provider schema and CLI provider input contract concrete and aligned', () => {
    const providerOption = program.options.find((option) => option.long === '--provider');

    expect(Object.values(ProviderTypeSchema.enum)).toEqual([...providerValues]);
    expect(ProviderTypeSchema.safeParse('auto').success).toBe(false);
    expect(providerOption?.description).toContain(`(${providerPipeList})`);
    expect(providerOption?.description).not.toMatch(/\bauto\b/);
  });
});
