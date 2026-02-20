/**
 * Tests for summarizeTaskName
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { getProvider } from '../infra/providers/index.js';
import { resolveConfigValues } from '../infra/config/index.js';
import { summarizeTaskName } from '../infra/task/summarize.js';

const mockGetProvider = vi.mocked(getProvider);
const mockResolveConfigValues = vi.mocked(resolveConfigValues);

const mockProviderCall = vi.fn();
const mockProvider = {
  setup: () => ({ call: mockProviderCall }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProvider.mockReturnValue(mockProvider);
  mockResolveConfigValues.mockReturnValue({
    provider: 'claude',
    model: undefined,
    branchNameStrategy: 'ai',
  });
});

describe('summarizeTaskName', () => {
  it('should return AI-generated slug for task name', async () => {
    // Given: AI returns a slug for input
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: 'add-auth',
      timestamp: new Date(),
    });

    // When
    const result = await summarizeTaskName('long task name for testing', { cwd: '/project' });

    // Then
    expect(result).toBe('add-auth');
    expect(mockGetProvider).toHaveBeenCalledWith('claude');
    const callPrompt = mockProviderCall.mock.calls[0]?.[0];
    expect(callPrompt).toContain('Generate a slug from the task description below.');
    expect(callPrompt).toContain('<task_description>');
    expect(callPrompt).toContain('long task name for testing');
    expect(callPrompt).toContain('</task_description>');
    expect(mockProviderCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: '/project',
        permissionMode: 'readonly',
      })
    );
  });

  it('should return AI-generated slug for English task name', async () => {
    // Given
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: 'fix-login-bug',
      timestamp: new Date(),
    });

    // When
    const result = await summarizeTaskName('long task name for testing', { cwd: '/project' });

    // Then
    expect(result).toBe('fix-login-bug');
  });

  it('should clean up AI response with extra characters', async () => {
    // Given: AI response has extra whitespace or formatting
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: '  Add-User-Auth!  \n',
      timestamp: new Date(),
    });

    // When
    const result = await summarizeTaskName('long task name for testing', { cwd: '/project' });

    // Then
    expect(result).toBe('add-user-auth');
  });

  it('should truncate long slugs to 30 characters without trailing hyphen', async () => {
    // Given: AI returns a long slug
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: 'this-is-a-very-long-slug-that-exceeds-thirty-characters',
      timestamp: new Date(),
    });

    // When
    const result = await summarizeTaskName('long task name for testing', { cwd: '/project' });

    // Then
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toBe('this-is-a-very-long-slug-that');
    expect(result).not.toMatch(/-$/); // No trailing hyphen
  });

  it('should return "task" as fallback for empty AI response', async () => {
    // Given: AI returns empty string
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: '',
      timestamp: new Date(),
    });

    // When
    const result = await summarizeTaskName('long task name for testing', { cwd: '/project' });

    // Then
    expect(result).toBe('task');
  });

  it('should use custom model if specified in options', async () => {
    // Given
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: 'custom-task',
      timestamp: new Date(),
    });

    // When
    await summarizeTaskName('test', { cwd: '/project', model: 'sonnet' });

    // Then
    expect(mockProviderCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: 'sonnet',
      })
    );
  });

  it('should use provider from config.yaml', async () => {
    // Given: config has codex provider with branchNameStrategy: 'ai'
    mockResolveConfigValues.mockReturnValue({
      provider: 'codex',
      model: 'gpt-4',
      branchNameStrategy: 'ai',
    });
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: 'codex-task',
      timestamp: new Date(),
    });

    // When
    await summarizeTaskName('test', { cwd: '/project' });

    // Then
    expect(mockGetProvider).toHaveBeenCalledWith('codex');
    expect(mockProviderCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: 'gpt-4',
      })
    );
  });

  it('should remove consecutive hyphens', async () => {
    // Given: AI response has consecutive hyphens
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: 'fix---multiple---hyphens',
      timestamp: new Date(),
    });

    // When
    const result = await summarizeTaskName('long task name for testing', { cwd: '/project' });

    // Then
    expect(result).toBe('fix-multiple-hyphens');
  });

  it('should remove leading and trailing hyphens', async () => {
    // Given: AI response has leading/trailing hyphens
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: '-leading-trailing-',
      timestamp: new Date(),
    });

    // When
    const result = await summarizeTaskName('long task name for testing', { cwd: '/project' });

    // Then
    expect(result).toBe('leading-trailing');
  });

  it('should throw error when config load fails', async () => {
    // Given: config loading throws error
    mockResolveConfigValues.mockImplementation(() => {
      throw new Error('Config not found');
    });

    // When/Then
    await expect(summarizeTaskName('test', { cwd: '/project' })).rejects.toThrow('Config not found');
  });

  it('should use romanization when useLLM is false', async () => {
    // When: useLLM is explicitly false
    const result = await summarizeTaskName('romanization test', { cwd: '/project', useLLM: false });

    // Then: should not call provider, should return romaji
    expect(mockProviderCall).not.toHaveBeenCalled();
    expect(result).toMatch(/^[a-z0-9-]+$/);
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it('should handle mixed Japanese/English with romanization', async () => {
    // When
    const result = await summarizeTaskName('Add romanization', { cwd: '/project', useLLM: false });

    // Then
    expect(result).toMatch(/^[a-z0-9-]+$/);
    expect(result).not.toMatch(/^-|-$/); // No leading/trailing hyphens
  });

  it('should use romaji by default', async () => {
    // Given: branchNameStrategy is not set (undefined)
    mockResolveConfigValues.mockReturnValue({
      provider: 'claude',
      model: undefined,
      branchNameStrategy: undefined,
    });

    // When: useLLM not specified, branchNameStrategy not set
    const result = await summarizeTaskName('test task', { cwd: '/project' });

    // Then: should NOT call provider, should return romaji
    expect(mockProviderCall).not.toHaveBeenCalled();
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });

  it('should use AI when branchNameStrategy is ai', async () => {
    // Given: branchNameStrategy is 'ai'
    mockResolveConfigValues.mockReturnValue({
      provider: 'claude',
      model: undefined,
      branchNameStrategy: 'ai',
    });
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: 'ai-generated-slug',
      timestamp: new Date(),
    });

    // When: useLLM not specified, branchNameStrategy is 'ai'
    const result = await summarizeTaskName('test task', { cwd: '/project' });

    // Then: should call provider
    expect(mockProviderCall).toHaveBeenCalled();
    expect(result).toBe('ai-generated-slug');
  });

  it('should use romaji when branchNameStrategy is romaji', async () => {
    // Given: branchNameStrategy is 'romaji'
    mockResolveConfigValues.mockReturnValue({
      provider: 'claude',
      model: undefined,
      branchNameStrategy: 'romaji',
    });

    // When
    const result = await summarizeTaskName('test task', { cwd: '/project' });

    // Then: should NOT call provider
    expect(mockProviderCall).not.toHaveBeenCalled();
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });

  it('should respect explicit useLLM option over config', async () => {
    // Given: branchNameStrategy is 'romaji' but useLLM is explicitly true
    mockResolveConfigValues.mockReturnValue({
      provider: 'claude',
      model: undefined,
      branchNameStrategy: 'romaji',
    });
    mockProviderCall.mockResolvedValue({
      persona: 'summarizer',
      status: 'done',
      content: 'explicit-ai-slug',
      timestamp: new Date(),
    });

    // When: useLLM is explicitly true
    const result = await summarizeTaskName('test task', { cwd: '/project', useLLM: true });

    // Then: should call provider (explicit option overrides config)
    expect(mockProviderCall).toHaveBeenCalled();
    expect(result).toBe('explicit-ai-slug');
  });

  it('should respect explicit useLLM false over config with ai strategy', async () => {
    // Given: branchNameStrategy is 'ai' but useLLM is explicitly false
    mockResolveConfigValues.mockReturnValue({
      provider: 'claude',
      model: undefined,
      branchNameStrategy: 'ai',
    });

    // When: useLLM is explicitly false
    const result = await summarizeTaskName('test task', { cwd: '/project', useLLM: false });

    // Then: should NOT call provider (explicit option overrides config)
    expect(mockProviderCall).not.toHaveBeenCalled();
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});
