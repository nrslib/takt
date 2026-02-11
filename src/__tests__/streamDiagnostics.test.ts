import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { debugMock, createLoggerMock } = vi.hoisted(() => ({
  debugMock: vi.fn(),
  createLoggerMock: vi.fn(),
}));

createLoggerMock.mockImplementation(() => ({
  debug: debugMock,
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../shared/utils/debug.js', () => ({
  createLogger: createLoggerMock,
}));

import { createStreamDiagnostics } from '../shared/utils/streamDiagnostics.js';

describe('createStreamDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should log connected event with elapsedMs', () => {
    // Given: 診断オブジェクト
    const diagnostics = createStreamDiagnostics('component', { runId: 'r1' });

    // When: 接続完了を通知する
    diagnostics.onConnected();

    // Then: elapsedMs を含むデバッグログが出力される
    expect(debugMock).toHaveBeenCalledWith('Stream connected', {
      runId: 'r1',
      elapsedMs: 0,
    });
  });

  it('should log first event only once even when called twice', () => {
    // Given: 診断オブジェクト
    const diagnostics = createStreamDiagnostics('component', { runId: 'r2' });

    // When: first event を2回通知する
    diagnostics.onFirstEvent('event-a');
    diagnostics.onFirstEvent('event-b');

    // Then: first event ログは1回だけ出る
    expect(debugMock).toHaveBeenCalledTimes(1);
    expect(debugMock).toHaveBeenCalledWith('Stream first event', {
      runId: 'r2',
      firstEventType: 'event-a',
      elapsedMs: 0,
    });
  });

  it('should include eventCount and durationMs on completion', () => {
    // Given: 複数イベントを処理した診断オブジェクト
    const diagnostics = createStreamDiagnostics('component', { runId: 'r3' });
    diagnostics.onConnected();
    diagnostics.onEvent('turn.started');
    vi.advanceTimersByTime(120);
    diagnostics.onEvent('turn.completed');
    vi.advanceTimersByTime(80);

    // When: 完了通知を行う
    diagnostics.onCompleted('normal', 'done');

    // Then: 集計情報を含む完了ログが出力される
    expect(debugMock).toHaveBeenLastCalledWith('Stream completed', {
      runId: 'r3',
      reason: 'normal',
      detail: 'done',
      eventCount: 2,
      lastEventType: 'turn.completed',
      durationMs: 200,
      connected: true,
      iterationStarted: false,
    });
  });

  it('should increment eventCount and use it in stream error log', () => {
    // Given: 1イベント処理済みの診断オブジェクト
    const diagnostics = createStreamDiagnostics('component', { runId: 'r4' });
    diagnostics.onEvent('turn.started');

    // When: ストリームエラーを通知する
    diagnostics.onStreamError('turn.failed', 'failed');

    // Then: eventCount がエラーログに反映される
    expect(debugMock).toHaveBeenLastCalledWith('Stream error event', {
      runId: 'r4',
      eventType: 'turn.failed',
      message: 'failed',
      eventCount: 1,
    });
  });
});
