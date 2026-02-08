/**
 * Tests for interactive mode variants (assistant, persona, quiet, passthrough)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPersonaSessions: vi.fn(() => ({})),
  updatePersonaSession: vi.fn(),
  getProjectConfigDir: vi.fn(() => '/tmp'),
  loadSessionState: vi.fn(() => null),
  clearSessionState: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn(() => vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  selectOptionWithDefault: vi.fn(),
}));

import { getProvider } from '../infra/providers/index.js';
import { selectOptionWithDefault, selectOption } from '../shared/prompt/index.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOptionWithDefault = vi.mocked(selectOptionWithDefault);
const mockSelectOption = vi.mocked(selectOption);

// ── Stdin helpers (same pattern as interactive.test.ts) ──

let savedIsTTY: boolean | undefined;
let savedIsRaw: boolean | undefined;
let savedSetRawMode: typeof process.stdin.setRawMode | undefined;
let savedStdoutWrite: typeof process.stdout.write;
let savedStdinOn: typeof process.stdin.on;
let savedStdinRemoveListener: typeof process.stdin.removeListener;
let savedStdinResume: typeof process.stdin.resume;
let savedStdinPause: typeof process.stdin.pause;

function setupRawStdin(rawInputs: string[]): void {
  savedIsTTY = process.stdin.isTTY;
  savedIsRaw = process.stdin.isRaw;
  savedSetRawMode = process.stdin.setRawMode;
  savedStdoutWrite = process.stdout.write;
  savedStdinOn = process.stdin.on;
  savedStdinRemoveListener = process.stdin.removeListener;
  savedStdinResume = process.stdin.resume;
  savedStdinPause = process.stdin.pause;

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isRaw', { value: false, configurable: true, writable: true });
  process.stdin.setRawMode = vi.fn((mode: boolean) => {
    (process.stdin as unknown as { isRaw: boolean }).isRaw = mode;
    return process.stdin;
  }) as unknown as typeof process.stdin.setRawMode;
  process.stdout.write = vi.fn(() => true) as unknown as typeof process.stdout.write;
  process.stdin.resume = vi.fn(() => process.stdin) as unknown as typeof process.stdin.resume;
  process.stdin.pause = vi.fn(() => process.stdin) as unknown as typeof process.stdin.pause;

  let currentHandler: ((data: Buffer) => void) | null = null;
  let inputIndex = 0;

  process.stdin.on = vi.fn(((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'data') {
      currentHandler = handler as (data: Buffer) => void;
      if (inputIndex < rawInputs.length) {
        const data = rawInputs[inputIndex]!;
        inputIndex++;
        queueMicrotask(() => {
          if (currentHandler) {
            currentHandler(Buffer.from(data, 'utf-8'));
          }
        });
      }
    }
    return process.stdin;
  }) as typeof process.stdin.on);

  process.stdin.removeListener = vi.fn(((event: string) => {
    if (event === 'data') {
      currentHandler = null;
    }
    return process.stdin;
  }) as typeof process.stdin.removeListener);
}

function restoreStdin(): void {
  if (savedIsTTY !== undefined) {
    Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true });
  }
  if (savedIsRaw !== undefined) {
    Object.defineProperty(process.stdin, 'isRaw', { value: savedIsRaw, configurable: true, writable: true });
  }
  if (savedSetRawMode) process.stdin.setRawMode = savedSetRawMode;
  if (savedStdoutWrite) process.stdout.write = savedStdoutWrite;
  if (savedStdinOn) process.stdin.on = savedStdinOn;
  if (savedStdinRemoveListener) process.stdin.removeListener = savedStdinRemoveListener;
  if (savedStdinResume) process.stdin.resume = savedStdinResume;
  if (savedStdinPause) process.stdin.pause = savedStdinPause;
}

function toRawInputs(inputs: (string | null)[]): string[] {
  return inputs.map((input) => {
    if (input === null) return '\x04';
    return input + '\r';
  });
}

function setupMockProvider(responses: string[]): void {
  let callIndex = 0;
  const mockCall = vi.fn(async () => {
    const content = callIndex < responses.length ? responses[callIndex] : 'AI response';
    callIndex++;
    return {
      persona: 'interactive',
      status: 'done' as const,
      content: content!,
      timestamp: new Date(),
    };
  });
  const mockSetup = vi.fn(() => ({ call: mockCall }));
  const mockProvider = {
    setup: mockSetup,
    _call: mockCall,
    _setup: mockSetup,
  };
  mockGetProvider.mockReturnValue(mockProvider);
}

// ── Imports (after mocks) ──

import { INTERACTIVE_MODES, DEFAULT_INTERACTIVE_MODE } from '../core/models/interactive-mode.js';
import { selectInteractiveMode } from '../features/interactive/modeSelection.js';
import { passthroughMode } from '../features/interactive/passthroughMode.js';
import { quietMode } from '../features/interactive/quietMode.js';
import { personaMode } from '../features/interactive/personaMode.js';
import type { PieceContext } from '../features/interactive/interactive.js';
import type { FirstMovementInfo } from '../infra/config/loaders/pieceResolver.js';

// ── Setup ──

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectOptionWithDefault.mockResolvedValue('assistant');
  mockSelectOption.mockResolvedValue('execute');
});

afterEach(() => {
  restoreStdin();
});

// ── InteractiveMode type & constants tests ──

describe('InteractiveMode type', () => {
  it('should define all four modes', () => {
    expect(INTERACTIVE_MODES).toEqual(['assistant', 'persona', 'quiet', 'passthrough']);
  });

  it('should have assistant as default mode', () => {
    expect(DEFAULT_INTERACTIVE_MODE).toBe('assistant');
  });
});

// ── Mode selection tests ──

describe('selectInteractiveMode', () => {
  it('should call selectOptionWithDefault with four mode options', async () => {
    // When
    await selectInteractiveMode('en');

    // Then
    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ value: 'assistant' }),
        expect.objectContaining({ value: 'persona' }),
        expect.objectContaining({ value: 'quiet' }),
        expect.objectContaining({ value: 'passthrough' }),
      ]),
      'assistant',
    );
  });

  it('should use piece default when provided', async () => {
    // When
    await selectInteractiveMode('en', 'quiet');

    // Then
    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      'quiet',
    );
  });

  it('should return null when user cancels', async () => {
    // Given
    mockSelectOptionWithDefault.mockResolvedValue(null);

    // When
    const result = await selectInteractiveMode('en');

    // Then
    expect(result).toBeNull();
  });

  it('should return selected mode value', async () => {
    // Given
    mockSelectOptionWithDefault.mockResolvedValue('persona');

    // When
    const result = await selectInteractiveMode('ja');

    // Then
    expect(result).toBe('persona');
  });

  it('should present options in correct order', async () => {
    // When
    await selectInteractiveMode('en');

    // Then
    const options = mockSelectOptionWithDefault.mock.calls[0]?.[1] as Array<{ value: string }>;
    expect(options?.[0]?.value).toBe('assistant');
    expect(options?.[1]?.value).toBe('persona');
    expect(options?.[2]?.value).toBe('quiet');
    expect(options?.[3]?.value).toBe('passthrough');
  });
});

// ── Passthrough mode tests ──

describe('passthroughMode', () => {
  it('should return initialInput directly when provided', async () => {
    // When
    const result = await passthroughMode('en', 'my task text');

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('my task text');
  });

  it('should return cancel when user sends EOF', async () => {
    // Given
    setupRawStdin(toRawInputs([null]));

    // When
    const result = await passthroughMode('en');

    // Then
    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should return cancel when user enters empty input', async () => {
    // Given
    setupRawStdin(toRawInputs(['']));

    // When
    const result = await passthroughMode('en');

    // Then
    expect(result.action).toBe('cancel');
  });

  it('should return user input as task when entered', async () => {
    // Given
    setupRawStdin(toRawInputs(['implement login feature']));

    // When
    const result = await passthroughMode('en');

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('implement login feature');
  });

  it('should trim whitespace from user input', async () => {
    // Given
    setupRawStdin(toRawInputs(['  my task  ']));

    // When
    const result = await passthroughMode('en');

    // Then
    expect(result.task).toBe('my task');
  });
});

// ── Quiet mode tests ──

describe('quietMode', () => {
  it('should generate instructions from initialInput without questions', async () => {
    // Given
    setupMockProvider(['Generated task instruction for login feature.']);
    mockSelectOption.mockResolvedValue('execute');

    // When
    const result = await quietMode('/project', 'implement login feature');

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Generated task instruction for login feature.');
  });

  it('should return cancel when user sends EOF for input', async () => {
    // Given
    setupRawStdin(toRawInputs([null]));
    setupMockProvider([]);

    // When
    const result = await quietMode('/project');

    // Then
    expect(result.action).toBe('cancel');
  });

  it('should return cancel when user enters empty input', async () => {
    // Given
    setupRawStdin(toRawInputs(['']));
    setupMockProvider([]);

    // When
    const result = await quietMode('/project');

    // Then
    expect(result.action).toBe('cancel');
  });

  it('should prompt for input when no initialInput is provided', async () => {
    // Given
    setupRawStdin(toRawInputs(['fix the bug']));
    setupMockProvider(['Fix the bug instruction.']);
    mockSelectOption.mockResolvedValue('execute');

    // When
    const result = await quietMode('/project');

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Fix the bug instruction.');
  });

  it('should include piece context in summary generation', async () => {
    // Given
    const pieceContext: PieceContext = {
      name: 'test-piece',
      description: 'A test piece',
      pieceStructure: '1. implement\n2. review',
      movementPreviews: [],
    };
    setupMockProvider(['Instruction with piece context.']);
    mockSelectOption.mockResolvedValue('execute');

    // When
    const result = await quietMode('/project', 'some task', pieceContext);

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Instruction with piece context.');
  });
});

// ── Persona mode tests ──

describe('personaMode', () => {
  const mockFirstMovement: FirstMovementInfo = {
    personaContent: 'You are a senior coder. Write clean, maintainable code.',
    personaDisplayName: 'Coder',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  };

  it('should return cancel when user types /cancel', async () => {
    // Given
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    // When
    const result = await personaMode('/project', mockFirstMovement);

    // Then
    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should return cancel on EOF', async () => {
    // Given
    setupRawStdin(toRawInputs([null]));
    setupMockProvider([]);

    // When
    const result = await personaMode('/project', mockFirstMovement);

    // Then
    expect(result.action).toBe('cancel');
  });

  it('should use first movement persona as system prompt', async () => {
    // Given
    setupRawStdin(toRawInputs(['fix bug', '/cancel']));
    setupMockProvider(['I see the issue.']);

    // When
    await personaMode('/project', mockFirstMovement);

    // Then: the provider should be set up with persona content as system prompt
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _setup: ReturnType<typeof vi.fn> };
    expect(mockProvider._setup).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'You are a senior coder. Write clean, maintainable code.',
      }),
    );
  });

  it('should use first movement allowed tools', async () => {
    // Given
    setupRawStdin(toRawInputs(['check the code', '/cancel']));
    setupMockProvider(['Looking at the code.']);

    // When
    await personaMode('/project', mockFirstMovement);

    // Then
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
      }),
    );
  });

  it('should process initialInput as first message', async () => {
    // Given
    setupRawStdin(toRawInputs(['/go']));
    setupMockProvider(['I analyzed the issue.', 'Task summary.']);
    mockSelectOption.mockResolvedValue('execute');

    // When
    const result = await personaMode('/project', mockFirstMovement, 'fix the login');

    // Then
    expect(result.action).toBe('execute');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(2);
    const firstPrompt = mockProvider._call.mock.calls[0]?.[0] as string;
    expect(firstPrompt).toBe('fix the login');
  });

  it('should handle /play command', async () => {
    // Given
    setupRawStdin(toRawInputs(['/play direct task text']));
    setupMockProvider([]);

    // When
    const result = await personaMode('/project', mockFirstMovement);

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('direct task text');
  });

  it('should fall back to default tools when first movement has none', async () => {
    // Given
    const noToolsMovement: FirstMovementInfo = {
      personaContent: 'Persona prompt',
      personaDisplayName: 'Agent',
      allowedTools: [],
    };
    setupRawStdin(toRawInputs(['test', '/cancel']));
    setupMockProvider(['response']);

    // When
    await personaMode('/project', noToolsMovement);

    // Then
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
      }),
    );
  });

  it('should handle multi-turn conversation before /go', async () => {
    // Given
    setupRawStdin(toRawInputs(['first message', 'second message', '/go']));
    setupMockProvider(['reply 1', 'reply 2', 'Final summary.']);
    mockSelectOption.mockResolvedValue('execute');

    // When
    const result = await personaMode('/project', mockFirstMovement);

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Final summary.');
  });
});
