import { describe, expect, it, vi } from 'vitest';
import { sdkMessageToStreamEvent } from '../infra/claude/stream-converter.js';
import type { StreamEvent } from '../infra/claude/types.js';

describe('sdkMessageToStreamEvent', () => {
  it('assistant.error を assistant_error イベントとして流す', () => {
    const callback = vi.fn<(event: StreamEvent) => void>();

    sdkMessageToStreamEvent(
      {
        type: 'assistant',
        message: { content: [] },
        error: 'rate_limit',
        uuid: 'uuid-1',
        session_id: 'session-1',
        parent_tool_use_id: null,
      },
      callback,
      true,
    );

    expect(callback).toHaveBeenCalledWith({
      type: 'assistant_error',
      data: {
        error: 'rate_limit',
        sessionId: 'session-1',
      },
    });
  });

  it('rate_limit_event を rate_limit イベントとして流す', () => {
    const callback = vi.fn<(event: StreamEvent) => void>();

    sdkMessageToStreamEvent(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          overageDisabledReason: 'out_of_credits',
          resetsAt: 1775059200,
          overageResetsAt: 1775059200,
          isUsingOverage: false,
        },
        uuid: 'uuid-2',
        session_id: 'session-2',
      },
      callback,
      true,
    );

    expect(callback).toHaveBeenCalledWith({
      type: 'rate_limit',
      data: {
        sessionId: 'session-2',
        status: 'rejected',
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'out_of_credits',
        resetsAt: 1775059200,
        overageResetsAt: 1775059200,
        isUsingOverage: false,
      },
    });
  });
});
