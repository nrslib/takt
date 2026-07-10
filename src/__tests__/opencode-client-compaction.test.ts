import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      listen: vi.fn((_port: number, _host: string, callback: () => void) => {
        callback();
      }),
      address: vi.fn(() => ({ port: 62000 })),
      close: vi.fn((callback?: (err?: Error) => void) => callback?.()),
    };
  },
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');

type SummarizeRequestOptions = {
  signal?: AbortSignal;
};

/**
 * summarize() のたびに一意な id を持つ「完了済みの新しい summary」を返す
 * messages モック。
 *
 * 実装は summarize() の前後で必ず session.messages() を呼ぶ（前: 既存
 * summary の snapshot、後: 完了ポーリング）。要約の完了判定そのものを
 * 検証しないテストで固定値の空データ（data: []）を使い続けると、今回分の
 * summary が一向に現れず、全体タイムアウト（OPENCODE_SUMMARY_WAIT_TIMEOUT_MS
 * = 3分）まで待ってから例外になる（このモジュールには「出現しなければ
 * 要約不要とみなして早期 return する」猶予は無い — summarize は要約対象が
 * 無くても必ず summary を作ることが実測済みのため、現れないのは異常
 * 扱いになる）。呼び出しごとに新しい id を返すことで、直前の snapshot
 * には無かった「新しい完了済み summary」として即座に見つかり、待たずに
 * 完了する。
 */
function createAutoCompletingMessagesMock(): ReturnType<typeof vi.fn> {
  let counter = 0;
  return vi.fn().mockImplementation(async () => ({
    data: [{
      info: {
        id: `sum-${++counter}`,
        role: 'assistant',
        summary: true,
        time: { completed: counter },
      },
    }],
  }));
}

describe('OpenCodeClient compactSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSharedServer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Given an existing session When compactSession runs Then it calls session.summarize with the SDK payload and abort signal', async () => {
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'new-session' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: sessionCreate,
          promptAsync,
          summarize,
          messages: createAutoCompletingMessagesMock(),
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    const abortController = new AbortController();

    await client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
      opencodeApiKey: 'test-key',
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
      },
    });

    expect(summarize).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: '/repo',
      providerID: 'opencode',
      modelID: 'big-pickle',
      auto: false,
    }, {
      signal: expect.any(AbortSignal),
    });
    const requestOptions = summarize.mock.calls[0]?.[1] as SummarizeRequestOptions;
    expect(requestOptions.signal).not.toBe(abortController.signal);
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  it('Given an invalid OpenCode model When compactSession runs Then it fails before calling the SDK', async () => {
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();

    await expect(client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'big-pickle',
    })).rejects.toThrow("OpenCode model must be in 'provider/model' format");

    expect(summarize).not.toHaveBeenCalled();
  });

  it('Given external abort while summarize is running When compactSession runs Then it aborts the SDK signal immediately', async () => {
    const summarize = vi.fn()
      .mockImplementation((_payload: unknown, requestOptions: SummarizeRequestOptions) => {
        return new Promise<never>((_resolve, reject) => {
          requestOptions.signal?.addEventListener('abort', () => {
            reject(new Error('SDK summarize aborted'));
          });
        });
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    const abortController = new AbortController();

    const compactPromise = client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(summarize).toHaveBeenCalledTimes(1);
    });
    const requestOptions = summarize.mock.calls[0]?.[1] as SummarizeRequestOptions;
    expect(requestOptions.signal).toBeDefined();
    expect(requestOptions.signal).not.toBe(abortController.signal);
    expect(requestOptions.signal?.aborted).toBe(false);

    const compactRejection = expect(compactPromise).rejects.toThrow('OpenCode execution aborted');
    abortController.abort();

    expect(requestOptions.signal?.aborted).toBe(true);
    await compactRejection;
  });

  it('Given session summarize throws synchronously When compactSession fails Then it removes the external abort listener', async () => {
    const summarize = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('SDK summarize failed synchronously');
      })
      .mockResolvedValueOnce({ data: { id: 'session-2' } });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages: createAutoCompletingMessagesMock(),
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    const abortController = new AbortController();
    const addAbortListener = vi.spyOn(abortController.signal, 'addEventListener');
    const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener');

    await expect(client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
    })).rejects.toThrow('SDK summarize failed synchronously');

    // collectExistingSummaryIds()（summarize 前の snapshot 読み取り）と
    // summarize() 自身は、どちらも withTimeout() 経由で abortSignal を
    // 個別に購読・解除する。summarize が同期的に投げても snapshot 側の
    // 購読はすでに完了・解除済みのため、この1回の失敗だけで add/remove は
    // 2組（snapshot 用・summarize 用）発生する。
    expect(addAbortListener).toHaveBeenCalledTimes(2);
    expect(removeAbortListener).toHaveBeenCalledTimes(2);
    expect(removeAbortListener).toHaveBeenNthCalledWith(
      1,
      'abort',
      addAbortListener.mock.calls[0]?.[1],
    );
    expect(removeAbortListener).toHaveBeenNthCalledWith(
      2,
      'abort',
      addAbortListener.mock.calls[1]?.[1],
    );

    await client.compactSession({
      cwd: '/repo',
      sessionId: 'session-2',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
    });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
  });

  it('Given session summarize does not settle When compactSession runs Then the SDK call receives an interaction timeout signal', async () => {
    const summarize = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-0' } })
      .mockImplementationOnce((_payload: unknown, requestOptions: SummarizeRequestOptions) => {
        return new Promise<never>((_resolve, reject) => {
          requestOptions.signal?.addEventListener('abort', () => {
            reject(new Error('SDK summarize aborted'));
          });
        });
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages: createAutoCompletingMessagesMock(),
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    const abortController = new AbortController();

    await client.compactSession({
      cwd: '/repo',
      sessionId: 'session-0',
      model: 'opencode/big-pickle',
    });

    vi.useFakeTimers();
    const compactPromise = client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
    });
    // 実装は summarize() の前に collectExistingSummaryIds()（session.messages()
    // 呼び出し）を挟むようになったため、summarize が呼ばれるまでに複数回の
    // マイクロタスクを経由する。setTimeout を伴わない Promise チェーンなので
    // フェイクタイマーの影響は受けないが、単純な2回の Promise.resolve() では
    // 待ちが足りないため、十分な回数フラッシュする。
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    expect(summarize).toHaveBeenCalledTimes(2);
    const requestOptions = summarize.mock.calls[1]?.[1] as SummarizeRequestOptions;
    expect(requestOptions.signal).toBeDefined();
    expect(requestOptions.signal).not.toBe(abortController.signal);
    expect(requestOptions.signal?.aborted).toBe(false);

    const compactRejection = expect(compactPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);

    expect(requestOptions.signal?.aborted).toBe(true);
    await compactRejection;
  });

  it('Given a summary still generating When compactSession runs Then it waits until the summary completes', async () => {
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    // 1回目（snapshot、summarize 前）は既存の summary なし。2回目（最初の
    // poll）は今回の summary が現れているが未完了。3回目で完了したメッセージ
    // を返す。待たずに戻ると OpenCode が後続のツール呼び出しを拒否する。
    const messages = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ info: { id: 'sum-1', role: 'assistant', summary: true, time: {} } }] })
      .mockResolvedValueOnce({ data: [{ info: { id: 'sum-1', role: 'assistant', summary: true, time: { completed: 1 } } }] });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    });

    expect(messages).toHaveBeenCalledTimes(3);
  });

  it('Given a summary message that completed with an error When compactSession runs Then it fails instead of treating the summary as successful', async () => {
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    // OpenCode はエラー終了した要約にも time.completed を付ける。completed の
    // 有無だけで判定すると失敗を成功と取り違え、未圧縮のまま次のプロンプトへ
    // 進んで同じ理由で再度失敗する（このテストが再現する不変条件）。
    //
    // id を付けてスナップショット（summarize 前）には存在しない、今回分の
    // summary であることを明示する。同じレスポンスを snapshot にも使うと、
    // その id が既存扱いになり、直後の poll で除外されて「今回分がまだ
    // 現れていない」経路（出現猶予待ち）に落ちてしまい、このテストが検証
    // したい「今回の summary 自体がエラーで失敗する」ケースを再現できない。
    const messages = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{
          info: {
            id: 'sum-new',
            role: 'assistant',
            summary: true,
            time: { completed: 1 },
            error: { message: 'context length exceeded' },
          },
        }],
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await expect(compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    })).rejects.toThrow('context length exceeded');

    expect(messages).toHaveBeenCalledTimes(2);
  });

  it('Given a past failed summary message excluded from this call by id and this call\'s own summary succeeding at the first poll When compactSession runs Then it completes without throwing (the stale failure is not mistaken for the current one)', async () => {
    // codex 指摘: session.messages() は全履歴を返すため、同じセッションで過去の
    // 要約が失敗し、その後リトライして成功していても、旧実装は履歴中のエラー付き
    // summary を1件でも見つけると例外にしていた。sessionId は phase や resume で
    // 再利用されるため、過去の失敗メッセージがそのまま履歴に残り続ける。
    // 判定対象は「今回の summarize() が作った summary」だけに絞る必要がある。
    //
    // AssistantMessage.id は SDK の型で必須のフィールドで、実装は
    // summary === true なのに id が文字列でないメッセージを見つけると
    // fail fast する（OpenCode summary message has no id）。そのため id を
    // 省略して「区別できない2件」を再現することはもうできない。代わりに
    // 過去の失敗には固定の id、今回の成功には別の id を与え、snapshot
    // （summarize 前）には過去の失敗だけを、最初の poll（summarize 後）で
    // 初めて今回分が現れるようにする。これで「過去の失敗が今回の成功を
    // 覆い隠さない」という旧テストの意図を、実契約に沿ったまま検証できる。
    const staleFailedSummary = {
      info: {
        id: 'sum-old-failed',
        role: 'assistant' as const,
        summary: true,
        time: { completed: 1 },
        error: { message: 'context length exceeded (stale failure from an earlier phase)' },
      },
    };
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const messages = vi.fn()
      // 1回目（snapshot、summarize 前）: 過去に失敗した summary だけが存在する。
      .mockResolvedValueOnce({ data: [staleFailedSummary] })
      // 2回目（最初の poll）: 今回分がすでに現れ、エラーなく完了している。
      .mockResolvedValueOnce({
        data: [
          staleFailedSummary,
          {
            info: {
              id: 'sum-new-success',
              role: 'assistant',
              summary: true,
              time: { completed: 2 },
            },
          },
        ],
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await expect(compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    })).resolves.toBeUndefined();

    expect(messages).toHaveBeenCalledTimes(2);
  });

  it('Given a past summary message stuck without a completed time excluded from this call by id When compactSession runs Then it completes on this call\'s own summary without waiting on the stale pending message', async () => {
    // codex 指摘は完了判定にも同じ問題があるとしていた: 過去の summary
    // メッセージが（何らかの理由で）time.completed を持たないまま履歴に残って
    // いても、今回分の summary が完了していればそれ以上待つ必要はない。
    //
    // id 必須の fail fast があるため、過去の未完了と今回の完了を id で
    // 区別する。snapshot（summarize 前）には過去の未完了だけを返し、最初の
    // poll（summarize 後）で今回分が完了済みとして現れるようにする。
    // stale なメッセージが existingSummaryIds に登録され、poll 側の探索
    // 対象（!existingSummaryIds.has）から除外されることを呼び出し回数
    // （2回・待たずに完了）で確認する。
    const stalePendingSummary = {
      info: {
        id: 'sum-old-pending',
        role: 'assistant' as const,
        summary: true,
        time: {},
      },
    };
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const messages = vi.fn()
      // 1回目（snapshot、summarize 前）: 過去の未完了 summary だけが存在する。
      .mockResolvedValueOnce({ data: [stalePendingSummary] })
      // 2回目（最初の poll）: 今回分が現れ、すでに完了している。
      .mockResolvedValueOnce({
        data: [
          stalePendingSummary,
          {
            info: {
              id: 'sum-new-success',
              role: 'assistant',
              summary: true,
              time: { completed: 2 },
            },
          },
        ],
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await expect(compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    })).resolves.toBeUndefined();

    expect(messages).toHaveBeenCalledTimes(2);
  });

  it('Given a summary message with no id in the pre-summarize snapshot When compactSession runs Then it fails fast instead of silently accepting the message', async () => {
    // AssistantMessage.id は SDK の型（node_modules/@opencode-ai/sdk/dist/v2/
    // gen/types.gen.d.ts）で必須のフィールド。id が無い summary は契約違反で
    // あり、id で「今回の要約」を識別できない以上、過去の要約を今回のものと
    // 取り違える余地を残す。collectExistingSummaryIds()（summarize 前の
    // snapshot 読み取り）はこれを黙って見逃さず、その場で fail fast する。
    // snapshot の時点で落ちるため、summarize() は一度も呼ばれない。
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const messages = vi.fn().mockResolvedValue({
      data: [{
        info: {
          // id を意図的に欠落させる。
          role: 'assistant',
          summary: true,
          time: { completed: 1 },
        },
      }],
    });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await expect(compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    })).rejects.toThrow('OpenCode summary message has no id: session-1');

    expect(summarize).not.toHaveBeenCalled();
  });

  it('Given a summary message with no id appearing while polling for completion When compactSession runs Then it fails fast instead of silently accepting the message', async () => {
    // 上のテストが snapshot 側の fail fast を検証するのに対し、こちらは
    // waitForSummaryToComplete()（summarize 後のポーリング）側を検証する。
    // snapshot は空（既存 summary なし）で通過させ、最初の poll で id の無い
    // summary を返す。summarize() 自体はすでに呼ばれているはず。
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const messages = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{
          info: {
            // id を意図的に欠落させる。
            role: 'assistant',
            summary: true,
            time: { completed: 1 },
          },
        }],
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await expect(compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    })).rejects.toThrow('OpenCode summary message has no id: session-1');

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it('Given session.messages returns no data before summarize When compactSession runs Then it fails instead of assuming there are no existing summaries', async () => {
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    // collectExistingSummaryIds()（summarize 前の snapshot）が data を読めない
    // まま先へ進むと、既存の summary を1件も除外できず、今回分の summary を
    // 過去のものと誤認しうる。この呼び出しは summarize() より前に起きるため、
    // summarize は一度も呼ばれずに失敗する。
    const messages = vi.fn().mockResolvedValue({});
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await expect(compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    })).rejects.toThrow('not readable before summarize');

    expect(summarize).not.toHaveBeenCalled();
  });

  it('Given session.messages returns no data while waiting for summary When compactSession runs Then it fails instead of assuming the summary finished', async () => {
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    // snapshot（summarize 前）は正常に読める（既存 summary なし）が、
    // summarize() 後のポーリングで data が読めなくなるケース。要約中のまま
    // 先へ進むと後続のツール呼び出しが全て拒否されるため、判定できないなら
    // 止める必要がある。
    const messages = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({});
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await expect(compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    })).rejects.toThrow('not readable while waiting for summary');

    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('Given a past failed summary message not yet superseded by this call\'s summary at the first poll When compactSession runs Then it completes without mistaking the stale failure for the current summary', async () => {
    // codex 指摘の核心: summarize() が投入した今回分の要約ジョブは、
    // 完了はおろか履歴に「現れる」までにも時間差がある。id 集合で除外しない
    // 実装だと、今回分がまだ履歴に現れていない最初のポーリングでは過去の
    // summary が最新（というより唯一の）候補になり、それが過去の失敗であれば
    // 即例外にしてしまう。sessionId は phase や resume で再利用されるため、
    // このシナリオは実運用でも起こりうる。
    const staleFailedSummary = {
      info: {
        id: 'sum-old',
        role: 'assistant' as const,
        summary: true,
        error: { message: 'stale failure from an earlier compaction' },
        time: { completed: 1 },
      },
    };
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const messages = vi.fn()
      // 1回目（snapshot、summarize 前）: 過去に失敗した summary だけが存在する。
      .mockResolvedValueOnce({ data: [staleFailedSummary] })
      // 2回目（最初の poll）: 今回分はまだ履歴に現れていない。
      .mockResolvedValueOnce({ data: [staleFailedSummary] })
      // 3回目: 今回分が履歴に現れた。エラーなく完了している。
      .mockResolvedValueOnce({
        data: [
          staleFailedSummary,
          {
            info: {
              id: 'sum-new',
              role: 'assistant',
              summary: true,
              time: { completed: 2 },
            },
          },
        ],
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await expect(compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    })).resolves.toBeUndefined();

    expect(messages).toHaveBeenCalledTimes(3);
  });

  it('Given a past successful summary not yet superseded by this call\'s summary at the first poll When compactSession runs Then it waits for this call\'s own summary instead of returning on the stale success', async () => {
    // 過去の成功と今回分を混同すると、今回の要約がまだ終わっていないのに
    // 即 return してしまい、圧縮前のコンテキストのまま次のプロンプトへ進む。
    const staleSucceededSummary = {
      info: {
        id: 'sum-old',
        role: 'assistant' as const,
        summary: true,
        time: { completed: 1 },
      },
    };
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const messages = vi.fn()
      // 1回目（snapshot）: 過去に成功した summary だけが存在する。
      .mockResolvedValueOnce({ data: [staleSucceededSummary] })
      // 2回目（最初の poll）: 今回分はまだ履歴に現れていない。
      .mockResolvedValueOnce({ data: [staleSucceededSummary] })
      // 3回目: 今回分が現れたが、まだ未完了。ここで return してはいけない。
      .mockResolvedValueOnce({
        data: [
          staleSucceededSummary,
          { info: { id: 'sum-new', role: 'assistant', summary: true, time: {} } },
        ],
      })
      // 4回目: 今回分が完了した。
      .mockResolvedValueOnce({
        data: [
          staleSucceededSummary,
          { info: { id: 'sum-new', role: 'assistant', summary: true, time: { completed: 2 } } },
        ],
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    await expect(compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    })).resolves.toBeUndefined();

    // 3回目（今回分が現れたが未完了）で return せず、完了する4回目まで
    // ポーリングを続けたことを呼び出し回数で確認する。
    expect(messages).toHaveBeenCalledTimes(4);
  });

  it('Given this call\'s summary never appears in history When compactSession runs Then it rejects after the wait timeout instead of assuming the summary was unnecessary', async () => {
    // 実測（ローカルの偽プロバイダ）: メッセージが1件も無いセッションに対して
    // session.summarize() を呼んでも戻り値は true で、1秒後には summary
    // メッセージが1件できていた。つまり要約対象が無くても summary は必ず
    // 作られる。したがって「今回の summary が履歴に一向に現れない」のは
    // 異常であり、以前あった「出現猶予（旧
    // OPENCODE_SUMMARY_APPEARANCE_TIMEOUT_MS = 10秒）で諦めて要約不要と
    // みなし return する」分岐は誤った前提に基づいていたため削除された。
    // 現在は全体タイムアウト（OPENCODE_SUMMARY_WAIT_TIMEOUT_MS = 3分）まで
    // 待ち続け、それでも現れなければ
    // 'OpenCode session summarize did not finish in time' で reject する。
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const messages = vi.fn().mockResolvedValue({ data: [] });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
          messages,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    vi.useFakeTimers();
    const { compactOpenCodeSession } = await import('../infra/opencode/client.js');
    const compactPromise = compactOpenCodeSession({
      cwd: '/tmp/project',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    });

    // 待機が実際に起きていることを検証する（codex 指摘: 旧テストは即時
    // return しても通る書き方だった）。settled フラグと呼び出し回数の
    // どちらでも「まだ確定していない」ことを確かめてから、タイムアウトを
    // 超えるまで時間を進める。
    let settled = false;
    compactPromise.then(() => { settled = true; }, () => { settled = true; });
    const compactRejection = expect(compactPromise).rejects.toThrow(
      'OpenCode session summarize did not finish in time',
    );

    // ポーリング間隔（実装内の OPENCODE_SUMMARY_POLL_INTERVAL_MS = 500ms）
    // 1回分だけ進めた時点では、まだ確定していないはず。
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    const callsAfterFirstPoll = messages.mock.calls.length;
    // snapshot（collectExistingSummaryIds）分の1回 + 最初の poll 分の1回で
    // 最低2回は呼ばれている。
    expect(callsAfterFirstPoll).toBeGreaterThan(1);

    // 全体タイムアウト（実装内の OPENCODE_SUMMARY_WAIT_TIMEOUT_MS = 3分）を
    // 超えるまで進める。
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

    expect(settled).toBe(true);
    // ポーリングが1回きりではなく、実際に繰り返し行われたことも確認する。
    expect(messages.mock.calls.length).toBeGreaterThan(callsAfterFirstPoll);
    await compactRejection;
  });
});
