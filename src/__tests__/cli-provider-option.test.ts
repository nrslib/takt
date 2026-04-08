import { describe, expect, it } from 'vitest';
import { program } from '../app/cli/program.js';

const removedWorkflowOptionName = `--${['p', 'i', 'e', 'c', 'e'].join('')}`;

describe('CLI --provider option', () => {
  it('should include cursor in provider help text', () => {
    const providerOption = program.options.find((option) => option.long === '--provider');

    expect(providerOption).toBeDefined();
    expect(providerOption?.description).toContain('cursor');
  });

  it('should list claude-sdk and headless claude in provider help text', () => {
    const providerOption = program.options.find((option) => option.long === '--provider');

    expect(providerOption?.description).toContain('claude-sdk');
    expect(providerOption?.description).toMatch(/claude\|/);
  });

  it('should not expose removed legacy workflow option', () => {
    const removedWorkflowOption = program.options.find((option) => option.long === removedWorkflowOptionName);

    expect(removedWorkflowOption).toBeUndefined();
  });

  it('should expose --workflow as the canonical workflow option', () => {
    const workflowOption = program.options.find((option) => option.long === '--workflow');

    expect(workflowOption).toBeDefined();
    expect(workflowOption?.description).toBe('Workflow name or path to workflow file');
  });
});
