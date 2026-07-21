/**
 * OpenCodeClient の tool-guard recovery オーケストレーションのテスト
 * （opencode-client-retry.test.ts と同じ SDK モック機構）。
 *
 * - edit_conflict_loop → 同一セッション内 correction 1回 → 再発で fresh session
 *   recovery 1回 → done
 * - tool_error_burst → 同一セッション内 correction 1回 → 再発で fresh session
 *   recovery 1回 → 再発で即失敗
 * - absolute_cost_limit → 即失敗（recovery なし）
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type MockStreamEvent = Record<string, unknown>;

let runPlans: MockStreamEvent[][] = [];
let runPlanIndex = 0;

function createEvents(events: MockStreamEvent[], sessionId: string) {
  return (async function* () {
    for (const event of events) {
      const properties = event.properties;
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        throw new Error('Mock OpenCode event properties are required');
      }
      yield { ...event, properties: { ...properties, sessionID: sessionId } };
    }
  })();
}

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

const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');

let sessionSeq = 0;

function installOpenCodeMock() {
  let activeSessionId: string | undefined;
  const sessionCreate = vi.fn().mockImplementation(async () => {
    sessionSeq += 1;
    activeSessionId = `session-${sessionSeq}`;
    return { data: { id: activeSessionId } };
  });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const abort = vi.fn().mockResolvedValue({ data: true });
  const subscribe = vi.fn().mockImplementation(async () => {
    const plan = runPlans[runPlanIndex];
    runPlanIndex += 1;
    if (!plan) {
      throw new Error(`Missing run plan for attempt ${runPlanIndex}`);
    }
    if (activeSessionId === undefined) {
      throw new Error('OpenCode session must be created before subscribing');
    }
    return { stream: createEvents(plan, activeSessionId) };
  });

  createOpencodeMock.mockResolvedValue({
    client: {
      instance: { dispose: vi.fn() },
      session: { create: sessionCreate, promptAsync, abort },
      event: { subscribe },
      permission: { reply: vi.fn() },
    },
    server: { close: vi.fn() },
  });

  return { sessionCreate, promptAsync, abort, subscribe };
}

let toolCallSeq = 0;

function editErrorEvent(filePath: string, oldString: string): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: 'edit',
        callID: `tc-${toolCallSeq}`,
        state: {
          status: 'error',
          error: 'oldString not found in content',
          input: { filePath, oldString, newString: 'replacement' },
        },
      },
    },
  };
}

function genericErrorEvent(index: number): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: `tool-${index % 4}`,
        callID: `tc-${toolCallSeq}`,
        state: { status: 'error', error: `provider degradation failure ${index}`, input: {} },
      },
    },
  };
}

function bodyErrorEvent(tool: string, key: string, body: string, index: number): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool,
        callID: `tc-${toolCallSeq}`,
        state: {
          status: 'error',
          error: `Tool failure ${index} quoted body:\n${body}`,
          input: { filePath: `src/file-${index}.ts`, [key]: body },
        },
      },
    },
  };
}

function sensitiveErrorEvent(input: Record<string, unknown>, error: string): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: 'fetch',
        callID: `tc-${toolCallSeq}`,
        state: { status: 'error', error, input },
      },
    },
  };
}

function shortSecretInvalidArgumentEvent(): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: 'read',
        callID: `tc-${toolCallSeq}`,
        state: {
          status: 'error',
          error: 'Invalid arguments: token "a"',
          input: { token: 'a' },
        },
      },
    },
  };
}

function completedToolEvent(
  tool: string,
  input: Record<string, unknown>,
  output: string,
  callID?: string,
  metadata?: Record<string, unknown>,
): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool,
        callID: callID ?? `tc-${toolCallSeq}`,
        state: {
          status: 'completed',
          input,
          output,
          title: tool,
          ...(metadata !== undefined ? { metadata } : {}),
        },
      },
    },
  };
}

function invalidCompletedToolEvent(): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: 'invalid',
        callID: `tc-${toolCallSeq}`,
        state: {
          status: 'completed',
          input: {
            tool: 'read',
            error: `Required argument 'filePath' is missing or invalid (variant ${'x'.repeat(toolCallSeq)})`,
          },
          output: 'OpenCode rejected the tool call',
          title: 'invalid',
        },
      },
    },
  };
}

function successEvents(sessionId: string, text: string): MockStreamEvent[] {
  return [
    {
      type: 'message.part.updated',
      properties: { part: { id: 'p-done', type: 'text', text }, delta: text },
    },
    { type: 'session.idle', properties: { sessionID: sessionId } },
  ];
}

describe('OpenCodeClient tool guard recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetSharedServer();
    runPlans = [];
    runPlanIndex = 0;
    sessionSeq = 0;
    toolCallSeq = 0;
  });

  afterEach(() => {
    delete process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET;
    delete process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS;
    delete process.env.TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS;
  });

  it('completed の成功反復は recovery や transient retry をせず1回の prompt で error になる', async () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '3';
    runPlans = [[
      completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
      completedToolEvent('bash', { command: 'git diff -- src/b.ts' }, 'unchanged'),
      completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
      completedToolEvent('bash', { command: 'git diff -- src/b.ts' }, 'unchanged'),
      completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
    ]];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('successful tool result loop');
    expect(result.error).not.toContain('git diff');
    expect(result.error).not.toContain('unchanged');
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it.each([1, null])('metadata.exit=%s の同一結果は edit 成功を挟んでも12回目で terminal error になり、本文を漏らさず recovery しない', async (exit) => {
    const sensitiveInput = 'verify --token secret-input-body';
    const sensitiveOutput = 'verification failed: secret-output-body';
    runPlans = [[
      ...Array.from({ length: 12 }, () => [
        completedToolEvent('bash', { command: sensitiveInput }, sensitiveOutput, undefined, { exit }),
        completedToolEvent('edit', { filePath: 'src/a.ts' }, 'changed', undefined, { exit: 0 }),
      ]).flat(),
    ]];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('tool result stagnation');
    expect(result.error).not.toContain(sensitiveInput);
    expect(result.error).not.toContain(sensitiveOutput);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it('metadata.exit=0 は同じキーの結果停滞を消去する', async () => {
    process.env.TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS = '3';
    const input = { command: 'verify' };
    runPlans = [[
      completedToolEvent('bash', input, 'failed', undefined, { exit: 1 }),
      completedToolEvent('bash', input, 'failed', undefined, { exit: 1 }),
      completedToolEvent('bash', input, 'passed', undefined, { exit: 0 }),
      completedToolEvent('bash', input, 'failed', undefined, { exit: 1 }),
      completedToolEvent('bash', input, 'failed', undefined, { exit: 1 }),
      ...successEvents('never', 'done').slice(0, 1),
      { type: 'session.idle', properties: {} },
    ]];

    installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
  });

  it('metadata 欠落または exit 型不正の completed は従来どおり成功として扱う', async () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '2';
    runPlans = [[
      completedToolEvent('bash', { command: 'verify' }, 'unchanged'),
      completedToolEvent('bash', { command: 'verify' }, 'unchanged', undefined, { exit: '1' }),
    ]];

    installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('successful tool result loop');
    expect(result.error).not.toContain('tool result stagnation');
  });

  it('completed invalid は成功台帳へ入れず既存の引数エラー検出へ流れる', async () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '2';
    const invalidLoop = () => [
      invalidCompletedToolEvent(),
      invalidCompletedToolEvent(),
      invalidCompletedToolEvent(),
      invalidCompletedToolEvent(),
    ];
    runPlans = [invalidLoop(), invalidLoop(), invalidLoop()];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid');
    expect(result.error).not.toContain('successful tool result loop');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
  });

  it('同一 session の correction attempt をまたいで成功反復を数える', async () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '3';
    runPlans = [
      [
        completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
        completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
      ],
      [
        completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
      ],
    ];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('successful tool result loop');
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    const calls = promptAsync.mock.calls.map((call) => call[0] as { sessionID: string });
    expect(calls[0]?.sessionID).toBe('session-1');
    expect(calls[1]?.sessionID).toBe('session-1');
  });

  it('edit conflict: 同一セッション correction 1回 → 再発で fresh session 1回 → 成功で done', async () => {
    runPlans = [
      // attempt1 (session-1): 同一署名 edit エラー ×3 → edit_conflict_loop。
      [
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
      ],
      // attempt2 (correction、session-1 を再開): 是正しても同一署名 ×3。
      [
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
      ],
      // attempt3 (fresh session、session-2): 成功。
      successEvents('session-2', 'recovered and finished'),
    ];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('recovered and finished');
    expect(promptAsync).toHaveBeenCalledTimes(3);

    // attempt1: 新規セッション。attempt2: correction は同一セッション再開
    // （create は呼ばれない）。attempt3: fresh session。
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    const call1 = promptAsync.mock.calls[0]?.[0] as { sessionID: string; parts: Array<{ text: string }> };
    const call2 = promptAsync.mock.calls[1]?.[0] as { sessionID: string; parts: Array<{ text: string }> };
    const call3 = promptAsync.mock.calls[2]?.[0] as { sessionID: string; parts: Array<{ text: string }> };
    expect(call1.sessionID).toBe('session-1');
    expect(call2.sessionID).toBe('session-1');
    expect(call3.sessionID).toBe('session-2');

    // correction は元プロンプトを再送せず、再読込・同一 oldString 反復禁止の
    // 是正指示のみ。oldString の本文は含めない。
    expect(call2.parts[0]?.text).toContain('Re-read');
    expect(call2.parts[0]?.text).toContain('src/target.ts');
    expect(call2.parts[0]?.text).not.toContain('stubborn wrong span');
    expect(call2.parts[0]?.text).not.toContain('implement the task');

    // fresh session は途中成果の上書き禁止を明記した前置文 + 元プロンプト。
    expect(call3.parts[0]?.text).toContain('partially completed work');
    expect(call3.parts[0]?.text).toContain('Do NOT overwrite');
    expect(call3.parts[0]?.text).toContain('implement the task');

    // 観測: tool health が応答に構造化されて残る。
    const toolHealth = (result.debugInfo as { toolHealth?: { totalErrors: number; recoveriesUsed: number } })?.toolHealth;
    expect(toolHealth?.totalErrors).toBe(6);
    expect(toolHealth?.recoveriesUsed).toBe(2);
  });

  it('correction 中の別署名 conflict は新しい conflict として自身の correction から始まり、共有 fresh recovery を消費しない（codex ブロッカー2）', async () => {
    runPlans = [
      // attempt1 (session-1): 署名A ×3 → correction(A)。
      [
        editErrorEvent('src/alpha.ts', 'wrong span alpha'),
        editErrorEvent('src/alpha.ts', 'wrong span alpha'),
        editErrorEvent('src/alpha.ts', 'wrong span alpha'),
      ],
      // attempt2 (correction A、session-1 再開): 今度は別ファイルの別署名B ×3。
      // 旧実装はこれを「correction 済みの再発」と誤同一視して fresh を消費していた。
      [
        editErrorEvent('src/beta.ts', 'wrong span beta'),
        editErrorEvent('src/beta.ts', 'wrong span beta'),
        editErrorEvent('src/beta.ts', 'wrong span beta'),
      ],
      // attempt3 (correction B、session-1 再開): 署名B が再発 → correction 失敗
      // → fresh へ escalate。
      [
        editErrorEvent('src/beta.ts', 'wrong span beta'),
        editErrorEvent('src/beta.ts', 'wrong span beta'),
        editErrorEvent('src/beta.ts', 'wrong span beta'),
      ],
      // attempt4 (fresh、session-2): 成功。
      successEvents('session-2', 'finally done'),
    ];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(4);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    const calls = promptAsync.mock.calls.map((call) => call[0] as { sessionID: string; parts: Array<{ text: string }> });
    // attempt2 は署名A（src/alpha.ts）の correction、attempt3 は署名B（src/beta.ts）の
    // 新しい correction — fresh ではなく同一セッション再開。
    expect(calls[1]?.sessionID).toBe('session-1');
    expect(calls[1]?.parts[0]?.text).toContain('src/alpha.ts');
    expect(calls[2]?.sessionID).toBe('session-1');
    expect(calls[2]?.parts[0]?.text).toContain('src/beta.ts');
    expect(calls[2]?.parts[0]?.text).toContain('Re-read');
    // attempt4 が唯一の fresh recovery。
    expect(calls[3]?.sessionID).toBe('session-2');
    expect(calls[3]?.parts[0]?.text).toContain('partially completed work');
  });

  it('correction / fresh recovery を使い切った後の失敗応答（AgentResponse.error）にも oldString 本文が露出しない', async () => {
    // correction 上限（既定2）と fresh（1）をすべて edit conflict で消費させる。
    const conflictBatch = (file: string, span: string) => [
      editErrorEvent(file, span),
      editErrorEvent(file, span),
      editErrorEvent(file, span),
    ];
    runPlans = [
      conflictBatch('src/alpha.ts', 'secret-looking source body ALPHA'), // → correction(A)
      conflictBatch('src/alpha.ts', 'secret-looking source body ALPHA'), // 再発 → fresh
      conflictBatch('src/alpha.ts', 'secret-looking source body ALPHA'), // fresh でも再発 → 失敗
    ];

    const { promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    // 失敗メッセージは署名ハッシュと filePath のみで、oldString 本文を含まない。
    expect(result.error).toContain('edit conflict loop');
    expect(result.error).toContain('src/alpha.ts');
    expect(result.error).not.toContain('secret-looking source body ALPHA');
  });

  it('tool_error_burst: correction → fresh session → 再発で即失敗（needs_fix 等への迂回はしない）', async () => {
    runPlans = [
      // attempt1: 連続10エラー（559スピン型）→ burst。
      [...Array.from({ length: 10 }, (_, index) => genericErrorEvent(index))],
      // attempt2 (correction): また連続10エラー → 同じ fingerprint の再発で fresh。
      [...Array.from({ length: 10 }, (_, index) => genericErrorEvent(index + 10))],
      // attempt3 (fresh): 再発 → recovery 消費済みで失敗。
      [...Array.from({ length: 10 }, (_, index) => genericErrorEvent(index + 20))],
    ];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('tool error burst');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    const call2 = promptAsync.mock.calls[1]?.[0] as { parts: Array<{ text: string }> };
    const call3 = promptAsync.mock.calls[2]?.[0] as { parts: Array<{ text: string }> };
    expect(call2.parts[0]?.text).toContain('tool calls are failing repeatedly');
    expect(call2.parts[0]?.text).not.toContain('implement the task');
    expect(call3.parts[0]?.text).toContain('degraded into a burst');
    expect(call3.parts[0]?.text).toContain('implement the task');

    // 絶対台帳は recovery をまたいで維持されている。
    const toolHealth = (result.debugInfo as { toolHealth?: { totalErrors: number; recoveriesUsed: number } })?.toolHealth;
    expect(toolHealth?.totalErrors).toBe(30);
    expect(toolHealth?.recoveriesUsed).toBe(2);
  });

  it('エラー文が oldString 本文を引用しても failureMessage（AgentResponse.error）に本文が現れない（codex 2巡目ブロッカー: エラー文経由の漏えい）', async () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '5';
    const longOldString = 'const secretLookingSnippet = computeInternalThing(privateValue); // quoted verbatim by the opencode edit error';
    // OpenCode の edit エラー文は oldString の内容を含むことがある
    // （Could not find... の詳細部分）。入力側のマスクだけでは閉じない。
    const editErrorQuotingBody = (index: number): MockStreamEvent => {
      toolCallSeq += 1;
      return {
        type: 'message.part.updated',
        properties: {
          part: {
            id: `part-${toolCallSeq}`,
            type: 'tool',
            tool: 'edit',
            callID: `tc-${toolCallSeq}`,
            state: {
              status: 'error',
              error: `Could not find the following text in src/f${index}.ts:\n${longOldString}`,
              input: { filePath: `src/f${index}.ts`, oldString: longOldString, newString: 'replacement' },
            },
          },
        },
      };
    };
    // filePath を変えて edit_conflict（同一署名）を避け、絶対上限5で即失敗させる。
    // absolute_cost_limit の message は最後のエラー文を連結する経路（codex 再演）。
    runPlans = [[0, 1, 2, 3, 4].map((index) => editErrorQuotingBody(index))];

    const { promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('absolute tool error budget');
    expect(promptAsync).toHaveBeenCalledTimes(1);
    // エラー文に引用された oldString 本文は {sha256 先頭12桁, length} に
    // 置換され、failureMessage には現れない。
    expect(result.error).not.toContain(longOldString);
    expect(result.error).not.toContain('secretLookingSnippet');
    expect(result.error).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
  });

  it.each([
    ['write', 'content', 'complete source body quoted by write failure'],
    ['apply_patch', 'patchText', 'patch body quoted by apply_patch failure'],
  ])('guard の最終 AgentResponse.error に %s.%s 本文を残さない', async (tool, key, body) => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '5';
    runPlans = [[0, 1, 2, 3, 4].map((index) => bodyErrorEvent(tool, key, body, index))];
    installOpenCodeMock();
    const client = new OpenCodeClient();

    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('absolute tool error budget');
    expect(result.error).not.toContain(body);
    expect(result.error).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
  });

  it('guard の最終 AgentResponse.error に HTTP/session 機密値を再流出させない', async () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '1';
    const secrets = {
      proxyAuthorization: 'Basic proxy-credential-secret',
      cookies: 'sid=cookie-value-secret',
      sessionId: 'provider-session-value-secret',
    };
    runPlans = [[sensitiveErrorEvent({
      'Proxy-Authorization': secrets.proxyAuthorization,
      cookies: secrets.cookies,
      sessionId: secrets.sessionId,
    }, `provider rejected ${secrets.proxyAuthorization}; ${secrets.cookies}; ${secrets.sessionId}`)]];

    installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('absolute tool error budget');
    expect(result.error).not.toContain(secrets.proxyAuthorization);
    expect(result.error).not.toContain(secrets.cookies);
    expect(result.error).not.toContain(secrets.sessionId);
  });

  it('short secrets do not prevent invalid-argument loop detection', async () => {
    runPlans = [
      [
        shortSecretInvalidArgumentEvent(),
        shortSecretInvalidArgumentEvent(),
        shortSecretInvalidArgumentEvent(),
        shortSecretInvalidArgumentEvent(),
      ],
      successEvents('unused', 'recovered'),
    ];

    const { promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(promptAsync.mock.calls)).not.toContain('token "a"');
  });

  it('absolute_cost_limit: 即失敗し recovery は使われない', async () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '5';
    runPlans = [
      // 成功を挟んで burst を避けつつ、絶対上限5に到達させる。
      [
        genericErrorEvent(0),
        ...successEvents('never', 'x').slice(0, 1), // text のみ（idle は最後）
        genericErrorEvent(1),
        genericErrorEvent(2),
        genericErrorEvent(3),
        genericErrorEvent(4),
      ],
    ];

    const { promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('absolute tool error budget');
    // recovery attempt は発生しない。
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});
