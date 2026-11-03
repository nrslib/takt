vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
/**
 * Claude SDK executor layer tests.
 *
 * Covers:
 * - SdkOptionsBuilder — outputSchema → outputFormat conversion and env wiring
 * - QueryExecutor — structured_output extraction, abortSignal wiring,
 *   rate limit cause preservation
 * - sdkMessageToStreamEvent — SDK message → stream event conversion
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delimiter, dirname } from 'node:path';
import type { ClaudeSpawnOptions, StreamEvent } from '../infra/claude/types.js';
import type { HookInput, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const {
  queryMock,
  interruptMock,
  AbortErrorMock,
} = vi.hoisted(() => {
  class AbortErrorMock extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'AbortError';
    }
  }

  return {
    queryMock: vi.fn(),
    interruptMock: vi.fn(async () => {}),
    AbortErrorMock,
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: queryMock,
  AbortError: AbortErrorMock,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...original,
    createLogger: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { QueryExecutor } from '../infra/claude/executor.js';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import { getActiveQueryCount } from '../infra/claude/query-manager.js';
import { sdkMessageToStreamEvent } from '../infra/claude/stream-converter.js';
import { ClaudeProvider } from '../infra/providers/claude.js';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('strict manager tool restrictions', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each(['strictToolAllowlist', 'mcpOnlySideEffects'] as const)('transfers %s from the provider to the SDK and rejects other tools', async (restriction) => {
    const structured = { message: 'question', summary: null };
    queryMock.mockReturnValue(createMockQuery([{ type: 'result', subtype: 'success', result: 'done', structured_output: structured }]));
    const serverName = 'takt-mgr_session';
    const tools = ['Read', ...['takt_create_goal', 'takt_list_goals', 'takt_get_goal', 'takt_list_tasks', 'takt_get_run'].map((name) => `mcp__${serverName}__${name}`)];
    const agent = new ClaudeProvider().setup({ name: 'manager', systemPrompt: 'manager' });
    const response = await agent.call('consult', {
      cwd: '/tmp/project', permissionMode: 'readonly', [restriction]: tools,
      allowedTools: tools, mcpServers: { [serverName]: { command: 'node', args: ['mcp.js'] } },
      outputSchema: { type: 'object' },
    });
    expect(response.structuredOutput).toEqual(structured);
    const sdk = queryMock.mock.calls[0]![0].options;
    expect(sdk).toMatchObject({ tools: ['Read'], allowedTools: tools, settingSources: [], skills: [], plugins: [], agents: {}, strictMcpConfig: true, sandbox: { enabled: true, allowUnsandboxedCommands: false } });
    expect(sdk.mcpServers).toEqual({ [serverName]: { command: 'node', args: ['mcp.js'] } });
    if (restriction === 'mcpOnlySideEffects') expect(sdk).not.toHaveProperty('canUseTool');
    for (const tool of [...tools, 'StructuredOutput', 'Bash', 'Edit', 'WebFetch', 'WebSearch', `mcp__${serverName}__takt_enqueue_task`, 'Task']) {
      const allowed = tools.includes(tool) || tool === 'StructuredOutput';
      if (restriction === 'strictToolAllowlist') {
        expect(await sdk.canUseTool(tool, {})).toMatchObject({ behavior: allowed ? 'allow' : 'deny' });
      }
      const hook = sdk.hooks.PreToolUse.find(({ matcher }: { matcher?: string }) => matcher === undefined)?.hooks[0];
      expect(hook).toBeTypeOf('function');
      expect(await hook({ tool_name: tool })).toMatchObject({ hookSpecificOutput: { permissionDecision: allowed ? 'allow' : 'deny' } });
    }
  });

  it('omits an interactive permission callback in manager mode while preserving it in normal execution', () => {
    const handler = vi.fn();
    const options = { cwd: '/tmp/project', permissionMode: 'readonly' as const, allowedTools: ['Read'], onPermissionRequest: handler };
    expect(buildSdkOptions({ ...options, mcpOnlySideEffects: ['Read'] })).not.toHaveProperty('canUseTool');
    expect(buildSdkOptions(options).canUseTool).toBeTypeOf('function');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not allow a native output collector when no output schema was requested', async () => {
    const sdk = buildSdkOptions({ cwd: '/tmp/project', permissionMode: 'readonly', mcpOnlySideEffects: ['Read'] });
    const hook = sdk.hooks?.PreToolUse?.find(({ matcher }) => matcher === undefined)?.hooks[0];
    expect(hook).toBeDefined();
    const result = await hook!({ tool_name: 'StructuredOutput' } as HookInput, undefined, { signal: new AbortController().signal });
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it.each([
    { permissionMode: 'edit' as const, strictToolAllowlist: ['Read'] },
    { permissionMode: 'readonly' as const, strictToolAllowlist: ['Bash'] },
    { permissionMode: 'readonly' as const, strictToolAllowlist: ['mcp__takt__*'] },
    { permissionMode: 'readonly' as const, strictToolAllowlist: ['mcp__takt__mgr__get_run'] },
    { permissionMode: 'readonly' as const, strictToolAllowlist: ['mcp__takt__get__run'] },
    { permissionMode: 'readonly' as const, strictToolAllowlist: ['mcp__takt___get_run'] },
    { permissionMode: 'readonly' as const, strictToolAllowlist: ['Read'], bypassPermissions: true },
  ])('rejects invalid strict tool controls before SDK invocation: %j', (options) => {
    expect(() => buildSdkOptions({ cwd: '/tmp/project', ...options })).toThrow('Strict tool');
    expect(queryMock).not.toHaveBeenCalled();
  });
});

const RATE_LIMIT_MESSAGE = 'Rate limit exceeded. Please try again later.';
const EXIT_CODE_MESSAGE = 'Claude Code process exited with code 1';

it('keeps a caller-owned conversation resume failure to one SDK attempt through the provider adapter', async () => {
  queryMock.mockReset().mockReturnValue(createMockQuery([], new Error(EXIT_CODE_MESSAGE)));
  const result = await new ClaudeProvider().setup({ name: 'manager', systemPrompt: 'manager' }).call('private conversation', {
    cwd: '/tmp/project', sessionId: 'saved-session', callerManagedSession: true,
  });
  expect(result.status).toBe('error');
  expect(queryMock).toHaveBeenCalledOnce();
  expect(queryMock.mock.calls[0]![0].options.resume).toBe('saved-session');
  expect(result.failureCategory).toBeUndefined();
});

it.each([false, true].flatMap((custom) => [false, true].map((throws) => ({ custom, throws }))))('propagates a rejected resume through the Claude provider (custom: $custom, exception: $throws)', async ({ custom, throws }) => {
  const sessionId = '00000000-0000-4000-8000-000000000099';
  const error = `No conversation found with session ID: ${sessionId}`;
  queryMock.mockReset().mockReturnValue(createMockQuery([
    { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, errors: [error] },
  ], throws ? new Error(`Claude Code returned an error result: ${error}`) : undefined));
  const response = await new ClaudeProvider().setup({ name: 'manager', ...(custom ? { systemPrompt: 'manager' } : {}) }).call('continue', {
    cwd: '/tmp/project', sessionId, callerManagedSession: true,
  });
  expect(response).toMatchObject({ status: 'error', failureCategory: 'session_continuation_unsupported' });
  expect(queryMock).toHaveBeenCalledOnce();
});

it.each(['authentication failed', 'network unavailable', 'No conversation found with session ID: another-session'])('does not classify an unrelated SDK failure: %s', async (error) => {
  queryMock.mockReset().mockReturnValue(createMockQuery([
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error] },
  ]));
  const response = await new QueryExecutor().execute('continue', { cwd: '/tmp/project', sessionId: 'saved-session', callerManagedSession: true });
  expect(response.success).toBe(false);
  expect(response).not.toHaveProperty('failureCategory', 'session_continuation_unsupported');
  expect(queryMock).toHaveBeenCalledOnce();
});

it.each([false, true])('recovers through the real Claude adapter only before tool execution (tools: %s)', async (tools) => {
  const sessionId = '00000000-0000-4000-8000-000000000099';
  const error = `No conversation found with session ID: ${sessionId}`;
  queryMock.mockReset().mockReturnValueOnce(createMockQuery([
    ...(tools ? [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } }] : []),
    { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, errors: [error] },
  ], new Error(`Claude Code returned an error result: ${error}`)));
  const invalidateSession = vi.fn(async () => {});
  if (!tools) queryMock.mockImplementationOnce(({ prompt, options }) => {
    expect(invalidateSession).toHaveBeenCalledOnce();
    expect(options.resume).toBeUndefined();
    expect(prompt).toContain('pending revision 4; current goals');
    return createMockQuery([{ type: 'result', subtype: 'success', structured_output: { message: 'fresh reply', summary: null }, session_id: 'fresh-session' }]);
  });
  const executor = createManagerTurnExecutor('/tmp/project', {
    ctx: { providerType: 'claude', provider: new ClaudeProvider(), lang: 'en', model: undefined },
    permissionJudge: { resolution: { provider: 'claude', model: undefined, providerOptions: {} }, language: 'en', systemPrompt: 'judge', managerPersona: 'manager', managerPolicy: 'policy' },
    strategy: { systemPrompt: 'manager' },
  });
  const result = executor.execute({ prompt: 'continue', instruction: 'continue', sessionId, abortSignal: new AbortController().signal,
    assignment: { kind: 'repository', repositoryDirectory: '/tmp/project' }, configDirectory: '/tmp/config',
    recovery: { context: 'pending revision 4; current goals', invalidateSession } });
  if (tools) await expect(result).rejects.toMatchObject({ failureCategory: 'session_continuation_unsupported' });
  else expect(await result).toMatchObject({ message: 'fresh reply', sessionId: 'fresh-session' });
  expect(invalidateSession).toHaveBeenCalledOnce();
  expect(queryMock).toHaveBeenCalledTimes(tools ? 1 : 2);
});

it('does not classify successful assistant content as a rejected Claude session', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000099';
  queryMock.mockReset().mockReturnValue(createMockQuery([{ type: 'result', subtype: 'success',
    result: `No conversation found with session ID: ${sessionId}`, structured_output: { message: 'session_continuation_unsupported', summary: null } }]));
  const response = await new ClaudeProvider().setup({ name: 'manager' }).call('continue', { cwd: '/tmp/project', sessionId, callerManagedSession: true });
  expect(response.status).toBe('done');
  expect(response.failureCategory).toBeUndefined();
  expect(queryMock).toHaveBeenCalledOnce();
});

it('classifies the exact resume diagnostic on SDK stderr before any result arrives', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000099';
  queryMock.mockReset().mockImplementation(({ options }) => {
    options.stderr(`No conversation found with session ID: ${sessionId}\n`);
    return createMockQuery([], new Error(EXIT_CODE_MESSAGE));
  });
  const response = await new QueryExecutor().execute('continue', { cwd: '/tmp/project', sessionId, callerManagedSession: true });
  expect(response).toMatchObject({ success: false, failureCategory: 'session_continuation_unsupported' });
  expect(queryMock).toHaveBeenCalledOnce();
});

type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

function createMockQuery(
  messages: Array<Record<string, unknown>>,
  error?: Error,
) {
  return {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown> {
      for (const message of messages) {
        yield message;
      }

      if (error) {
        throw error;
      }
    },
  };
}

function createMockQueryThatFailsAfterFirstMessage(
  firstMessage: Record<string, unknown>,
  precedingMessages: Array<Record<string, unknown>> = [],
) {
  const state = { afterMarkerPulled: false };
  return {
    state,
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown> {
      for (const message of precedingMessages) {
        yield message;
      }
      yield firstMessage;
      state.afterMarkerPulled = true;
      throw new Error('stream should stop after rate limit detection');
    },
  };
}

function createInterruptibleQuery() {
  let interrupted = false;
  interruptMock.mockImplementation(async () => {
    interrupted = true;
  });

  return {
    interrupt: interruptMock,
    async *[Symbol.asyncIterator](): AsyncGenerator<never, void, unknown> {
      while (!interrupted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new AbortErrorMock('aborted');
    },
  };
}

function createAssistantRateLimitMessage(): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { content: [] },
    error: 'rate_limit',
    uuid: 'assistant-rate-limit',
    session_id: 'session-rate-limit',
    parent_tool_use_id: null,
  };
}

function createAssistantTextMessage(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
    session_id: 'session-rate-limit',
  };
}

function createRateLimitEventMessage(
  rateLimitInfo: {
    status: RateLimitStatus;
    overageStatus?: RateLimitStatus;
  },
): Record<string, unknown> {
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: rateLimitInfo.status,
      rateLimitType: 'five_hour',
      overageStatus: rateLimitInfo.overageStatus ?? rateLimitInfo.status,
      overageDisabledReason: 'out_of_credits',
      resetsAt: 1775059200,
      overageResetsAt: 1775059200,
      isUsingOverage: false,
    },
    uuid: 'rate-limit-event',
    session_id: 'session-rate-limit',
  };
}

function createResultMessage(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result: 'done',
    ...overrides,
  };
}

describe('SdkOptionsBuilder — outputFormat 変換', () => {
  it('does not restore original servers after the prepared MCP set has excluded every server', () => {
    const sdkOptions = buildSdkOptions({
      cwd: '/tmp',
      mcpServers: { datadog: {
        type: 'http', url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}' },
      } },
      preparedMcp: { dispose: async () => {}, sdkOptions: { mcpServers: {}, strictMcpConfig: true } },
    });

    expect(sdkOptions.strictMcpConfig).toBe(true);
    expect(Object.keys(sdkOptions.mcpServers ?? {})).toEqual([]);
  });

  it('effort が SDK options に直接反映される', () => {
    const sdkOptions = buildSdkOptions({ cwd: '/tmp', effort: 'medium' });

    expect(sdkOptions.effort).toBe('medium');
  });

  it('provider が定義する effort 文字列を SDK options へそのまま渡す', () => {
    const sdkOptions = buildSdkOptions({ cwd: '/tmp', effort: 'provider-defined' });

    expect(sdkOptions.effort).toBe('provider-defined');
  });

  it('outputSchema が outputFormat に変換される', () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    const sdkOptions = buildSdkOptions({ cwd: '/tmp', outputSchema: schema });

    expect(sdkOptions.outputFormat).toEqual({
      type: 'json_schema',
      schema,
    });
  });

  it('outputSchema 未設定なら outputFormat は含まれない', () => {
    const sdkOptions = buildSdkOptions({ cwd: '/tmp' });
    expect(sdkOptions).not.toHaveProperty('outputFormat');
  });

  it('現在の Node.js 実行ディレクトリを PATH の先頭に追加する', () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = ['/usr/bin', '/bin'].join(delimiter);

      const sdkOptions = buildSdkOptions({
        cwd: '/tmp',
        pathToClaudeCodeExecutable: '/tmp/test-bin/claude',
      });

      const pathEntries = sdkOptions.env?.PATH?.split(delimiter) ?? [];
      expect(pathEntries[0]).toBe(dirname(process.execPath));
      expect(pathEntries).toContain('/usr/bin');
      expect(pathEntries).toContain(dirname(process.execPath));
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('Anthropic API key を env に引き継ぐ', () => {
    const sdkOptions = buildSdkOptions({
      cwd: '/tmp',
      anthropicApiKey: 'test-key',
    });

    expect(sdkOptions.env?.ANTHROPIC_API_KEY).toBe('test-key');
  });

  it('baseUrl を ANTHROPIC_BASE_URL として SDK env に注入し ambient env より優先する', () => {
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    try {
      process.env.ANTHROPIC_BASE_URL = 'http://ambient.example.test';
      const spawnOptions = {
        cwd: '/tmp',
        baseUrl: 'http://127.0.0.1:8787',
      } as unknown as ClaudeSpawnOptions;

      const sdkOptions = buildSdkOptions(spawnOptions);

      expect(sdkOptions.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      }
    }
  });
});

describe('QueryExecutor — structuredOutput 抽出', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('result メッセージの structured_output (snake_case) を抽出する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structured_output: { step: 2 } },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.success).toBe(true);
    expect(result.structuredOutput).toEqual({ step: 2 });
  });

  it('result メッセージの structuredOutput (camelCase) を抽出する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structuredOutput: { step: 3 } },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toEqual({ step: 3 });
  });

  it('structured_output が snake_case 優先 (snake_case と camelCase 両方ある場合)', async () => {
    queryMock.mockReturnValue(createMockQuery([
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        structured_output: { step: 1 },
        structuredOutput: { step: 9 },
      },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toEqual({ step: 1 });
  });

  it('structuredOutput がない場合は undefined', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'plain text' },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('structured_output が配列の場合は無視する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structured_output: [1, 2, 3] },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('structured_output が null の場合は無視する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structured_output: null },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('assistant テキストと structured_output を同時に取得する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'thinking...' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'final text',
        structured_output: { step: 1, reason: 'approved' },
      },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.success).toBe(true);
    expect(result.content).toBe('final text');
    expect(result.structuredOutput).toEqual({ step: 1, reason: 'approved' });
  });

  it('result メッセージの usage を providerUsage として抽出する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });
    const providerUsage = result.providerUsage;

    expect(providerUsage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      cachedInputTokens: 12,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 7,
      usageMissing: false,
    });
  });

  it('usage が存在しない場合は usageMissing=true と reason を返す', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done' },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });
    const providerUsage = result.providerUsage;

    expect(providerUsage).toMatchObject({
      usageMissing: true,
      reason: 'usage_not_available',
    });
  });

  it('usage に必須 token が欠ける場合は usage_tokens_missing を返す', async () => {
    queryMock.mockReturnValue(createMockQuery([
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        usage: {
          input_tokens: 12,
        },
      },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.providerUsage).toEqual({
      usageMissing: true,
      reason: 'usage_tokens_missing',
    });
  });
});

describe('QueryExecutor abortSignal wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockImplementation(() => createInterruptibleQuery());
  });

  it('中断対象のqueryだけを停止し同時実行中の別queryを最後まで実行する', async () => {
    const controller = new AbortController();
    const siblingController = new AbortController();
    let finishSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => { finishSibling = resolve; });
    const target = createInterruptibleQuery();
    const sibling = {
      interrupt: vi.fn(async () => {}),
      async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown> {
        await siblingGate;
        yield { type: 'result', subtype: 'success', result: 'sibling completed' };
      },
    };
    queryMock.mockReturnValueOnce(target).mockReturnValueOnce(sibling);
    const activeBefore = getActiveQueryCount();
    const executor = new QueryExecutor();
    const execution = executor.execute('target', { cwd: '/tmp/project', abortSignal: controller.signal });
    const siblingExecution = executor.execute('sibling', { cwd: '/tmp/project', abortSignal: siblingController.signal });
    try {
      await vi.waitFor(() => expect(getActiveQueryCount()).toBe(activeBefore + 2));
      controller.abort();
      expect((await execution).interrupted).toBe(true);
      expect(target.interrupt).toHaveBeenCalledOnce();
      expect(sibling.interrupt).not.toHaveBeenCalled();
      expect(siblingController.signal.aborted).toBe(false);
      finishSibling();
      expect(await siblingExecution).toMatchObject({ success: true, content: 'sibling completed' });
      expect(getActiveQueryCount()).toBe(activeBefore);
    } finally {
      controller.abort();
      finishSibling();
      await Promise.allSettled([execution, siblingExecution]);
    }
  });

  it('abortSignal 発火時に query.interrupt() を呼ぶ', async () => {
    const controller = new AbortController();
    const executor = new QueryExecutor();

    const promise = executor.execute('test', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    const result = await promise;

    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(result.interrupted).toBe(true);
  });

  it('開始前に中断済みの signal でも query.interrupt() を呼ぶ', async () => {
    const controller = new AbortController();
    controller.abort();

    const executor = new QueryExecutor();
    const result = await executor.execute('test', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(result.interrupted).toBe(true);
  });

  it('abort後はinterruptとiteratorの終了完了までquery registryから外さない', async () => {
    const controller = new AbortController();
    let resolveInterrupt!: () => void;
    let resolveReturn!: () => void;
    const interruptGate = new Promise<void>((resolve) => {
      resolveInterrupt = resolve;
    });
    const returnGate = new Promise<void>((resolve) => {
      resolveReturn = resolve;
    });
    let iteratorReturnStarted = false;
    const iterator: AsyncIterator<Record<string, unknown>> = {
      next: vi.fn(() => new Promise<IteratorResult<Record<string, unknown>>>(() => {})),
      return: vi.fn(async (): Promise<IteratorResult<Record<string, unknown>>> => {
        iteratorReturnStarted = true;
        await returnGate;
        return { done: true, value: undefined };
      }),
    };
    const query = {
      interrupt: vi.fn(async () => {
        await interruptGate;
      }),
      [Symbol.asyncIterator]: () => iterator,
    };
    queryMock.mockReturnValue(query);
    const activeBefore = getActiveQueryCount();
    const executor = new QueryExecutor();
    const execution = executor.execute('test', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    await vi.waitFor(() => expect(getActiveQueryCount()).toBe(activeBefore + 1));
    controller.abort();
    await vi.waitFor(() => {
      expect(query.interrupt).toHaveBeenCalledTimes(1);
      expect(iteratorReturnStarted).toBe(true);
    });
    expect(getActiveQueryCount()).toBe(activeBefore + 1);

    let settled = false;
    void execution.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    resolveInterrupt();
    resolveReturn();
    const result = await execution;

    expect(result.interrupted).toBe(true);
    expect(getActiveQueryCount()).toBe(activeBefore);
  });

  it('abort後のSDK cleanupがハングしても有限時間でqueryを解放する', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const iterator: AsyncIterator<Record<string, unknown>> = {
        next: vi.fn(() => new Promise<IteratorResult<Record<string, unknown>>>(() => {})),
        return: vi.fn(() => new Promise<IteratorResult<Record<string, unknown>>>(() => {})),
      };
      const query = {
        interrupt: vi.fn(() => new Promise<void>(() => {})),
        [Symbol.asyncIterator]: () => iterator,
      };
      queryMock.mockReturnValue(query);
      const activeBefore = getActiveQueryCount();
      const execution = new QueryExecutor().execute('test', {
        cwd: '/tmp/project',
        abortSignal: controller.signal,
      });

      await vi.waitFor(() => expect(getActiveQueryCount()).toBe(activeBefore + 1));
      controller.abort();
      for (let attempt = 0; attempt < 10 && vi.getTimerCount() === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(query.interrupt).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      const result = await execution;

      expect(result.interrupted).toBe(true);
      expect(getActiveQueryCount()).toBe(activeBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QueryExecutor transient throttling', () => {
  beforeEach(() => {
    queryMock.mockReset();
    vi.useFakeTimers();
  });

  it.each(['result', 'exception', 'assistant'] as const)(
    'tool_use後の%sによる429では同じpromptを再実行しない', async (channel) => {
      const toolUse = {
        type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'touch marker' } }] },
        session_id: 'failed-session',
      };
      const failure = channel === 'result'
        ? createMockQuery([toolUse, createResultMessage({ subtype: 'error_during_execution', is_error: true, errors: ['HTTP 429: Too Many Requests'] })])
        : channel === 'exception'
          ? createMockQuery([toolUse], new Error('HTTP 429: Too Many Requests'))
          : createMockQuery([toolUse, createAssistantRateLimitMessage()]);
      queryMock.mockReturnValueOnce(failure).mockReturnValue(createMockQuery([createResultMessage({ result: 'unexpected retry' })]));

      const pending = new QueryExecutor().execute('prompt', { cwd: '/tmp/project' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ success: false, content: '', errorKind: 'rate_limit' });
      expect(queryMock).toHaveBeenCalledOnce();
    },
  );

  it('本文中のtool_use文字列だけなら429を再試行する', async () => {
    queryMock.mockReturnValueOnce(createMockQuery([
      createAssistantTextMessage('The literal string tool_use appears here.'),
      createAssistantRateLimitMessage(),
    ])).mockReturnValueOnce(createMockQuery([createResultMessage({ result: 'final answer' })]));

    const pending = new QueryExecutor().execute('prompt', { cwd: '/tmp/project' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ success: true, content: 'final answer' });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it.each(['exception', 'result', 'assistant', 'rate_limit_event'] as const)(
    '%s の429を2回再試行し実行制約と成功結果を保持する', async (channel) => {
      const makeFailure = () => {
        if (channel === 'exception') return createMockQuery([], new Error('HTTP 429: Too Many Requests'));
        if (channel === 'result') return createMockQuery([createResultMessage({
          subtype: 'error_during_execution', is_error: true, errors: ['HTTP 429: Too Many Requests'],
        })]);
        if (channel === 'assistant') return createMockQuery([createAssistantRateLimitMessage()]);
        return createMockQuery([{
          type: 'rate_limit_event', session_id: 'failed-session', uuid: 'throttled',
          rate_limit_info: { status: 'rejected' },
        }]);
      };
      queryMock.mockReturnValueOnce(makeFailure()).mockReturnValueOnce(makeFailure()).mockReturnValueOnce(
        createMockQuery([createAssistantTextMessage('final answer'), createResultMessage({
          result: 'final answer', session_id: 'final-session', structured_output: { ok: true },
        })]),
      );
      const activeBefore = getActiveQueryCount();
      const onStream = vi.fn();
      const options: ClaudeSpawnOptions = {
        cwd: '/tmp/project', model: 'sonnet', sessionId: 'original-session',
        permissionMode: 'readonly', allowedTools: ['Read'], skillsEnabled: false,
        outputSchema: { type: 'object' }, mcpServers: { test: { command: 'node', args: ['mcp.js'] } },
        onStream,
      };
      const pending = new QueryExecutor().execute('original prompt', options);
      await vi.advanceTimersByTimeAsync(999);
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(getActiveQueryCount()).toBe(activeBefore);
      expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(queryMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(queryMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({
        success: true, content: 'final answer', sessionId: 'final-session', structuredOutput: { ok: true },
      });
      expect(queryMock).toHaveBeenCalledTimes(3);
      expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(1);
      expect(getActiveQueryCount()).toBe(activeBefore);
      for (const [request] of queryMock.mock.calls) {
        expect(request.prompt).toBe('original prompt');
        expect(request.options).toMatchObject({
          cwd: '/tmp/project', model: 'sonnet', resume: 'original-session',
          allowedTools: ['Read'], skills: [], outputFormat: { type: 'json_schema', schema: options.outputSchema },
          mcpServers: options.mcpServers,
        });
        expect(request.options.permissionMode).not.toBe('bypassPermissions');
      }
    },
  );

  it.each([
    'usage_limit_exceeded',
    'HTTP 429: Your workspace is out of credits. Add credits to continue.',
    'You hit your spend cap set in your workspace. Increase your spend cap to continue. HTTP 429',
  ])('失敗resultの使い切りは再試行しない: %s', async (message) => {
    queryMock.mockReturnValue(createMockQuery([createResultMessage({
      subtype: 'error_during_execution', is_error: true, errors: [message],
    })]));
    const result = await new QueryExecutor().execute('prompt', { cwd: '/tmp/project', sessionId: 'resume' });
    expect(result).toMatchObject({ success: false, content: '', errorKind: 'rate_limit' });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('429の再試行中に使い切りを受けたら追加queryを作らない', async () => {
    queryMock.mockReturnValueOnce(createMockQuery([], new Error('HTTP 429: Too Many Requests')))
      .mockReturnValue(createMockQuery([createRateLimitEventMessage({ status: 'rejected' })]));
    const pending = new QueryExecutor().execute('prompt', { cwd: '/tmp/project' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ success: false, errorKind: 'rate_limit' });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('429の待機中に中断したらqueryを追加せず登録を解放する', async () => {
    queryMock.mockReturnValue(createMockQuery([], new Error('HTTP 429: Too Many Requests')));
    const controller = new AbortController();
    const activeBefore = getActiveQueryCount();
    const pending = new QueryExecutor().execute('prompt', { cwd: '/tmp/project', abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await pending).toMatchObject({ success: false, interrupted: true });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(getActiveQueryCount()).toBe(activeBefore);
  });
});

describe('QueryExecutor rate limit cause preservation', () => {
  it('通常のis_error resultに含まれる既存の構造化出力を保持する', async () => {
    queryMock.mockReturnValue(createMockQuery([createResultMessage({
      is_error: true, result: 'partial answer', structured_output: { partial: true },
    })]));
    const result = await new QueryExecutor().execute('prompt', { cwd: '/tmp/project' });
    expect(result).toMatchObject({ success: false, content: 'partial answer', structuredOutput: { partial: true } });
    expect(result.errorKind).toBeUndefined();
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it('is_error resultの429は予算後の終端イベントでも失敗として返す', async () => {
    vi.useFakeTimers();
    queryMock.mockReturnValue(createMockQuery([createResultMessage({ is_error: true, result: 'HTTP 429: Too Many Requests' })]));
    const onStream = vi.fn();
    const pending = new QueryExecutor().execute('prompt', { cwd: '/tmp/project', onStream });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await pending).toMatchObject({ success: false, content: '', errorKind: 'rate_limit' });
    expect(queryMock).toHaveBeenCalledTimes(9);
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(1);
    expect(onStream).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'result', data: expect.objectContaining({
      result: '', success: false, error: 'HTTP 429: Too Many Requests',
    }) }));
    vi.useRealTimers();
  });

  it('api_error_statusだけの429を再試行して成功する', async () => {
    vi.useFakeTimers();
    queryMock.mockReturnValueOnce(createMockQuery([createResultMessage({ is_error: true, api_error_status: 429, result: 'request rejected' })]))
      .mockReturnValueOnce(createMockQuery([createResultMessage({ result: 'final answer' })]));
    const pending = new QueryExecutor().execute('prompt', { cwd: '/tmp/project' });
    await vi.advanceTimersByTimeAsync(999);
    expect(queryMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ success: true, content: 'final answer' });
    expect(queryMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('api_error_statusの429に使い切りが伴う場合は即終了する', async () => {
    queryMock.mockReturnValue(createMockQuery([createResultMessage({ is_error: true, api_error_status: 429, result: 'usage_limit_exceeded' })]));
    expect(await new QueryExecutor().execute('prompt', { cwd: '/tmp/project' })).toMatchObject({ success: false, errorKind: 'rate_limit' });
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it('成功resultのapi_error_statusは失敗入力として分類しない', async () => {
    queryMock.mockReturnValue(createMockQuery([createResultMessage({ is_error: false, api_error_status: 429, result: 'final answer' })]));
    expect(await new QueryExecutor().execute('prompt', { cwd: '/tmp/project' })).toMatchObject({ success: true, content: 'final answer' });
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it('本文の引用と後続の空のrate_limit属性を混同せず再試行する', async () => {
    vi.useFakeTimers();
    queryMock.mockReturnValueOnce(createMockQuery([
      createAssistantTextMessage('説明: usage_limit_exceeded'), createAssistantRateLimitMessage(),
    ])).mockReturnValueOnce(createMockQuery([createResultMessage({ result: 'final answer' })]));
    const pending = new QueryExecutor().execute('prompt', { cwd: '/tmp/project' });
    await vi.advanceTimersByTimeAsync(999);
    expect(queryMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ success: true, content: 'final answer' });
    expect(queryMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
  it('最終result callbackの失敗を応答に保持してquery登録を解放する', async () => {
    const activeBefore = getActiveQueryCount();
    queryMock.mockReturnValue(createMockQuery([createResultMessage({ result: 'done' })]));
    const result = await new QueryExecutor().execute('prompt', { cwd: '/tmp/project', onStream: (event) => {
      if (event.type === 'result') throw new Error('stream callback failed');
    } });
    expect(result).toMatchObject({ success: false, error: 'stream callback failed' });
    expect(queryMock).toHaveBeenCalledOnce();
    expect(getActiveQueryCount()).toBe(activeBefore);
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('assistant.error の rate_limit は8回再試行後に exit code 1 より優先する', async () => {
    vi.useFakeTimers();
    // Given
    queryMock.mockReturnValue(
      createMockQuery([createAssistantRateLimitMessage()], new Error(EXIT_CODE_MESSAGE)),
    );
    const executor = new QueryExecutor();

    // When
    const pending = executor.execute('test prompt', { cwd: '/tmp/project' });
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await pending;

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBe(RATE_LIMIT_MESSAGE);
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(9);
  });

  it('rate_limit_event が観測された場合は SDK event の詳細を返す', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createRateLimitEventMessage({ status: 'rejected' }),
      ], new Error(EXIT_CODE_MESSAGE)),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toContain('Claude SDK rate limit event: status=rejected');
    expect(result.error).toContain('overageDisabledReason=out_of_credits');
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('status=allowed なら overageStatus=rejected でも rate_limit 扱いせずリクエストを完走させる', async () => {
    // overage 未提供の組織では overageStatus が恒常的に 'rejected' になるが、
    // ベース status が 'allowed' であればリクエストは成功するため rate_limit ではない。
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createRateLimitEventMessage({
          status: 'allowed',
          overageStatus: 'rejected',
        }),
        createAssistantTextMessage('ok'),
        createResultMessage({ subtype: 'success', result: 'ok' }),
      ]),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(true);
    expect(result.content).toBe('ok');
    expect(result.errorKind).toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('status=rejected でも overageStatus=allowed なら overage で救済されるので rate_limit 扱いしない', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createRateLimitEventMessage({
          status: 'rejected',
          overageStatus: 'allowed',
        }),
        createAssistantTextMessage('ok'),
        createResultMessage({ subtype: 'success', result: 'ok' }),
      ]),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(true);
    expect(result.content).toBe('ok');
    expect(result.errorKind).toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('Claude response の result 文面が rate limit を示す場合はその文面を返す', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createResultMessage({
          subtype: 'error',
          result: "You're out of extra usage. Please retry later.",
        }),
      ], new Error(EXIT_CODE_MESSAGE)),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBe("You're out of extra usage. Please retry later.");
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('Claude SDK の HTTP 429 は8回の待機後に sdk_error の rate_limited を返す', async () => {
    vi.useFakeTimers();
    // Given
    queryMock.mockReturnValue(
      createMockQuery([], new Error('HTTP 429: rate limit exceeded')),
    );
    const executor = new QueryExecutor();

    // When
    const pending = executor.execute('test prompt', { cwd: '/tmp/project' });
    await vi.advanceTimersByTimeAsync(0);
    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(queryMock).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(queryMock).toHaveBeenCalledTimes(index + 2);
    }
    const result = await pending;

    // Then
    expect(result.success).toBe(false);
    expect(result.content).toBe('');
    expect(result.error).toBe('HTTP 429: rate limit exceeded');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.rateLimitInfo?.source).toBe('sdk_error');
    expect(queryMock).toHaveBeenCalledTimes(9);
  });

  it('assistant text のみで rate limit が示された場合はその文面を返す', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createAssistantTextMessage("You're out of extra usage. Please retry later."),
      ], new Error(EXIT_CODE_MESSAGE)),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBe("You're out of extra usage. Please retry later.");
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('assistant text の一般的な rate limit / 429 記述は rate_limited にしない', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createAssistantTextMessage('Documented rate limit fallback behavior for issue 429.'),
        createResultMessage({
          subtype: 'success',
          result: 'Documented rate limit fallback behavior for issue 429.',
        }),
      ]),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(true);
    expect(result.content).toBe('Documented rate limit fallback behavior for issue 429.');
    expect(result.errorKind).toBeUndefined();
  });

  it('assistant text が通知文を引用しているだけなら rate_limited にしない', async () => {
    // Given: ファイル内容の報告に rate limit 通知と同じ語が含まれる (#1674)
    const reply = 'marker.txt の内容: このリポジトリの検出パターンは usage_limit_exceeded です。';
    queryMock.mockReturnValue(
      createMockQuery([
        createAssistantTextMessage(reply),
        createResultMessage({ subtype: 'success', result: reply }),
      ]),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(true);
    expect(result.content).toBe(reply);
    expect(result.errorKind).toBeUndefined();
    expect(result.rateLimitInfo).toBeUndefined();
  });

  it('複数行の assistant text の一部が通知文と同じ形でも rate_limited にしない', async () => {
    // Given: 通知文を 1 行まるごと引用した上で説明を続けている
    const reply = [
      'Claude CLI は上限到達時に次の文面を返します。',
      "You're out of extra usage · resets 2:30pm (Asia/Tokyo)",
      'この文面を検出対象に追加してください。',
    ].join('\n');
    queryMock.mockReturnValue(
      createMockQuery([
        createAssistantTextMessage(reply),
        createResultMessage({ subtype: 'success', result: reply }),
      ]),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(true);
    expect(result.errorKind).toBeUndefined();
  });

  it('前の assistant message が通常の本文でも、後続の通知文だけの message は rate_limited として検出する', async () => {
    // Given: 通常の応答の後に通知文が単独 message として届く
    const query = createMockQueryThatFailsAfterFirstMessage(
      createAssistantTextMessage("You're out of extra usage · resets 2:30pm (Asia/Tokyo)"),
      [createAssistantTextMessage('ファイルを確認しています。')],
    );
    queryMock.mockReturnValue(query);
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBe("You're out of extra usage · resets 2:30pm (Asia/Tokyo)");
    expect(result.errorKind).toBe('rate_limit');
    expect(result.rateLimitInfo?.source).toBe('stream_marker');
  });

  it('stream 本文の rate limit マーカーを検出した時点で購読を打ち切り rate_limited として返す', async () => {
    // Given
    const query = createMockQueryThatFailsAfterFirstMessage(
      createAssistantTextMessage("You're out of extra usage · resets 2:30pm (Asia/Tokyo)"),
    );
    queryMock.mockReturnValue(query);
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.content).toBe('');
    expect(result.error).toBe("You're out of extra usage · resets 2:30pm (Asia/Tokyo)");
    expect(result.errorKind).toBe('rate_limit');
    expect(query.state.afterMarkerPulled).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('sessionId 付きの一時的な RateLimit は resume を保持して8回再試行する', async () => {
    vi.useFakeTimers();
    // Given
    queryMock.mockImplementation(() => (
      createMockQuery([createAssistantRateLimitMessage()], new Error(EXIT_CODE_MESSAGE))
    ));
    const executor = new QueryExecutor();

    // When
    const pending = executor.execute('test prompt', {
      cwd: '/tmp/project',
      sessionId: 'resume-session-1',
    });
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await pending;

    // Then
    expect(result.error).toBe(RATE_LIMIT_MESSAGE);
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(9);
    for (const [request] of queryMock.mock.calls) {
      expect(request.options.resume).toBe('resume-session-1');
    }
  });

  it('sessionId 付き実行で rejected の rate_limit_event を観測した場合も no-resume retry を行わない', async () => {
    // Given
    queryMock.mockImplementation(() => (
      createMockQuery([
        createRateLimitEventMessage({ status: 'rejected' }),
      ], new Error(EXIT_CODE_MESSAGE))
    ));
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', {
      cwd: '/tmp/project',
      sessionId: 'resume-session-1',
    });

    // Then
    expect(result.error).toContain('Claude SDK rate limit event: status=rejected');
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(
      (queryMock.mock.calls[0]?.[0] as { options?: { resume?: string } }).options?.resume,
    ).toBe('resume-session-1');
  });

  it('RateLimit シグナルがない generic exit code error は既存どおり no-resume retry する', async () => {
    // Given
    queryMock.mockImplementation(() => createMockQuery([], new Error(EXIT_CODE_MESSAGE)));
    const executor = new QueryExecutor();
    const onActivity = vi.fn();

    // When
    const result = await executor.execute('test prompt', {
      cwd: '/tmp/project',
      sessionId: 'resume-session-1',
      onActivity,
    });

    // Then
    expect(result.error).toBe(EXIT_CODE_MESSAGE);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(onActivity).toHaveBeenNthCalledWith(1, { kind: 'attempt_started' });
    expect(onActivity).toHaveBeenNthCalledWith(2, { kind: 'attempt_started' });
    expect(onActivity.mock.invocationCallOrder[1]).toBeLessThan(
      queryMock.mock.invocationCallOrder[1]!,
    );
    expect(
      (queryMock.mock.calls[0]?.[0] as { options?: { resume?: string } }).options?.resume,
    ).toBe('resume-session-1');
    expect(
      (queryMock.mock.calls[1]?.[0] as { options?: { resume?: string } }).options?.resume,
    ).toBeUndefined();
  });

  it('tool_use後のexit code errorではsessionを外して同じpromptを再実行しない', async () => {
    const toolUse = {
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'touch marker' } }] },
      session_id: 'resume-session-1',
    };
    queryMock.mockReturnValueOnce(createMockQuery([toolUse], new Error(EXIT_CODE_MESSAGE)))
      .mockImplementation(() => { throw new Error('unexpected retry'); });
    const onActivity = vi.fn();

    const result = await new QueryExecutor().execute('prompt', {
      cwd: '/tmp/project', sessionId: 'resume-session-1', onActivity,
    });

    expect(result).toMatchObject({ success: false, content: '', error: EXIT_CODE_MESSAGE });
    expect(queryMock).toHaveBeenCalledOnce();
    expect(queryMock.mock.calls[0]?.[0].options.resume).toBe('resume-session-1');
    expect(onActivity).toHaveBeenCalledOnce();
  });

  it('Skills 無効の resume 失敗を再試行するときも、SDK の空の Skill allowlist を維持する', async () => {
    queryMock.mockImplementation(() => createMockQuery([], new Error(EXIT_CODE_MESSAGE)));
    const executor = new QueryExecutor();

    await executor.execute('test prompt', {
      cwd: '/tmp/project',
      sessionId: 'resume-session-1',
      skillsEnabled: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect((queryMock.mock.calls[0]?.[0] as { options?: { skills?: unknown } }).options?.skills).toEqual([]);
    expect((queryMock.mock.calls[1]?.[0] as { options?: { skills?: unknown } }).options?.skills).toEqual([]);
  });

  it.each([
    ['allowed', 'allowed'],
    ['allowed_warning', 'allowed_warning'],
    ['allowed', 'allowed_warning'],
    // overage 未提供のため overageStatus が恒常的に rejected だが、ベースは通っている
    ['allowed', 'rejected'],
    ['allowed_warning', 'rejected'],
    // ベースは超過しているが overage で救済される
    ['rejected', 'allowed'],
    ['rejected', 'allowed_warning'],
  ] as const)(
    'rate_limit_event status=%s overageStatus=%s は失敗扱いせず generic error と no-resume retry を維持する',
    async (status, overageStatus) => {
      // Given
      queryMock.mockImplementation(() => (
        createMockQuery([
          createRateLimitEventMessage({ status, overageStatus }),
        ], new Error(EXIT_CODE_MESSAGE))
      ));
      const executor = new QueryExecutor();

      // When
      const result = await executor.execute('test prompt', {
        cwd: '/tmp/project',
        sessionId: 'resume-session-1',
      });

      // Then
      expect(result.error).toBe(EXIT_CODE_MESSAGE);
      expect(result.errorKind).toBeUndefined();
      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(
        (queryMock.mock.calls[0]?.[0] as { options?: { resume?: string } }).options?.resume,
      ).toBe('resume-session-1');
      expect(
        (queryMock.mock.calls[1]?.[0] as { options?: { resume?: string } }).options?.resume,
      ).toBeUndefined();
    },
  );
});

describe('sdkMessageToStreamEvent', () => {
  it.each([
    { name: 'multiple blocks', metadata: {}, ids: ['A', 'B'], expected: { id: 'A', completedToolIds: ['A', 'B'] } },
    { name: 'reversed blocks', metadata: {}, ids: ['B', 'A'], expected: { id: 'B', completedToolIds: ['B', 'A'] } },
    { name: 'metadata before blocks', metadata: { tool_use_id: 'C', toolUseId: 'ignored' }, ids: ['A', 'B'], expected: { id: 'C', completedToolIds: ['C', 'A', 'B'] } },
    { name: 'camel case metadata', metadata: { toolUseId: 'B' }, ids: ['A', 'B'], expected: { id: 'B', completedToolIds: ['B', 'A'] } },
    { name: 'duplicate ids', metadata: { tool_use_id: 'A' }, ids: ['A', 'A'], expected: { id: 'A' } },
    { name: 'single block', metadata: {}, ids: ['A'], expected: { id: 'A' } },
    { name: 'no ids', metadata: {}, ids: [], expected: {} },
  ])('should preserve the result fields and emit one event for $name', ({ metadata, ids, expected }) => {
    const callback = vi.fn<(event: StreamEvent) => void>();
    const message: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'B' })),
      },
      tool_use_result: { ...metadata, stdout: 'normal output', stderr: 'failed output', is_error: true },
      session_id: 'session-1',
      parent_tool_use_id: null,
    };

    sdkMessageToStreamEvent(message, callback, true);

    expect(callback.mock.calls).toEqual([[{
      type: 'tool_result',
      data: { ...expected, content: 'failed output', isError: true },
    }]]);
  });

  it.each([undefined, null, { content: 'result body' }])('should preserve tool_use_result presence and content handling for %j', (toolUseResult) => {
    const callback = vi.fn<(event: StreamEvent) => void>();
    const message: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'A', content: 'first' },
          { type: 'tool_result', tool_use_id: 'B', content: 'second' },
        ],
      },
      tool_use_result: toolUseResult,
      session_id: 'session-1',
      parent_tool_use_id: null,
    };

    sdkMessageToStreamEvent(message, callback, true);

    expect(callback.mock.calls).toEqual(toolUseResult === undefined ? [] : [[{
      type: 'tool_result',
      data: { id: 'A', completedToolIds: ['A', 'B'], content: toolUseResult === null ? '' : 'result body', isError: false },
    }]]);
  });

  it('assistant.error を assistant_error イベントとして流す', () => {
    const callback = vi.fn<(event: StreamEvent) => void>();

    sdkMessageToStreamEvent(
      {
        type: 'assistant',
        message: { content: [] },
        error: 'rate_limit',
        uuid: 'uuid-1',
        session_id: 'session-1',
        parent_tool_use_id: null,
      } as unknown as Parameters<typeof sdkMessageToStreamEvent>[0],
      callback,
      true,
    );

    expect(callback).toHaveBeenCalledWith({
      type: 'assistant_error',
      data: {
        error: 'rate_limit',
        sessionId: 'session-1',
      },
    });
  });

  it('rate_limit_event を rate_limit イベントとして流す', () => {
    const callback = vi.fn<(event: StreamEvent) => void>();

    sdkMessageToStreamEvent(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          overageDisabledReason: 'out_of_credits',
          resetsAt: 1775059200,
          overageResetsAt: 1775059200,
          isUsingOverage: false,
        },
        uuid: 'uuid-2',
        session_id: 'session-2',
      } as unknown as Parameters<typeof sdkMessageToStreamEvent>[0],
      callback,
      true,
    );

    expect(callback).toHaveBeenCalledWith({
      type: 'rate_limit',
      data: {
        sessionId: 'session-2',
        status: 'rejected',
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'out_of_credits',
        resetsAt: 1775059200,
        overageResetsAt: 1775059200,
        isUsingOverage: false,
      },
    });
  });
});
