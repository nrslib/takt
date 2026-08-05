import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockEventStream,
  textPartUpdated,
  reasoningPartUpdated,
  sensitiveToolPartUpdated,
  expectStreamTextOnce,
  expectStreamThinkingOnce,
  sessionIdle,
  successfulSessionAbort,
  unavailableToolErrorEvent,
  promptTextOfCall,
  startTimerPump,
} from './helpers/opencode-client-test-helpers.js';

const { createOpencodeMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      unref: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
      listen: vi.fn((_port: number, _host: string, cb: () => void) => {
        cb();
      }),
      address: vi.fn(() => ({ port: 62000 })),
      close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
    };
  },
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

describe('OpenCodeClient tool loop recovery', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();
  });

  // タイマー駆動の待ち（retry backoff・idle watchdog・permission タイムアウト）を
  // fake timers で実時間ゼロに圧縮する。アサーションは実時間版と同一。
  let pump: { stop: () => Promise<void> };

  beforeEach(() => {
    pump = startTimerPump(20);
  });

  afterEach(async () => {
    await pump.stop();
  });

  it('should return provider error when the same unavailable OpenCode tool error repeats', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const unavailableToolError = "Model tried to call unavailable tool 'invalid'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-tool-loop' },
      },
    ], 'session-tool-loop');

    // 同一セッション correction、fresh session の双方で同じ fingerprint を
    // 再発させ、3回目を terminal にする。
    const correctionStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-3',
            type: 'tool',
            callID: 'call-run-3',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-4',
            type: 'tool',
            callID: 'call-run-4',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
    ], 'session-tool-loop');
    const freshStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-5',
            type: 'tool',
            callID: 'call-run-5',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-6',
            type: 'tool',
            callID: 'call-run-6',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
    ], 'session-tool-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-tool-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-tool-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });
    const abort = successfulSessionAbort();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('run');
    expect(result.content).toContain(unavailableToolError);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('write report');
    expect(promptTextOfCall(promptAsync, 2)).toContain('write report');
    expect(abort).toHaveBeenCalledTimes(3);
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(promptAsync.mock.invocationCallOrder[1]);
    expect(abort.mock.invocationCallOrder[1]).toBeLessThan(promptAsync.mock.invocationCallOrder[2]);
    expect(promptAsync.mock.calls.map(([payload]) => (payload as { sessionID: string }).sessionID)).toEqual([
      'session-tool-loop',
      'session-tool-loop',
      'session-tool-fresh',
    ]);
    expect(stream.returnSpy).toHaveBeenCalled();
    expect(correctionStream.returnSpy).toHaveBeenCalled();
    expect(freshStream.returnSpy).toHaveBeenCalled();
  });

  // v3-r4 実測形の回帰: opencode 1.17.18 に存在しない 'list' を呼び続け、
  // correction → fresh session 後も同名再発 → 確定失敗。修正前は recovery
  // 前置文の有効ツール一覧が TAKT の写像（'list' を含む）から生成され、
  // 「'list' は存在しない」と言った直後に 'list' を利用可能と再誘導していた。
  // 前置文はサーバ申告（エラー文の Available tools）を正とし、'invalid'
  // （内部擬似ツール）を除外し、'list' の具体的な代替（glob / bash ls）へ
  // 誘導することを固定する。

  it('should not re-advertise the phantom list tool in the recovery preamble (v3-r4 regression)', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const listUnavailableError = "Model tried to call unavailable tool 'list'. Available tools: bash, edit, glob, grep, invalid, read, skill, todowrite, webfetch, write.";
    const listErrorPart = (index: number) => ({
      type: 'message.part.updated',
      properties: {
        part: {
          id: `list-part-${index}`,
          type: 'tool',
          callID: `call-list-${index}`,
          tool: 'list',
          state: { status: 'error', input: { path: '.' }, error: listUnavailableError },
        },
      },
    });
    const stream = new MockEventStream([listErrorPart(1), listErrorPart(2)], 'session-list-loop');
    const correctionStream = new MockEventStream([listErrorPart(3), listErrorPart(4)], 'session-list-loop');
    const freshStream = new MockEventStream([listErrorPart(5), listErrorPart(6)], 'session-list-loop-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-list-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-list-loop-fresh' } });
    const abort = successfulSessionAbort();
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'fix the findings', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    // recovery 後の同名再発は本物の失敗として確定する（v3-r4 と同じ結末）。
    expect(result.status).toBe('error');
    expect(result.content).toContain("'list'");
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenCalledTimes(3);
    expect(promptAsync.mock.calls.map(([payload]) => (payload as { sessionID: string }).sessionID)).toEqual([
      'session-list-loop',
      'session-list-loop',
      'session-list-loop-fresh',
    ]);

    const correctionPrompt = promptTextOfCall(promptAsync, 1);
    expect(correctionPrompt).toContain('unavailable tool "list"');
    expect(correctionPrompt).toContain('"bash", "edit", "glob", "grep", "read"');
    expect(correctionPrompt).not.toContain('fix the findings');
    const freshPrompt = promptTextOfCall(promptAsync, 2);
    expect(freshPrompt).toContain('previous session repeatedly called an unavailable tool');
    expect(freshPrompt).toContain('fix the findings');
    expect(freshPrompt).toContain('Do NOT overwrite or discard');
  });

  // OpenCode は拒否したツール呼び出しを `invalid` 擬似ツールの status='completed'
  // として返す。実測（takt-bench v3-r1 の implement）: qwen が 195 回連続で踏み、
  // 3 つの検出器も cycle budget も一度も発火しなかった。実物の形で検証する。
  const invalidToolPart = (index: number, attempted: string, error: string) => ({
    type: 'message.part.updated',
    properties: {
      part: {
        id: `invalid-part-${index}`,
        type: 'tool',
        callID: `call-invalid-${index}`,
        tool: 'invalid',
        state: {
          status: 'completed',
          input: { tool: attempted, error },
          output: `The arguments provided to the tool are invalid: ${error}`,
          title: 'invalid',
        },
      },
    },
  });

  const runInvalidScenario = async (events: unknown[]) => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-invalid-loop' } })
      .mockResolvedValue({ data: { id: 'session-invalid-loop-fresh' } });
    let subscription = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subscription += 1;
      const sessionID = sessionCreate.mock.calls.length > 1
        ? 'session-invalid-loop-fresh'
        : 'session-invalid-loop';
      const attemptEvents = events.map((event) => {
        const value = event as { type: string; properties: { part: Record<string, unknown> } };
        return {
          ...value,
          properties: {
            ...value.properties,
            part: {
              ...value.properties.part,
              id: `${String(value.properties.part.id)}-${subscription}`,
              callID: `${String(value.properties.part.callID)}-${subscription}`,
            },
          },
        };
      });
      return Promise.resolve({
        stream: new MockEventStream([
          ...attemptEvents,
          sessionIdle(sessionID),
        ], sessionID),
      });
    });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: sessionCreate,
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    return client.call('coder', 'write report', { cwd: '/tmp', model: 'opencode/qwen3-coder-next' });
  };

  it('should treat a completed "invalid" tool part as a rejected tool call and stop the repeating loop', async () => {
    const error = "Model tried to call unavailable tool 'list'. Available tools: bash, edit, glob, grep, read.";
    const result = await runInvalidScenario([
      invalidToolPart(1, 'list', error),
      invalidToolPart(2, 'list', error),
      invalidToolPart(3, 'list', error),
      invalidToolPart(4, 'list', error),
    ]);

    expect(result.status).toBe('error');
    // 検出器には本来呼ぼうとしたツール名が渡る（"invalid" ではなく "list"）。
    expect(result.content).toContain('list');
  });

  it('should treat a completed "invalid" tool part reporting a missing argument as a rejected call', async () => {
    const error = "Required argument 'filePath' is missing or invalid.";
    const result = await runInvalidScenario([
      invalidToolPart(1, 'read', error),
      invalidToolPart(2, 'read', error),
      invalidToolPart(3, 'read', error),
      invalidToolPart(4, 'read', error),
    ]);

    expect(result.status).toBe('error');
    expect(result.content).toContain('read');
  });

  it('should not punish a single invalid tool call that the model corrects on its own', async () => {
    const error = "Model tried to call unavailable tool 'list'. Available tools: bash, edit, glob, grep, read.";
    const result = await runInvalidScenario([
      invalidToolPart(1, 'list', error),
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-ok',
            type: 'tool',
            callID: 'call-ok',
            sessionID: 'session-invalid-loop',
            tool: 'read',
            state: { status: 'completed', input: { filePath: '/tmp/a.ts' }, output: 'ok', title: 'read' },
          },
        },
      },
    ]);

    // 1 回の空振りは自己修正の余地として許す（実測: v3-r2 の qwen は直後に
    // bash / glob へ切り替えた）。
    expect(result.status).toBe('done');
  });

  it('should return provider error when the same invalid OpenCode tool error repeats', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const invalidToolError = "Model tried to call invalid tool 'run'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: invalidToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: invalidToolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-invalid-tool-loop' },
      },
    ], 'session-invalid-tool-loop');

    // correction と fresh session の双方で同じ fingerprint を再発させる。
    const correctionStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-3',
            type: 'tool',
            callID: 'call-run-3',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: invalidToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-4',
            type: 'tool',
            callID: 'call-run-4',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: invalidToolError },
          },
        },
      },
    ], 'session-invalid-tool-loop');
    const freshStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-run-5', 'run', 'glob, grep, read', invalidToolError),
      unavailableToolErrorEvent('tool-part-6', 'call-run-6', 'run', 'glob, grep, read', invalidToolError),
    ], 'session-invalid-tool-loop-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-invalid-tool-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-invalid-tool-loop-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('run');
    expect(result.content).toContain(invalidToolError);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('write report');
    expect(promptTextOfCall(promptAsync, 2)).toContain('write report');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should return provider error when unavailable OpenCode tool errors alternate tools', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const runToolError = "Model tried to call unavailable tool 'run'. Available tools: glob, grep, read.";
    const listToolError = "Model tried to call invalid tool 'list'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: runToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-list-1',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-alternating-tool-loop' },
      },
    ], 'session-alternating-tool-loop');

    // correction と fresh session でも交互ループを起こし、terminal を検証する。
    const correctionStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-3',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: runToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-4',
            type: 'tool',
            callID: 'call-list-2',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
    ], 'session-alternating-tool-loop');
    const freshStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-run-3', 'run', 'glob, grep, read', runToolError),
      unavailableToolErrorEvent('tool-part-6', 'call-list-3', 'list', 'glob, grep, read', listToolError),
    ], 'session-alternating-tool-loop-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-alternating-tool-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-alternating-tool-loop-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('list');
    expect(result.content).toContain(listToolError);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('write report');
    expect(promptTextOfCall(promptAsync, 2)).toContain('write report');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should detect unavailable tool loop even when running state precedes each error', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const toolError = "Model tried to call unavailable tool 'invalid'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'running', input: { command: 'echo report' }, title: 'run' },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: toolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'running', input: { command: 'echo report' }, title: 'run' },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: toolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-running-then-error-loop' },
      },
    ], 'session-running-then-error-loop');

    // recovery の再試行側でも同じループを起こし、従来の打ち切り契約を検証する
    const correctionStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-run-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-run-4', 'run'),
    ], 'session-running-then-error-loop');
    const freshStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-run-5', 'run'),
      unavailableToolErrorEvent('tool-part-6', 'call-run-6', 'run'),
    ], 'session-running-then-error-loop-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-running-then-error-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-running-then-error-loop-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('run');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should ignore duplicate unavailable tool updates for the same OpenCode call', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const runToolError = "Model tried to call unavailable tool 'run'. Available tools: glob, grep, read.";
    const listToolError = "Model tried to call invalid tool 'list'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-run',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: runToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-run',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: runToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-list',
            type: 'tool',
            callID: 'call-list-1',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-duplicate-tool-update' },
      },
    ], 'session-duplicate-tool-update');

    // recovery の再試行側でも list のループを起こし、従来の打ち切り契約を検証する
    const correctionStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-list-2',
            type: 'tool',
            callID: 'call-list-2',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-list-3',
            type: 'tool',
            callID: 'call-list-3',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
    ], 'session-duplicate-tool-update');
    const freshStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-list-4', 'call-list-4', 'list', 'glob, grep, read', listToolError),
      unavailableToolErrorEvent('tool-part-list-5', 'call-list-5', 'list', 'glob, grep, read', listToolError),
    ], 'session-duplicate-tool-update-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-duplicate-tool-update' } })
      .mockResolvedValueOnce({ data: { id: 'session-duplicate-tool-update-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('list');
    expect(result.content).toContain(listToolError);
    expect(result.content).not.toContain(runToolError);
    // 発火は重複 run ではなく2件目の list（重複 update は1回として数える）。
    // recovery の前置文が引用するツール名で確かめる。
    expect(promptTextOfCall(promptAsync, 1)).toContain('"list"');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should continue when an unavailable OpenCode tool error occurs only once', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const unavailableToolError = "Model tried to call unavailable tool 'invalid'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'text-part-1', sessionID: 'session-single-tool-error', type: 'text', text: 'report ready' },
          delta: 'report ready',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-single-tool-error' },
      },
    ], 'session-single-tool-error');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-single-tool-error' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('report ready');
    expect(result.content).not.toContain(unavailableToolError);
  });

  it('should correct an unavailable-tool loop in-session, then recover a repeated fingerprint in one fresh session', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      sensitiveToolPartUpdated('session-a', 'correction-secret-tool', 'correction-private-token'),
      textPartUpdated('session-a', 'correction-tail', 'correction retry tail'),
      reasoningPartUpdated('session-a', 'correction-reasoning', 'correction reasoning tail'),
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-a');
    const correctionStream = new MockEventStream([
      sensitiveToolPartUpdated('session-a', 'fresh-secret-tool', 'fresh-private-token'),
      textPartUpdated('session-a', 'fresh-tail', 'fresh retry tail'),
      reasoningPartUpdated('session-a', 'fresh-reasoning', 'fresh reasoning tail'),
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'run'),
    ], 'session-a');
    const recoveredStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-1', sessionID: 'session-b', type: 'text', text: 'done via bash' }, delta: 'done via bash' },
      },
      { type: 'session.idle', properties: { sessionID: 'session-b' } },
    ], 'session-b');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-a' } })
      .mockResolvedValueOnce({ data: { id: 'session-b' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const abort = successfulSessionAbort();
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const onStream = vi.fn();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    expect(result.status).toBe('done');
    // 元セッションを捨て、新しい fresh session の ID を上位に返す
    expect(result.sessionId).toBe('session-b');
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(abort).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls.map(([payload]) => (payload as { sessionID: string }).sessionID)).toEqual([
      'session-a',
      'session-a',
      'session-b',
    ]);
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('unavailable tool "run"');
    expect(correctionText).toContain('"bash", "edit", "glob", "grep"');
    expect(correctionText).not.toContain('implement it');
    const retryText = promptTextOfCall(promptAsync, 2);
    expect(retryText).toContain('previous session repeatedly called an unavailable tool');
    expect(retryText).toContain('Do NOT overwrite or discard');
    expect(retryText).toContain('implement it');
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(promptAsync.mock.invocationCallOrder[1]);
    expect(abort.mock.invocationCallOrder[1]).toBeLessThan(promptAsync.mock.invocationCallOrder[2]);
    expectStreamTextOnce(onStream, 'correction retry tail');
    expectStreamTextOnce(onStream, 'fresh retry tail');
    expectStreamThinkingOnce(onStream, 'correction reasoning tail');
    expectStreamThinkingOnce(onStream, 'fresh reasoning tail');
    expect(JSON.stringify(onStream.mock.calls)).not.toContain('correction-private-token');
    expect(JSON.stringify(onStream.mock.calls)).not.toContain('fresh-private-token');
  });

  it('should keep a resumed session for correction and discard it only after the fingerprint repeats', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-old');
    const correctionStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'run'),
    ], 'session-old');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-fresh-run' } },
    ], 'session-fresh-run');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-fresh-run' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('session-fresh-run');
    // initial と correction は resume、同じ fingerprint の再発後だけ fresh を作る
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({ sessionID: 'session-old' });
    expect(promptAsync.mock.calls[1]?.[0]).toMatchObject({ sessionID: 'session-old' });
    expect(promptAsync.mock.calls[2]?.[0]).toMatchObject({ sessionID: 'session-fresh-run' });
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('implement it');
    expect(promptTextOfCall(promptAsync, 2)).toContain('implement it');
  });

  it('should fail after correction and the single fresh recovery both repeat the same fingerprint', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const firstLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-a');
    const correctionLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'run'),
    ], 'session-a');
    const freshLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-5', 'run'),
      unavailableToolErrorEvent('tool-part-6', 'call-6', 'run'),
    ], 'session-fresh');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: firstLoop })
      .mockResolvedValueOnce({ stream: correctionLoop })
      .mockResolvedValueOnce({ stream: freshLoop });
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-a' } })
      .mockResolvedValueOnce({ data: { id: 'session-fresh' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    // correction と fresh を使い切った後の再発は terminal（計3 attempt）
    expect(result.status).toBe('error');
    expect(result.content).toContain('run');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls.map(([payload]) => (payload as { sessionID: string }).sessionID)).toEqual([
      'session-a',
      'session-a',
      'session-fresh',
    ]);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('implement it');
    expect(promptTextOfCall(promptAsync, 2)).toContain('implement it');
  });

  it('should make a different fingerprint terminal after the fresh recovery has been used', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const firstLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-a');
    const correctionLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'run'),
    ], 'session-a');
    const invalidArgumentError = 'The read tool was called with invalid arguments: SchemaError(Expected string)';
    const freshLoop = new MockEventStream(Array.from({ length: 4 }, (_, index) => ({
      type: 'message.part.updated',
      properties: {
        part: {
          id: `invalid-part-${index}`,
          type: 'tool',
          callID: `invalid-call-${index}`,
          tool: 'read',
          state: { status: 'error', input: {}, error: invalidArgumentError },
        },
      },
    })), 'session-fresh');
    const unexpectedCorrection = new MockEventStream([
      textPartUpdated('session-fresh', 'unexpected', 'incorrectly recovered'),
      sessionIdle('session-fresh'),
    ], 'session-fresh');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: firstLoop })
      .mockResolvedValueOnce({ stream: correctionLoop })
      .mockResolvedValueOnce({ stream: freshLoop })
      .mockResolvedValueOnce({ stream: unexpectedCorrection });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-a' } })
      .mockResolvedValueOnce({ data: { id: 'session-fresh' } });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('invalid tool argument loop');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
  });

  it('should quote todo_write and advertise the observed tool set in its correction', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'todo_write'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'todo_write'),
    ], 'session-todo');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-todo' } },
    ], 'session-todo');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-todo' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'track the plan', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('unavailable tool "todo_write"');
    expect(correctionText).toContain('"todowrite"');
    expect(correctionText).not.toContain('track the plan');
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('should not invent a semantic mapping for an unknown hallucinated tool name', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'execute_shell'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'execute_shell'),
    ], 'session-unknown');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-unknown' } },
    ], 'session-unknown');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-unknown' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'run the build', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('"execute_shell"');
    expect(correctionText).not.toContain('Use "bash"');
    expect(correctionText).toContain('"bash", "edit", "glob", "grep"');
    expect(correctionText).not.toContain('run the build');
  });

  it('should advertise only observed tools when bash is not enabled', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      // bash の無いレビュー系ステップでは、サーバ申告一覧にも bash が現れない。
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run', 'glob, grep, invalid, read, skill'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run', 'glob, grep, invalid, read, skill'),
    ], 'session-no-bash');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-no-bash' } },
    ], 'session-no-bash');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-no-bash' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review the diff', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      // bash の無いレビュー系ステップの allowed_tools を再現する
      allowedTools: ['read', 'glob', 'grep'],
    });

    expect(result.status).toBe('done');
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('"run"');
    expect(correctionText).not.toContain('Use "bash"');
    expect(correctionText).toContain('"glob", "grep", "read", "skill"');
    expect(correctionText).not.toContain('"list"');
    expect(correctionText).not.toContain('"bash"');
  });

  it('should not advertise todowrite when it is absent from the observed tool set', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'todo_write', 'glob, grep, invalid, read, skill'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'todo_write', 'glob, grep, invalid, read, skill'),
    ], 'session-no-todo');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-no-todo' } },
    ], 'session-no-todo');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-no-todo' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review the diff', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      allowedTools: ['read', 'glob', 'grep'],
    });

    expect(result.status).toBe('done');
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('"todo_write"');
    expect(correctionText).not.toContain('Use "todowrite"');
    expect(correctionText).toContain('"glob", "grep", "read", "skill"');
    expect(correctionText).not.toContain('"todowrite"');
  });

  it('should apply correction, fresh recovery, then terminal failure to an invalid-argument loop', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const events = [1, 2, 3, 4].map((n) => ({
      type: 'message.part.updated',
      properties: {
        part: {
          id: `tool-part-${n}`,
          type: 'tool',
          callID: `call-${n}`,
          tool: 'read',
          state: {
            status: 'error',
            input: {},
            error: `Required argument 'filePath' is missing or invalid (variant ${'x'.repeat(n)})`,
          },
        },
      },
    }));
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-invalid-arg' } })
      .mockResolvedValueOnce({ data: { id: 'session-invalid-arg-fresh' } });
    let subscription = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subscription += 1;
      const sessionID = sessionCreate.mock.calls.length > 1
        ? 'session-invalid-arg-fresh'
        : 'session-invalid-arg';
      const attemptEvents = events.map((event) => ({
        ...event,
        properties: {
          ...event.properties,
          part: {
            ...event.properties.part,
            id: `${event.properties.part.id}-${subscription}`,
            callID: `${event.properties.part.callID}-${subscription}`,
          },
        },
      }));
      return Promise.resolve({ stream: new MockEventStream(attemptEvents, sessionID) });
    });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'read files', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('invalid tool argument loop');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('read files');
    expect(promptTextOfCall(promptAsync, 2)).toContain('read files');
  });

  it('連続閾値未満の一般エラー2件では正常完了する', async () => {
      const { OpenCodeClient } = await import('../infra/opencode/client.js');
      const events = [
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'tool-part-1',
              type: 'tool',
              callID: 'call-1',
              tool: 'read',
              state: { status: 'error', input: {}, error: 'file not found: /a' },
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'tool-part-2',
              type: 'tool',
              callID: 'call-2',
              tool: 'grep',
              state: { status: 'error', input: {}, error: 'pattern failed to compile' },
            },
          },
        },
        { type: 'session.idle', properties: { sessionID: 'session-budget-x' } },
      ];
      const promptAsync = vi.fn().mockResolvedValue(undefined);
      createOpencodeMock.mockResolvedValue({
        client: {
          instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
          session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-budget-x' } }), promptAsync, abort: successfulSessionAbort() },
          event: { subscribe: vi.fn().mockResolvedValue({ stream: new MockEventStream(events, 'session-budget-x') }) },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });

      const client = new OpenCodeClient();
      const result = await client.call('coder', 'explore', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      });

      expect(result.status).toBe('done');
      expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  it('should keep the unavailable-tool recovery slot even after the transient budget is consumed', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const emptyStream = () => new MockEventStream([], 'session-late');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-late');
    const successStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-late' } },
    ], 'session-late');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: emptyStream() })
      .mockResolvedValueOnce({ stream: emptyStream() })
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: successStream });
    const promptAsync = vi.fn()
      .mockRejectedValueOnce(new Error('transport error'))
      .mockRejectedValueOnce(new Error('transport error'))
      .mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-late' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    // transient 2回で基礎予算(3)の最終試行にループが来ても、別枠の1回で救済できる
    expect(result.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(4);
    expect(promptTextOfCall(promptAsync, 3)).toContain('"run"');
  });

  it('should safely quote a hostile hallucinated tool name in the retry preamble', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const hostileTool = 'bad"tool\nname';
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', hostileTool),
      unavailableToolErrorEvent('tool-part-2', 'call-2', hostileTool),
    ], 'session-hostile');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-hostile' } },
    ], 'session-hostile');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-hostile' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    const retryText = promptTextOfCall(promptAsync, 1);
    // JSON.stringify での引用: 引用符・改行がエスケープされ、生の改行が
    // 前置文の構造を壊さない
    expect(retryText).toContain(JSON.stringify(hostileTool));
    expect(retryText).not.toContain('a tool named bad"tool');
  });

  /** 予算系4テスト共通: イベント列を流して call の結果だけ返す */
  async function runBudgetScenario(sessionId: string, events: unknown[]): Promise<import('../core/models/index.js').AgentResponse> {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      ...events,
      { type: 'session.idle', properties: { sessionID: sessionId } },
    ], sessionId);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: sessionId } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    return new OpenCodeClient().call('coder', 'do it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      interactionTimeoutMs: 500,
    });
  }

  it('should complete normally when message cycles stay under the budget', async () => {
    process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET = '5';
    try {
      const result = await runBudgetScenario('session-under', Array.from({ length: 4 }, (_, i) => ({
        type: 'message.updated',
        properties: { info: { id: `message-${i}`, sessionID: 'session-under', role: 'assistant', time: { completed: 1000 + i } } },
      })).concat([{
        type: 'message.part.updated',
        properties: { part: { id: 'p-t', type: 'text', text: 'done', sessionID: 'session-under' } },
      }] as unknown[]));

      // 予算未満（4 < 5）なら通常どおり完了する
      expect(result.status).toBe('done');
    } finally {
      delete process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET;
    }
  });

  it('should complete normally when rotating tool errors stay under the consecutive threshold', async () => {
      const result = await runBudgetScenario('session-under2', ['read', 'write', 'glob', 'grep', 'list'].map((tool, i) => ({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `u${i}`, type: 'tool', tool, callID: `u${i}`, sessionID: 'session-under2',
            state: { status: 'error', error: `The ${tool} tool was called with invalid arguments: SchemaError(x)` },
          },
        },
      })).concat([{
        type: 'message.part.updated',
        properties: { part: { id: 'p-t2', type: 'text', text: 'done', sessionID: 'session-under2' } },
      }] as unknown[]));

      // 既定の consecutive=10 未満で、strict loop も同一ツール連続にならない。
      expect(result.status).toBe('done');
  });

  it('should stop a degenerate text-fragment loop via the message cycle budget', async () => {
    process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET = '5';
    try {
      const result = await runBudgetScenario('session-spin', Array.from({ length: 6 }, (_, i) => ({
        type: 'message.updated',
        properties: { info: { id: `message-${i}`, sessionID: 'session-spin', role: 'assistant', time: { completed: 1000 + i } } },
      })));

      expect(result.status).toBe('error');
      expect(result.error).toContain('message cycle budget exceeded');
    } finally {
      delete process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET;
    }
  });

  it('should not stop long healthy work that keeps completing tool calls', async () => {
    process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET = '5';
    try {
      // 成功するツール呼び出しを挟みながら予算の倍のサイクルを回す。
      // 総サイクル数で打ち切る実装ではここで落ちる（実測: 9万行の implement）。
      const events = Array.from({ length: 10 }, (_, i) => ([
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool', id: `tool-${i}`, callID: `call-${i}`, tool: 'read',
              sessionID: 'session-healthy', messageID: `msg-${i}`,
              state: { status: 'completed', input: {}, output: 'ok', title: 'read' },
            },
          },
        },
        {
          type: 'message.updated',
          properties: { info: { id: `message-${i}`, sessionID: 'session-healthy', role: 'assistant', time: { completed: 1000 + i } } },
        },
      ])).flat();

      const result = await runBudgetScenario('session-healthy', events);

      expect(result.status).toBe('done');
    } finally {
      delete process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET;
    }
  });

  it('ツール名が回転する6件のエラーは連続閾値に達せず正常完了する', async () => {
      const result = await runBudgetScenario('session-degenerate', ['read', 'write', 'glob', 'grep', 'list', 'edit'].map((tool, i) => ({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `c${i}`, type: 'tool', tool, callID: `c${i}`, sessionID: 'session-degenerate',
            state: { status: 'error', error: `The ${tool} tool was called with invalid arguments: SchemaError(x)` },
          },
        },
      })));

      expect(result.status).toBe('done');
  });

  it('should not trip the invalid-argument loop across interleaved unavailable errors', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const INVALID = 'The read tool was called with invalid arguments: SchemaError(Expected string)';
    const UNAVAILABLE = 'unavailable tool: fetch';
    const toolError = (id: string, tool: string, error: string) => ({
      type: 'message.part.updated',
      properties: { part: { id, type: 'tool', tool, callID: id, state: { status: 'error', error } } },
    });
    // invalid ×3 → unavailable ×1 → invalid ×1: 修正前は invalid 側が
    // unavailable を観測できず「連続4回」と誤認して打ち切っていた並び
    const stream = new MockEventStream([
      toolError('c1', 'read', INVALID),
      toolError('c2', 'read', INVALID),
      toolError('c3', 'read', INVALID),
      toolError('c4', 'fetch', UNAVAILABLE),
      toolError('c5', 'read', INVALID),
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-text', sessionID: 'session-mixed', type: 'text', text: 'done' }, delta: 'done' },
      },
      { type: 'session.idle', properties: { sessionID: 'session-mixed' } },
    ], 'session-mixed');
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-mixed' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('coder', 'do it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    // 偽の連続判定で error にならず完走する（unavailable も1回では閾値未満）
    expect(result.status).toBe('done');
  });
});
