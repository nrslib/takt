import { describe, expect, it, vi } from 'vitest';
import { program } from '../app/cli/program.js';

vi.mock('../app/cli/initialization.js', () => ({
  assertConfigDirsDoNotCollide: vi.fn(),
  initializeCliExecutionContext: vi.fn(async () => undefined),
}));
vi.mock('../app/cli/updateCheck.js', () => ({ runUpdateCheck: vi.fn(async () => undefined) }));

describe('CLI --provider option', () => {
  it.each(['claude-sdk', 'claude', 'claude-headless', 'claude-terminal'])('should accept %s as a provider', async (provider) => {
    vi.resetModules();
    const { program: isolatedProgram } = await import('../app/cli/program.js');
    isolatedProgram.exitOverride();
    isolatedProgram.parse(['node', 'takt', '--provider', provider], { from: 'node' });
    expect(isolatedProgram.opts().provider).toBe(provider);
  });

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

  it.each([
    { entry: 'interactive', args: [] },
    { entry: 'direct execution', args: ['--task', 'execute directly'] },
    { entry: 'pipeline', args: ['--pipeline', '--task', 'execute pipeline'] },
    { entry: 'run', args: ['run'] },
    { entry: 'watch', args: ['watch'] },
    { entry: 'list', args: ['list', '--non-interactive'] },
  ])('accepts runtime selection options through $entry', async ({ args }) => {
    vi.resetModules();
    const { program: isolatedProgram } = await import('../app/cli/program.js');
    await import('../app/cli/commands.js');
    const action = vi.fn();
    isolatedProgram.action(action);
    for (const command of isolatedProgram.commands) command.action(action);
    isolatedProgram.configureOutput({ writeErr: vi.fn() });

    await isolatedProgram.parseAsync([
      'node', 'takt', ...args,
      '--runtime-assignment', 'personal-quality',
      '--runtime-file', '.takt/runtime.quality.yaml',
    ]);

    expect(isolatedProgram.opts().runtimeAssignment).toBe('personal-quality');
    expect(isolatedProgram.opts().runtimeFile).toBe('.takt/runtime.quality.yaml');
    expect(action).toHaveBeenCalledTimes(1);
  });
});
