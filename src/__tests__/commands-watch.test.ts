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
  watchTasks: (...args: unknown[]) => mockWatchTasks(...args),
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
    mockProgramOpts.provider = 'openai';
    mockProgramOpts.model = 'gpt-5';
    mockWatchCommandOpts.ignoreExceed = true;

    const watchAction = commandActions.get('root.watch');
    const watchCommand = commandMocks.get('root.watch');

    expect(watchAction).toBeTypeOf('function');
    expect(watchCommand).toBeTruthy();

    await watchAction?.(undefined, watchCommand as never);

    expect(watchCommand?.optsWithGlobals).toHaveBeenCalled();
    expect(mockWatchTasks).toHaveBeenCalledWith('/test/cwd', {
      provider: 'openai',
      providerSource: 'cli',
      model: 'gpt-5',
      modelSource: 'cli',
      ignoreExceed: true,
    });
  });
});
