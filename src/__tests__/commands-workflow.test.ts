import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInitWorkflowCommand = vi.fn();
const mockDoctorWorkflowCommand = vi.fn();

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
  resolvedCwd: '/test/cwd',
  pipelineMode: false,
}));

vi.mock('../infra/config/index.js', () => ({
  clearPersonaSessions: vi.fn(),
  resolveConfigValue: vi.fn(),
}));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: vi.fn(() => '/tmp/takt'),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../features/tasks/index.js', () => ({
  runAllTasks: vi.fn(),
  addTask: vi.fn(),
  watchTasks: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock('../features/config/index.js', () => ({
  ejectBuiltin: vi.fn(),
  ejectFacet: vi.fn(),
  parseFacetType: vi.fn(),
  VALID_FACET_TYPES: ['personas', 'policies', 'knowledge', 'instructions', 'output-contracts'],
  resetCategoriesToDefault: vi.fn(),
  resetConfigToDefault: vi.fn(),
  deploySkill: vi.fn(),
  deploySkillCodex: vi.fn(),
}));

vi.mock('../features/prompt/index.js', () => ({
  previewPrompts: vi.fn(),
}));

vi.mock('../features/catalog/index.js', () => ({
  showCatalog: vi.fn(),
}));

vi.mock('../features/analytics/index.js', () => ({
  computeReviewMetrics: vi.fn(),
  formatReviewMetrics: vi.fn(),
  parseSinceDuration: vi.fn(),
  purgeOldEvents: vi.fn(),
}));

vi.mock('../commands/repertoire/add.js', () => ({
  repertoireAddCommand: vi.fn(),
}));

vi.mock('../commands/repertoire/remove.js', () => ({
  repertoireRemoveCommand: vi.fn(),
}));

vi.mock('../commands/repertoire/list.js', () => ({
  repertoireListCommand: vi.fn(),
}));

vi.mock('../features/workflowAuthoring/index.js', () => ({
  initWorkflowCommand: (...args: unknown[]) => mockInitWorkflowCommand(...args),
  doctorWorkflowCommand: (...args: unknown[]) => mockDoctorWorkflowCommand(...args),
}));

import '../app/cli/commands.js';

describe('CLI workflow command', () => {
  beforeEach(() => {
    mockInitWorkflowCommand.mockClear();
    mockDoctorWorkflowCommand.mockClear();
  });

  it('should register workflow root command and subcommands', () => {
    const calledCommandNames = rootCommand.command.mock.calls
      .map((call: unknown[]) => call[0] as string);

    expect(calledCommandNames).toContain('workflow');
    expect(commandMocks.get('root.workflow.init')).toBeTruthy();
    expect(commandMocks.get('root.workflow.doctor')).toBeTruthy();
  });

  it('should describe workflow command set with workflow terminology', () => {
    expect(commandMocks.get('root.workflow')?.description)
      .toHaveBeenCalledWith('Workflow authoring utilities');
    expect(commandMocks.get('root.workflow.init')?.description)
      .toHaveBeenCalledWith('Initialize a new workflow scaffold');
    expect(commandMocks.get('root.workflow.doctor')?.description)
      .toHaveBeenCalledWith('Validate workflow definitions');
  });

  it('should define init options and doctor target arguments', () => {
    const initCommand = commandMocks.get('root.workflow.init');
    const doctorCommand = commandMocks.get('root.workflow.doctor');

    expect(initCommand?.argument).toHaveBeenCalledWith('<name>', 'Workflow name');
    expect(initCommand?.option.mock.calls).toContainEqual(['--description <text>', 'Workflow description']);
    expect(initCommand?.option.mock.calls[1]?.[0]).toBe('--steps <count>');
    expect(initCommand?.option.mock.calls[1]?.[1]).toBe('Initial number of steps');
    expect(typeof initCommand?.option.mock.calls[1]?.[2]).toBe('function');
    expect(initCommand?.option.mock.calls).toContainEqual(['--template <kind>', 'Template kind (minimal|faceted)']);
    expect(initCommand?.option.mock.calls).toContainEqual([
      '--global',
      'Create in ~/.takt/workflows instead of project .takt/workflows',
    ]);
    expect(doctorCommand?.argument).toHaveBeenCalledWith('[targets...]', 'Workflow names or YAML paths');
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

    expect(mockDoctorWorkflowCommand).toHaveBeenCalledWith(['default', './flow.yaml'], '/test/cwd');
  });
});
