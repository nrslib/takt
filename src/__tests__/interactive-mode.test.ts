/**
 * Tests for interactive mode variants (assistant, grill-me, persona)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockProvider,
  restoreStdin,
  setupRawStdin,
  toRawInputs,
} from './helpers/stdinSimulator.js';

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
  takeSessionState: vi.fn(() => null),
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

vi.mock('../shared/prompt/confirm.js', () => ({
  confirm: vi.fn(),
}));

import { getProvider } from '../infra/providers/index.js';
import { selectOptionWithDefault, selectOption } from '../shared/prompt/index.js';
import { confirm } from '../shared/prompt/confirm.js';
import { PROVIDER_TYPES } from '../shared/types/provider.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOptionWithDefault = vi.mocked(selectOptionWithDefault);
const mockSelectOption = vi.mocked(selectOption);
const mockConfirm = vi.mocked(confirm);
const originalTmpDir = process.env.TMPDIR;
const TEST_TMPDIR = fs.realpathSync(os.tmpdir());

// ── Stdin helpers (same pattern as interactive.test.ts) ──


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
  // The spies stay reachable for the assertions; the rest of the provider
  // contract comes from the shared double so a change to it fails type checking.
  const mockProvider = Object.assign(makeProvider({ setup: mockSetup }), {
    _call: mockCall,
    _setup: mockSetup,
  });
  mockGetProvider.mockReturnValue(mockProvider);
}

// ── Imports (after mocks) ──
import { makeProvider } from './test-helpers.js';

import { INTERACTIVE_MODES, DEFAULT_INTERACTIVE_MODE } from '../core/models/interactive-mode.js';
import { selectInteractiveMode } from '../features/interactive/modeSelection.js';
import { selectInteractiveProvider } from '../features/interactive/providerSelection.js';
import { personaMode } from '../features/interactive/personaMode.js';
import type { FirstStepInfo } from '../infra/config/loaders/workflowResolver.js';

// ── Setup ──

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TMPDIR = TEST_TMPDIR;
  mockSelectOptionWithDefault.mockResolvedValue('assistant');
  mockSelectOption.mockResolvedValue('execute');
});

afterEach(() => {
  restoreStdin();
  if (originalTmpDir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = originalTmpDir;
  }
});

// ── InteractiveMode type & constants tests ──

describe('InteractiveMode type', () => {
  it('should define only the three supported modes', () => {
    expect(INTERACTIVE_MODES).toEqual(['assistant', 'grill-me', 'persona']);
  });

  it('should have assistant as default mode', () => {
    expect(DEFAULT_INTERACTIVE_MODE).toBe('assistant');
  });
});

// ── Mode selection tests ──

describe('selectInteractiveMode', () => {
  it('should call selectOptionWithDefault with three mode options', async () => {
    // When
    await selectInteractiveMode('en');

    // Then
    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ value: 'assistant' }),
        expect.objectContaining({ value: 'grill-me' }),
        expect.objectContaining({ value: 'persona' }),
      ]),
      'assistant',
    );
  });

  it('should exclude unavailable modes and use assistant as the default', async () => {
    // When
    await selectInteractiveMode('en', ['assistant', 'persona']);

    // Then
    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      [
        expect.objectContaining({ value: 'assistant' }),
        expect.objectContaining({ value: 'persona' }),
      ],
      'assistant',
    );
  });

  it('should use the first available mode when the default is unavailable', async () => {
    await selectInteractiveMode('en', ['grill-me', 'persona']);

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      [
        expect.objectContaining({ value: 'grill-me' }),
        expect.objectContaining({ value: 'persona' }),
      ],
      'grill-me',
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
    expect(options?.[1]?.value).toBe('grill-me');
    expect(options?.[2]?.value).toBe('persona');
  });
});

describe('selectInteractiveProvider', () => {
  it('should offer providers with the current provider as the default', async () => {
    mockSelectOptionWithDefault.mockResolvedValueOnce('claude');

    const selected = await selectInteractiveProvider('en', 'codex');

    expect(selected).toBe('claude');
    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      PROVIDER_TYPES.map((provider) => ({ label: provider, value: provider })),
      'codex',
    );
  });

  it('should return null when provider selection is cancelled', async () => {
    mockSelectOptionWithDefault.mockResolvedValueOnce(null);

    const selected = await selectInteractiveProvider('ja', 'codex');

    expect(selected).toBeNull();
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
    const { provider, capture } = createMockProvider(['Add regression coverage for the shared /go path.']);
    mockGetProvider.mockReturnValue(provider);
    mockSelectOption.mockResolvedValue('execute');

    const result = await personaMode('/project', mockFirstStep);

    expect(result).toEqual({
      action: 'execute',
      task: 'Add regression coverage for the shared /go path.',
    });
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(capture.prompts[0]).toMatch(/Gherkin/);
    expect(capture.prompts[0]).not.toMatch(/\bQuint\b|\bAlloy\b/);
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
