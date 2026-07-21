import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProgramOpts: Record<string, unknown> = {};
const mockResumeDirectRun = vi.fn();

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
      optsWithGlobals: vi.fn(() => mockProgramOpts),
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

vi.mock('../features/tasks/resume/index.js', () => ({
  resumeDirectRun: (...args: unknown[]) => mockResumeDirectRun(...args),
}));

import '../app/cli/commands.js';

describe('CLI resume command', () => {
  beforeEach(() => {
    mockResumeDirectRun.mockClear();
    for (const key of Object.keys(mockProgramOpts)) {
      delete mockProgramOpts[key];
    }
  });

  it('registers the resume command', () => {
    const calledCommandNames = rootCommand.command.mock.calls
      .map((call: unknown[]) => call[0] as string);

    expect(calledCommandNames).toContain('resume');
    expect(commandMocks.get('root.resume')?.description)
      .toHaveBeenCalledWith('Resume the latest failed or aborted direct run');
  });

  it('passes CLI provider and model overrides to direct run resume', async () => {
    mockProgramOpts.provider = 'mock';
    mockProgramOpts.model = 'gpt-test';
    const resumeAction = commandActions.get('root.resume');

    expect(resumeAction).toBeTypeOf('function');

    await resumeAction?.(undefined, commandMocks.get('root.resume') as never);

    expect(mockResumeDirectRun).toHaveBeenCalledWith('/test/cwd', {
      provider: 'mock',
      providerSource: 'cli',
      model: 'gpt-test',
      modelSource: 'cli',
    });
  });
});
