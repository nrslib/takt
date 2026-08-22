import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const mockInitWorkflowCommand = vi.fn();
const mockDoctorWorkflowCommand = vi.fn();
const mockInspectWorkflowCommand = vi.fn();
const mockInspectModuleLoaded = vi.fn();
const mockPreviewPrompts = vi.fn();

const { rootCommand, commandActions, commandMocks } = vi.hoisted(() => {
  const commandActions = new Map<string, (...args: unknown[]) => void>();
  const commandMocks = new Map<string, Record<string, unknown>>();

  function createCommandMock(actionKey: string): {
    description: ReturnType<typeof vi.fn>;
    argument: ReturnType<typeof vi.fn>;
    option: ReturnType<typeof vi.fn>;
    opts: ReturnType<typeof vi.fn>;
    action: (action: (...args: unknown[]) => void) => unknown;
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
    command.action = vi.fn((action: (...args: unknown[]) => void) => {
      commandActions.set(actionKey, action);
      return command;
    });

    return command as {
      description: ReturnType<typeof vi.fn>;
      argument: ReturnType<typeof vi.fn>;
      option: ReturnType<typeof vi.fn>;
      opts: ReturnType<typeof vi.fn>;
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

vi.mock('../features/workflowAuthoring/init.js', () => ({
  initWorkflowCommand: (...args: unknown[]) => mockInitWorkflowCommand(...args),
}));

vi.mock('../features/workflowAuthoring/doctor.js', () => ({
  doctorWorkflowCommand: (...args: unknown[]) => mockDoctorWorkflowCommand(...args),
}));

vi.mock('../features/workflowAuthoring/inspect.js', () => {
  mockInspectModuleLoaded();
  return {
    inspectWorkflowCommand: (...args: unknown[]) => mockInspectWorkflowCommand(...args),
  };
});

vi.mock('../features/prompt/preview.js', () => ({
  previewPrompts: (...args: unknown[]) => mockPreviewPrompts(...args),
}));

import '../app/cli/commands.js';

const inspectModuleLoadedCallsAtRegistration = mockInspectModuleLoaded.mock.calls.length;

describe('CLI workflow command', () => {
  beforeEach(() => {
    mockInitWorkflowCommand.mockClear();
    mockDoctorWorkflowCommand.mockClear();
    mockInspectWorkflowCommand.mockClear();
    mockPreviewPrompts.mockClear();
    rootCommand.opts.mockReturnValue({});
  });

  it('should register workflow root command and subcommands', () => {
    const calledCommandNames = rootCommand.command.mock.calls
      .map((call: unknown[]) => call[0] as string);

    expect(calledCommandNames).toContain('workflow');
    expect(commandMocks.get('root.workflow.init')).toBeTruthy();
    expect(commandMocks.get('root.workflow.doctor')).toBeTruthy();
    expect(commandMocks.get('root.workflow.inspect')).toBeTruthy();
    expect(inspectModuleLoadedCallsAtRegistration).toBe(0);
  });

  it('should define init options and doctor/inspect target arguments', () => {
    const initCommand = commandMocks.get('root.workflow.init');
    const doctorCommand = commandMocks.get('root.workflow.doctor');
    const inspectCommand = commandMocks.get('root.workflow.inspect');

    expect((initCommand?.argument as Mock).mock.calls[0]?.[0]).toBe('<name>');
    const optionNames = (initCommand?.option as Mock).mock.calls.map(([name]) => name as string);
    expect(optionNames).toEqual(expect.arrayContaining([
      '--description <text>',
      '--steps <count>',
      '--template <kind>',
      '--global',
    ]));
    expect((doctorCommand?.argument as Mock).mock.calls[0]?.[0]).toBe('[targets...]');
    expect((inspectCommand?.argument as Mock).mock.calls[0]?.[0]).toBe('[target]');
  });

  it('should delegate init action to workflow authoring feature', async () => {
    const initAction = commandActions.get('root.workflow.init');

    expect(initAction).toBeTypeOf('function');

    await initAction?.('sample-flow', {
      description: 'Workflow description',
      steps: 3,
      template: 'faceted',
      global: true,
    });

    expect(mockInitWorkflowCommand).toHaveBeenCalledWith('sample-flow', {
      description: 'Workflow description',
      global: true,
      steps: 3,
      template: 'faceted',
      projectDir: '/test/cwd',
    });
  });

  it('should delegate doctor action to workflow authoring feature', async () => {
    const doctorAction = commandActions.get('root.workflow.doctor');

    expect(doctorAction).toBeTypeOf('function');

    await doctorAction?.(['default', './flow.yaml']);

    expect(mockDoctorWorkflowCommand).toHaveBeenCalledWith(['default', './flow.yaml'], '/test/cwd', undefined);
  });

  it('should delegate inspect action with one target to workflow authoring feature', async () => {
    const inspectAction = commandActions.get('root.workflow.inspect');

    expect(inspectAction).toBeTypeOf('function');

    await inspectAction?.('sample-flow');

    expect(mockInspectWorkflowCommand).toHaveBeenCalledWith('sample-flow', '/test/cwd', undefined);
  });

  it('should propagate CLI execution overrides to prompt preview, workflow doctor, and workflow inspect', async () => {
    rootCommand.opts.mockReturnValue({ provider: 'mock', model: 'cli-model', autoStrategy: 'performance' });
    const promptAction = commandActions.get('root.prompt');
    const doctorAction = commandActions.get('root.workflow.doctor');
    const inspectAction = commandActions.get('root.workflow.inspect');
    const expectedOverrides = {
      provider: 'mock',
      providerSource: 'cli',
      model: 'cli-model',
      modelSource: 'cli',
      autoStrategy: 'performance',
    };

    await promptAction?.('default');
    await doctorAction?.(['default']);
    await inspectAction?.('default');

    expect(mockPreviewPrompts).toHaveBeenCalledWith('/test/cwd', 'default', expectedOverrides);
    expect(mockDoctorWorkflowCommand).toHaveBeenCalledWith(['default'], '/test/cwd', expectedOverrides);
    expect(mockInspectWorkflowCommand).toHaveBeenCalledWith('default', '/test/cwd', expectedOverrides);
  });
});
