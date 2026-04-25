import { describe, expect, it } from 'vitest';
import {
  AGENT_FAILURE_CATEGORIES,
  classifyAbortSignalReason,
  createPartTimeoutReason,
  createProviderErrorFailure,
  createStreamIdleTimeoutFailure,
  formatAgentFailure,
} from '../shared/types/agent-failure.js';

describe('agent-failure', () => {
  it('失敗分類の生成と表示整形を共通契約として扱う', () => {
    const partTimeout = classifyAbortSignalReason(new Error(createPartTimeoutReason(2500)));

    expect(partTimeout).toEqual({
      category: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
      reason: 'Part timeout after 2500ms',
    });
    expect(formatAgentFailure(partTimeout)).toBe('part timeout: Part timeout after 2500ms');
    expect(
      formatAgentFailure(createProviderErrorFailure('Gateway unavailable'), { includeCategoryPrefix: true }),
    ).toBe('provider error: Gateway unavailable');
    expect(
      formatAgentFailure(
        createStreamIdleTimeoutFailure('Codex stream timed out after 10 minutes of inactivity'),
        { includeCategoryPrefix: true },
      ),
    ).toBe('stream idle timeout: Codex stream timed out after 10 minutes of inactivity');
  });
});
