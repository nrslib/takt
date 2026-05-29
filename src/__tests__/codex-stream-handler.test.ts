import { describe, expect, it, vi } from 'vitest';
import {
  createStreamTrackingState,
  emitCodexItemCompleted,
  emitCodexItemStart,
  emitResult,
} from '../infra/codex/CodexStreamHandler.js';
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

describe('CodexStreamHandler active tool tracking', () => {
  it('user-facing stream callback がなくても command_execution の active tool state を更新する', () => {
    const state = createStreamTrackingState();

    emitCodexItemStart(
      { id: 'cmd-1', type: 'command_execution', command: 'npm run test:e2e:mock' },
      undefined,
      state,
    );

    expect(state.activeTool).toEqual({
      id: 'cmd-1',
      tool: 'Bash',
      input: { command: 'npm run test:e2e:mock' },
    });

    emitCodexItemCompleted(
      {
        id: 'cmd-1',
        type: 'command_execution',
        status: 'completed',
        exit_code: 0,
        aggregated_output: 'done',
      },
      undefined,
      state,
    );

    expect(state.activeTool).toBeUndefined();
  });

  it('id が無い command_execution completed でも active tool state を残さない', () => {
    const state = createStreamTrackingState();

    emitCodexItemStart(
      { type: 'command_execution', command: 'npm run test:e2e:mock' },
      undefined,
      state,
    );

    expect(state.activeTool).toEqual({
      id: expect.stringMatching(/^item_/),
      tool: 'Bash',
      input: { command: 'npm run test:e2e:mock' },
    });

    emitCodexItemCompleted(
      {
        type: 'command_execution',
        status: 'completed',
        exit_code: 0,
        aggregated_output: 'done',
      },
      undefined,
      state,
    );

    expect(state.activeTool).toBeUndefined();
  });

  it('id が無い command_execution 完了後の次の command を active tool state に記録する', () => {
    const state = createStreamTrackingState();

    emitCodexItemStart({ type: 'command_execution', command: 'npm test' }, undefined, state);
    const firstId = state.activeTool?.id;

    emitCodexItemCompleted(
      {
        type: 'command_execution',
        status: 'completed',
        exit_code: 0,
        aggregated_output: 'done',
      },
      undefined,
      state,
    );
    emitCodexItemStart({ type: 'command_execution', command: 'npm run lint' }, undefined, state);

    expect(state.activeTool).toEqual({
      id: expect.stringMatching(/^item_/),
      tool: 'Bash',
      input: { command: 'npm run lint' },
    });
    expect(state.activeTool?.id).not.toBe(firstId);
  });
});
