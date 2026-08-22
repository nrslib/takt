import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProgramOpts: Record<string, unknown> = {};
const mockRunCommandOpts: Record<string, unknown> = {};
const mockRunAllTasks = vi.fn();

const { rootCommand, commandActions, commandMocks } = vi.hoisted(() => {
  const commandActions = new Map<string, (...args: unknown[]) => void>();
  const commandMocks = new Map<string, Record<string, unknown>>();

  function createCommandMock(actionKey: string): {
    description: ReturnType<typeof vi.fn>;
    argument: ReturnType<typeof vi.fn>;
    option: ReturnType<typeof vi.fn>;
    opts: ReturnType<typeof vi.fn>;
    optsWithGlobals: ReturnType<typeof vi.fn>;
    action: (action: (...args: unknown[]) => void) => unknown;
    command: ReturnType<typeof vi.fn>;
  } {
    const command: Record<string, unknown> = {
      description: vi.fn().mockReturnThis(),
      argument: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(),
      opts: vi.fn(() => mockProgramOpts),
      optsWithGlobals: vi.fn(() => mockRunCommandOpts),
    };
    commandMocks.set(actionKey, command);

    command.command = vi.fn((subName: string) => createCommandMock(`${actionKey}.${subName}`));
    command.action = vi.fn((action: (...args: unknown[]) => void) => {
      commandActions.set(actionKey, action);
      return command;
    });

    return command as {
      description: ReturnType<typeof vi.fn>;
      argument: ReturnType<typeof vi.fn>;
      option: ReturnType<typeof vi.fn>;
      opts: ReturnType<typeof vi.fn>;
      optsWithGlobals: ReturnType<typeof vi.fn>;
      action: (action: (...args: unknown[]) => void) => unknown;
      command: ReturnType<typeof vi.fn>;
    };
  }

  return {
    rootCommand: createCommandMock('root'),
    commandActions,
    commandMocks,
  };
});

vi.mock('../app/cli/program.js', () => ({
  program: rootCommand,
}));

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: vi.fn(() => ({ cwd: '/test/cwd', pipelineMode: false })),
}));

vi.mock('../features/tasks/execute/runAllTasks.js', () => ({
  runAllTasks: (...args: unknown[]) => mockRunAllTasks(...args),
}));

import '../app/cli/commands.js';

describe('CLI run command', () => {
  beforeEach(() => {
    mockRunAllTasks.mockClear();
    for (const key of Object.keys(mockProgramOpts)) {
      delete mockProgramOpts[key];
    }
    for (const key of Object.keys(mockRunCommandOpts)) {
      delete mockRunCommandOpts[key];
    }
  });

  it('run コマンドに --ignore-exceed オプションを登録する', () => {
    const runCommand = commandMocks.get('root.run');

    expect(runCommand).toBeTruthy();
    expect(runCommand?.option).toHaveBeenCalledWith(
      '--ignore-exceed',
      'Ignore workflow max_steps and continue running tasks',
    );
  });

  it('run 実行時に --ignore-exceed 指定がある場合だけ ignoreExceed を渡す', async () => {
    mockProgramOpts.provider = 'openai';
    mockProgramOpts.model = 'gpt-5';
    mockRunCommandOpts.ignoreExceed = true;

    const runAction = commandActions.get('root.run');
    const runCommand = commandMocks.get('root.run');

    await runAction?.(undefined, runCommand as never);

    expect(mockRunAllTasks).toHaveBeenCalledWith('/test/cwd', {
      provider: 'openai',
      providerSource: 'cli',
      model: 'gpt-5',
      modelSource: 'cli',
      ignoreExceed: true,
    });
  });

  it('run 実行時に --ignore-exceed 未指定なら config 値を潰す false を渡さない', async () => {
    mockProgramOpts.provider = 'openai';

    const runAction = commandActions.get('root.run');
    const runCommand = commandMocks.get('root.run');

    await runAction?.(undefined, runCommand as never);

    expect(mockRunAllTasks).toHaveBeenCalledWith('/test/cwd', {
      provider: 'openai',
      providerSource: 'cli',
    });
  });

  it('should propagate a run implementation error to the CLI error boundary', async () => {
    const implementationError = new Error('run implementation failed');
    mockRunAllTasks.mockRejectedValueOnce(implementationError);
    const runAction = commandActions.get('root.run');
    const runCommand = commandMocks.get('root.run');

    const execution = runAction?.(undefined, runCommand as never);

    await expect(execution).rejects.toBe(implementationError);
  });
});
