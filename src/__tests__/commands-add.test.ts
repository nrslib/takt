import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOpts: Record<string, unknown> = {};
const mockAddTask = vi.fn();

const { rootCommand, commandActions } = vi.hoisted(() => {
  const commandActions = new Map<string, (...args: unknown[]) => void>();

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
    };

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
  };
});

vi.mock('../app/cli/program.js', () => ({
  program: rootCommand,
  resolvedCwd: '/test/cwd',
  pipelineMode: false,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: vi.fn(),
}));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: vi.fn(() => '/tmp/takt'),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../features/tasks/index.js', () => ({
  runAllTasks: vi.fn(),
  addTask: (...args: unknown[]) => mockAddTask(...args),
  watchTasks: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock('../features/config/index.js', () => ({
  clearPersonaSessions: vi.fn(),
  ejectBuiltin: vi.fn(),
  ejectFacet: vi.fn(),
  parseFacetType: vi.fn(),
  VALID_FACET_TYPES: ['personas', 'policies', 'knowledge', 'instructions', 'output-contracts'],
  resetCategoriesToDefault: vi.fn(),
  resetConfigToDefault: vi.fn(),
  deploySkill: vi.fn(),
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

import '../app/cli/commands.js';

describe('CLI add command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockOpts)) {
      delete mockOpts[key];
    }
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
  });
});
