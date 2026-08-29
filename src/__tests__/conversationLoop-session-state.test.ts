import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../infra/config/project/sessionState.js';

const {
  mockTakeSessionState,
  mockHasInteractiveTerminal,
  mockFormatSessionStatus,
  mockInfo,
  mockBlankLine,
} = vi.hoisted(() => ({
  mockTakeSessionState: vi.fn(),
  mockHasInteractiveTerminal: vi.fn(),
  mockFormatSessionStatus: vi.fn(),
  mockInfo: vi.fn(),
  mockBlankLine: vi.fn(),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  takeSessionState: (...args: unknown[]) => mockTakeSessionState(...args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  hasInteractiveTerminal: () => mockHasInteractiveTerminal(),
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/ui/index.js')>()),
  info: (...args: unknown[]) => mockInfo(...args),
  blankLine: (...args: unknown[]) => mockBlankLine(...args),
}));

vi.mock('../features/interactive/interactive.js', () => ({
  buildSummaryPrompt: vi.fn(),
  selectPostSummaryAction: vi.fn(),
  formatSessionStatus: (...args: unknown[]) => mockFormatSessionStatus(...args),
}));

import { displayAndClearSessionState } from '../features/interactive/conversationLoop.js';

function createSessionState(status: 'success' | 'error'): SessionState {
  return {
    status,
    workflowName: 'review-workflow',
    timestamp: '2026-08-26T00:00:00.000Z',
    ...(status === 'error' ? { errorMessage: 'provider unavailable' } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHasInteractiveTerminal.mockReturnValue(false);
  mockFormatSessionStatus.mockImplementation(
    (state: SessionState) => `formatted:${state.status}`,
  );
});

describe('displayAndClearSessionState', () => {
  it('should leave saved state for the Ink conversation runner', () => {
    mockHasInteractiveTerminal.mockReturnValue(true);

    displayAndClearSessionState('/repo', 'en');

    expect(mockTakeSessionState).not.toHaveBeenCalled();
    expect(mockFormatSessionStatus).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
    expect(mockBlankLine).not.toHaveBeenCalled();
  });

  it.each(['success', 'error'] as const)(
    'should display and consume a saved %s result when starting readline',
    (status) => {
      const sessionState = createSessionState(status);
      mockTakeSessionState.mockReturnValue(sessionState);

      displayAndClearSessionState('/repo', 'en');

      expect(mockTakeSessionState).toHaveBeenCalledExactlyOnceWith('/repo');
      expect(mockFormatSessionStatus).toHaveBeenCalledExactlyOnceWith(sessionState, 'en');
      expect(mockInfo).toHaveBeenCalledExactlyOnceWith(`formatted:${status}`);
      expect(mockBlankLine).toHaveBeenCalledOnce();
    },
  );
});
