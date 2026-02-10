/**
 * Tests for createIssueFromTask function
 *
 * Verifies title truncation (100-char boundary), success/failure UI output,
 * and multi-line task handling (first line → title, full text → body).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../infra/github/issue.js', () => ({
  createIssue: vi.fn(),
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

import { createIssue } from '../infra/github/issue.js';
import { success, error } from '../shared/ui/index.js';
import { createIssueFromTask } from '../features/tasks/index.js';

const mockCreateIssue = vi.mocked(createIssue);
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
});
