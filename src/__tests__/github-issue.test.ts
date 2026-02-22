/**
 * Tests for github/issue module
 *
 * Tests parsing and formatting functions.
 * checkGhCli/fetchIssue/resolveIssueTask are integration functions
 * that call `gh` CLI, so they are not unit-tested here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseIssueNumbers,
  isIssueReference,
  formatIssueAsTask,
  generateIssueTitle,
  type GitHubIssue,
} from '../infra/github/issue.js';

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { resolveConfigValues } from '../infra/config/index.js';
import { getProvider } from '../infra/providers/index.js';
import { loadTemplate } from '../shared/prompts/index.js';

const mockResolveConfigValues = vi.mocked(resolveConfigValues);
const mockGetProvider = vi.mocked(getProvider);
const mockLoadTemplate = vi.mocked(loadTemplate);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseIssueNumbers', () => {
  it('should parse single issue reference', () => {
    expect(parseIssueNumbers(['#6'])).toEqual([6]);
  });

  it('should parse multiple issue references', () => {
    expect(parseIssueNumbers(['#6', '#7'])).toEqual([6, 7]);
  });

  it('should parse large issue numbers', () => {
    expect(parseIssueNumbers(['#123'])).toEqual([123]);
  });

  it('should return empty for non-issue args', () => {
    expect(parseIssueNumbers(['Fix bug'])).toEqual([]);
  });

  it('should return empty when mixed issue and non-issue args', () => {
    expect(parseIssueNumbers(['#6', 'and', '#7'])).toEqual([]);
  });

  it('should return empty for empty args', () => {
    expect(parseIssueNumbers([])).toEqual([]);
  });

  it('should not match partial issue patterns', () => {
    expect(parseIssueNumbers(['#abc'])).toEqual([]);
    expect(parseIssueNumbers(['#'])).toEqual([]);
    expect(parseIssueNumbers(['##6'])).toEqual([]);
    expect(parseIssueNumbers(['6'])).toEqual([]);
    expect(parseIssueNumbers(['issue#6'])).toEqual([]);
  });

  it('should handle #0', () => {
    expect(parseIssueNumbers(['#0'])).toEqual([0]);
  });
});

describe('isIssueReference', () => {
  it('should return true for #N patterns', () => {
    expect(isIssueReference('#6')).toBe(true);
    expect(isIssueReference('#123')).toBe(true);
  });

  it('should return true with whitespace trim', () => {
    expect(isIssueReference(' #6 ')).toBe(true);
  });

  it('should return false for non-issue text', () => {
    expect(isIssueReference('Fix bug')).toBe(false);
    expect(isIssueReference('#abc')).toBe(false);
    expect(isIssueReference('')).toBe(false);
    expect(isIssueReference('#')).toBe(false);
    expect(isIssueReference('6')).toBe(false);
  });

  it('should return false for issue number followed by text (issue #32)', () => {
    expect(isIssueReference('#32あああ')).toBe(false);
    expect(isIssueReference('#10abc')).toBe(false);
    expect(isIssueReference('#123text')).toBe(false);
  });

  it('should return false for multiple issues (single string)', () => {
    expect(isIssueReference('#6 #7')).toBe(false);
  });
});

describe('formatIssueAsTask', () => {
  it('should format issue with all fields', () => {
    const issue: GitHubIssue = {
      number: 6,
      title: 'Fix authentication bug',
      body: 'The login flow is broken.',
      labels: ['bug', 'priority:high'],
      comments: [
        { author: 'user1', body: 'I can reproduce this.' },
        { author: 'user2', body: 'Fixed in PR #7.' },
      ],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toContain('## GitHub Issue #6: Fix authentication bug');
    expect(result).toContain('The login flow is broken.');
    expect(result).toContain('### Labels');
    expect(result).toContain('bug, priority:high');
    expect(result).toContain('### Comments');
    expect(result).toContain('**user1**: I can reproduce this.');
    expect(result).toContain('**user2**: Fixed in PR #7.');
  });

  it('should format issue with no body', () => {
    const issue: GitHubIssue = {
      number: 10,
      title: 'Empty issue',
      body: '',
      labels: [],
      comments: [],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toBe('## GitHub Issue #10: Empty issue');
    expect(result).not.toContain('### Labels');
    expect(result).not.toContain('### Comments');
  });

  it('should format issue with labels but no comments', () => {
    const issue: GitHubIssue = {
      number: 5,
      title: 'Feature request',
      body: 'Add dark mode.',
      labels: ['enhancement'],
      comments: [],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toContain('### Labels');
    expect(result).toContain('enhancement');
    expect(result).not.toContain('### Comments');
  });

  it('should format issue with comments but no labels', () => {
    const issue: GitHubIssue = {
      number: 3,
      title: 'Discussion',
      body: 'Thoughts?',
      labels: [],
      comments: [
        { author: 'dev', body: 'LGTM' },
      ],
    };

    const result = formatIssueAsTask(issue);

    expect(result).not.toContain('### Labels');
    expect(result).toContain('### Comments');
    expect(result).toContain('**dev**: LGTM');
  });

  it('should handle multiline body', () => {
    const issue: GitHubIssue = {
      number: 1,
      title: 'Multi-line',
      body: 'Line 1\nLine 2\n\nLine 4',
      labels: [],
      comments: [],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toContain('Line 1\nLine 2\n\nLine 4');
  });
});

describe('generateIssueTitle', () => {
  const mockAgent = {
    call: vi.fn(),
  };

  const mockProviderSetup = vi.fn().mockReturnValue(mockAgent);

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfigValues.mockReturnValue({
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      language: 'en',
    });
    mockGetProvider.mockReturnValue({ setup: mockProviderSetup } as unknown as ReturnType<typeof getProvider>);
    mockLoadTemplate.mockReturnValue('mock prompt');
  });

  it('should return trimmed title from AI response', async () => {
    mockAgent.call.mockResolvedValue({ content: '  Fixed authentication bug  ' });

    const result = await generateIssueTitle('Fix login issue', '/tmp');

    expect(result).toBe('Fixed authentication bug');
  });

  it('should throw error when AI returns empty response', async () => {
    mockAgent.call.mockResolvedValue({ content: '' });

    await expect(generateIssueTitle('Fix login issue', '/tmp')).rejects.toThrow(
      'AI returned an empty response for issue title. Please provide a title manually.'
    );
  });

  it('should throw error when AI returns whitespace-only response', async () => {
    mockAgent.call.mockResolvedValue({ content: '   \n\t  ' });

    await expect(generateIssueTitle('Fix login issue', '/tmp')).rejects.toThrow(
      'AI returned an empty response for issue title. Please provide a title manually.'
    );
  });

  it('should truncate title to 97 chars + ellipsis when over 100 characters', async () => {
    const longTitle = 'a'.repeat(120);
    mockAgent.call.mockResolvedValue({ content: longTitle });

    const result = await generateIssueTitle('Task description', '/tmp');

    expect(result).toBe(`${'a'.repeat(97)}...`);
    expect(result).toHaveLength(100);
  });

  it('should use title as-is when exactly 100 characters', async () => {
    const title100 = 'a'.repeat(100);
    mockAgent.call.mockResolvedValue({ content: title100 });

    const result = await generateIssueTitle('Task description', '/tmp');

    expect(result).toBe(title100);
    expect(result).toHaveLength(100);
  });

  it('should use title as-is when under 100 characters', async () => {
    const shortTitle = 'Fix authentication bug';
    mockAgent.call.mockResolvedValue({ content: shortTitle });

    const result = await generateIssueTitle('Fix login issue', '/tmp');

    expect(result).toBe(shortTitle);
  });

  it('should throw error when AI call fails', async () => {
    mockAgent.call.mockRejectedValue(new Error('API rate limit exceeded'));

    await expect(generateIssueTitle('Fix login issue', '/tmp')).rejects.toThrow('API rate limit exceeded');
  });

  it('should pass correct parameters to provider', async () => {
    mockAgent.call.mockResolvedValue({ content: 'Test title' });

    await generateIssueTitle('My task description', '/project/cwd');

    expect(mockProviderSetup).toHaveBeenCalledWith({
      name: 'issue-title-generator',
      systemPrompt: 'mock prompt',
    });
    expect(mockAgent.call).toHaveBeenCalledWith('mock prompt', {
      cwd: '/project/cwd',
      model: 'claude-3-5-sonnet-20241022',
      permissionMode: 'readonly',
    });
  });
});
