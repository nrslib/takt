/**
 * CLI routing: skip_interactive_mode_selection (skip mode picker) and interactive_mode `none` (direct run).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

vi.mock('../shared/prompt/index.js', () => ({}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: vi.fn(),
    fetchIssue: vi.fn(),
  }),
  parseIssueNumbers: vi.fn(() => []),
  formatIssueAsTask: vi.fn(),
  isIssueReference: vi.fn(),
  resolveIssueTask: vi.fn(),
  formatPrReviewAsTask: vi.fn(),
}));

const mockSelectAndExecuteTask = vi.fn();
const mockDeterminePiece = vi.fn();

vi.mock('../features/tasks/index.js', () => ({
  selectAndExecuteTask: (...args: unknown[]) => mockSelectAndExecuteTask(...args),
  determinePiece: (...args: unknown[]) => mockDeterminePiece(...args),
  saveTaskFromInteractive: vi.fn(),
  createIssueAndSaveTask: vi.fn(),
  promptLabelSelection: vi.fn().mockResolvedValue([]),
}));

vi.mock('../features/pipeline/index.js', () => ({
  executePipeline: vi.fn(),
}));

const mockSelectInteractiveMode = vi.fn();
const mockInteractiveMode = vi.fn();
const mockPassthroughMode = vi.fn();
const mockQuietMode = vi.fn();
const mockPersonaMode = vi.fn();
const mockDispatchConversationAction = vi.fn(
  async (result: { action: string; task: string }, handlers: Record<string, (r: unknown) => unknown>) => {
    return handlers[result.action](result);
  },
);

vi.mock('../features/interactive/index.js', () => ({
  interactiveMode: (...args: unknown[]) => mockInteractiveMode(...args),
  selectInteractiveMode: (...args: unknown[]) => mockSelectInteractiveMode(...args),
  passthroughMode: (...args: unknown[]) => mockPassthroughMode(...args),
  quietMode: (...args: unknown[]) => mockQuietMode(...args),
  personaMode: (...args: unknown[]) => mockPersonaMode(...args),
  resolveLanguage: vi.fn(() => 'en'),
  selectRun: vi.fn(() => null),
  loadRunSessionContext: vi.fn(),
  listRecentRuns: vi.fn(() => []),
  normalizeTaskHistorySummary: vi.fn((items: unknown[]) => items),
  dispatchConversationAction: (...args: unknown[]) => mockDispatchConversationAction(...args),
}));

const mockListAllTaskItems = vi.fn();
const mockIsStaleRunningTask = vi.fn();
vi.mock('../infra/task/index.js', () => ({
  TaskRunner: vi.fn(() => ({
    listAllTaskItems: mockListAllTaskItems,
  })),
  isStaleRunningTask: (...args: unknown[]) => mockIsStaleRunningTask(...args),
}));

const mockGetPieceDescription = vi.fn();

vi.mock('../infra/config/index.js', () => ({
  getPieceDescription: (...args: unknown[]) => mockGetPieceDescription(...args),
  resolveConfigValue: vi.fn((_: string, key: string) => (key === 'piece' ? 'default' : false)),
  resolveConfigValues: vi.fn(() => ({ language: 'en', interactivePreviewMovements: 3, provider: 'claude' })),
  loadPersonaSessions: vi.fn(() => ({})),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: vi.fn(() => ({ local: {}, global: {} })),
}));

vi.mock('../shared/constants.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DEFAULT_PIECE_NAME: 'default',
}));

const mockOpts: Record<string, unknown> = {};

vi.mock('../app/cli/program.js', () => {
  const chainable = {
    opts: vi.fn(() => mockOpts),
    argument: vi.fn().mockReturnThis(),
    action: vi.fn().mockReturnThis(),
  };
  return {
    program: chainable,
    resolvedCwd: '/test/cwd',
    pipelineMode: false,
  };
});

const mockResolveAgentOverrides = vi.fn();

vi.mock('../app/cli/helpers.js', () => ({
  resolveAgentOverrides: (...args: unknown[]) => mockResolveAgentOverrides(...args),
  isDirectTask: vi.fn(() => false),
  resolveWorkflowCliOption: vi.fn((opts: Record<string, unknown>) => {
    const workflow = typeof opts.workflow === 'string' ? opts.workflow : undefined;
    const piece = typeof opts.piece === 'string' ? opts.piece : undefined;
    if (workflow !== undefined && piece !== undefined && workflow !== piece) {
      throw new Error('--workflow and --piece cannot be used together with different values');
    }
    return workflow ?? piece;
  }),
}));

import { executeDefaultAction } from '../app/cli/routing.js';

function defaultPieceDesc(overrides: Record<string, unknown> = {}) {
  return {
    name: 'opt-in-piece',
    description: '',
    pieceStructure: '',
    movementPreviews: [],
    interactiveMode: 'quiet' as const,
    firstMovement: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mockOpts)) {
    delete mockOpts[key];
  }
  mockDeterminePiece.mockResolvedValue('opt-in-piece');
  mockResolveAgentOverrides.mockReturnValue(undefined);
  mockListAllTaskItems.mockReturnValue([]);
  mockIsStaleRunningTask.mockReturnValue(false);
  mockGetPieceDescription.mockImplementation(() => defaultPieceDesc());
  mockSelectInteractiveMode.mockResolvedValue('assistant');
  mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'from-assistant' });
  mockPassthroughMode.mockResolvedValue({ action: 'execute', task: 'from-passthrough' });
  mockQuietMode.mockResolvedValue({ action: 'execute', task: 'from-quiet' });
  mockPersonaMode.mockResolvedValue({ action: 'execute', task: 'from-persona' });
});

describe('executeDefaultAction interactive opt-in', () => {
  it('Given no opt-in flags — When default action with no task — Then selectInteractiveMode is called', async () => {
    mockGetPieceDescription.mockReturnValue(defaultPieceDesc());

    await executeDefaultAction();

    expect(mockSelectInteractiveMode).toHaveBeenCalled();
  });

  it('Given skipInteractiveModeSelection true — When no task — Then selectInteractiveMode is not called', async () => {
    mockGetPieceDescription.mockReturnValue(
      defaultPieceDesc({
        skipInteractiveModeSelection: true,
        interactiveMode: 'assistant',
      }),
    );

    await executeDefaultAction();

    expect(mockSelectInteractiveMode).not.toHaveBeenCalled();
  });

  it('Given skipInteractiveModeSelection and interactive_mode none — When no task — Then no dialogue handlers and task is piece name', async () => {
    mockGetPieceDescription.mockReturnValue(
      defaultPieceDesc({
        skipInteractiveModeSelection: true,
        interactiveMode: 'none',
        name: 'my-workflow',
      }),
    );

    await executeDefaultAction();

    expect(mockInteractiveMode).not.toHaveBeenCalled();
    expect(mockPassthroughMode).not.toHaveBeenCalled();
    expect(mockQuietMode).not.toHaveBeenCalled();
    expect(mockPersonaMode).not.toHaveBeenCalled();

    expect(mockDispatchConversationAction).toHaveBeenCalledWith(
      { action: 'execute', task: 'my-workflow' },
      expect.any(Object),
    );

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'my-workflow',
      expect.objectContaining({
        piece: 'opt-in-piece',
        skipTaskList: true,
        interactiveUserInput: false,
        interactiveMetadata: expect.objectContaining({ confirmed: false, task: 'my-workflow' }),
      }),
      undefined,
    );
  });

  it('Given skipInteractiveModeSelection and interactive_mode none — When positional task — Then no dialogue and task is positional text', async () => {
    mockGetPieceDescription.mockReturnValue(
      defaultPieceDesc({
        skipInteractiveModeSelection: true,
        interactiveMode: 'none',
      }),
    );

    await executeDefaultAction('user supplied task');

    expect(mockSelectInteractiveMode).not.toHaveBeenCalled();
    expect(mockInteractiveMode).not.toHaveBeenCalled();

    expect(mockDispatchConversationAction).toHaveBeenCalledWith(
      { action: 'execute', task: 'user supplied task' },
      expect.any(Object),
    );

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'user supplied task',
      expect.objectContaining({
        interactiveUserInput: false,
        interactiveMetadata: expect.objectContaining({ confirmed: false, task: 'user supplied task' }),
      }),
      undefined,
    );
  });
});
