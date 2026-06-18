import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContext, setQuietMode } from '../shared/context.js';

vi.mock('../features/interactive/lineEditor.js', () => ({
  readMultilineInput: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
}));

import { readMultilineInput } from '../features/interactive/lineEditor.js';
import {
  promptContinueAfterTaskResult,
  shouldPromptForInteractiveContinue,
} from '../features/interactive/continuePrompt.js';
import { info } from '../shared/ui/index.js';

const mockReadMultilineInput = vi.mocked(readMultilineInput);
const mockInfo = vi.mocked(info);

let originalIsTTY: boolean | undefined;
let originalNoTty: string | undefined;
let originalTouchTty: string | undefined;
let originalCi: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  AppContext.resetInstance();
  originalIsTTY = process.stdin.isTTY;
  originalNoTty = process.env.TAKT_NO_TTY;
  originalTouchTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;
  originalCi = process.env.CI;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  delete process.env.TAKT_NO_TTY;
  delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
  delete process.env.CI;
});

afterEach(() => {
  AppContext.resetInstance();
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  if (originalNoTty === undefined) {
    delete process.env.TAKT_NO_TTY;
  } else {
    process.env.TAKT_NO_TTY = originalNoTty;
  }
  if (originalTouchTty === undefined) {
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
  } else {
    process.env.TAKT_TEST_FLG_TOUCH_TTY = originalTouchTty;
  }
  if (originalCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = originalCi;
  }
});

describe('shouldPromptForInteractiveContinue', () => {
  it.each(['assistant', 'persona', 'passthrough'] as const)(
    'returns true for normal interactive TTY %s mode',
    (selectedMode) => {
      setQuietMode(false);

      const result = shouldPromptForInteractiveContinue({ selectedMode });

      expect(result).toBe(true);
    },
  );

  it('returns false for selected quiet mode', () => {
    setQuietMode(false);

    const result = shouldPromptForInteractiveContinue({ selectedMode: 'quiet' });

    expect(result).toBe(false);
  });

  it('returns false for global quiet mode', () => {
    setQuietMode(true);

    const result = shouldPromptForInteractiveContinue({ selectedMode: 'assistant' });

    expect(result).toBe(false);
  });

  it('returns false for non-TTY execution', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    setQuietMode(false);

    const result = shouldPromptForInteractiveContinue({ selectedMode: 'assistant' });

    expect(result).toBe(false);
  });

  it('returns false for CI execution even when stdin is TTY', () => {
    process.env.CI = 'true';
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    setQuietMode(false);

    const result = shouldPromptForInteractiveContinue({ selectedMode: 'assistant' });

    expect(result).toBe(false);
  });
});

describe('promptContinueAfterTaskResult', () => {
  it('prints completed status and accepts empty input as continue', async () => {
    mockReadMultilineInput.mockResolvedValue('');

    const result = await promptContinueAfterTaskResult(true, 'en');

    expect(result).toBe(true);
    expect(mockInfo).toHaveBeenCalledWith('Task completed');
    expect(mockReadMultilineInput).toHaveBeenCalledWith('Continue? [Y/n]');
  });

  it('prints failed status and returns false for no input', async () => {
    mockReadMultilineInput.mockResolvedValue('n');

    const result = await promptContinueAfterTaskResult(false, 'en');

    expect(result).toBe(false);
    expect(mockInfo).toHaveBeenCalledWith('Task failed');
    expect(mockReadMultilineInput).toHaveBeenCalledWith('Continue? [Y/n]');
  });

  it.each(['y', 'Y', 'yes', 'YES'])('accepts %s as continue', async (input) => {
    mockReadMultilineInput.mockResolvedValue(input);

    const result = await promptContinueAfterTaskResult(true, 'en');

    expect(result).toBe(true);
  });

  it('treats EOF or Ctrl-C as exit', async () => {
    mockReadMultilineInput.mockResolvedValue(null);

    const result = await promptContinueAfterTaskResult(true, 'en');

    expect(result).toBe(false);
  });
});
