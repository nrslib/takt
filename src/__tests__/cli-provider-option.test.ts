import { describe, expect, it, vi } from 'vitest';
import { program } from '../app/cli/program.js';

describe('CLI --provider option', () => {
  it('Given provider auto on the command line, When parsing CLI options, Then the error explains the concrete-provider migration', async () => {
    const writeErr = vi.fn();
    vi.resetModules();
    const { program: isolatedProgram } = await import('../app/cli/program.js');
    isolatedProgram.exitOverride();
    isolatedProgram.configureOutput({ writeErr });

    expect(() => isolatedProgram.parse(['node', 'takt', '--provider', 'auto'], { from: 'node' }))
      .toThrow();
    expect(writeErr).toHaveBeenCalled();

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
      .toThrow();
    expect(writeErr).toHaveBeenCalled();
  });

  it('Given auto routing is available, When inspecting CLI options, Then --auto-strategy is exposed with supported strategies', () => {
    const autoStrategyOption = program.options.find((option) => option.long === '--auto-strategy');
    const choices = (autoStrategyOption as unknown as { argChoices?: string[] } | undefined)?.argChoices;

    expect(autoStrategyOption).toBeDefined();
    expect(choices).toEqual(['cost', 'balanced', 'performance']);
  });

  it('Given an unsupported auto strategy, When parsing CLI options, Then Commander rejects it', async () => {
    const writeErr = vi.fn();
    vi.resetModules();
    const { program: isolatedProgram } = await import('../app/cli/program.js');
    isolatedProgram.exitOverride();
    isolatedProgram.configureOutput({ writeErr });

    expect(() => isolatedProgram.parse(['node', 'takt', '--auto-strategy', 'invalid'], { from: 'node' }))
      .toThrow();
    expect(writeErr).toHaveBeenCalled();

    isolatedProgram.parse(['node', 'takt', '--auto-strategy', 'cost'], { from: 'node' });
    expect(isolatedProgram.opts().autoStrategy).toBe('cost');
    expect(program.opts().autoStrategy).toBeUndefined();
  });

  it('should expose only one workflow option', () => {
    const workflowOptions = program.options.filter((option) => option.long === '--workflow');

    expect(workflowOptions).toHaveLength(1);
  });

});
