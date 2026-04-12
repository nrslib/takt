import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../features/interactive/lineEditor.js', () => ({
  readMultilineInput: vi.fn(),
}));

import { readMultilineInput } from '../features/interactive/lineEditor.js';
import {
  createSlashCommandCompletionProvider,
  getSlashCommandCompletions,
  readInteractiveInput,
} from '../features/interactive/interactiveInput.js';

const mockReadMultilineInput = vi.mocked(readMultilineInput);

describe('interactiveInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSlashCommandCompletions', () => {
    it('should return localized English descriptions with apply values', () => {
      const result = getSlashCommandCompletions('/play', 'en');

      expect(result).toEqual([
        {
          value: '/play',
          applyValue: '/play ',
          description: 'Run a task immediately',
        },
      ]);
    });

    it('should return localized Japanese descriptions', () => {
      const result = getSlashCommandCompletions('/play', 'ja');

      expect(result).toEqual([
        {
          value: '/play',
          applyValue: '/play ',
          description: 'タスクを即実行する',
        },
      ]);
    });
  });

  describe('createSlashCommandCompletionProvider', () => {
    it('should return empty candidates for non-slash input', () => {
      const provider = createSlashCommandCompletionProvider('en');

      expect(provider({ buffer: 'hello' })).toEqual([]);
    });

    it('should return empty candidates for multiline input', () => {
      const provider = createSlashCommandCompletionProvider('en');

      expect(provider({ buffer: '/go\nnote' })).toEqual([]);
    });

    it('should exclude /retry when enableRetryCommand is falsy', () => {
      const provider = createSlashCommandCompletionProvider('en', { enableRetryCommand: false, hasPreviousOrder: true });
      const values = provider({ buffer: '/' }).map((c) => c.value);

      expect(values).not.toContain('/retry');
      expect(values).toContain('/replay');
    });

    it('should include /retry when enableRetryCommand is true', () => {
      const provider = createSlashCommandCompletionProvider('en', { enableRetryCommand: true, hasPreviousOrder: true });
      const values = provider({ buffer: '/' }).map((c) => c.value);

      expect(values).toContain('/retry');
    });

    it('should exclude /replay when hasPreviousOrder is falsy', () => {
      const provider = createSlashCommandCompletionProvider('en', { enableRetryCommand: true, hasPreviousOrder: false });
      const values = provider({ buffer: '/' }).map((c) => c.value);

      expect(values).not.toContain('/replay');
      expect(values).toContain('/retry');
    });

    it('should include /replay when hasPreviousOrder is true', () => {
      const provider = createSlashCommandCompletionProvider('en', { hasPreviousOrder: true });
      const values = provider({ buffer: '/' }).map((c) => c.value);

      expect(values).toContain('/replay');
    });

    it('should exclude /retry and /replay when availability is explicitly set without them', () => {
      const provider = createSlashCommandCompletionProvider('en', {});
      const values = provider({ buffer: '/' }).map((c) => c.value);

      expect(values).not.toContain('/retry');
      expect(values).not.toContain('/replay');
    });

    it('should support suffix slash command form "text /go"', () => {
      const provider = createSlashCommandCompletionProvider('en');
      const results = provider({ buffer: 'fix the bug /g' });

      expect(results.length).toBe(1);
      expect(results[0]!.value).toBe('fix the bug /go');
      expect(results[0]!.applyValue).toBe('fix the bug /go ');
    });

    it('should return empty for slash in middle of text', () => {
      const provider = createSlashCommandCompletionProvider('en');
      const results = provider({ buffer: 'fix /go more text' });

      expect(results).toEqual([]);
    });
  });

  describe('readInteractiveInput', () => {
    it('should delegate to readMultilineInput with a slash command completion provider', async () => {
      mockReadMultilineInput.mockResolvedValue('/go');

      const result = await readInteractiveInput('> ', 'en');

      expect(result).toBe('/go');
      expect(mockReadMultilineInput).toHaveBeenCalledOnce();

      const [prompt, options] = mockReadMultilineInput.mock.calls[0]!;
      expect(prompt).toBe('> ');
      expect(options?.completionProvider).toBeTypeOf('function');
      expect(options?.completionProvider?.({ buffer: '/g' })).toEqual([
        {
          value: '/go',
          applyValue: '/go ',
          description: 'Create instruction & run',
        },
      ]);
    });
  });
});
