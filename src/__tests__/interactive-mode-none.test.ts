import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resetExecuteDefaultActionRoutingMocks,
  mockSelectAndExecuteTask,
  mockGetPieceDescription,
  mockSelectInteractiveMode,
  mockInteractiveMode,
  mockPassthroughMode,
  mockQuietMode,
  mockPersonaMode,
  mockDispatchConversationAction,
} from './helpers/executeDefaultActionRoutingMocks.js';

import { PieceConfigRawSchema, InteractiveModeSchema } from '../core/models/index.js';
import { loadPieceFromFile } from '../infra/config/loaders/pieceParser.js';

import { executeDefaultAction } from '../app/cli/routing.js';

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

describe('executeDefaultAction — interactive_mode none (direct first movement)', () => {
  beforeEach(() => {
    resetExecuteDefaultActionRoutingMocks({
      resolvedPieceName: 'none-mode-piece',
      defaultPieceDesc,
      selectInteractiveModeDefault: INTERACTIVE_MODE_NONE,
    });
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
        interactiveUserInput: false,
        pieceUserInputHandler: true,
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
        interactiveUserInput: false,
        pieceUserInputHandler: true,
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
