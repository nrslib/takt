/**
 * Unit tests for ask-user-question-handler, TTY handler,
 * and AskUserQuestionDeniedError handling in SdkOptionsBuilder.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AskUserQuestionDeniedError,
  createDenyAskUserQuestionHandler,
} from '../core/piece/ask-user-question-error.js';
import { createAskUserQuestionHandler } from '../infra/claude/ask-user-question-handler.js';
import { SdkOptionsBuilder, buildSdkOptions } from '../infra/claude/options-builder.js';
import type { AskUserQuestionInput, ClaudeSpawnOptions } from '../infra/claude/types.js';

vi.mock('../shared/prompt/select.js', () => ({
  selectOption: vi.fn(),
}));

vi.mock('../shared/prompt/confirm.js', () => ({
  promptInput: vi.fn(),
}));

import { selectOption } from '../shared/prompt/select.js';
import { promptInput } from '../shared/prompt/confirm.js';
import { createTtyAskUserQuestionHandler } from '../infra/claude/ask-user-question-tty.js';

const mockedSelectOption = vi.mocked(selectOption);
const mockedPromptInput = vi.mocked(promptInput);

describe('AskUserQuestionDeniedError', () => {
  it('should have the correct name', () => {
    const error = new AskUserQuestionDeniedError();
    expect(error.name).toBe('AskUserQuestionDeniedError');
  });

  it('should have a message instructing text-based output', () => {
    const error = new AskUserQuestionDeniedError();
    expect(error.message).toContain('not available in non-interactive mode');
  });

  it('should be an instance of Error', () => {
    const error = new AskUserQuestionDeniedError();
    expect(error).toBeInstanceOf(Error);
  });
});

describe('createAskUserQuestionHandler', () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalNoTty = process.env.TAKT_NO_TTY;
  const originalTouchTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true });
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
  });

  it('should return a handler when TTY is available', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    delete process.env.TAKT_NO_TTY;
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;

    const handler = createAskUserQuestionHandler();
    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });

  it('should return a deny handler when no TTY is available', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });
    delete process.env.TAKT_NO_TTY;
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;

    const handler = createAskUserQuestionHandler();
    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });

  it('should return a deny handler when TAKT_NO_TTY=1', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    process.env.TAKT_NO_TTY = '1';
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;

    const handler = createAskUserQuestionHandler();
    expect(handler).toBeDefined();
  });

  it('deny handler should throw AskUserQuestionDeniedError', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });
    delete process.env.TAKT_NO_TTY;
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;

    const handler = createAskUserQuestionHandler();
    const dummyInput: AskUserQuestionInput = {
      questions: [{ question: 'Which option?' }],
    };

    expect(() => handler(dummyInput)).toThrow(AskUserQuestionDeniedError);
  });
});

describe('createDenyAskUserQuestionHandler', () => {
  it('should always throw AskUserQuestionDeniedError', () => {
    const handler = createDenyAskUserQuestionHandler();
    const input: AskUserQuestionInput = {
      questions: [{ question: 'Test?' }],
    };

    expect(() => handler(input)).toThrow(AskUserQuestionDeniedError);
  });

  it('should return a function', () => {
    const handler = createDenyAskUserQuestionHandler();
    expect(typeof handler).toBe('function');
  });
});

describe('createTtyAskUserQuestionHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('single-select questions', () => {
    it('should return the selected option label', async () => {
      mockedSelectOption.mockResolvedValue('Option A');

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{
          question: 'Which library?',
          header: 'Library',
          options: [
            { label: 'Option A', description: 'First option' },
            { label: 'Option B', description: 'Second option' },
          ],
        }],
      };

      const result = await handler(input);

      expect(result).toEqual({ 'Which library?': 'Option A' });
      expect(mockedSelectOption).toHaveBeenCalledWith(
        '[Library] Which library?',
        expect.arrayContaining([
          expect.objectContaining({ label: 'Option A', value: 'Option A' }),
          expect.objectContaining({ label: 'Option B', value: 'Option B' }),
          expect.objectContaining({ label: 'Other', value: '__other__' }),
        ]),
      );
    });

    it('should prompt for text input when Other is selected', async () => {
      mockedSelectOption.mockResolvedValue('__other__');
      mockedPromptInput.mockResolvedValue('Custom answer');

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{
          question: 'Which option?',
          options: [{ label: 'Option A' }],
        }],
      };

      const result = await handler(input);

      expect(result).toEqual({ 'Which option?': 'Custom answer' });
    });

    it('should throw AskUserQuestionDeniedError when cancelled', async () => {
      mockedSelectOption.mockResolvedValue(null);

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{
          question: 'Which option?',
          options: [{ label: 'Option A' }],
        }],
      };

      await expect(handler(input)).rejects.toThrow(AskUserQuestionDeniedError);
    });
  });

  describe('multi-select questions', () => {
    it('should return comma-separated selected labels', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedPromptInput.mockResolvedValueOnce('1,3');

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{
          question: 'Which features?',
          multiSelect: true,
          options: [
            { label: 'Feature A' },
            { label: 'Feature B' },
            { label: 'Feature C' },
          ],
        }],
      };

      const result = await handler(input);

      expect(result).toEqual({ 'Which features?': 'Feature A, Feature C' });
    });

    it('should handle Other selection with additional text input', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedPromptInput
        .mockResolvedValueOnce('1,4')
        .mockResolvedValueOnce('My custom feature');

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{
          question: 'Which features?',
          multiSelect: true,
          options: [
            { label: 'Feature A' },
            { label: 'Feature B' },
            { label: 'Feature C' },
          ],
        }],
      };

      const result = await handler(input);

      expect(result).toEqual({ 'Which features?': 'Feature A, My custom feature' });
    });

    it('should throw AskUserQuestionDeniedError when cancelled', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedPromptInput.mockResolvedValue(null);

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{
          question: 'Which features?',
          multiSelect: true,
          options: [{ label: 'Feature A' }],
        }],
      };

      await expect(handler(input)).rejects.toThrow(AskUserQuestionDeniedError);
    });
  });

  describe('free-text questions', () => {
    it('should return the entered text', async () => {
      mockedPromptInput.mockResolvedValue('My answer');

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{ question: 'What is your name?' }],
      };

      const result = await handler(input);

      expect(result).toEqual({ 'What is your name?': 'My answer' });
    });

    it('should throw AskUserQuestionDeniedError when cancelled', async () => {
      mockedPromptInput.mockResolvedValue(null);

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{ question: 'What is your name?' }],
      };

      await expect(handler(input)).rejects.toThrow(AskUserQuestionDeniedError);
    });
  });

  describe('multiple questions', () => {
    it('should process all questions and return aggregated answers', async () => {
      mockedSelectOption.mockResolvedValue('Option B');
      mockedPromptInput.mockResolvedValue('Free text answer');

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [
          {
            question: 'Pick one',
            options: [{ label: 'Option A' }, { label: 'Option B' }],
          },
          {
            question: 'Enter text',
          },
        ],
      };

      const result = await handler(input);

      expect(result).toEqual({
        'Pick one': 'Option B',
        'Enter text': 'Free text answer',
      });
    });
  });

  describe('header display', () => {
    it('should prefix question with header when present', async () => {
      mockedPromptInput.mockResolvedValue('answer');

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{ question: 'What?', header: 'Auth' }],
      };

      await handler(input);

      expect(mockedPromptInput).toHaveBeenCalledWith('[Auth] What?');
    });

    it('should not prefix when header is absent', async () => {
      mockedPromptInput.mockResolvedValue('answer');

      const handler = createTtyAskUserQuestionHandler();
      const input: AskUserQuestionInput = {
        questions: [{ question: 'What?' }],
      };

      await handler(input);

      expect(mockedPromptInput).toHaveBeenCalledWith('What?');
    });
  });
});

describe('SdkOptionsBuilder.createAskUserQuestionHooks — AskUserQuestionDeniedError handling', () => {
  it('should return decision: block when handler throws AskUserQuestionDeniedError', async () => {
    const denyHandler = (): never => {
      throw new AskUserQuestionDeniedError();
    };

    const hooks = SdkOptionsBuilder.createAskUserQuestionHooks(denyHandler);
    const preToolUseHooks = hooks['PreToolUse'];
    expect(preToolUseHooks).toBeDefined();
    expect(preToolUseHooks).toHaveLength(1);

    const hookFn = preToolUseHooks![0]!.hooks[0]!;
    const input = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Test?' }] },
    };
    const abortController = new AbortController();

    const result = await hookFn(input, undefined, { signal: abortController.signal });

    expect(result).toEqual({
      continue: true,
      decision: 'block',
      reason: expect.stringContaining('not available in non-interactive mode'),
    });
  });

  it('should block on unexpected handler errors (fail-safe)', async () => {
    const failingHandler = (): never => {
      throw new Error('unexpected failure');
    };

    const hooks = SdkOptionsBuilder.createAskUserQuestionHooks(failingHandler);
    const hookFn = hooks['PreToolUse']![0]!.hooks[0]!;
    const input = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Test?' }] },
    };
    const abortController = new AbortController();

    const result = await hookFn(input, undefined, { signal: abortController.signal });

    expect(result).toEqual({
      continue: true,
      decision: 'block',
      reason: 'Internal error in AskUserQuestion handler',
    });
  });

  it('should pass through successful handler results', async () => {
    const successHandler = vi.fn().mockResolvedValue({ 'Which option?': 'Option A' });

    const hooks = SdkOptionsBuilder.createAskUserQuestionHooks(successHandler);
    const hookFn = hooks['PreToolUse']![0]!.hooks[0]!;
    const input = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which option?' }] },
    };
    const abortController = new AbortController();

    const result = await hookFn(input, undefined, { signal: abortController.signal });

    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: JSON.stringify({ 'Which option?': 'Option A' }),
      },
    });
  });
});

describe('buildSdkOptions — AskUserQuestion hooks registration', () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalNoTty = process.env.TAKT_NO_TTY;
  const originalTouchTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true });
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
  });

  it('should auto-register PreToolUse hooks in non-TTY when no handler is provided', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });
    delete process.env.TAKT_NO_TTY;
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;

    const options: ClaudeSpawnOptions = { cwd: '/tmp/test' };
    const sdkOptions = buildSdkOptions(options);

    expect(sdkOptions.hooks).toBeDefined();
    expect(sdkOptions.hooks!['PreToolUse']).toBeDefined();
  });

  it('should register hooks in TTY when no handler is provided', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    delete process.env.TAKT_NO_TTY;
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;

    const options: ClaudeSpawnOptions = { cwd: '/tmp/test' };
    const sdkOptions = buildSdkOptions(options);

    expect(sdkOptions.hooks).toBeDefined();
    expect(sdkOptions.hooks!['PreToolUse']).toBeDefined();
  });

  it('non-TTY auto-deny hook should return decision: block for AskUserQuestion', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });
    delete process.env.TAKT_NO_TTY;
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;

    const options: ClaudeSpawnOptions = { cwd: '/tmp/test' };
    const sdkOptions = buildSdkOptions(options);

    const hookFn = sdkOptions.hooks!['PreToolUse']![0]!.hooks[0]!;
    const input = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Choose?' }] },
    };
    const abortController = new AbortController();

    const result = await hookFn(input, undefined, { signal: abortController.signal });

    expect(result).toEqual({
      continue: true,
      decision: 'block',
      reason: expect.stringContaining('not available in non-interactive mode'),
    });
  });

  it('should use explicit handler when provided, even in non-TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });
    delete process.env.TAKT_NO_TTY;
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;

    const customHandler = vi.fn().mockResolvedValue({});
    const options: ClaudeSpawnOptions = {
      cwd: '/tmp/test',
      onAskUserQuestion: customHandler,
    };
    const sdkOptions = buildSdkOptions(options);

    // Hooks should be registered (using the custom handler)
    expect(sdkOptions.hooks).toBeDefined();
    expect(sdkOptions.hooks!['PreToolUse']).toBeDefined();
  });
});
