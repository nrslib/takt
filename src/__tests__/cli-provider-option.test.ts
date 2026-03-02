import { describe, expect, it } from 'vitest';
import { program } from '../app/cli/program.js';

describe('CLI --provider option', () => {
  it('should include cursor in provider help text', () => {
    const providerOption = program.options.find((option) => option.long === '--provider');

    expect(providerOption).toBeDefined();
    expect(providerOption?.description).toContain('cursor');
  });
});
