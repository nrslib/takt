import { describe, expect, it } from 'vitest';
import { program } from '../app/cli/program.js';

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

  it('Given auto routing is available, When inspecting provider help text, Then provider auto is listed', () => {
    const providerOption = program.options.find((option) => option.long === '--provider');

    expect(providerOption?.description).toContain('auto');
  });

  it('Given auto routing is available, When inspecting CLI options, Then --auto-strategy is exposed with supported strategies', () => {
    const autoStrategyOption = program.options.find((option) => option.long === '--auto-strategy');

    expect(autoStrategyOption).toBeDefined();
    expect(autoStrategyOption?.description).toContain('cost');
    expect(autoStrategyOption?.description).toContain('balanced');
    expect(autoStrategyOption?.description).toContain('performance');
  });

  it('should expose only one workflow option', () => {
    const workflowOptions = program.options.filter((option) => option.long === '--workflow');

    expect(workflowOptions).toHaveLength(1);
  });

  it('should expose --workflow as the canonical workflow option', () => {
    const workflowOption = program.options.find((option) => option.long === '--workflow');

    expect(workflowOption).toBeDefined();
    expect(workflowOption?.description).toBe('Workflow name or path to workflow file');
  });
});
