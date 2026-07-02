/**
 * Tests for interactive mode variants (assistant, persona, quiet, passthrough)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
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
import { info } from '../shared/ui/index.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOptionWithDefault = vi.mocked(selectOptionWithDefault);
const mockSelectOption = vi.mocked(selectOption);
const mockInfo = vi.mocked(info);
const attachmentSessionDirs = new Set<string>();

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
    getRuntimeInstructions: vi.fn(() => null),
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
import type { WorkflowContext } from '../features/interactive/interactive.js';
import type { FirstStepInfo } from '../infra/config/loaders/workflowResolver.js';

// ── Setup ──

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectOptionWithDefault.mockResolvedValue('assistant');
  mockSelectOption.mockResolvedValue('execute');
});

afterEach(() => {
  restoreStdin();
  for (const sessionDir of attachmentSessionDirs) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  attachmentSessionDirs.clear();
});

function createOscImagePaste(): string {
  const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  return `\x1B]1337;File=inline=1;name=reference.png;size=${imageData.length}:${imageData.toString('base64')}\x07`;
}

function createInvalidSizeOscImagePaste(): string {
  const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  return `\x1B]1337;File=inline=1;name=reference.png;size=${imageData.length + 1}:${imageData.toString('base64')}\x07`;
}

function trackAttachmentSession(tempPath: string): void {
  attachmentSessionDirs.add(path.dirname(path.dirname(tempPath)));
}

function createIsolatedTmpRoot(prefix: string): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  attachmentSessionDirs.add(tmpRoot);
  return tmpRoot;
}

function listTaktTempSessionDirs(): Set<string> {
  const taktTempRoot = path.join(os.tmpdir(), 'takt');
  if (!fs.existsSync(taktTempRoot)) {
    return new Set();
  }
  return new Set(
    fs.readdirSync(taktTempRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(taktTempRoot, entry.name)),
  );
}

function expectNoNewTaktTempSessionDirs(previous: Set<string>): void {
  const leaked = [...listTaktTempSessionDirs()].filter((sessionDir) => !previous.has(sessionDir));
  expect(leaked).toEqual([]);
}

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

  it('should use workflow default when provided', async () => {
    // When
    await selectInteractiveMode('en', 'quiet');

    // Then
    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      'quiet',
    );
  });

  it('should exclude unavailable modes and fall back to assistant by default', async () => {
    // When
    await selectInteractiveMode('en', 'passthrough', ['assistant', 'persona', 'quiet']);

    // Then
    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      [
        expect.objectContaining({ value: 'assistant' }),
        expect.objectContaining({ value: 'persona' }),
        expect.objectContaining({ value: 'quiet' }),
      ],
      'assistant',
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

  it('should show passthrough intro without slash command guidance when prompting for input', async () => {
    // Given
    setupRawStdin(toRawInputs([null]));

    // When
    await passthroughMode('ja');

    // Then
    expect(mockInfo).toHaveBeenCalledWith(
      'パススルーモード - タスク内容を入力してください。入力内容をそのまま実行します。',
    );
    const introMessage = mockInfo.mock.calls[0]?.[0] as string;
    expect(introMessage).not.toContain('/go');
    expect(introMessage).not.toContain('/play');
    expect(introMessage).not.toContain('/resume');
    expect(introMessage).not.toContain('/cancel');
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

  it('should return pasted image attachments with placeholders in task text', async () => {
    setupRawStdin([`use ${createOscImagePaste()} please\r`]);

    const result = await passthroughMode('en');

    expect(result.action).toBe('execute');
    expect(result.task).toBe('use [Image #1] please');
    expect(result.attachments?.[0]?.fileName).toBe('image-1.png');
    expect(result.attachments?.[0]).not.toHaveProperty('relativePath');
    expect(result.attachments?.[0]?.tempPath).toBeDefined();
    trackAttachmentSession(result.attachments![0]!.tempPath);
    expect(fs.existsSync(result.attachments![0]!.tempPath)).toBe(true);
  });

  it('should cleanup pasted image session directory when input processing throws after image paste', async () => {
    const tmpRoot = createIsolatedTmpRoot('takt-passthrough-cleanup-');
    const originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = tmpRoot;
    const previousSessionDirs = listTaktTempSessionDirs();
    setupRawStdin([
      `use ${createOscImagePaste()} ${createInvalidSizeOscImagePaste()}\r`,
    ]);

    try {
      await expect(passthroughMode('en')).rejects.toThrow(
        'Pasted inline image data does not match its declared size.',
      );

      expectNoNewTaktTempSessionDirs(previousSessionDirs);
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
    }
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
  it('should generate instructions from a direct task without questions', async () => {
    // Given
    setupMockProvider(['Generated task instruction for login feature.']);
    mockSelectOption.mockResolvedValue('execute');

    // When
    const result = await quietMode('/project', { userMessage: 'implement login feature' });

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Generated task instruction for login feature.');
  });

  it('should show quiet intro without slash command guidance when prompting for input', async () => {
    // Given
    setupRawStdin(toRawInputs([null]));

    // When
    await quietMode('/project');

    // Then
    expect(mockInfo).toHaveBeenCalledWith(
      'Quiet mode - describe your task. Instructions will be generated without further questions.',
    );
    const introMessage = mockInfo.mock.calls[0]?.[0] as string;
    expect(introMessage).not.toContain('/go');
    expect(introMessage).not.toContain('/play');
    expect(introMessage).not.toContain('/resume');
    expect(introMessage).not.toContain('/cancel');
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

  it('should return pasted image attachments from prompted quiet input', async () => {
    setupRawStdin([`use ${createOscImagePaste()} please\r`]);
    setupMockProvider(['Generated task using [Image #1].']);
    mockSelectOption.mockResolvedValue('execute');

    const result = await quietMode('/project');

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Generated task using [Image #1].');
    expect(result.attachments?.[0]?.fileName).toBe('image-1.png');
    expect(result.attachments?.[0]).not.toHaveProperty('relativePath');
    expect(result.attachments?.[0]?.tempPath).toBeDefined();
    trackAttachmentSession(result.attachments![0]!.tempPath);
    expect(fs.existsSync(result.attachments![0]!.tempPath)).toBe(true);
  });

  it('should cleanup pasted image session directory when prompted input processing throws after image paste', async () => {
    const tmpRoot = createIsolatedTmpRoot('takt-quiet-cleanup-');
    const originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = tmpRoot;
    const previousSessionDirs = listTaktTempSessionDirs();
    setupRawStdin([
      `use ${createOscImagePaste()} ${createInvalidSizeOscImagePaste()}\r`,
    ]);
    setupMockProvider([]);

    try {
      await expect(quietMode('/project')).rejects.toThrow(
        'Pasted inline image data does not match its declared size.',
      );

      expectNoNewTaktTempSessionDirs(previousSessionDirs);
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
    }
  });

  it('should include workflow context in summary generation', async () => {
    // Given
    const workflowContext: WorkflowContext = {
      name: 'test-workflow',
      description: 'A test workflow',
      workflowStructure: '1. implement\n2. review',
      stepPreviews: [],
    };
    setupMockProvider(['Instruction with workflow context.']);
    mockSelectOption.mockResolvedValue('execute');

    // When
    const result = await quietMode('/project', { userMessage: 'some task' }, workflowContext);

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Instruction with workflow context.');
  });
});

// ── Persona mode tests ──

describe('personaMode', () => {
  const mockFirstStep: FirstStepInfo = {
    personaContent: 'You are a senior coder. Write clean, maintainable code.',
    personaDisplayName: 'Coder',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  };

  it('should return cancel when user types /cancel', async () => {
    // Given
    setupRawStdin(toRawInputs(['/cancel']));
    setupMockProvider([]);

    // When
    const result = await personaMode('/project', mockFirstStep);

    // Then
    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should return cancel on EOF', async () => {
    // Given
    setupRawStdin(toRawInputs([null]));
    setupMockProvider([]);

    // When
    const result = await personaMode('/project', mockFirstStep);

    // Then
    expect(result.action).toBe('cancel');
  });

  it('should use first step allowed tools', async () => {
    // Given
    setupRawStdin(toRawInputs(['check the code', '/cancel']));
    setupMockProvider(['Looking at the code.']);

    // When
    await personaMode('/project', mockFirstStep);

    // Then
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
      }),
    );
  });

  it('should summarize initial /go task text without prior conversation', async () => {
    setupRawStdin(toRawInputs(['/go add regression coverage', '/cancel']));
    setupMockProvider(['Add regression coverage for the shared /go path.']);
    mockSelectOption.mockResolvedValue('execute');

    const result = await personaMode('/project', mockFirstStep);

    expect(result).toEqual({
      action: 'execute',
      task: 'Add regression coverage for the shared /go path.',
    });
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);
  });

  it('should keep initialInput as source context until the user acts', async () => {
    // Given
    setupRawStdin(toRawInputs(['/go']));
    setupMockProvider(['Task summary.']);
    mockSelectOption.mockResolvedValue('execute');

    // When
    const result = await personaMode('/project', mockFirstStep, { sourceContext: 'fix the login' });

    // Then
    expect(result.action).toBe('execute');
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);
  });

  it('should keep initial /go text as user note when only source context exists', async () => {
    setupRawStdin(toRawInputs(['/go inspect latest feedback', '/cancel']));
    setupMockProvider(['Task summary with source context and note.']);
    mockSelectOption.mockResolvedValue('execute');

    const result = await personaMode('/project', mockFirstStep, { sourceContext: 'PR context' });

    expect(result).toEqual({
      action: 'execute',
      task: 'Task summary with source context and note.',
    });
    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);
  });

  it('should include source context in the first persona prompt without turning it into a user turn', async () => {
    setupRawStdin(toRawInputs(['inspect the latest feedback', '/cancel']));
    setupMockProvider(['Looking at the context now.']);

    await personaMode('/project', mockFirstStep, { sourceContext: 'PR context' });

    const mockProvider = mockGetProvider.mock.results[0]!.value as { _call: ReturnType<typeof vi.fn> };
    expect(mockProvider._call).toHaveBeenCalledTimes(1);
  });

  it('should handle /play command', async () => {
    // Given
    setupRawStdin(toRawInputs(['/play direct task text']));
    setupMockProvider([]);

    // When
    const result = await personaMode('/project', mockFirstStep);

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('direct task text');
  });

  it('should fall back to default tools when first step has none', async () => {
    // Given
    const noToolsStep: FirstStepInfo = {
      personaContent: 'Persona prompt',
      personaDisplayName: 'Agent',
      allowedTools: [],
    };
    setupRawStdin(toRawInputs(['test', '/cancel']));
    setupMockProvider(['response']);

    // When
    await personaMode('/project', noToolsStep);

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
    const result = await personaMode('/project', mockFirstStep);

    // Then
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Final summary.');
  });
});
