/**
 * Tests for createIssueFromTask function
 *
 * Verifies title truncation (100-char boundary), success/failure UI output,
 * and multi-line task handling (first line → title, full text → body).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateIssue } = vi.hoisted(() => ({
  mockCreateIssue: vi.fn(),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    createIssue: (...args: unknown[]) => mockCreateIssue(...args),
  }),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { success, error } from '../shared/ui/index.js';
import { createIssueFromTask } from '../features/tasks/index.js';
import { extractTitle } from '../features/tasks/add/index.js';

const mockSuccess = vi.mocked(success);
const mockError = vi.mocked(error);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createIssueFromTask', () => {
  describe('title truncation boundary', () => {
    it('should use title as-is when exactly 99 characters', () => {
      // Given: 99-character first line
      const title99 = 'a'.repeat(99);
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask(title99);

      // Then: title passed without truncation
      expect(mockCreateIssue).toHaveBeenCalledWith({
        title: title99,
        body: title99,
      });
    });

    it('should use title as-is when exactly 100 characters', () => {
      // Given: 100-character first line
      const title100 = 'a'.repeat(100);
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask(title100);

      // Then: title passed without truncation
      expect(mockCreateIssue).toHaveBeenCalledWith({
        title: title100,
        body: title100,
      });
    });

    it('should truncate title to 97 chars + ellipsis when 101 characters', () => {
      // Given: 101-character first line
      const title101 = 'a'.repeat(101);
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask(title101);

      // Then: title truncated to 97 chars + "..."
      const expectedTitle = `${'a'.repeat(97)}...`;
      expect(expectedTitle).toHaveLength(100);
      expect(mockCreateIssue).toHaveBeenCalledWith({
        title: expectedTitle,
        body: title101,
      });
    });
  });

  it('should display success message with URL when issue creation succeeds', () => {
    // Given
    const url = 'https://github.com/owner/repo/issues/42';
    mockCreateIssue.mockReturnValue({ success: true, url });

    // When
    createIssueFromTask('Test task');

    // Then
    expect(mockSuccess).toHaveBeenCalledWith(`Issue created: ${url}`);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('should display error message when issue creation fails', () => {
    // Given
    const errorMsg = 'repo not found';
    mockCreateIssue.mockReturnValue({ success: false, error: errorMsg });

    // When
    createIssueFromTask('Test task');

    // Then
    expect(mockError).toHaveBeenCalledWith(`Failed to create issue: ${errorMsg}`);
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  describe('return value', () => {
    it('should return issue number when creation succeeds', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/42' });

      // When
      const result = createIssueFromTask('Test task');

      // Then
      expect(result).toBe(42);
    });

    it('should return undefined when creation fails', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: false, error: 'auth failed' });

      // When
      const result = createIssueFromTask('Test task');

      // Then
      expect(result).toBeUndefined();
    });

    it('should return undefined and display error when URL has non-numeric suffix', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/abc' });

      // When
      const result = createIssueFromTask('Test task');

      // Then
      expect(result).toBeUndefined();
      expect(mockError).toHaveBeenCalledWith('Failed to extract issue number from URL');
    });
  });

  it('should use first line as title and full text as body for multi-line task', () => {
    // Given: multi-line task
    const task = 'First line title\nSecond line details\nThird line more info';
    mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

    // When
    createIssueFromTask(task);

    // Then: first line → title, full text → body
    expect(mockCreateIssue).toHaveBeenCalledWith({
      title: 'First line title',
      body: task,
    });
  });

  describe('labels option', () => {
    it('should pass labels to createIssue when provided', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task', { labels: ['bug'] });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith({
        title: 'Test task',
        body: 'Test task',
        labels: ['bug'],
      });
    });

    it('should not include labels key when options is undefined', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task');

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith({
        title: 'Test task',
        body: 'Test task',
      });
    });

    it('should not include labels key when labels is empty array', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task', { labels: [] });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith({
        title: 'Test task',
        body: 'Test task',
      });
    });

    it('should filter out empty string labels', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task', { labels: ['bug', '', 'enhancement'] });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith({
        title: 'Test task',
        body: 'Test task',
        labels: ['bug', 'enhancement'],
      });
    });
  });
});

describe('extractTitle', () => {
  describe('Markdown heading extraction', () => {
    it('should strip # and return text for h1 heading', () => {
      // Given
      const task = '# Fix broken title\nDetails here';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Fix broken title');
    });

    it('should strip ## and return text for h2 heading', () => {
      // Given
      const task = '## Fix broken title\nDetails here';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Fix broken title');
    });

    it('should strip ### and return text for h3 heading', () => {
      // Given
      const task = '### Fix broken title\nDetails here';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Fix broken title');
    });

    it('should prefer first Markdown heading over preceding plain text', () => {
      // Given: AI preamble followed by heading
      const task = '失礼しました。修正します。\n## Fix broken title\nDetails here';

      // When
      const result = extractTitle(task);

      // Then: heading wins over first line
      expect(result).toBe('Fix broken title');
    });

    it('should find heading even when multiple empty lines precede it', () => {
      // Given
      const task = '\n\n## Fix broken title\nDetails here';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Fix broken title');
    });
  });

  describe('fallback to first non-empty line', () => {
    it('should return first non-empty line when no Markdown heading exists', () => {
      // Given: plain text without heading
      const task = 'Fix broken title\nSecond line details';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Fix broken title');
    });

    it('should skip leading empty lines when no heading exists', () => {
      // Given: leading blank lines
      const task = '\n\nFix broken title\nDetails here';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Fix broken title');
    });

    it('should not treat h4+ headings as Markdown headings', () => {
      // Given: #### is not matched (only h1-h3 are recognized)
      const task = '#### h4 heading\nDetails here';

      // When
      const result = extractTitle(task);

      // Then: falls back to first non-empty line as-is
      expect(result).toBe('#### h4 heading');
    });

    it('should not treat heading without space after hash as Markdown heading', () => {
      // Given: #Title has no space, so not recognized as heading
      const task = '#NoSpace\nDetails here';

      // When
      const result = extractTitle(task);

      // Then: falls back to first non-empty line
      expect(result).toBe('#NoSpace');
    });
  });

  describe('title truncation', () => {
    it('should truncate heading title to 97 chars + ellipsis when over 100 chars', () => {
      // Given: heading text over 100 characters
      const longTitle = 'a'.repeat(102);
      const task = `## ${longTitle}\nDetails here`;

      // When
      const result = extractTitle(task);

      // Then: truncated to 97 + "..."
      expect(result).toBe(`${'a'.repeat(97)}...`);
      expect(result).toHaveLength(100);
    });

    it('should truncate plain text title to 97 chars + ellipsis when over 100 chars', () => {
      // Given: plain text over 100 characters
      const longTitle = 'b'.repeat(102);
      const task = `${longTitle}\nDetails here`;

      // When
      const result = extractTitle(task);

      // Then: truncated to 97 + "..."
      expect(result).toBe(`${'b'.repeat(97)}...`);
      expect(result).toHaveLength(100);
    });

    it('should not truncate title of exactly 100 characters', () => {
      // Given: title exactly 100 chars
      const title100 = 'c'.repeat(100);
      const task = `## ${title100}\nDetails here`;

      // When
      const result = extractTitle(task);

      // Then: not truncated
      expect(result).toBe(title100);
      expect(result).toHaveLength(100);
    });
  });
});
