vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
vi.mock('../infra/managed-providers/preflight.js', () => ({ checkManagedProviders: vi.fn(async () => undefined) }));
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { PermissionMode } from '../core/models/index.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import { connectManagerMcp } from '../features/manager/managerMcp.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { createOpenCodeServerStartMock } from './helpers/opencode-server-process-test-helpers.js';
import { MockEventStream, sessionIdle, successfulSessionAbort } from './helpers/opencode-client-test-helpers.js';

const { createOpencodeMock, execFileMock, startOpenCodeServerMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
  execFileMock: vi.fn(),
  startOpenCodeServerMock: vi.fn(),
}));

const managerMcp = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), transport: vi.fn(), transportClose: vi.fn(), callTool: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  connect = managerMcp.connect;
  close = managerMcp.close;
  callTool = managerMcp.callTool;
} }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {
  constructor(options: unknown) { managerMcp.transport(options); }
  close = managerMcp.transportClose;
} }));

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
  structuredOutput?: Record<string, unknown>,
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
  const stream = new MockEventStream([
    ...permissionEvents,
    ...(structuredOutput === undefined ? [] : [{
      type: 'message.updated',
      properties: { info: { sessionID: sessionId, role: 'assistant', structured: structuredOutput } },
    }]),
    sessionIdle(sessionId),
  ], sessionId);
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
    vi.stubEnv('TAKT_OPENCODE_VERSION', 'v1');
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
    vi.unstubAllEnvs();
    if (projectCwd !== undefined) {
      rmSync(projectCwd, { recursive: true, force: true });
      projectCwd = undefined;
    }
  });

  it('passes assigned user server permissions and builtin read tools through an assistant turn', async () => {
    projectCwd = mkdtempSync(join(process.env.TAKT_CONFIG_DIR!, 'assistant-opencode-mcp-'));
    mkdirSync(join(projectCwd, '.takt'));
    writeFileSync(join(projectCwd, '.takt', 'runtime.yaml'), stringify({ version: 1, mcp: {
      servers: { backlog: { type: 'stdio', command: 'backlog-fixture' },
        'takt-full': { type: 'stdio', command: 'full-takt-fixture' } },
      targets: { personas: { assistant: { servers: ['backlog', 'takt-full'] } } },
    } }));
    const permissions = ['backlog_get_issue', 'backlog_add_issue', 'takt-full_takt_enqueue_goal_task',
      'takt_takt_list_tasks', 'takt_takt_get_run', 'takt_takt_list_goals', 'takt_takt_get_goal',
      'takt_takt_enqueue_goal_task', 'other_get_issue'];
    const { sessionCreate, promptAsync, permissionReply } = createOpenCodeClientMock('assistant-user-mcp', permissions);
    const plan = createPlan(projectCwd);

    const outcome = await callAIWithRetry('read and register issues', plan.strategy.systemPrompt, plan.strategy.allowedTools,
      projectCwd, plan.ctx, { outputMode: 'silent', persistSession: false });

    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.success).toBe(true);
    const config = getFirstOpenCodeStartConfig().mcp as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(['backlog', 'takt', 'takt-full']);
    const rules = sessionCreate.mock.calls[0]![0].permission as OpenCodePermissionRule[];
    expect(getPermissionRule(rules, 'backlog_*')).toEqual({ permission: 'backlog_*', pattern: '*', action: 'allow' });
    expect(getPermissionRule(rules, 'takt-full_*')).toEqual({ permission: 'takt-full_*', pattern: '*', action: 'allow' });
    expect(getPermissionRule(rules, 'takt_*')).toBeUndefined();
    const tools = promptAsync.mock.calls[0]![0].tools as Record<string, boolean>;
    expect(tools).toMatchObject({ 'backlog_*': true, 'takt-full_*': true,
      takt_takt_list_tasks: true, takt_takt_get_run: true, takt_takt_list_goals: true, takt_takt_get_goal: true });
    expect(permissionReply.mock.calls.map(([request]) => request.reply)).toEqual([
      'once', 'once', 'once', 'once', 'once', 'once', 'once', 'reject', 'reject',
    ]);
  });

  it.each(['backlog__main', 'queue_'])(
    'grants every tool of the assigned server %s and rejects the tools of an unassigned similarly named server',
    async (serverName) => {
      projectCwd = mkdtempSync(join(process.env.TAKT_CONFIG_DIR!, 'assistant-opencode-mcp-name-'));
      mkdirSync(join(projectCwd, '.takt'));
      writeFileSync(join(projectCwd, '.takt', 'runtime.yaml'), stringify({ version: 1, mcp: {
        servers: { backlog: { type: 'stdio', command: 'backlog-fixture' },
          [serverName]: { type: 'stdio', command: 'named-fixture' } },
        targets: { personas: { assistant: { servers: [serverName] } } },
      } }));
      const permissions = [`${serverName}_get_issue`, `${serverName}_add_issue`,
        'backlog_get_issue', 'takt_takt_enqueue_goal_task', 'takt_takt_get_run'];
      const { sessionCreate, promptAsync, permissionReply } = createOpenCodeClientMock('assistant-named-mcp', permissions);
      const plan = createPlan(projectCwd);

      const outcome = await callAIWithRetry('read and register issues', plan.strategy.systemPrompt, plan.strategy.allowedTools,
        projectCwd, plan.ctx, { outputMode: 'silent', persistSession: false });

      expect(outcome.error).toBeUndefined();
      expect(outcome.result?.success).toBe(true);
      expect(Object.keys(getFirstOpenCodeStartConfig().mcp as Record<string, unknown>).sort())
        .toEqual([serverName, 'takt'].sort());
      const rules = sessionCreate.mock.calls[0]![0].permission as OpenCodePermissionRule[];
      expect(getPermissionRule(rules, `${serverName}_*`)).toEqual({ permission: `${serverName}_*`, pattern: '*', action: 'allow' });
      expect(rules.filter((rule) => rule.permission.startsWith(`${serverName}_`)).map((rule) => rule.permission))
        .toEqual([`${serverName}_*`]);
      expect(getPermissionRule(rules, 'backlog_*')).toBeUndefined();
      expect(getPermissionRule(rules, 'takt_*')).toBeUndefined();
      expect(rules.filter((rule) => rule.permission.startsWith('takt_')).map((rule) => rule.permission).sort())
        .toEqual(['takt_takt_get_goal', 'takt_takt_get_run', 'takt_takt_list_goals', 'takt_takt_list_tasks']);
      const tools = promptAsync.mock.calls[0]![0].tools as Record<string, boolean>;
      expect(tools[`${serverName}_*`]).toBe(true);
      expect(tools['backlog_*']).toBeUndefined();
      expect(permissionReply.mock.calls.map(([request]) => request.reply)).toEqual([
        'once', 'once', 'reject', 'reject', 'once',
      ]);
    },
  );

  it('starts the first manager turn with the actual MCP server name and connection settings', async () => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-opencode-manager-mcp-'));
    mkdirSync(join(projectCwd, '.takt'));
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), 'provider: opencode\nmodel: opencode/big-pickle\nlanguage: en\n');
    const connection = await connectManagerMcp(projectCwd);
    const [serverName] = Object.keys(connection.servers);
    if (serverName === undefined) throw new Error('Manager MCP did not return a server');
    expect(serverName).toContain('takt_mgr_');
    const server = connection.servers[serverName];
    if (server === undefined || server.type !== 'stdio' || server.args === undefined) {
      throw new Error('Manager MCP did not return a stdio command');
    }
    expect(managerMcp.connect).toHaveBeenCalledTimes(1);
    expect(managerMcp.transport).toHaveBeenCalledWith(expect.objectContaining({
      command: server.command, args: server.args, cwd: projectCwd,
    }));
    expect(server.args).toEqual(expect.arrayContaining(['--tool-set', 'manager']));

    const sessionId = 'manager-first-session';
    const { sessionCreate, promptAsync, permissionReply } = createOpenCodeClientMock(
      sessionId, ['bash', 'edit', 'webfetch'], { message: 'What is your goal?', summary: null },
    );
    const plan = createManagerConversationPlan(projectCwd, { language: 'en' });
    const executor = createManagerTurnExecutor(projectCwd, { ...plan, ctx: { ...plan.ctx, mcpServers: connection.servers } });
    try {
      expect(plan.ctx.provider).toBeInstanceOf(OpenCodeProvider);
      expect(await executor.execute({ prompt: 'ゴールを相談したい', instruction: 'ゴールを相談したい', sessionId: undefined,
        assignment: undefined, configDirectory: process.env.TAKT_CONFIG_DIR!, abortSignal: new AbortController().signal }))
        .toMatchObject({ message: 'What is your goal?', summary: null });

      expect(getFirstOpenCodeStartConfig().mcp).toEqual({
        [serverName]: {
          type: 'local', command: [server.command, ...server.args],
          environment: server.env,
        },
      });
      expect(server.env).toMatchObject({ TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR });
      expect(server.env).not.toHaveProperty('TAKT_MANAGER_GOAL_OWNERS');
      expect(sessionCreate).toHaveBeenCalledTimes(1);
      const sessionOptions = sessionCreate.mock.calls[0]![0] as { permission: OpenCodePermissionRule[] };
      expect(getPermissionRule(sessionOptions.permission, '*')).toEqual({ permission: '*', pattern: '*', action: 'allow' });
      expect(promptAsync).toHaveBeenCalledTimes(1);
      const promptOptions = promptAsync.mock.calls[0]![0] as { sessionID: string; tools: Record<string, boolean> };
      expect(promptOptions.sessionID).toBe(sessionId);
      expect(promptOptions.tools).toMatchObject({ read: true, bash: true, edit: true, webfetch: true });
      expect(permissionReply.mock.calls.map(([request]) => request.reply)).toEqual(['always', 'always', 'always']);
      expect(managerMcp.callTool).not.toHaveBeenCalled();
    } finally {
      await connection.dispose();
    }
    expect(managerMcp.close).toHaveBeenCalledTimes(1);
    expect(managerMcp.transportClose).toHaveBeenCalledTimes(1);
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
      { sessionID: sessionId, requestID: 'permission-0', directory: projectCwd, reply: expectedReply },
      { sessionID: sessionId, requestID: 'permission-1', directory: projectCwd, reply: expectedReply },
      { sessionID: sessionId, requestID: 'permission-2', directory: projectCwd, reply: 'reject' },
      { sessionID: sessionId, requestID: 'permission-3', directory: projectCwd, reply: 'reject' },
      { sessionID: sessionId, requestID: 'permission-4', directory: projectCwd, reply: 'reject' },
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
      { sessionID: 'resumed-session', requestID: 'permission-0', directory: projectCwd, reply: 'once' },
      { sessionID: 'resumed-session', requestID: 'permission-1', directory: projectCwd, reply: 'reject' },
      { sessionID: 'resumed-session', requestID: 'permission-2', directory: projectCwd, reply: 'reject' },
    ]);
  });
});
