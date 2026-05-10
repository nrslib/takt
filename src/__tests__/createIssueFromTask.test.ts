/**
 * Tests for createIssueFromTask function
 *
 * Verifies title truncation (100-char boundary), success/failure UI output,
 * and multi-line task handling (first line → title, full text → body).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateIssue, mockLogInfo, mockLogError } = vi.hoisted(() => ({
  mockCreateIssue: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
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
    info: mockLogInfo,
    debug: vi.fn(),
    error: mockLogError,
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
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: title99, body: title99 },
        undefined,
      );
    });

    it('should use title as-is when exactly 100 characters', () => {
      // Given: 100-character first line
      const title100 = 'a'.repeat(100);
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask(title100);

      // Then: title passed without truncation
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: title100, body: title100 },
        undefined,
      );
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
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: expectedTitle, body: title101 },
        undefined,
      );
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
    expect(mockCreateIssue).toHaveBeenCalledWith(
      { title: 'First line title', body: task },
      undefined,
    );
  });

  describe('cwd propagation', () => {
    it('cwd を指定した場合は createIssue に cwd を渡す', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task', { cwd: '/worktree/clone' });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Test task', body: 'Test task' },
        '/worktree/clone',
      );
    });

    it('cwd 省略時は createIssue に undefined を渡す', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task');

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Test task', body: 'Test task' },
        undefined,
      );
    });
  });

  describe('labels option', () => {
    it('should pass labels to createIssue when provided', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task', { labels: ['bug'] });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Test task', body: 'Test task', labels: ['bug'] },
        undefined,
      );
    });

    it('should not include labels key when options is undefined', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task');

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Test task', body: 'Test task' },
        undefined,
      );
    });

    it('should not include labels key when labels is empty array', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task', { labels: [] });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Test task', body: 'Test task' },
        undefined,
      );
    });

    it('should filter out empty string labels', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      createIssueFromTask('Test task', { labels: ['bug', '', 'enhancement'] });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Test task', body: 'Test task', labels: ['bug', 'enhancement'] },
        undefined,
      );
    });
  });

  describe('structured output title', () => {
    it('uses a valid structured output title as the issue title', () => {
      // Given
      const task = '## Generic task heading\nImplement AI issue title generation';
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/7' });

      // When
      createIssueFromTask(task, {
        title: 'Generate concise issue titles with AI',
        labels: ['enhancement'],
      });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        {
          title: 'Generate concise issue titles with AI',
          body: task,
          labels: ['enhancement'],
        },
        undefined,
      );
      expect(mockLogInfo).toHaveBeenCalledWith('Issue created', expect.objectContaining({
        url: 'https://github.com/owner/repo/issues/7',
        issueNumber: 7,
        used_structured_output: true,
      }));
    });

    it('truncates a valid structured output title at the existing 100 character boundary', () => {
      // Given
      const longTitle = 'a'.repeat(101);
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/8' });

      // When
      createIssueFromTask('## Task body\nDetails', { title: longTitle });

      // Then
      const expectedTitle = `${'a'.repeat(97)}...`;
      expect(expectedTitle).toHaveLength(100);
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: expectedTitle, body: '## Task body\nDetails' },
        undefined,
      );
    });

    it('falls back to the task-derived title and logs missing when structured title is absent', () => {
      // Given
      const task = '## Implement fallback issue title\nDetails';
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/9' });

      // When
      createIssueFromTask(task);

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Implement fallback issue title', body: task },
        undefined,
      );
      expect(mockLogInfo).toHaveBeenCalledWith('Issue created', expect.objectContaining({
        used_structured_output: false,
        fallback_reason: 'missing',
      }));
    });

    it('falls back and logs prohibited_title when structured title is generic task order text', () => {
      // Given
      const task = '## Generate issue title from structured output\nDetails';
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/10' });

      // When
      createIssueFromTask(task, { title: '# タスク指示書' });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Generate issue title from structured output', body: task },
        undefined,
      );
      expect(mockLogInfo).toHaveBeenCalledWith('Issue created', expect.objectContaining({
        used_structured_output: false,
        fallback_reason: 'prohibited_title',
      }));
    });

    it('falls back when structured title is a Markdown Summary heading', () => {
      // Given
      const task = '## Generate issue title from structured output\nDetails';
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/13' });

      // When
      createIssueFromTask(task, { title: '## Summary' });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Generate issue title from structured output', body: task },
        undefined,
      );
      expect(mockLogInfo).toHaveBeenCalledWith('Issue created', expect.objectContaining({
        used_structured_output: false,
        fallback_reason: 'prohibited_title',
      }));
    });

    it('falls back when structured title is a Japanese Markdown summary heading', () => {
      // Given
      const task = '## AIでIssueタイトルを要約する\nDetails';
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/14' });

      // When
      createIssueFromTask(task, { title: '## 概要' });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'AIでIssueタイトルを要約する', body: task },
        undefined,
      );
      expect(mockLogInfo).toHaveBeenCalledWith('Issue created', expect.objectContaining({
        used_structured_output: false,
        fallback_reason: 'prohibited_title',
      }));
    });

    it('uses the generated summary line instead of template headings when structured title is invalid', () => {
      // Given
      const task = [
        '## Summary',
        'Generate issue title from structured summary',
        '',
        '## Goals',
        '- Keep the issue title concise',
        '',
        '## Acceptance Criteria',
        '- [ ] The title is not a template heading',
        '- [ ] The summary line is used',
      ].join('\n');
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/12' });

      // When
      createIssueFromTask(task, { title: '# Task Order' });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Generate issue title from structured summary', body: task },
        undefined,
      );
      expect(mockLogInfo).toHaveBeenCalledWith('Issue created', expect.objectContaining({
        used_structured_output: false,
        fallback_reason: 'prohibited_title',
      }));
    });

    it('falls back and logs too_short when structured title is shorter than the minimum', () => {
      // Given
      const task = '## Generate issue title from task body\nDetails';
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/11' });

      // When
      createIssueFromTask(task, { title: 'abc' });

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(
        { title: 'Generate issue title from task body', body: task },
        undefined,
      );
      expect(mockLogInfo).toHaveBeenCalledWith('Issue created', expect.objectContaining({
        used_structured_output: false,
        fallback_reason: 'too_short',
      }));
    });

    it('logs structured output decision metadata when issue creation fails', () => {
      // Given
      mockCreateIssue.mockReturnValue({ success: false, error: 'repo not found' });

      // When
      createIssueFromTask('## Task body\nDetails', { title: 'AI generated issue title' });

      // Then
      expect(mockLogError).toHaveBeenCalledWith('Failed to create issue', expect.objectContaining({
        error: 'repo not found',
        used_structured_output: true,
      }));
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

      // Then: falls back to first non-empty line and strips Markdown decoration
      expect(result).toBe('h4 heading');
    });

    it('should not treat heading without space after hash as Markdown heading', () => {
      // Given: #Title has no space, so not recognized as heading
      const task = '#NoSpace\nDetails here';

      // When
      const result = extractTitle(task);

      // Then: falls back to first non-empty line
      expect(result).toBe('#NoSpace');
    });

    it('skips a prohibited task order heading and uses the next valid heading', () => {
      // Given
      const task = '# タスク指示書\n\n## Generate concise AI issue titles\nDetails here';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Generate concise AI issue titles');
    });

    it('skips a too-short heading and uses the next valid non-empty line', () => {
      // Given
      const task = '## abc\nGenerate concise AI issue titles\nDetails here';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Generate concise AI issue titles');
    });

    it('skips structured task template section headings and uses the summary line', () => {
      // Given
      const task = '## Summary\nGenerate concise AI issue titles\n## Goals\n- Keep titles short';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Generate concise AI issue titles');
    });

    it('skips prohibited Japanese bullet candidates and uses the next valid bullet title', () => {
      // Given
      const task = [
        '## Summary',
        'タスク指示書',
        '',
        '## Goals',
        '- タスク指示書',
        '- Generate concise AI issue titles',
      ].join('\n');

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Generate concise AI issue titles');
    });

    it('skips prohibited English bullet candidates and uses the next valid bullet title', () => {
      // Given
      const task = [
        '## Summary',
        'Task Order',
        '',
        '## Goals',
        '- Task Order',
        '- Generate concise AI issue titles',
      ].join('\n');

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Generate concise AI issue titles');
    });

    it('strips checklist prefixes before validating task-derived candidates', () => {
      // Given
      const task = [
        '## Summary',
        'Task Order',
        '',
        '## Goals',
        '- [ ] Task Order',
        '- [x] Generate concise AI issue titles',
      ].join('\n');

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('Generate concise AI issue titles');
    });

    it('skips Japanese structured task template section headings and uses the summary line', () => {
      // Given
      const task = '## 概要\nAIでIssueタイトルを要約する\n## 目的\n- 短いタイトルにする';

      // When
      const result = extractTitle(task);

      // Then
      expect(result).toBe('AIでIssueタイトルを要約する');
    });

    it('rejects task content when every extracted title candidate is invalid', () => {
      // Given
      const task = '# タスク指示書\nabc';

      // When / Then
      expect(() => extractTitle(task)).toThrow('No valid issue title could be generated');
    });

    it('does not create an issue when fallback title extraction has no valid candidate', () => {
      // Given
      const task = '# タスク指示書\nabc';

      // When
      const result = createIssueFromTask(task);

      // Then
      expect(result).toBeUndefined();
      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(mockError).toHaveBeenCalledWith(
        'Failed to create issue: No valid issue title could be generated from task content',
      );
      expect(mockLogError).toHaveBeenCalledWith('Failed to create issue', expect.objectContaining({
        used_structured_output: false,
        fallback_reason: 'missing',
      }));
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
