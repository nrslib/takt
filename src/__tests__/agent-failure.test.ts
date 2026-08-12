import { describe, expect, it } from 'vitest';
import {
  AGENT_FAILURE_CATEGORIES,
  classifyAbortSignalReason,
  createPartTimeoutReason,
  createProviderErrorFailure,
  createProviderStreamParseError,
  createProviderStreamParseFailure,
  createStreamIdleTimeoutFailure,
  formatAgentFailure,
  isProviderStreamParseError,
} from '../shared/types/agent-failure.js';

describe('agent-failure', () => {
  it('registers the stdout parse failure category', () => {
    expect(AGENT_FAILURE_CATEGORIES).toMatchObject({
      PROVIDER_STREAM_PARSE_ERROR: 'provider_stream_parse_error',
    });
  });

  it('creates and formats a stdout parse failure detail', () => {
    const failure = createProviderStreamParseFailure(new Error('Failed to parse item: invalid stdout line'));

    expect(failure).toEqual({
      category: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
      reason: 'Failed to parse item: invalid stdout line',
    });
    expect(formatAgentFailure(failure)).toBe(
      'provider stream parse error: Failed to parse item: invalid stdout line',
    );
  });

  it('keeps the typed parse failure reason raw when the response was already formatted', () => {
    const error = createProviderStreamParseError(
      'provider stream parse error: Failed to parse item: invalid stdout line',
    );

    expect(isProviderStreamParseError(error)).toBe(true);
    expect(error.reason).toBe('Failed to parse item: invalid stdout line');
    expect(error.message).toBe('provider stream parse error: Failed to parse item: invalid stdout line');
  });

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
