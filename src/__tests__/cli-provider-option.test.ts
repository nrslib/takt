import { describe, expect, it, vi } from 'vitest';
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

  it('Given provider selection is concrete-only, When inspecting provider help text, Then provider auto is not listed', () => {
    const providerOption = program.options.find((option) => option.long === '--provider');

    expect(providerOption?.description).not.toMatch(/\bauto\b/);
  });

  it('Given provider auto on the command line, When parsing CLI options, Then the error explains the concrete-provider migration', async () => {
    const writeErr = vi.fn();
    vi.resetModules();
    const { program: isolatedProgram } = await import('../app/cli/program.js');
    isolatedProgram.exitOverride();
    isolatedProgram.configureOutput({ writeErr });

    expect(() => isolatedProgram.parse(['node', 'takt', '--provider', 'auto'], { from: 'node' }))
      .toThrow(/provider: auto has been removed/i);
    expect(writeErr.mock.calls.join('\n')).toMatch(/concrete provider.*auto_routing/i);

    isolatedProgram.parse(['node', 'takt', '--provider', 'mock'], { from: 'node' });
    expect(isolatedProgram.opts().provider).toBe('mock');
    expect(program.opts().provider).toBeUndefined();
  });

  it('Given an unknown provider on the command line, When parsing CLI options, Then the error lists the allowed concrete choices', async () => {
    const writeErr = vi.fn();
    vi.resetModules();
    const { program: isolatedProgram } = await import('../app/cli/program.js');
    isolatedProgram.exitOverride();
    isolatedProgram.configureOutput({ writeErr });

    expect(() => isolatedProgram.parse(['node', 'takt', '--provider', 'unknown'], { from: 'node' }))
      .toThrow(/allowed choices/i);
    expect(writeErr.mock.calls.join('\n')).toMatch(/claude.*codex.*mock/i);
  });

  it('Given auto routing is available, When inspecting CLI options, Then --auto-strategy is exposed with supported strategies', () => {
    const autoStrategyOption = program.options.find((option) => option.long === '--auto-strategy');
    const choices = (autoStrategyOption as unknown as { argChoices?: string[] } | undefined)?.argChoices;

    expect(autoStrategyOption).toBeDefined();
    expect(autoStrategyOption?.description).toContain('cost');
    expect(autoStrategyOption?.description).toContain('balanced');
    expect(autoStrategyOption?.description).toContain('performance');
    expect(choices).toEqual(['cost', 'balanced', 'performance']);
  });

  it('Given an unsupported auto strategy, When parsing CLI options, Then Commander rejects it', async () => {
    const writeErr = vi.fn();
    vi.resetModules();
    const { program: isolatedProgram } = await import('../app/cli/program.js');
    isolatedProgram.exitOverride();
    isolatedProgram.configureOutput({ writeErr });

    expect(() => isolatedProgram.parse(['node', 'takt', '--auto-strategy', 'invalid'], { from: 'node' }))
      .toThrow(/invalid choice|allowed choices/i);
    expect(writeErr.mock.calls.join('\n')).toMatch(/invalid choice|allowed choices/i);

    isolatedProgram.parse(['node', 'takt', '--auto-strategy', 'cost'], { from: 'node' });
    expect(isolatedProgram.opts().autoStrategy).toBe('cost');
    expect(program.opts().autoStrategy).toBeUndefined();
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
