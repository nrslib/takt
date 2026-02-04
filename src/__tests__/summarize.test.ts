/**
 * Tests for summarizeTaskName
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
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
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';
import { summarizeTaskName } from '../infra/task/summarize.js';

const mockGetProvider = vi.mocked(getProvider);
const mockLoadGlobalConfig = vi.mocked(loadGlobalConfig);

const mockProviderCall = vi.fn();
const mockProvider = {
  call: mockProviderCall,
  callCustom: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProvider.mockReturnValue(mockProvider);
  mockLoadGlobalConfig.mockReturnValue({
    language: 'ja',
    defaultPiece: 'default',
    logLevel: 'info',
    provider: 'claude',
    model: 'haiku',
  });
});

describe('summarizeTaskName', () => {
  it('should return AI-generated slug for task name', async () => {
    // Given: AI returns a slug for input
    mockProviderCall.mockResolvedValue({
      agent: 'summarizer',
      status: 'done',
      content: 'add-auth',
      timestamp: new Date(),
    });

    // When
    const result = await summarizeTaskName('long task name for testing', { cwd: '/project' });

    // Then
    expect(result).toBe('add-auth');
    expect(mockGetProvider).toHaveBeenCalledWith('claude');
    expect(mockProviderCall).toHaveBeenCalledWith(
      'summarizer',
      'long task name for testing',
      expect.objectContaining({
        cwd: '/project',
        model: 'haiku',
        allowedTools: [],
      })
    );
  });

  it('should return AI-generated slug for English task name', async () => {
    // Given
    mockProviderCall.mockResolvedValue({
      agent: 'summarizer',
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
      agent: 'summarizer',
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
      agent: 'summarizer',
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
      agent: 'summarizer',
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
      agent: 'summarizer',
      status: 'done',
      content: 'custom-task',
      timestamp: new Date(),
    });

    // When
    await summarizeTaskName('test', { cwd: '/project', model: 'sonnet' });

    // Then
    expect(mockProviderCall).toHaveBeenCalledWith(
      'summarizer',
      expect.any(String),
      expect.objectContaining({
        model: 'sonnet',
      })
    );
  });

  it('should use provider from config.yaml', async () => {
    // Given: config has codex provider
    mockLoadGlobalConfig.mockReturnValue({
      language: 'ja',
      defaultPiece: 'default',
      logLevel: 'info',
      provider: 'codex',
      model: 'gpt-4',
    });
    mockProviderCall.mockResolvedValue({
      agent: 'summarizer',
      status: 'done',
      content: 'codex-task',
      timestamp: new Date(),
    });

    // When
    await summarizeTaskName('test', { cwd: '/project' });

    // Then
    expect(mockGetProvider).toHaveBeenCalledWith('codex');
    expect(mockProviderCall).toHaveBeenCalledWith(
      'summarizer',
      expect.any(String),
      expect.objectContaining({
        model: 'gpt-4',
      })
    );
  });

  it('should remove consecutive hyphens', async () => {
    // Given: AI response has consecutive hyphens
    mockProviderCall.mockResolvedValue({
      agent: 'summarizer',
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
      agent: 'summarizer',
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
    mockLoadGlobalConfig.mockImplementation(() => {
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

  it('should use LLM by default', async () => {
    // Given
    mockProviderCall.mockResolvedValue({
      agent: 'summarizer',
      status: 'done',
      content: 'add-auth',
      timestamp: new Date(),
    });

    // When: useLLM not specified (defaults to true)
    await summarizeTaskName('test', { cwd: '/project' });

    // Then: should call provider
    expect(mockProviderCall).toHaveBeenCalled();
  });
});
