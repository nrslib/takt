/**
 * Tests for session selector
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionIndexEntry } from '../infra/claude/session-reader.js';

const mockLoadSessionIndex = vi.fn<(dir: string) => SessionIndexEntry[]>();
const mockExtractLastAssistantResponse = vi.fn<(path: string, maxLen: number) => string | null>();

vi.mock('../infra/claude/session-reader.js', () => ({
  loadSessionIndex: (...args: [string]) => mockLoadSessionIndex(...args),
  extractLastAssistantResponse: (...args: [string, number]) => mockExtractLastAssistantResponse(...args),
}));

const mockSelectOption = vi.fn<(prompt: string, options: unknown[]) => Promise<string | null>>();

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: (...args: [string, unknown[]]) => mockSelectOption(...args),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: (key: string, _lang: string, params?: Record<string, string>) => {
    if (key === 'interactive.sessionSelector.newSession') return 'New session';
    if (key === 'interactive.sessionSelector.newSessionDescription') return 'Start a new conversation';
    if (key === 'interactive.sessionSelector.messages') return `${params?.count} messages`;
    if (key === 'interactive.sessionSelector.lastResponse') return `Last: ${params?.response}`;
    if (key === 'interactive.sessionSelector.prompt') return 'Select a session';
    return key;
  },
}));

import { selectRecentSession } from '../features/interactive/sessionSelector.js';

describe('selectRecentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null when no sessions exist', async () => {
    mockLoadSessionIndex.mockReturnValue([]);

    const result = await selectRecentSession('/project', 'en');

    expect(result).toBeNull();
    expect(mockSelectOption).not.toHaveBeenCalled();
  });

  it('should return null when user selects __new__', async () => {
    mockLoadSessionIndex.mockReturnValue([
      createSession('session-1', 'Hello world', '2026-01-28T10:00:00.000Z'),
    ]);
    mockExtractLastAssistantResponse.mockReturnValue(null);
    mockSelectOption.mockResolvedValue('__new__');

    const result = await selectRecentSession('/project', 'en');

    expect(result).toBeNull();
  });

  it('should return null when user cancels selection', async () => {
    mockLoadSessionIndex.mockReturnValue([
      createSession('session-1', 'Hello world', '2026-01-28T10:00:00.000Z'),
    ]);
    mockExtractLastAssistantResponse.mockReturnValue(null);
    mockSelectOption.mockResolvedValue(null);

    const result = await selectRecentSession('/project', 'en');

    expect(result).toBeNull();
  });

  it('should return sessionId when user selects a session', async () => {
    mockLoadSessionIndex.mockReturnValue([
      createSession('session-abc', 'Fix the bug', '2026-01-28T10:00:00.000Z'),
    ]);
    mockExtractLastAssistantResponse.mockReturnValue(null);
    mockSelectOption.mockResolvedValue('session-abc');

    const result = await selectRecentSession('/project', 'en');

    expect(result).toBe('session-abc');
  });

  it('should pass correct options to selectOption with new session first', async () => {
    mockLoadSessionIndex.mockReturnValue([
      createSession('s1', 'First prompt', '2026-01-28T10:00:00.000Z', 5),
    ]);
    mockExtractLastAssistantResponse.mockReturnValue('Some response');
    mockSelectOption.mockResolvedValue('s1');

    await selectRecentSession('/project', 'en');

    expect(mockSelectOption).toHaveBeenCalledWith(
      'Select a session',
      expect.arrayContaining([
        expect.objectContaining({ value: '__new__', label: 'New session' }),
        expect.objectContaining({ value: 's1' }),
      ]),
    );

    const options = mockSelectOption.mock.calls[0]![1] as Array<{ value: string }>;
    expect(options[0]!.value).toBe('__new__');
    expect(options[1]!.value).toBe('s1');
  });

  it('should limit display to MAX_DISPLAY_SESSIONS (10)', async () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      createSession(`s${i}`, `Prompt ${i}`, `2026-01-${String(i + 10).padStart(2, '0')}T10:00:00.000Z`),
    );
    mockLoadSessionIndex.mockReturnValue(sessions);
    mockExtractLastAssistantResponse.mockReturnValue(null);
    mockSelectOption.mockResolvedValue(null);

    await selectRecentSession('/project', 'en');

    const options = mockSelectOption.mock.calls[0]![1] as Array<{ value: string }>;
    // 1 new session + 10 display sessions = 11 total
    expect(options).toHaveLength(11);
  });

  it('should include last response details when available', async () => {
    mockLoadSessionIndex.mockReturnValue([
      createSession('s1', 'Hello', '2026-01-28T10:00:00.000Z', 3, '/path/to/s1.jsonl'),
    ]);
    mockExtractLastAssistantResponse.mockReturnValue('AI response text');
    mockSelectOption.mockResolvedValue('s1');

    await selectRecentSession('/project', 'en');

    expect(mockExtractLastAssistantResponse).toHaveBeenCalledWith('/path/to/s1.jsonl', 200);

    const options = mockSelectOption.mock.calls[0]![1] as Array<{ value: string; details?: string[] }>;
    const sessionOption = options[1]!;
    expect(sessionOption.details).toBeDefined();
    expect(sessionOption.details![0]).toContain('AI response text');
  });
});

function createSession(
  sessionId: string,
  firstPrompt: string,
  modified: string,
  messageCount = 5,
  fullPath = `/path/to/${sessionId}.jsonl`,
): SessionIndexEntry {
  return {
    sessionId,
    firstPrompt,
    modified,
    messageCount,
    gitBranch: 'main',
    isSidechain: false,
    fullPath,
  };
}
