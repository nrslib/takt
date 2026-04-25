import { describe, expect, it, vi } from 'vitest';
import { emitResult } from '../infra/codex/CodexStreamHandler.js';
import type { StreamCallback } from '../core/workflow/types.js';

describe('CodexStreamHandler emitResult', () => {
  it('失敗分類を result イベントへ含める', () => {
    const onStream: StreamCallback = vi.fn();

    emitResult(onStream, false, 'Workflow interrupted by user (SIGINT)', 'session-1', 'external_abort');

    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: {
        result: 'Workflow interrupted by user (SIGINT)',
        sessionId: 'session-1',
        success: false,
        error: 'Workflow interrupted by user (SIGINT)',
        failureCategory: 'external_abort',
      },
    });
  });
});
