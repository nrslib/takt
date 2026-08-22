import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProgramOpts: Record<string, unknown> = {};
const mockWatchCommandOpts: Record<string, unknown> = {};
const mockWatchTasks = vi.fn();

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
      optsWithGlobals: vi.fn(() => mockWatchCommandOpts),
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

vi.mock('../features/tasks/watch/index.js', () => ({
  watchTasks: (...args: unknown[]) => mockWatchTasks(...args),
}));

import '../app/cli/commands.js';

describe('CLI watch command', () => {
  beforeEach(() => {
    mockWatchTasks.mockClear();
    for (const key of Object.keys(mockProgramOpts)) {
      delete mockProgramOpts[key];
    }
    for (const key of Object.keys(mockWatchCommandOpts)) {
      delete mockWatchCommandOpts[key];
    }
  });

  it('watch コマンドに --ignore-exceed オプションを登録する', () => {
    const watchCommand = commandMocks.get('root.watch');

    expect(watchCommand).toBeTruthy();
    expect(watchCommand?.option).toHaveBeenCalledWith(
      '--ignore-exceed',
      'Ignore workflow max_steps and continue running tasks',
    );
  });

  it('watch 実行時に ignoreExceed を agentOverrides と合わせて watchTasks へ渡す', async () => {
    mockProgramOpts.provider = 'codex';
    mockProgramOpts.model = 'gpt-5';
    mockProgramOpts.autoStrategy = 'performance';
    mockWatchCommandOpts.ignoreExceed = true;

    const watchAction = commandActions.get('root.watch');
    const watchCommand = commandMocks.get('root.watch');

    expect(watchAction).toBeTypeOf('function');
    expect(watchCommand).toBeTruthy();

    await watchAction?.(undefined, watchCommand as never);

    expect(watchCommand?.optsWithGlobals).toHaveBeenCalled();
    expect(mockWatchTasks).toHaveBeenCalledWith('/test/cwd', {
      provider: 'codex',
      providerSource: 'cli',
      model: 'gpt-5',
      modelSource: 'cli',
      autoStrategy: 'performance',
      ignoreExceed: true,
    });
  });

  it('watch 実行時に --ignore-exceed 未指定なら ignoreExceed を渡さない', async () => {
    mockProgramOpts.provider = 'codex';

    const watchAction = commandActions.get('root.watch');
    const watchCommand = commandMocks.get('root.watch');

    await watchAction?.(undefined, watchCommand as never);

    expect(mockWatchTasks).toHaveBeenCalledWith('/test/cwd', {
      provider: 'codex',
      providerSource: 'cli',
    });
  });

  it('watch 実行時に --ignore-exceed 未指定なら config 由来 ignore_exceed を上書きしない', async () => {
    const watchAction = commandActions.get('root.watch');
    const watchCommand = commandMocks.get('root.watch');

    await watchAction?.(undefined, watchCommand as never);

    expect(mockWatchTasks).toHaveBeenCalledWith('/test/cwd', {});
  });
});
