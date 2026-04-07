/**
 * interactive_mode "none" (none-like nuance): skip TAKT dialogue and execute the first
 * movement immediately — with or without positional / CLI task text.
 *
 * `run_interactive_without_task` is removed from schema; legacy YAML keys are ignored.
 * INTERACTIVE_MODE_NONE must match `INTERACTIVE_MODES` in src/core/models/interactive-mode.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PieceConfigRawSchema, InteractiveModeSchema } from '../core/models/index.js';
import { loadPieceFromFile } from '../infra/config/loaders/pieceParser.js';

/** Align with production enum after implementation (task: none-like, no collision). */
const INTERACTIVE_MODE_NONE = 'none' as const;

const MINIMAL_MOVEMENTS = `initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    instruction: "{task}"
    rules:
      - condition: done
        next: COMPLETE
`;

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
    name: 'none-mode-piece',
    description: '',
    pieceStructure: '',
    movementPreviews: [],
    interactiveMode: INTERACTIVE_MODE_NONE,
    firstMovement: undefined,
    ...overrides,
  };
}

describe('InteractiveModeSchema — none-like mode', () => {
  it('Given valid token — When parse — Then accepts none-like interactive_mode', () => {
    expect(InteractiveModeSchema.parse(INTERACTIVE_MODE_NONE)).toBe(INTERACTIVE_MODE_NONE);
  });
});

describe('PieceConfigRawSchema — interactive_mode none + legacy run_interactive_without_task removal', () => {
  const minimalConfig = {
    name: 'schema-none',
    movements: [
      {
        name: 'step1',
        persona: 'coder',
        instruction: '{task}',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
    interactive_mode: INTERACTIVE_MODE_NONE,
  };

  it('Given interactive_mode none — When PieceConfigRawSchema.parse — Then preserves interactive_mode', () => {
    const result = PieceConfigRawSchema.parse(minimalConfig);
    expect(result.interactive_mode).toBe(INTERACTIVE_MODE_NONE);
  });

  it('Given legacy run_interactive_without_task without skip_interactive_mode_selection — When parse — Then does not fail cross-field refine', () => {
    const raw = {
      ...minimalConfig,
      run_interactive_without_task: true,
      skip_interactive_mode_selection: false,
    };
    const result = PieceConfigRawSchema.parse(raw);
    expect(result).not.toHaveProperty('run_interactive_without_task');
  });
});

describe('Piece YAML — interactive_mode none', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-none-mode-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('Given interactive_mode none — When loadPieceFromFile — Then interactiveMode is none-like', () => {
    const yaml = `name: none-piece
interactive_mode: ${INTERACTIVE_MODE_NONE}
${MINIMAL_MOVEMENTS}
`;
    const path = join(tempDir, 'none.yaml');
    writeFileSync(path, yaml);

    const piece = loadPieceFromFile(path, tempDir);

    expect(piece.interactiveMode).toBe(INTERACTIVE_MODE_NONE);
  });

  it('Given legacy run_interactive_without_task in YAML — When loadPieceFromFile — Then field is not surfaced on PieceConfig', () => {
    const yaml = `name: legacy-keys
interactive_mode: assistant
skip_interactive_mode_selection: true
run_interactive_without_task: true
${MINIMAL_MOVEMENTS}
`;
    const path = join(tempDir, 'legacy.yaml');
    writeFileSync(path, yaml);

    const piece = loadPieceFromFile(path, tempDir);

    expect(piece).not.toHaveProperty('runInteractiveWithoutTask');
  });
});

describe('executeDefaultAction — interactive_mode none (direct first movement)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockOpts)) {
      delete mockOpts[key];
    }
    mockDeterminePiece.mockResolvedValue('none-mode-piece');
    mockResolveAgentOverrides.mockReturnValue(undefined);
    mockListAllTaskItems.mockReturnValue([]);
    mockIsStaleRunningTask.mockReturnValue(false);
    mockGetPieceDescription.mockImplementation(() => defaultPieceDesc());
    mockSelectInteractiveMode.mockResolvedValue(INTERACTIVE_MODE_NONE);
    mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'from-assistant' });
    mockPassthroughMode.mockResolvedValue({ action: 'execute', task: 'from-passthrough' });
    mockQuietMode.mockResolvedValue({ action: 'execute', task: 'from-quiet' });
    mockPersonaMode.mockResolvedValue({ action: 'execute', task: 'from-persona' });
  });

  it('Given skipInteractiveModeSelection and none mode — When no positional task — Then no dialogue handlers and task is piece name', async () => {
    mockGetPieceDescription.mockReturnValue(
      defaultPieceDesc({
        skipInteractiveModeSelection: true,
        name: 'workflow-name',
      }),
    );

    await executeDefaultAction();

    expect(mockInteractiveMode).not.toHaveBeenCalled();
    expect(mockPassthroughMode).not.toHaveBeenCalled();
    expect(mockQuietMode).not.toHaveBeenCalled();
    expect(mockPersonaMode).not.toHaveBeenCalled();

    expect(mockDispatchConversationAction).toHaveBeenCalledWith(
      { action: 'execute', task: 'workflow-name' },
      expect.any(Object),
    );

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'workflow-name',
      expect.objectContaining({
        piece: 'none-mode-piece',
        skipTaskList: true,
        interactiveMetadata: expect.objectContaining({ confirmed: false, task: 'workflow-name' }),
      }),
      undefined,
    );
  });

  it('Given skipInteractiveModeSelection and none mode — When positional task — Then no dialogue handlers and task is positional text', async () => {
    mockGetPieceDescription.mockReturnValue(
      defaultPieceDesc({
        skipInteractiveModeSelection: true,
      }),
    );

    await executeDefaultAction('cli task body');

    expect(mockSelectInteractiveMode).not.toHaveBeenCalled();
    expect(mockInteractiveMode).not.toHaveBeenCalled();
    expect(mockPassthroughMode).not.toHaveBeenCalled();
    expect(mockQuietMode).not.toHaveBeenCalled();
    expect(mockPersonaMode).not.toHaveBeenCalled();

    expect(mockDispatchConversationAction).toHaveBeenCalledWith(
      { action: 'execute', task: 'cli task body' },
      expect.any(Object),
    );

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'cli task body',
      expect.objectContaining({
        piece: 'none-mode-piece',
        skipTaskList: true,
        interactiveMetadata: expect.objectContaining({ confirmed: false, task: 'cli task body' }),
      }),
      undefined,
    );
  });

  it('Given skipInteractiveModeSelection false — When selectInteractiveMode returns none — Then no assistant/passthrough/quiet/persona handlers', async () => {
    mockGetPieceDescription.mockReturnValue(
      defaultPieceDesc({
        skipInteractiveModeSelection: false,
        interactiveMode: 'assistant',
      }),
    );
    mockSelectInteractiveMode.mockResolvedValue(INTERACTIVE_MODE_NONE);

    await executeDefaultAction('from user');

    expect(mockSelectInteractiveMode).toHaveBeenCalled();
    expect(mockInteractiveMode).not.toHaveBeenCalled();
    expect(mockPassthroughMode).not.toHaveBeenCalled();
    expect(mockQuietMode).not.toHaveBeenCalled();
    expect(mockPersonaMode).not.toHaveBeenCalled();

    expect(mockDispatchConversationAction).toHaveBeenCalledWith(
      { action: 'execute', task: 'from user' },
      expect.any(Object),
    );
  });

  it('Given none mode with skipInteractiveModeSelection undefined — When default action — Then selectInteractiveMode is still invoked (no implicit skip)', async () => {
    mockGetPieceDescription.mockReturnValue(defaultPieceDesc());

    await executeDefaultAction();

    expect(mockSelectInteractiveMode).toHaveBeenCalled();
  });
});
