import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { McpAssignmentSection } from '../infra/config/runtime-provider/mcp-assignment.js';
import type { AgentResponse, PermissionMode } from '../core/models/index.js';
import { createTaktMcpServer } from '../app/mcp/server.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import { extractRetrySelectionAgreement } from '../features/interactive/retrySelectionAgreement.js';
import type { Provider, ProviderAgent, ProviderCallOptions, ProviderType } from '../infra/providers/types.js';
import { DebugLogger } from '../shared/utils/debug.js';

function createFakeProvider(
  providerCall: ProviderAgent['call'],
): { provider: Provider; providerCall: ProviderAgent['call'] } {
  const agent: ProviderAgent = { call: providerCall };
  const provider: Provider = {
    supportsStructuredOutput: false,
    supportsNativeImageInput: false,
    supportedMcpTransports: new Set<'stdio' | 'sse' | 'http'>(['stdio']),
    getRuntimeInstructions: () => null,
    keepsAllowedToolWithoutEdit: () => true,
    setup: vi.fn(() => agent),
  };
  return { provider, providerCall };
}

function createGrillMePlan(projectCwd: string, provider: Provider, permissionMode?: PermissionMode) {
  return createAssistantConversationPlan(projectCwd, {
    assistantMode: 'grill-me',
    formalSpec: false,
    formalSpecComments: true,
    modelCheckTimeoutSeconds: 300,
    resolvedSessionContext: {
      provider,
      providerType: 'copilot',
      model: 'copilot-model',
      lang: 'en',
      personaName: 'grill-me-interactive',
      sessionId: undefined,
      ...(permissionMode === undefined ? {} : { permissionMode }),
    },
  });
}

function successfulResponse(): AgentResponse {
  return {
    persona: 'grill-me-interactive',
    status: 'done',
    content: 'copilot response',
    timestamp: new Date(),
  };
}

async function listTaktToolNames(toolSet: 'all' | 'read-only'): Promise<string[]> {
  const server = createTaktMcpServer({}, { toolSet });
  const client = new Client({ name: `takt-mcp-${toolSet}-test-client`, version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

function toClaudeMcpToolName(toolName: string): string {
  return `mcp__takt__${toolName}`;
}

function createInteractivePlan(
  projectCwd: string,
  provider: Provider,
  providerType: ProviderType,
  options: {
    assistantMode?: 'assistant' | 'grill-me';
    permissionMode?: PermissionMode;
    sessionId?: string;
  } = {},
) {
  return createAssistantConversationPlan(projectCwd, {
    assistantMode: options.assistantMode ?? 'assistant',
    formalSpec: false,
    formalSpecComments: true,
    modelCheckTimeoutSeconds: 300,
    resolvedSessionContext: {
      provider,
      providerType,
      model: `${providerType}-model`,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    },
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
}

describe('conversation task-state MCP integration', () => {
  let projectCwd: string | undefined;

  function writeRuntime(mcp: McpAssignmentSection): string {
    projectCwd = mkdtempSync(join(process.env.TAKT_CONFIG_DIR!, 'assistant-runtime-'));
    mkdirSync(join(projectCwd, '.takt'));
    writeFileSync(join(projectCwd, '.takt', 'runtime.yaml'), stringify({ version: 1, mcp }));
    return projectCwd;
  }

  const userServers = {
    backlog: { type: 'stdio' as const, command: 'backlog-fixture' },
    'takt-full': { type: 'stdio' as const, command: 'full-takt-fixture' },
    takt: { type: 'stdio' as const, command: 'user-takt-must-not-start' },
  };

  it.each(['assistant', 'grill-me'] as const)(
    'passes the assistant persona assignment to a provider turn in %s mode',
    async (assistantMode) => {
      const cwd = writeRuntime({ servers: userServers, targets: { personas: { assistant: { servers: ['backlog'] } } } });
      const providerCall = vi.fn(async (_prompt: string, _options: ProviderCallOptions): Promise<AgentResponse> => successfulResponse());
      const { provider } = createFakeProvider(providerCall);
      const plan = createInteractivePlan(cwd, provider, 'claude-sdk', { assistantMode });

      const outcome = await callAIWithRetry('read and register issues', plan.strategy.systemPrompt, plan.strategy.allowedTools,
        cwd, plan.ctx, { outputMode: 'silent', persistSession: false });

      expect(outcome.result?.success).toBe(true);
      const options = providerCall.mock.calls[0]![1] as ProviderCallOptions;
      expect(Object.keys(options.mcpServers!).sort()).toEqual(['backlog', 'takt']);
      expect(options.mcpServers!.backlog).toEqual(userServers.backlog);
      expect(options.allowedTools).toEqual(expect.arrayContaining(['mcp__backlog',
        'mcp__takt__takt_list_tasks', 'mcp__takt__takt_get_run',
        'mcp__takt__takt_list_goals', 'mcp__takt__takt_get_goal']));
      expect(options.allowedTools?.filter((tool) => tool === 'mcp__takt' || tool.startsWith('mcp__takt__')).sort())
        .toEqual(['mcp__takt__takt_get_goal', 'mcp__takt__takt_get_run', 'mcp__takt__takt_list_goals', 'mcp__takt__takt_list_tasks']);
    },
  );

  it.each([
    { name: 'defaults without an assistant target', defaults: { servers: ['backlog'] }, targets: {}, expected: ['backlog', 'takt'] },
    { name: 'the union of defaults and assistant additions', defaults: { servers: ['backlog'] },
      targets: { personas: { assistant: { servers: ['backlog', 'takt-full'] } } }, expected: ['backlog', 'takt', 'takt-full'] },
    { name: 'assistant exclusions over both additions', defaults: { servers: ['backlog', 'takt-full'] },
      targets: { personas: { assistant: { servers: ['backlog'], exclude: ['backlog'] } } }, expected: ['takt', 'takt-full'] },
    { name: 'selector exclusions over both additions', defaults: { servers: ['backlog', 'takt-full'] },
      targets: { personas: { assistant: { servers: ['backlog'] } }, internal_agents: { selector: { exclude: ['backlog'] } } },
      expected: ['takt', 'takt-full'] },
  ] satisfies Array<{ name: string; defaults: McpAssignmentSection['defaults']; targets: McpAssignmentSection['targets']; expected: string[] }>)
    ('applies $name to the servers sent to the provider', async ({ defaults, targets, expected }) => {
      const cwd = writeRuntime({ servers: userServers, defaults, targets });
      const providerCall = vi.fn(async (_prompt: string, _options: ProviderCallOptions): Promise<AgentResponse> => successfulResponse());
      const { provider } = createFakeProvider(providerCall);
      const plan = createInteractivePlan(cwd, provider, 'claude-sdk');

      const outcome = await callAIWithRetry('prompt', plan.strategy.systemPrompt, plan.strategy.allowedTools,
        cwd, plan.ctx, { outputMode: 'silent', persistSession: false });

      expect(outcome.result?.success).toBe(true);
      const options = providerCall.mock.calls[0]![1];
      expect(Object.keys(options.mcpServers!).sort()).toEqual(expected);
      const permittedUserServers = options.allowedTools?.filter((tool) => tool === 'mcp__backlog' || tool === 'mcp__takt-full');
      expect(permittedUserServers?.sort()).toEqual(expected.filter((name) => name !== 'takt').map((name) => `mcp__${name}`).sort());
    });

  it.each(['assistant', 'grill-me'] as const)('ignores internal persona target names in %s mode', (assistantMode) => {
    const cwd = writeRuntime({ servers: userServers, targets: { personas: {
      interactive: { servers: ['backlog'] }, 'grill-me-interactive': { servers: ['backlog'] },
    } } });
    const { provider } = createFakeProvider(vi.fn(async () => successfulResponse()));
    const plan = createInteractivePlan(cwd, provider, 'claude-sdk', { assistantMode });
    expect(Object.keys(plan.ctx.mcpServers!)).toEqual(['takt']);
  });

  it('uses only the builtin read-only takt server when a user definition collides', async () => {
    const cwd = writeRuntime({ servers: userServers, defaults: { servers: ['backlog', 'takt'] } });
    const providerCall = vi.fn(async (_prompt: string, _options: ProviderCallOptions): Promise<AgentResponse> => successfulResponse());
    const { provider } = createFakeProvider(providerCall);
    const log = vi.spyOn(DebugLogger.prototype, 'writeLog');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const onNotice = vi.fn();
    try {
      const plan = createInteractivePlan(cwd, provider, 'claude-sdk');
      const outcome = await callAIWithRetry('inspect tasks', plan.strategy.systemPrompt, plan.strategy.allowedTools,
        cwd, plan.ctx, { outputMode: 'silent', persistSession: false, onNotice });

      expect(outcome.result?.success).toBe(true);
      const options = providerCall.mock.calls[0]![1];
      expect(Object.keys(options.mcpServers!).sort()).toEqual(['backlog', 'takt']);
      expect(options.mcpServers!.takt).toMatchObject({ command: process.execPath,
        args: [expect.any(String), '--tool-set', 'read-only', '--include-reference-markers'] });
      expect(options.allowedTools?.filter((tool) => tool === 'mcp__takt' || tool.startsWith('mcp__takt__')).sort())
        .toEqual(['mcp__takt__takt_get_goal', 'mcp__takt__takt_get_run', 'mcp__takt__takt_list_goals', 'mcp__takt__takt_list_tasks']);
      expect(plan.strategy.mcpUnavailableNotice).toBeUndefined();
      expect(onNotice).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('keeps builtin takt available when runtime exclusions name takt', () => {
    const cwd = writeRuntime({ servers: userServers, defaults: { servers: ['takt'] }, targets: {
      personas: { assistant: { exclude: ['takt'] } }, internal_agents: { selector: { exclude: ['takt'] } },
    } });
    const { provider } = createFakeProvider(vi.fn(async () => successfulResponse()));
    const plan = createInteractivePlan(cwd, provider, 'claude-sdk');
    expect(plan.ctx.mcpServers!.takt).toMatchObject({ command: process.execPath,
      args: [expect.any(String), '--tool-set', 'read-only', '--include-reference-markers'] });
  });

  it('rejects an assigned unsupported transport while creating a supported provider plan', () => {
    const cwd = writeRuntime({ servers: { backlog: { type: 'sse', url: 'https://example.test/mcp' } },
      targets: { personas: { assistant: { servers: ['backlog'] } } } });
    const providerCall = vi.fn(async () => successfulResponse());
    const { provider } = createFakeProvider(providerCall);
    expect(() => createInteractivePlan(cwd, provider, 'codex')).toThrow();
    expect(providerCall).not.toHaveBeenCalled();
  });

  it.each(['assistant', 'grill-me'] as const)('passes assigned servers to readonly Copilot in %s mode', async (assistantMode) => {
    const cwd = writeRuntime({ servers: userServers, targets: { personas: { assistant: { servers: ['backlog'] } } } });
    const providerCall = vi.fn(async (_prompt: string, options: ProviderCallOptions) => {
      expect(Object.keys(options.mcpServers!).sort()).toEqual(['backlog', 'takt']);
      const payload = JSON.parse(readFileSync(options.preparedMcp!.path!, 'utf8')) as { mcpServers: Record<string, { args?: string[] }> };
      expect(Object.keys(payload.mcpServers).sort()).toEqual(['backlog', 'takt']);
      expect(payload.mcpServers.takt!.args).toContain('read-only');
      return successfulResponse();
    });
    const { provider } = createFakeProvider(providerCall);
    const plan = createInteractivePlan(cwd, provider, 'copilot', { assistantMode, permissionMode: 'readonly' });
    const outcome = await callAIWithRetry('prompt', plan.strategy.systemPrompt, plan.strategy.allowedTools,
      cwd, plan.ctx, { outputMode: 'silent', persistSession: false });
    expect(outcome.result?.success).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(providerCall).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'without a user takt definition', defaults: undefined },
    { name: 'with a user takt definition that collides with the builtin', defaults: { servers: ['backlog', 'takt'] } },
  ] satisfies Array<{ name: string; defaults: McpAssignmentSection['defaults'] }>)(
    'approves every tool of assigned Codex user servers and only the builtin read-only takt tools $name',
    async ({ defaults }) => {
      for (const assistantMode of ['assistant', 'grill-me'] as const) {
        const cwd = writeRuntime({
          servers: userServers,
          ...(defaults === undefined ? {} : { defaults }),
          targets: { personas: { assistant: { servers: ['backlog', 'takt-full'] } } },
        });
        const providerCall = vi.fn(async (_prompt: string, _options: ProviderCallOptions): Promise<AgentResponse> => successfulResponse());
        const { provider } = createFakeProvider(providerCall);
        const plan = createInteractivePlan(cwd, provider, 'codex', { assistantMode });
        const outcome = await callAIWithRetry('prompt', plan.strategy.systemPrompt, plan.strategy.allowedTools,
          cwd, plan.ctx, { outputMode: 'silent', persistSession: false });

        expect(outcome.result?.success).toBe(true);
        const entries = providerCall.mock.calls[0]![1].preparedMcp!.config!.mcp_servers!;
        expect(Object.keys(entries).sort()).toEqual(['backlog', 'takt', 'takt-full']);
        for (const name of ['backlog', 'takt-full']) {
          expect(entries[name]).toMatchObject({ default_tools_approval_mode: 'approve' });
        }
        expect(entries.takt).not.toHaveProperty('default_tools_approval_mode');
        expect(entries.takt).toMatchObject({ args: expect.arrayContaining(['read-only']) });
        expect((entries.takt as { tools?: unknown }).tools).toEqual({
          takt_get_goal: { approval_mode: 'approve' },
          takt_get_run: { approval_mode: 'approve' },
          takt_list_goals: { approval_mode: 'approve' },
          takt_list_tasks: { approval_mode: 'approve' },
        });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it('drops both MCP server sets when extracting retry agreement after a configured conversation turn', async () => {
    const cwd = writeRuntime({ servers: userServers, targets: { personas: { assistant: { servers: ['backlog'] } } } });
    const providerCall = vi.fn(async (_prompt: string, _options: ProviderCallOptions): Promise<AgentResponse> => successfulResponse());
    const { provider } = createFakeProvider(providerCall);
    const plan = createInteractivePlan(cwd, provider, 'claude-sdk');
    const outcome = await callAIWithRetry('retry the task', plan.strategy.systemPrompt, plan.strategy.allowedTools,
      cwd, plan.ctx, { outputMode: 'silent', persistSession: false });
    expect(outcome.result?.success).toBe(true);
    expect(Object.keys(providerCall.mock.calls[0]![1].mcpServers!).sort()).toEqual(['backlog', 'takt']);

    await expect(extractRetrySelectionAgreement({ cwd, lang: 'en', sessionContext: plan.ctx,
      history: [{ role: 'user', content: 'retry the task' }] })).resolves.toBe('copilot response');

    const options = providerCall.mock.calls[1]![1];
    expect(options.mcpServers).toBeUndefined();
    expect(options.preparedMcp).toBeUndefined();
    expect(options.allowedTools).toEqual([]);
  });

  it.each(['pi', 'deepseek-harness'] as const)('continues a configured %s conversation with a notice and no MCP', async (providerType) => {
    const cwd = writeRuntime({ servers: userServers, targets: { personas: { assistant: { servers: ['backlog'] } } } });
    const providerCall = vi.fn(async (_prompt: string, _options: ProviderCallOptions): Promise<AgentResponse> => successfulResponse());
    const { provider } = createFakeProvider(providerCall);
    const plan = createInteractivePlan(cwd, provider, providerType);
    const outcome = await callAIWithRetry('prompt', plan.strategy.systemPrompt, plan.strategy.allowedTools,
      cwd, plan.ctx, { outputMode: 'silent', persistSession: false });

    expect(outcome.result?.success).toBe(true);
    expect(plan.strategy.mcpUnavailableNotice).toEqual(expect.stringContaining('does not support MCP servers'));
    const options = providerCall.mock.calls[0]![1];
    expect(options.mcpServers).toBeUndefined();
    expect(options.preparedMcp).toBeUndefined();
    expect(options.allowedTools?.filter((tool) => tool.startsWith('mcp__')) ?? []).toEqual([]);
  });

  afterEach(() => {
    if (projectCwd !== undefined) {
      rmSync(projectCwd, { recursive: true, force: true });
      projectCwd = undefined;
    }
  });

  it('passes the grill-me plan task-state server through the real Copilot adapter and cleans it up', async () => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-conversation-task-state-mcp-'));
    let configPathDuringCall: string | undefined;
    let configDirectoryDuringCall: string | undefined;
    const providerCall = vi.fn(async (_prompt: string, options: ProviderCallOptions) => {
      expect(options.permissionMode).toBe('readonly');
      expect(options.preparedMcp).toBeDefined();

      const prepared = options.preparedMcp!;
      const additionalConfigArg = prepared.args?.find((arg) => arg.startsWith('--additional-mcp-config=@'));
      configPathDuringCall = additionalConfigArg?.slice('--additional-mcp-config=@'.length);
      configDirectoryDuringCall = configPathDuringCall === undefined
        ? undefined
        : dirname(configPathDuringCall);
      expect(configPathDuringCall).toBe(prepared.path);
      expect(configPathDuringCall).toBeDefined();
      expect(existsSync(configPathDuringCall!)).toBe(true);

      const payload = JSON.parse(readFileSync(configPathDuringCall!, 'utf8')) as {
        mcpServers: Record<string, { command: string; args?: string[] }>;
      };
      expect(payload.mcpServers.takt).toMatchObject({
        command: process.execPath,
        args: [expect.any(String), '--tool-set', 'read-only', '--include-reference-markers'],
      });
      return successfulResponse();
    });
    const { provider } = createFakeProvider(providerCall);
    const plan = createGrillMePlan(projectCwd, provider, 'readonly');

    expect(plan.strategy.permissionMode).toBeUndefined();
    expect(plan.ctx.permissionMode).toBe('readonly');
    expect(plan.ctx.mcpServers?.takt).toMatchObject({
      type: 'stdio',
      command: process.execPath,
      args: [expect.any(String), '--tool-set', 'read-only', '--include-reference-markers'],
    });

    const { result, error } = await callAIWithRetry(
      'inspect the current task state',
      plan.strategy.systemPrompt,
      plan.strategy.allowedTools,
      projectCwd,
      plan.ctx,
      {
        outputMode: 'silent',
      },
    );

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true, content: 'copilot response' });
    expect(providerCall).toHaveBeenCalledOnce();
    expect(configPathDuringCall).toBeDefined();
    expect(existsSync(configPathDuringCall!)).toBe(false);
    expect(configDirectoryDuringCall).toBeDefined();
    expect(existsSync(configDirectoryDuringCall!)).toBe(false);
  });

  it('rejects an arbitrary readonly MCP record even when its arguments look read-only', async () => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-conversation-task-state-mcp-'));
    const providerCall = vi.fn(async (): Promise<AgentResponse> => successfulResponse());
    const { provider } = createFakeProvider(providerCall);
    const plan = createGrillMePlan(projectCwd, provider, 'readonly');
    const generatedServer = plan.ctx.mcpServers?.takt;
    if (generatedServer === undefined || generatedServer.type !== 'stdio') {
      throw new Error('The grill-me plan did not generate its stdio task-state server');
    }

    plan.ctx.mcpServers = {
      takt: {
        ...generatedServer,
        command: '/fixture/arbitrary-server',
      },
    };

    const outcome = await callAIWithRetry(
      'inspect the current task state',
      plan.strategy.systemPrompt,
      plan.strategy.allowedTools,
      projectCwd,
      plan.ctx,
      {
        outputMode: 'silent',
      },
    );

    expect(outcome.result).toBeNull();
    expect(outcome.error).toContain('readonly permission mode');
    expect(providerCall).not.toHaveBeenCalled();
  });

  it.each(['claude-sdk', 'claude', 'claude-terminal', 'opencode'] as const)(
    'passes only the generated task-state read-only tools to %s',
    async (providerType) => {
      projectCwd = mkdtempSync(join(tmpdir(), 'takt-conversation-task-state-mcp-'));
      const allToolNames = await listTaktToolNames('all');
      const readOnlyToolNames = await listTaktToolNames('read-only');
      const writeToolNames = allToolNames.filter((name) => !readOnlyToolNames.includes(name));
      const providerCall = vi.fn(async (_prompt: string, options: ProviderCallOptions) => {
        expect(options.mcpServers).toBeDefined();
        expect(options.preparedMcp).toBeDefined();
        expect(options.allowedTools).toEqual(expect.arrayContaining(
          readOnlyToolNames.map(toClaudeMcpToolName),
        ));
        expect(options.allowedTools).not.toEqual(expect.arrayContaining(
          writeToolNames.map(toClaudeMcpToolName),
        ));
        return successfulResponse();
      });
      const { provider } = createFakeProvider(providerCall);
      const plan = createInteractivePlan(projectCwd, provider, providerType);

      const { result, error } = await callAIWithRetry(
        'inspect the current task state',
        plan.strategy.systemPrompt,
        plan.strategy.allowedTools,
        projectCwd,
        plan.ctx,
        { outputMode: 'silent' },
      );

      expect(error).toBeUndefined();
      expect(result).toMatchObject({ success: true, content: 'copilot response' });
      expect(providerCall).toHaveBeenCalledOnce();
    },
  );

  it('does not derive task-state permissions from an untrusted server copy', async () => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-conversation-task-state-mcp-'));
    const readOnlyToolNames = await listTaktToolNames('read-only');
    const providerCall = vi.fn(async (_prompt: string, options: ProviderCallOptions) => {
      expect(options.allowedTools).not.toEqual(expect.arrayContaining(
        readOnlyToolNames.map(toClaudeMcpToolName),
      ));
      return successfulResponse();
    });
    const { provider } = createFakeProvider(providerCall);
    const plan = createInteractivePlan(projectCwd, provider, 'claude-sdk');
    const generatedServer = plan.ctx.mcpServers?.takt;
    if (generatedServer === undefined || generatedServer.type !== 'stdio') {
      throw new Error('The interactive plan did not generate its stdio task-state server');
    }
    plan.ctx.mcpServers = {
      takt: {
        ...generatedServer,
        command: '/fixture/arbitrary-server',
      },
    };

    const { result, error } = await callAIWithRetry(
      'inspect the current task state',
      plan.strategy.systemPrompt,
      plan.strategy.allowedTools,
      projectCwd,
      plan.ctx,
      { outputMode: 'silent' },
    );

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true });
    expect(providerCall).toHaveBeenCalledOnce();
  });

  it('does not pass task-state MCP or permissions to a strict-readonly attempt', async () => {
    projectCwd = writeRuntime({ servers: userServers, targets: { personas: { assistant: { servers: ['backlog'] } } } });
    const readOnlyToolNames = await listTaktToolNames('read-only');
    const providerCall = vi.fn(async (_prompt: string, options: ProviderCallOptions) => {
      expect(options.mcpServers).toBeUndefined();
      expect(options.preparedMcp).toBeUndefined();
      expect(options.allowedTools).not.toEqual(expect.arrayContaining(
        readOnlyToolNames.map(toClaudeMcpToolName),
      ));
      expect(options.allowedTools?.filter((tool) => tool.startsWith('mcp__')) ?? []).toEqual([]);
      return successfulResponse();
    });
    const { provider } = createFakeProvider(providerCall);
    const plan = createInteractivePlan(projectCwd, provider, 'claude-sdk');

    const { result, error } = await callAIWithRetry(
      'inspect the current task state',
      plan.strategy.systemPrompt,
      plan.strategy.allowedTools,
      projectCwd,
      plan.ctx,
      { internalAgentIsolation: 'strict-readonly', outputMode: 'silent' },
    );

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true });
    expect(providerCall).toHaveBeenCalledOnce();
  });

  it('retains task-state read-only permissions when retrying without a stale session', async () => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-conversation-task-state-mcp-'));
    const readOnlyToolNames = await listTaktToolNames('read-only');
    const capturedOptions: ProviderCallOptions[] = [];
    const providerCall = vi.fn(async (_prompt: string, options: ProviderCallOptions) => {
      capturedOptions.push(options);
      if (capturedOptions.length === 1) {
        return {
          ...successfulResponse(),
          status: 'blocked' as const,
          content: '',
          error: 'stale session',
          sessionId: 'stale-session',
        };
      }
      return { ...successfulResponse(), sessionId: 'new-session' };
    });
    const { provider } = createFakeProvider(providerCall);
    const plan = createInteractivePlan(projectCwd, provider, 'claude-sdk', { sessionId: 'stale-session' });

    const { result, error } = await callAIWithRetry(
      'inspect the current task state',
      plan.strategy.systemPrompt,
      plan.strategy.allowedTools,
      projectCwd,
      plan.ctx,
      { outputMode: 'silent' },
    );

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true, sessionId: 'new-session' });
    expect(providerCall).toHaveBeenCalledTimes(2);
    for (const options of capturedOptions) {
      expect(options.allowedTools).toEqual(expect.arrayContaining(
        readOnlyToolNames.map(toClaudeMcpToolName),
      ));
      expect(options.preparedMcp).toBeDefined();
    }
  });
});
vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  inspectProviderInstallation: vi.fn(async () => ({ state: 'ready', directory: '/test/managed' })),
}));
