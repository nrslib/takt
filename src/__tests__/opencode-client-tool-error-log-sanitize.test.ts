import { beforeEach, describe, expect, it, vi } from 'vitest';

// OpenCode のツール呼び出し失敗を debug ログへ残す機能（84622c96）は
// state.input / state.error を無加工で渡していたため、bash の command や
// edit の内容に含まれる API キー等の機密情報がそのままログに残り得た。
// このテストは、失敗したツール呼び出しの引数がログへ渡る前にマスクされる
// ことを、OpenCodeClient を実際に駆動して確認する。

type MockStreamEvent = Record<string, unknown>;

function createEvents(events: MockStreamEvent[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

const { createOpencodeMock, debugLogSpy } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
  debugLogSpy: vi.fn(),
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
      address: vi.fn(() => ({ port: 62100 })),
      close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
    };
  },
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

// createLogger 以外の実エクスポートはそのまま使う。debug だけをスパイに
// 差し替え、client.ts のモジュール読み込み時に一度だけ生成される
// `log`（createLogger('opencode-sdk')）が常にこのスパイを参照するようにする。
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    trace: vi.fn(),
    debug: debugLogSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  }),
}));

const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');

function installOpenCodeMock(events: MockStreamEvent[]) {
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const subscribe = vi.fn().mockResolvedValue({ stream: createEvents(events) });

  createOpencodeMock.mockResolvedValue({
    client: {
      instance: { dispose: vi.fn() },
      session: { create: sessionCreate, promptAsync },
      event: { subscribe },
      permission: { reply: vi.fn() },
    },
    server: { close: vi.fn() },
  });

  return { sessionCreate, promptAsync, subscribe };
}

describe('OpenCodeClient tool call failure logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetSharedServer();
  });

  it('bash command に API キーらしき文字列を含む失敗ツール呼び出しがあっても、debug ログにその文字列がそのまま出ない', async () => {
    const secret = 'sk-liveTestSecretDoNotLeak1234567890';
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'Bash',
            state: {
              status: 'error',
              input: {
                command: `curl -H "Authorization: Bearer ${secret}" https://example.com/api`,
              },
              error: `Command failed: authentication rejected token ${secret}`,
            },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ];

    installOpenCodeMock(events);
    const client = new OpenCodeClient();

    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    const failureCall = debugLogSpy.mock.calls.find(([message]) => message === 'OpenCode tool call failed');
    expect(failureCall).toBeDefined();

    // ログ呼び出し全体（メッセージ + 付随データ）のどこにも生の秘密文字列が
    // 残っていないことを確認する。マスクが input/error の一部だけに効いて
    // 他の経路で漏れるケースも拾えるよう、呼び出し引数全体を対象にする。
    const serializedCall = JSON.stringify(failureCall);
    expect(serializedCall).not.toContain(secret);

    // マスクされてもキー名（command）とツール名は残り、後から
    // 「何のツールの何の引数が壊れたか」を特定できる。
    const [, data] = failureCall as [string, { tool: string; input: { command: string }; error: string }];
    expect(data.tool).toBe('Bash');
    expect(data.input).toHaveProperty('command');
    expect(data.input.command).toContain('[REDACTED]');
    expect(data.error).toContain('[REDACTED]');
  });

  it('password や Authorization / Cookie など機密キーの値は形式によらずマスクされ、offset や誤字キーの値はそのまま残る', async () => {
    // sanitizeSensitiveText() はテキスト全体から「キー名: 値」という並びを
    // 正規表現で見つけてマスクする実装のため、値を単独の文字列として渡すと
    // キーの文脈が失われ、"hunter2" や "Bearer opaque-value" のような非定型の
    // 値はマスクされなかった（修正前の実測挙動）。オブジェクトを再帰的に
    // 走査する際にキー名の文脈を引き継ぎ、機密キーなら値の形式・型を問わず
    // 丸ごとマスクする。
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-2',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-2',
            tool: 'Edit',
            state: {
              status: 'error',
              input: {
                password: 'hunter2',
                Authorization: 'Bearer opaque-value',
                headers: { Cookie: 'session=abc' },
                // qwen が read に offset: "290.0" という文字列を、edit に
                // filepaath という誤字キーを渡していた（実測）。この2つは
                // 機密キーではないため、後から引数の壊れ方を特定できるよう
                // マスクせずそのまま残す必要がある。
                offset: '290.0',
                filepaath: '/x',
              },
              error: 'Tool call failed',
            },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ];

    installOpenCodeMock(events);
    const client = new OpenCodeClient();

    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    const failureCall = debugLogSpy.mock.calls.find(([message]) => message === 'OpenCode tool call failed');
    expect(failureCall).toBeDefined();
    const [, data] = failureCall as [string, { input: Record<string, unknown> }];

    expect(data.input.password).toBe('[REDACTED]');
    expect(data.input.Authorization).toBe('[REDACTED]');
    expect((data.input.headers as Record<string, unknown>).Cookie).toBe('[REDACTED]');

    expect(data.input.offset).toBe('290.0');
    expect(data.input.filepaath).toBe('/x');
  });
});
