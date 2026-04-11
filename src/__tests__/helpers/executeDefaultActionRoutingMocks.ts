import { vi } from 'vitest';

export const mockSelectAndExecuteTask = vi.fn();
export const mockDeterminePiece = vi.fn();

vi.mock('../../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

vi.mock('../../shared/prompt/index.js', () => ({}));

vi.mock('../../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../infra/git/index.js', () => ({
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

vi.mock('../../features/tasks/index.js', () => ({
  selectAndExecuteTask: (...args: unknown[]) => mockSelectAndExecuteTask(...args),
  determinePiece: (...args: unknown[]) => mockDeterminePiece(...args),
  saveTaskFromInteractive: vi.fn(),
  createIssueAndSaveTask: vi.fn(),
  promptLabelSelection: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../features/pipeline/index.js', () => ({
  executePipeline: vi.fn(),
}));

export const mockSelectInteractiveMode = vi.fn();
export const mockInteractiveMode = vi.fn();
export const mockPassthroughMode = vi.fn();
export const mockQuietMode = vi.fn();
export const mockPersonaMode = vi.fn();
export const mockDispatchConversationAction = vi.fn(
  async (result: { action: string; task: string }, handlers: Record<string, (r: unknown) => unknown>) => {
    return handlers[result.action](result);
  },
);

vi.mock('../../features/interactive/index.js', () => ({
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

export const mockListAllTaskItems = vi.fn();
export const mockIsStaleRunningTask = vi.fn();
vi.mock('../../infra/task/index.js', () => ({
  TaskRunner: vi.fn(() => ({
    listAllTaskItems: mockListAllTaskItems,
  })),
  isStaleRunningTask: (...args: unknown[]) => mockIsStaleRunningTask(...args),
}));

export const mockGetPieceDescription = vi.fn();

vi.mock('../../infra/config/index.js', () => ({
  getPieceDescription: (...args: unknown[]) => mockGetPieceDescription(...args),
  resolveConfigValue: vi.fn((_: string, key: string) => (key === 'piece' ? 'default' : false)),
  resolveConfigValues: vi.fn(() => ({ language: 'en', interactivePreviewMovements: 3, provider: 'claude' })),
  loadPersonaSessions: vi.fn(() => ({})),
}));

vi.mock('../../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: vi.fn(() => ({ local: {}, global: {} })),
}));

vi.mock('../../shared/constants.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DEFAULT_PIECE_NAME: 'default',
}));

export const mockOpts: Record<string, unknown> = {};

vi.mock('../../app/cli/program.js', () => {
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

export const mockResolveAgentOverrides = vi.fn();

vi.mock('../../app/cli/helpers.js', () => ({
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

export type ResetExecuteDefaultActionRoutingMocksOptions = {
  resolvedPieceName: string;
  defaultPieceDesc: () => Record<string, unknown>;
  selectInteractiveModeDefault?: string;
};

export function resetExecuteDefaultActionRoutingMocks(opts: ResetExecuteDefaultActionRoutingMocksOptions): void {
  vi.clearAllMocks();
  for (const key of Object.keys(mockOpts)) {
    delete mockOpts[key];
  }
  mockDeterminePiece.mockResolvedValue(opts.resolvedPieceName);
  mockResolveAgentOverrides.mockReturnValue(undefined);
  mockListAllTaskItems.mockReturnValue([]);
  mockIsStaleRunningTask.mockReturnValue(false);
  mockGetPieceDescription.mockImplementation(() => opts.defaultPieceDesc());
  mockSelectInteractiveMode.mockResolvedValue(opts.selectInteractiveModeDefault ?? 'assistant');
  mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'from-assistant' });
  mockPassthroughMode.mockResolvedValue({ action: 'execute', task: 'from-passthrough' });
  mockQuietMode.mockResolvedValue({ action: 'execute', task: 'from-quiet' });
  mockPersonaMode.mockResolvedValue({ action: 'execute', task: 'from-persona' });
}
