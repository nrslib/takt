import { describe, expect, it } from 'vitest';
import { resolveWorkflowCliOption } from '../app/cli/helpers.js';
import { program } from '../app/cli/program.js';

const legacyWorkflowOptionKey = ['pi', 'ece'].join('');
const legacyWorkflowFlag = `--${legacyWorkflowOptionKey}`;

describe('CLI workflow canonical naming', () => {
  it('should expose only the canonical workflow option in global help', () => {
    // Given
    const workflowOptions = program.options.filter((option) => option.long === '--workflow');

    // Then
    expect(workflowOptions).toHaveLength(1);
    expect(workflowOptions[0]?.description).toBe('Workflow name or path to workflow file');
  });

  it('should resolve the workflow option when the canonical key is provided', () => {
    // Given
    const opts = { workflow: 'default' };

    // When
    const resolved = resolveWorkflowCliOption(opts);

    // Then
    expect(resolved).toBe('default');
  });

  it('should ignore removed legacy option keys in CLI option resolution', () => {
    // Given
    const opts = { [legacyWorkflowOptionKey]: 'legacy-default' };

    // When
    const resolved = resolveWorkflowCliOption(opts);

    // Then
    expect(resolved).toBeUndefined();
  });

  it('should prefer the canonical workflow key when a removed legacy key is also present', () => {
    // Given
    const opts = {
      workflow: 'default',
      [legacyWorkflowOptionKey]: 'legacy-default',
    };

    // When
    const resolved = resolveWorkflowCliOption(opts);

    // Then
    expect(resolved).toBe('default');
  });

  it('should not mention removed legacy terminology in help output', () => {
    // When
    const help = program.helpInformation();

    // Then
    expect(help).toContain('--workflow <name>');
    expect(help).not.toContain(legacyWorkflowFlag);
    expect(help).not.toMatch(/\bpiece\b/i);
  });
});
