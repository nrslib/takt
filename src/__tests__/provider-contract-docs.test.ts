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
  it('keeps schema and CLI help provider lists aligned', () => {
    const providerOption = program.options.find((option) => option.long === '--provider');

    expect(Object.values(ProviderTypeSchema.enum)).toEqual([...providerValues]);
    expect(providerOption?.description).toContain(`(${providerPipeList})`);
  });
});
