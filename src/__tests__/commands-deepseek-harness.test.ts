import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedDeepSeekHarnessInstallation } from '../infra/deepseek-harness/index.js';

const {
  mockInstallManagedDeepSeekHarness,
  mockSuccess,
  mockInfo,
  rootCommand,
  commandActions,
  commandMocks,
} = vi.hoisted(() => {
  type CommandAction = (...args: unknown[]) => void | Promise<void>;
  const commandActions = new Map<string, CommandAction>();
  const commandMocks = new Map<string, Record<string, unknown>>();

  function createCommandMock(actionKey: string): {
    description: ReturnType<typeof vi.fn>;
    argument: ReturnType<typeof vi.fn>;
    option: ReturnType<typeof vi.fn>;
    opts: ReturnType<typeof vi.fn>;
    optsWithGlobals: ReturnType<typeof vi.fn>;
    action: (action: CommandAction) => unknown;
    command: ReturnType<typeof vi.fn>;
  } {
    const command: Record<string, unknown> = {
      description: vi.fn().mockReturnThis(),
      argument: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(),
      opts: vi.fn(() => ({})),
      optsWithGlobals: vi.fn(() => ({})),
    };
    commandMocks.set(actionKey, command);

    command.command = vi.fn((subName: string) => createCommandMock(`${actionKey}.${subName}`));
    command.action = vi.fn((action: CommandAction) => {
      commandActions.set(actionKey, action);
      return command;
    });

    return command as {
      description: ReturnType<typeof vi.fn>;
      argument: ReturnType<typeof vi.fn>;
      option: ReturnType<typeof vi.fn>;
      opts: ReturnType<typeof vi.fn>;
      optsWithGlobals: ReturnType<typeof vi.fn>;
      action: (action: CommandAction) => unknown;
      command: ReturnType<typeof vi.fn>;
    };
  }

  return {
    mockInstallManagedDeepSeekHarness: vi.fn(),
    mockSuccess: vi.fn(),
    mockInfo: vi.fn(),
    rootCommand: createCommandMock('root'),
    commandActions,
    commandMocks,
  };
});

vi.mock('../app/cli/program.js', () => ({
  program: rootCommand,
}));

vi.mock('../infra/deepseek-harness/index.js', () => ({
  installManagedDeepSeekHarness: mockInstallManagedDeepSeekHarness,
}));

vi.mock('../shared/ui/index.js', () => ({
  success: mockSuccess,
  info: mockInfo,
}));

import '../app/cli/commands.js';

function createInstallation(): ManagedDeepSeekHarnessInstallation {
  return {
    pythonPath: '/opt/python3',
    pythonVersion: '3.10',
    sdkVersion: '0.1.1rc1',
    runtimeVersion: '0.1.1rc1',
    venvPath: '/config/deepseek-harness/venv',
    dshHomePath: '/config/deepseek-harness/dsh-home',
  };
}

describe('CLI deepseek-harness install command', () => {
  beforeEach(() => {
    mockInstallManagedDeepSeekHarness.mockReset();
    mockSuccess.mockClear();
    mockInfo.mockClear();
  });

  it('registers the --python option on the install subcommand', () => {
    const installCommand = commandMocks.get('root.deepseek-harness.install');

    expect(installCommand).toBeTruthy();
    expect(installCommand?.option).toHaveBeenCalledWith(
      '--python <path>',
      'Bootstrap Python executable (default: python3, or python on Windows)',
    );
  });

  it('delegates without an installer option when --python is omitted', async () => {
    mockInstallManagedDeepSeekHarness.mockResolvedValue(createInstallation());
    const installAction = commandActions.get('root.deepseek-harness.install');

    expect(installAction).toBeTypeOf('function');
    await installAction?.({});

    expect(mockInstallManagedDeepSeekHarness).toHaveBeenCalledWith({});
  });

  it('passes the --python value to the installer as pythonPath', async () => {
    mockInstallManagedDeepSeekHarness.mockResolvedValue(createInstallation());
    const installAction = commandActions.get('root.deepseek-harness.install');

    expect(installAction).toBeTypeOf('function');
    await installAction?.({ python: '/opt/python3' });

    expect(mockInstallManagedDeepSeekHarness).toHaveBeenCalledWith({
      pythonPath: '/opt/python3',
    });
  });

  it('displays the installer result for the managed environment', async () => {
    mockInstallManagedDeepSeekHarness.mockResolvedValue({
      pythonPath: '/opt/python3',
      pythonVersion: '3.10',
      sdkVersion: '0.1.1rc1',
      runtimeVersion: '0.1.1rc1',
      venvPath: '/config/deepseek-harness/venv',
      dshHomePath: '/config/deepseek-harness/dsh-home',
    });
    const installAction = commandActions.get('root.deepseek-harness.install');

    expect(installAction).toBeTypeOf('function');
    await installAction?.({});

    expect(mockSuccess).toHaveBeenCalledTimes(1);
    expect(mockSuccess).toHaveBeenCalledWith(
      'DeepSeek Harness managed environment installed (0.1.1rc1)',
    );
    expect(mockInfo.mock.calls).toEqual([
      ['  Python: /opt/python3'],
      ['  VENV: /config/deepseek-harness/venv'],
      ['  DSH_HOME: /config/deepseek-harness/dsh-home'],
    ]);
  });

  it('propagates installer failures to the CLI error boundary', async () => {
    const failure = new Error('managed environment installation failed');
    mockInstallManagedDeepSeekHarness.mockRejectedValue(failure);
    const installAction = commandActions.get('root.deepseek-harness.install');

    expect(installAction).toBeTypeOf('function');
    const execution = installAction?.({});

    await expect(Promise.resolve(execution)).rejects.toBe(failure);
  });
});
