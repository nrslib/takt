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

  it('edit の oldString / newString はソース本文を残さず {sha256, length} にマスクされ、filePath は従来どおり残る（codex ブロッカー3）', async () => {
    const sourceBody = 'const secretLookingSourceLine = computeThing(privateValue);';
    const replacementBody = 'const replacedSourceLine = computeThing(publicValue);';
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-edit',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-edit',
            tool: 'edit',
            state: {
              status: 'error',
              input: {
                filePath: 'src/features/pipeline/execute.ts',
                oldString: sourceBody,
                newString: replacementBody,
              },
              error: 'oldString not found in content',
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

    // ログ呼び出し全体のどこにも oldString / newString の本文が残らない。
    const serializedCall = JSON.stringify(failureCall);
    expect(serializedCall).not.toContain(sourceBody);
    expect(serializedCall).not.toContain(replacementBody);

    // 本文は {sha256 先頭12桁, length} に置き換わり、filePath 等の他の引数は
    // 残る（ツール失敗デバッグ機能の本体は維持）。
    const [, data] = failureCall as [string, {
      tool: string;
      input: { filePath: string; oldString: { sha256: string; length: number }; newString: { sha256: string; length: number } };
    }];
    expect(data.input.filePath).toBe('src/features/pipeline/execute.ts');
    expect(data.input.oldString.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(data.input.oldString.length).toBe(sourceBody.length);
    expect(data.input.newString.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(data.input.newString.length).toBe(replacementBody.length);
  });

  it('エラー文そのものに oldString 本文が引用されていても debug ログに本文が残らない（codex 2巡目ブロッカー）', async () => {
    const sourceBody = 'const leakedThroughErrorText = computeThing(privateValue); // opencode quotes this in the error';
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-edit-err',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-edit-err',
            tool: 'edit',
            state: {
              status: 'error',
              input: {
                filePath: 'src/features/pipeline/steps.ts',
                oldString: sourceBody,
                newString: 'replacement text',
              },
              // OpenCode の edit エラー文は oldString の内容を引用することがある。
              error: `Could not find the following text in src/features/pipeline/steps.ts:\n${sourceBody}`,
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

    // ログ呼び出し全体のどこにも本文が残らない（input 側は {sha256,length}、
    // error 側はプレースホルダ置換）。
    const serializedCall = JSON.stringify(failureCall);
    expect(serializedCall).not.toContain(sourceBody);

    const [, data] = failureCall as [string, { error: string; input: { filePath: string } }];
    expect(data.error).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
    // エラー文の骨格（どのファイルで何が起きたか）は読める形で残る。
    expect(data.error).toContain('Could not find the following text');
    expect(data.input.filePath).toBe('src/features/pipeline/steps.ts');
  });

  it('onStream の全イベント（tool_use / tool_result）に oldString/newString 本文が一切現れない — provider event logging で永続化される経路（codex 3〜4巡目ブロッカー）', async () => {
    const sourceBody = 'const leakedViaOnStream = computeThing(privateValue); // opencode quotes this in the error';
    const replacementBody = 'const replacedViaOnStream = computeThing(publicValue);';
    // 最初のイベントがいきなり status: 'error' のケース: 未開始ツールの
    // tool_use 発火（state.input）が、マスク済み tool_result より先に走る。
    const events: MockStreamEvent[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-edit-stream',
            sessionID: 'session-1',
            type: 'tool',
            callID: 'call-edit-stream',
            tool: 'edit',
            state: {
              status: 'error',
              input: {
                filePath: 'src/core/workflow/engine/StepExecutor.ts',
                oldString: sourceBody,
                newString: replacementBody,
              },
              error: `Could not find the following text in src/core/workflow/engine/StepExecutor.ts:\n${sourceBody}`,
            },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-1' } },
    ];

    installOpenCodeMock(events);
    const client = new OpenCodeClient();

    const streamEvents: unknown[] = [];
    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream: (event) => {
        streamEvents.push(event);
      },
    });

    // onStream はライブ表示専用ではない: provider event logging 有効時は
    // イベント全文が *-provider-events.jsonl へ永続化される
    // （providerEventLogger.ts）。tool_use / tool_result を含む全イベントの
    // どこにも本文が残ってはならない。
    const serializedEvents = JSON.stringify(streamEvents);
    expect(serializedEvents).not.toContain(sourceBody);
    expect(serializedEvents).not.toContain(replacementBody);

    // tool_use: 本文フィールドだけ {sha256, length} に置換され、filePath は残る。
    const toolUses = streamEvents.filter((event) => (
      (event as { type?: string }).type === 'tool_use'
    )) as Array<{ data: { tool: string; input: Record<string, unknown> } }>;
    expect(toolUses.length).toBeGreaterThan(0);
    const editUse = toolUses.find((use) => use.data.tool === 'edit');
    expect(editUse).toBeDefined();
    expect(editUse!.data.input.filePath).toBe('src/core/workflow/engine/StepExecutor.ts');
    const oldStringMask = editUse!.data.input.oldString as { sha256: string; length: number };
    expect(oldStringMask.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(oldStringMask.length).toBe(sourceBody.length);
    const newStringMask = editUse!.data.input.newString as { sha256: string; length: number };
    expect(newStringMask.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(newStringMask.length).toBe(replacementBody.length);

    // tool_result: エラー文経由の本文もプレースホルダ置換済みで、骨格は読める。
    const toolResults = streamEvents.filter((event) => (
      (event as { type?: string }).type === 'tool_result'
    )) as Array<{ data: { content: string; isError: boolean } }>;
    expect(toolResults.length).toBeGreaterThan(0);
    const errorResult = toolResults.find((result) => result.data.isError);
    expect(errorResult).toBeDefined();
    expect(errorResult!.data.content).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
    expect(errorResult!.data.content).toContain('Could not find the following text');
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
