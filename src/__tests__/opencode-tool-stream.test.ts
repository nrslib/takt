import { describe, expect, it, vi } from 'vitest';
import {
  createStreamTrackingState,
  flushSensitiveTextStreams,
  handlePartUpdated,
  type OpenCodeToolPart,
  type OpenCodeToolState,
} from '../infra/opencode/OpenCodeStreamHandler.js';
import type { StreamCallback } from '../shared/types/provider.js';

function toolPart(state: OpenCodeToolState, callID = 'call-1', tool = 'read'): OpenCodeToolPart {
  return { id: `part-${callID}`, sessionID: 'session-1', type: 'tool', callID, tool, state };
}

describe('OpenCode ツール入力の確定と通知', () => {
  it.each([{}, { filePath: '/partial' }])('pending の入力 %j は通知せず、確定した引数を結果より先に一度通知する', (pendingInput) => {
    const state = createStreamTrackingState();
    const onStream = vi.fn<StreamCallback>();
    const input = { filePath: '/context/specifications/gherkin.feature' };
    for (let index = 0; index < 2; index++) {
      handlePartUpdated(toolPart({ status: 'pending', input: pendingInput }), undefined, onStream, state);
    }
    expect(onStream).not.toHaveBeenCalled();

    for (let index = 0; index < 3; index++) {
      handlePartUpdated(toolPart({ status: 'running', input }), undefined, onStream, state);
    }
    expect(onStream).toHaveBeenCalledExactlyOnceWith({ type: 'tool_use', data: { tool: 'read', input, id: 'call-1' } });
    handlePartUpdated(toolPart({ status: 'completed', input, output: '仕様本文', title: '仕様' }), undefined, onStream, state);
    expect(onStream.mock.calls.map(([event]) => event)).toEqual([
      { type: 'tool_use', data: { tool: 'read', input, id: 'call-1' } },
      { type: 'tool_result', data: { id: 'call-1', content: '仕様本文', isError: false } },
    ]);
  });

  it.each(['completed', 'error'] as const)('running を観測しなくても %s の入力を結果より先に通知する', (status) => {
    const state = createStreamTrackingState();
    const onStream = vi.fn<StreamCallback>();
    const input = { command: 'cat /context/specifications/gherkin.feature' };
    handlePartUpdated(toolPart({ status: 'pending', input: {} }, 'call-terminal', 'bash'), undefined, onStream, state);
    handlePartUpdated(toolPart(status === 'completed'
      ? { status, input, output: '仕様本文', title: '仕様' }
      : { status, input, error: '読み取り失敗' }, 'call-terminal', 'bash'), undefined, onStream, state);
    expect(onStream.mock.calls.map(([event]) => event)).toEqual([
      { type: 'tool_use', data: { tool: 'bash', input, id: 'call-terminal' } },
      { type: 'tool_result', data: { id: 'call-terminal', content: status === 'completed' ? '仕様本文' : '読み取り失敗', isError: status === 'error' } },
    ]);
  });

  it.each(['completed', 'error'] as const)('最初の観測が %s でも同じ ID の開始と結果を順序通り通知する', (status) => {
    const state = createStreamTrackingState();
    const onStream = vi.fn<StreamCallback>();
    const input = { filePath: '/spec.feature' };
    handlePartUpdated(toolPart(status === 'completed'
      ? { status, input, output: '仕様本文', title: '仕様' }
      : { status, input, error: '読み取り失敗' }), undefined, onStream, state);
    expect(onStream.mock.calls.map(([event]) => event)).toEqual([
      { type: 'tool_use', data: { tool: 'read', input, id: 'call-1' } },
      { type: 'tool_result', data: { id: 'call-1', content: status === 'completed' ? '仕様本文' : '読み取り失敗', isError: status === 'error' } },
    ]);
  });

  it('正当に引数がないツールも running で通知し、繰り返し更新で開始を重複させない', () => {
    const state = createStreamTrackingState();
    const onStream = vi.fn<StreamCallback>();
    handlePartUpdated(toolPart({ status: 'pending', input: {} }, 'no-args', 'clock'), undefined, onStream, state);
    expect(onStream).not.toHaveBeenCalled();
    for (let index = 0; index < 3; index++) {
      handlePartUpdated(toolPart({ status: 'running', input: {} }, 'no-args', 'clock'), undefined, onStream, state);
    }
    expect(onStream).toHaveBeenCalledExactlyOnceWith({ type: 'tool_use', data: { tool: 'clock', input: {}, id: 'no-args' } });
  });

  it.each([
    { tool: 'write', body: { content: '保存する本文' } },
    { tool: 'edit', body: { oldString: '変更前の本文', newString: '変更後の本文' } },
    { tool: 'apply_patch', body: { patchText: '*** Begin Patch\n本文\n*** End Patch' } },
  ])('$tool の遅れて確定した本文を要約し、機密値と直前の保留テキストをマスクする', ({ tool, body }) => {
    const state = createStreamTrackingState();
    const onStream = vi.fn<StreamCallback>();
    const secret = 'synthetic-private-value';
    const input = { filePath: '/file', token: secret, ...body };
    handlePartUpdated({ id: 'text', sessionID: 'session-1', type: 'text', text: `直前 ${secret}` }, undefined, onStream, state);
    handlePartUpdated(toolPart({ status: 'pending', input: {} }, 'masked', tool), undefined, onStream, state);
    expect(onStream).not.toHaveBeenCalled();
    handlePartUpdated(toolPart({ status: 'error', input, error: `${Object.values(body).join('\n')}\n${secret}` }, 'masked', tool), undefined, onStream, state);
    const events = onStream.mock.calls.map(([event]) => event);
    expect(events.map((event) => event.type)).toEqual(['text', 'tool_use', 'tool_result']);
    expect(events[0]).toEqual({ type: 'text', data: { text: '直前 [REDACTED]' } });
    const use = events.find((event) => event.type === 'tool_use');
    expect(use?.data.input).toMatchObject({ filePath: '/file', token: '[REDACTED]' });
    for (const [key, value] of Object.entries(body)) {
      expect(use?.data.input[key]).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{12}$/), length: value.length });
      for (const event of events) expect(JSON.stringify(event)).not.toContain(value);
    }
    for (const event of events) expect(JSON.stringify(event)).not.toContain(secret);
    expect(input.token).toBe(secret);
    for (const [key, value] of Object.entries(body)) expect(input[key as keyof typeof input]).toBe(value);
  });

  it('通知先がなくても pending の入力から機密値を収集する', () => {
    const state = createStreamTrackingState();
    handlePartUpdated(toolPart({ status: 'pending', input: { token: 'synthetic-pending-value' } }), undefined, undefined, state);
    const onStream = vi.fn<StreamCallback>();
    handlePartUpdated({ id: 'text', sessionID: 'session-1', type: 'text', text: 'synthetic-pending-value' }, undefined, onStream, state);
    flushSensitiveTextStreams(onStream, state);
    expect(onStream).toHaveBeenCalledExactlyOnceWith({ type: 'text', data: { text: '[REDACTED]' } });
  });

  it('pending も既存の ID 上限に含め、超過後の通知を停止する', () => {
    const state = createStreamTrackingState({ idLimit: 1, textByteLimit: 1024, reasoningByteLimit: 1024 });
    const onStream = vi.fn<StreamCallback>();
    expect(handlePartUpdated(toolPart({ status: 'pending', input: {} }, 'first'), undefined, onStream, state)).toBe(true);
    expect(handlePartUpdated(toolPart({ status: 'pending', input: {} }, 'second'), undefined, onStream, state)).toBe(false);
    expect(handlePartUpdated(toolPart({ status: 'running', input: { filePath: '/spec.feature' } }, 'first'), undefined, onStream, state)).toBe(false);
    expect(onStream).not.toHaveBeenCalled();
    expect(state.trackingLimitReason).toBe('tracked_id_count');
    expect(state.trackedIds.size).toBe(0);
    expect(state.startedTools.size).toBe(0);
  });
});
