/**
 * Tests for resolveAutoPrDraft priority chain: CLI > config > prompt
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadGlobalConfig: vi.fn(() => ({})),
}));

vi.mock('../infra/task/index.js', () => ({
  autoCommitAndPush: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/github/index.js', () => ({
  createPullRequest: vi.fn(),
  buildPrBody: vi.fn(),
  pushBranch: vi.fn(),
}));

import { confirm } from '../shared/prompt/index.js';
import { loadGlobalConfig } from '../infra/config/index.js';
import { resolveAutoPrDraft } from '../features/tasks/execute/postExecution.js';

const mockConfirm = vi.mocked(confirm);
const mockLoadGlobalConfig = vi.mocked(loadGlobalConfig);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveAutoPrDraft', () => {
  it('should return CLI option when provided as true', async () => {
    // Given: CLI option is true
    // When
    const result = await resolveAutoPrDraft(true);

    // Then: returns true without prompting
    expect(result).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should return CLI option when provided as false', async () => {
    // Given: CLI option is false
    // When
    const result = await resolveAutoPrDraft(false);

    // Then: returns false without prompting
    expect(result).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should return global config value when CLI option is undefined', async () => {
    // Given: no CLI option, global config has autoPrDraft=true
    mockLoadGlobalConfig.mockReturnValue({
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      concurrency: 1,
      taskPollIntervalMs: 500,
      autoPrDraft: true,
    });

    // When
    const result = await resolveAutoPrDraft(undefined);

    // Then: returns config value without prompting
    expect(result).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should return global config false when CLI option is undefined', async () => {
    // Given: no CLI option, global config has autoPrDraft=false
    mockLoadGlobalConfig.mockReturnValue({
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      concurrency: 1,
      taskPollIntervalMs: 500,
      autoPrDraft: false,
    });

    // When
    const result = await resolveAutoPrDraft(undefined);

    // Then: returns config value without prompting
    expect(result).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should prompt when neither CLI option nor config is set', async () => {
    // Given: no CLI option, no global config autoPrDraft
    mockLoadGlobalConfig.mockReturnValue({
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    mockConfirm.mockResolvedValue(true);

    // When
    const result = await resolveAutoPrDraft(undefined);

    // Then: prompts the user with 'Create as draft?' and default true
    expect(result).toBe(true);
    expect(mockConfirm).toHaveBeenCalledWith('Create as draft?', true);
  });

  it('should return user prompt response when user says no', async () => {
    // Given: no CLI option, no global config, user declines
    mockLoadGlobalConfig.mockReturnValue({
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    mockConfirm.mockResolvedValue(false);

    // When
    const result = await resolveAutoPrDraft(undefined);

    // Then: returns false from user prompt
    expect(result).toBe(false);
  });
});
