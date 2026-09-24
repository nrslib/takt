import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionMode } from '../core/models/index.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { createOpenCodeServerStartMock } from './helpers/opencode-server-process-test-helpers.js';
import {
  MockEventStream,
  sessionIdle,
  successfulSessionAbort,
} from './helpers/opencode-client-test-helpers.js';

const { createOpencodeMock, execFileMock, startOpenCodeServerMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
  execFileMock: vi.fn(),
  startOpenCodeServerMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

vi.mock('node:net', () => ({
  createServer: () => ({
    unref: vi.fn(),
    on: vi.fn(),
    listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
    address: vi.fn(() => ({ port: 62000 })),
    close: vi.fn((callback?: (error?: Error) => void) => callback?.()),
  }),
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

vi.mock('../infra/opencode/server-process.js', () => ({
  startOpenCodeServer: startOpenCodeServerMock,
}));

const OPEN_CODE_TASK_STATE_TOOLS = [
  'takt_takt_list_tasks',
  'takt_takt_get_run',
] as const;
const OPEN_CODE_TASK_STATE_WRITE_TOOLS = [
  'takt_takt_enqueue_task',
  'takt_takt_tell_run',
] as const;
const UNKNOWN_PERMISSION = 'takt_unknown_tool';

type OpenCodePermissionRule = {
  permission: string;
  pattern: string;
  action: string;
};

type OpenCodeClientMock = {
  sessionCreate: ReturnType<typeof vi.fn>;
  promptAsync: ReturnType<typeof vi.fn>;
  permissionReply: ReturnType<typeof vi.fn>;
};

function createPlan(
  projectCwd: string,
  permissionMode?: PermissionMode,
  sessionId?: string,
) {
  return createAssistantConversationPlan(projectCwd, {
    assistantMode: 'assistant',
    formalSpec: false,
    formalSpecComments: true,
    modelCheckTimeoutSeconds: 300,
    resolvedSessionContext: {
      provider: new OpenCodeProvider(),
      providerType: 'opencode',
      model: 'opencode/big-pickle',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
      ...(permissionMode === undefined ? {} : { permissionMode }),
    },
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

function createOpenCodeClientMock(
  sessionId: string,
  permissions: readonly string[],
): OpenCodeClientMock {
  const permissionEvents = permissions.map((permission, index) => ({
    type: 'permission.asked',
    properties: {
      id: `permission-${index}`,
      permission,
      patterns: ['*'],
      always: [],
    },
  }));
  const stream = new MockEventStream([...permissionEvents, sessionIdle(sessionId)], sessionId);
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const permissionReply = vi.fn().mockResolvedValue({ data: true });
  const client = {
    instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
    session: {
      create: sessionCreate,
      promptAsync,
      abort: successfulSessionAbort(),
    },
    event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
    permission: { reply: permissionReply },
  };

  createOpencodeMock.mockResolvedValue({
    client,
    server: { close: vi.fn() },
  });

  return { sessionCreate, promptAsync, permissionReply };
}

function getPermissionRule(
  rules: readonly OpenCodePermissionRule[],
  permission: string,
): OpenCodePermissionRule | undefined {
  return rules.find((rule) => rule.permission === permission);
}

function getFirstOpenCodeStartConfig(): Record<string, unknown> {
  const options = createOpencodeMock.mock.calls[0]?.[0] as { config?: Record<string, unknown> } | undefined;
  if (options?.config === undefined) {
    throw new Error('OpenCode server start was not observed');
  }
  return options.config;
}

describe('OpenCode task-state MCP integration', () => {
  let projectCwd: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        callback(null, '1.17.18\n', '');
      }
      return undefined;
    });
    startOpenCodeServerMock.mockImplementation(createOpenCodeServerStartMock(createOpencodeMock));
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();
  });

  afterEach(async () => {
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();
    if (projectCwd !== undefined) {
      rmSync(projectCwd, { recursive: true, force: true });
      projectCwd = undefined;
    }
  });

  it.each([
    { name: 'default mode', mode: undefined, expectedReply: 'once' },
    { name: 'readonly mode', mode: 'readonly' as const, expectedReply: 'once' },
    { name: 'edit mode', mode: 'edit' as const, expectedReply: 'once' },
    { name: 'full mode', mode: 'full' as const, expectedReply: 'always' },
  ])('propagates task-state permissions through OpenCode for $name', async ({ mode, expectedReply }) => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-opencode-task-state-mcp-'));
    const sessionId = `new-session-${mode ?? 'default'}`;
    const { sessionCreate, promptAsync, permissionReply } = createOpenCodeClientMock(
      sessionId,
      [...OPEN_CODE_TASK_STATE_TOOLS, ...OPEN_CODE_TASK_STATE_WRITE_TOOLS, UNKNOWN_PERMISSION],
    );
    const plan = createPlan(projectCwd, mode);

    expect(plan.ctx.provider).toBeInstanceOf(OpenCodeProvider);
    expect(plan.ctx.mcpServers).toBe(plan.ctx.taskStateMcpServers);

    const { result, error } = await callAIWithRetry(
      'inspect the current task state',
      plan.strategy.systemPrompt,
      plan.strategy.allowedTools,
      projectCwd,
      plan.ctx,
      { outputMode: 'silent', persistSession: false },
    );

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true, sessionId });

    const taskStateServer = plan.ctx.taskStateMcpServers?.takt;
    if (taskStateServer === undefined || taskStateServer.type !== 'stdio') {
      throw new Error('The assistant plan did not generate its trusted task-state server');
    }
    const config = getFirstOpenCodeStartConfig();
    const mcpConfig = config.mcp as Record<string, { type: string; command: string[] }>;
    expect(mcpConfig.takt).toEqual({
      type: 'local',
      command: [taskStateServer.command, ...(taskStateServer.args ?? [])],
    });

    const sessionOptions = sessionCreate.mock.calls[0]?.[0] as {
      permission: OpenCodePermissionRule[];
    } | undefined;
    expect(sessionOptions).toBeDefined();
    for (const tool of OPEN_CODE_TASK_STATE_TOOLS) {
      expect(getPermissionRule(sessionOptions!.permission, tool)).toEqual({
        permission: tool,
        pattern: '*',
        action: 'allow',
      });
    }
    for (const tool of OPEN_CODE_TASK_STATE_WRITE_TOOLS) {
      expect(getPermissionRule(sessionOptions!.permission, tool)).toBeUndefined();
    }

    const promptOptions = promptAsync.mock.calls[0]?.[0] as { tools: Record<string, boolean> } | undefined;
    expect(promptOptions).toBeDefined();
    for (const tool of OPEN_CODE_TASK_STATE_TOOLS) {
      expect(promptOptions!.tools[tool]).toBe(true);
    }
    for (const tool of OPEN_CODE_TASK_STATE_WRITE_TOOLS) {
      expect(Object.hasOwn(promptOptions!.tools, tool)).toBe(false);
    }

    expect(permissionReply.mock.calls.map(([request]) => request)).toEqual([
      { requestID: 'permission-0', directory: projectCwd, reply: expectedReply },
      { requestID: 'permission-1', directory: projectCwd, reply: expectedReply },
      { requestID: 'permission-2', directory: projectCwd, reply: 'reject' },
      { requestID: 'permission-3', directory: projectCwd, reply: 'reject' },
      { requestID: 'permission-4', directory: projectCwd, reply: 'reject' },
    ]);
    for (const call of permissionReply.mock.calls) {
      expect(call[1]).toEqual({ signal: expect.any(AbortSignal) });
    }
  });

  it('propagates task-state permissions through an existing OpenCode session', async () => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-opencode-task-state-mcp-'));
    const sessionId = 'resumed-session';
    const { sessionCreate, promptAsync, permissionReply } = createOpenCodeClientMock(
      sessionId,
      ['takt_takt_get_run', 'takt_takt_enqueue_task', UNKNOWN_PERMISSION],
    );
    const plan = createPlan(projectCwd, 'readonly', sessionId);

    const { result, error } = await callAIWithRetry(
      'inspect the resumed task state',
      plan.strategy.systemPrompt,
      plan.strategy.allowedTools,
      projectCwd,
      plan.ctx,
      { outputMode: 'silent', persistSession: false },
    );

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true, sessionId });
    expect(sessionCreate).not.toHaveBeenCalled();

    const promptOptions = promptAsync.mock.calls[0]?.[0] as {
      sessionID: string;
      tools: Record<string, boolean>;
    } | undefined;
    expect(promptOptions?.sessionID).toBe(sessionId);
    expect(promptOptions?.tools.takt_takt_list_tasks).toBe(true);
    expect(promptOptions?.tools.takt_takt_get_run).toBe(true);
    expect(Object.hasOwn(promptOptions?.tools ?? {}, 'takt_takt_enqueue_task')).toBe(false);
    expect(permissionReply.mock.calls.map(([request]) => request)).toEqual([
      { requestID: 'permission-0', directory: projectCwd, reply: 'once' },
      { requestID: 'permission-1', directory: projectCwd, reply: 'reject' },
      { requestID: 'permission-2', directory: projectCwd, reply: 'reject' },
    ]);
  });
});
