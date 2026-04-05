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
