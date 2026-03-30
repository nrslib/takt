import { describe, expect, it } from 'vitest';
import { program } from '../app/cli/program.js';

describe('CLI --provider option', () => {
  it('should include cursor in provider help text', () => {
    const providerOption = program.options.find((option) => option.long === '--provider');

    expect(providerOption).toBeDefined();
    expect(providerOption?.description).toContain('cursor');
  });

  it('should describe --piece with workflow terminology', () => {
    const pieceOption = program.options.find((option) => option.long === '--piece');

    expect(pieceOption).toBeDefined();
    expect(pieceOption?.description).toBe('Workflow name or path to workflow file');
  });
});
