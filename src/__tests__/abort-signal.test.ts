import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAbortSignal, buildInactivityAbortSignal } from '../core/workflow/engine/abort-signal.js';
import { recordWorkflowStepProviderEventActivity } from '../core/workflow/engine/step-deadline.js';
import { STALE_IN_FLIGHT_TOOL_FACTOR } from '../shared/types/provider-deadline.js';

describe('buildAbortSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('タイムアウトでabortされる', () => {
    const { signal, dispose } = buildAbortSignal(100, undefined);

    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).message).toBe('Part timeout after 100ms');

    dispose();
  });

  it('親シグナルがabortされると子シグナルへ伝搬する', () => {
    const parent = new AbortController();
    const { signal, dispose } = buildAbortSignal(1000, parent.signal);
    const reason = new Error('parent aborted');

    parent.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);

    dispose();
  });

  it('disposeでタイマーと親リスナーを解放する', () => {
    const parent = new AbortController();
    const addSpy = vi.spyOn(parent.signal, 'addEventListener');
    const removeSpy = vi.spyOn(parent.signal, 'removeEventListener');
    const { signal, dispose } = buildAbortSignal(100, parent.signal);

    expect(addSpy).toHaveBeenCalledTimes(1);

    dispose();
    vi.advanceTimersByTime(200);

    expect(signal.aborted).toBe(false);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('親シグナルが既にabort済みなら即時伝搬する', () => {
    const parent = new AbortController();
    const reason = new Error('already aborted');
    const addSpy = vi.spyOn(parent.signal, 'addEventListener');
    parent.abort(reason);

    const { signal, dispose } = buildAbortSignal(1000, parent.signal);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    expect(addSpy).not.toHaveBeenCalled();

    dispose();
  });
});

describe('buildInactivityAbortSignal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('活動のたびに無応答期限を更新する', () => {
    const deadline = buildInactivityAbortSignal(100, undefined);

    vi.advanceTimersByTime(90);
    deadline.recordActivity();
    vi.advanceTimersByTime(90);
    expect(deadline.signal.aborted).toBe(false);

    vi.advanceTimersByTime(10);
    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as Error).message).toBe('Part timeout after 100ms');
    deadline.dispose();
  });

  it('in-flight tool 中は通常期限を停止し、stale 上限で abort する', () => {
    const timeoutMs = 100;
    const deadline = buildInactivityAbortSignal(timeoutMs, undefined);

    deadline.recordActivity({
      kind: 'tool_started',
      executionUnitKey: 'step',
      toolCallKey: 'step\0tool-1',
    });
    vi.advanceTimersByTime(timeoutMs);
    expect(deadline.signal.aborted).toBe(false);

    vi.advanceTimersByTime(timeoutMs * (STALE_IN_FLIGHT_TOOL_FACTOR - 1) - 1);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as Error).message).toBe('Part timeout after 100ms');
    deadline.dispose();
  });

  it('tool 終端後は通常の無応答期限を再開する', () => {
    const deadline = buildInactivityAbortSignal(100, undefined);

    recordWorkflowStepProviderEventActivity(deadline.recordActivity, 'step', {
      type: 'tool_use',
      data: { tool: 'Bash', input: {}, id: 'tool-1' },
    });
    vi.advanceTimersByTime(150);
    recordWorkflowStepProviderEventActivity(deadline.recordActivity, 'step', {
      type: 'tool_result',
      data: { id: 'tool-1', content: 'done', isError: false },
    });
    vi.advanceTimersByTime(99);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });

  it('新しい attempt 開始時に欠落した tool 状態を破棄して通常期限を満額取り直す', () => {
    const deadline = buildInactivityAbortSignal(100, undefined);

    deadline.recordActivity({
      kind: 'tool_started',
      executionUnitKey: 'step',
      toolCallKey: 'step\0tool-1',
    });
    vi.advanceTimersByTime(90);
    deadline.recordActivity({ kind: 'attempt_started' });
    vi.advanceTimersByTime(99);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });

  it('別 execution unit の attempt 開始で in-flight tool を解除しない', () => {
    const timeoutMs = 100;
    const deadline = buildInactivityAbortSignal(timeoutMs, undefined);

    deadline.recordActivity({
      kind: 'tool_started',
      executionUnitKey: 'part-a',
      toolCallKey: 'part-a\0tool-1',
    });
    vi.advanceTimersByTime(90);
    deadline.recordActivity({ kind: 'attempt_started', executionUnitKey: 'part-b' });
    vi.advanceTimersByTime(timeoutMs);
    expect(deadline.signal.aborted).toBe(false);

    vi.advanceTimersByTime(timeoutMs * (STALE_IN_FLIGHT_TOOL_FACTOR - 1) - 90);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });
});
