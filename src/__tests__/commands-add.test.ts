import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOpts: Record<string, unknown> = {};
const mockAddTask = vi.fn();
const mockLogError = vi.fn();
const mockProcessExit = vi.fn();

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
      opts: vi.fn(() => mockOpts),
      optsWithGlobals: vi.fn(() => mockOpts),
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
  error: (...args: unknown[]) => mockLogError(...args),
}));

vi.mock('../features/tasks/index.js', () => ({
  runAllTasks: vi.fn(),
  addTask: (...args: unknown[]) => mockAddTask(...args),
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

vi.mock('../features/workflowAuthoring/index.js', () => ({
  initWorkflowCommand: vi.fn(),
  doctorWorkflowCommand: vi.fn(),
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

import '../app/cli/commands.js';
const configFeatures = await import('../features/config/index.js');

describe('CLI add command', () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockLogError.mockClear();
    mockProcessExit.mockClear();
    for (const key of Object.keys(mockOpts)) {
      delete mockOpts[key];
    }
    vi.spyOn(process, 'exit').mockImplementation(mockProcessExit as never);
  });

  describe('when --pr option is provided', () => {
    it('should pass program.opts().pr to addTask as prNumber', async () => {
      const prNumber = 374;
      mockOpts.pr = prNumber;

      const addAction = commandActions.get('root.add');
      expect(addAction).toBeTypeOf('function');

      await addAction?.();
      expect(mockAddTask).toHaveBeenCalledWith('/test/cwd', undefined, { prNumber });
    });
  });

  describe('when --pr option is omitted', () => {
    it('should keep existing addTask call signature', async () => {
      const addAction = commandActions.get('root.add');
      expect(addAction).toBeTypeOf('function');

      await addAction?.('Regular task');

      expect(mockAddTask).toHaveBeenCalledWith('/test/cwd', 'Regular task', undefined);
    });

    it('should resolve legacy --piece via command optsWithGlobals()', async () => {
      mockOpts.piece = 'legacy-flow';
      const addAction = commandActions.get('root.add');
      const addCommand = commandMocks.get('root.add');

      expect(addAction).toBeTypeOf('function');
      expect(addCommand).toBeTruthy();

      await addAction?.('Regular task', addCommand as never);

      expect(mockAddTask).toHaveBeenCalledWith('/test/cwd', 'Regular task', { workflow: 'legacy-flow' });
      expect(addCommand?.optsWithGlobals).toHaveBeenCalledTimes(1);
    });

    it('should resolve canonical --workflow via command optsWithGlobals()', async () => {
      mockOpts.workflow = 'canonical-flow';
      const addAction = commandActions.get('root.add');
      const addCommand = commandMocks.get('root.add');

      expect(addAction).toBeTypeOf('function');
      expect(addCommand).toBeTruthy();

      await addAction?.('Regular task', addCommand as never);

      expect(mockAddTask).toHaveBeenCalledWith('/test/cwd', 'Regular task', { workflow: 'canonical-flow' });
      expect(addCommand?.optsWithGlobals).toHaveBeenCalled();
    });

    it('should reject conflicting --workflow and --piece values before calling addTask', async () => {
      mockOpts.workflow = 'canonical-flow';
      mockOpts.piece = 'legacy-flow';
      const addAction = commandActions.get('root.add');
      mockProcessExit.mockImplementation(() => {
        throw new Error('process.exit:1');
      });

      expect(addAction).toBeTypeOf('function');

      await expect(addAction?.('Regular task')).rejects.toThrow('process.exit:1');

      expect(mockLogError).toHaveBeenCalledWith(
        '--workflow and --piece cannot be used together with different values',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(mockAddTask).not.toHaveBeenCalled();
    });
  });

  it('should not register switch command', () => {
    const calledCommandNames = rootCommand.command.mock.calls
      .map((call: unknown[]) => call[0] as string);

    expect(calledCommandNames).not.toContain('switch');
  });

  it('should register export-codex command', () => {
    const calledCommandNames = rootCommand.command.mock.calls
      .map((call: unknown[]) => call[0] as string);

    expect(calledCommandNames).toContain('export-codex');
  });

  it('should invoke deploySkillCodex for export-codex command', async () => {
    const exportCodexAction = commandActions.get('root.export-codex');
    expect(exportCodexAction).toBeTypeOf('function');

    await exportCodexAction?.();
    const deploySkillCodex = (configFeatures as Record<string, unknown>).deploySkillCodex;
    expect(deploySkillCodex).toHaveBeenCalledTimes(1);
  });

  it('should describe prompt workflow argument as defaulting to "default"', () => {
    const promptCommand = commandMocks.get('root.prompt');
    expect(promptCommand).toBeTruthy();
    expect(promptCommand?.description).toHaveBeenCalledWith('Preview assembled prompts for each step and phase');
    expect(promptCommand?.argument).toHaveBeenCalledWith(
      '[workflow]',
      'Workflow name or path (defaults to "default")',
    );
  });

  it('should describe eject with workflow terminology', () => {
    const ejectCommand = commandMocks.get('root.eject');
    expect(ejectCommand).toBeTruthy();
    expect(ejectCommand?.description).toHaveBeenCalledWith(
      'Copy builtin workflow or facet for customization (default: project .takt/)',
    );
    expect(ejectCommand?.argument).toHaveBeenNthCalledWith(
      1,
      '[typeOrName]',
      'Workflow name, or facet type (personas, policies, knowledge, instructions, output-contracts)',
    );
  });

  it('should use workflow terminology for relevant command descriptions', () => {
    expect(commandMocks.get('root.reset.categories')?.description)
      .toHaveBeenCalledWith('Reset workflow categories to builtin defaults');
    expect(commandMocks.get('root.export-cc')?.description)
      .toHaveBeenCalledWith('Export takt workflows/agents as Claude Code Skill (~/.claude/)');
    expect(commandMocks.get('root.export-codex')?.description)
      .toHaveBeenCalledWith('Export takt workflows/agents as Codex Skill (~/.agents/)');
  });
});
