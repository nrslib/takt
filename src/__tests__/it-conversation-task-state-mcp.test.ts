import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, PermissionMode } from '../core/models/index.js';
import { createTaktMcpServer } from '../app/mcp/server.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import type { Provider, ProviderAgent, ProviderCallOptions, ProviderType } from '../infra/providers/types.js';

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

  afterEach(() => {
    if (projectCwd !== undefined) {
      rmSync(projectCwd, { recursive: true, force: true });
      projectCwd = undefined;
    }
  });

  it('passes the grill-me plan task-state server through the real Copilot adapter and cleans it up', async () => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-conversation-task-state-mcp-'));
    let mcpServersDuringCall: ProviderCallOptions['mcpServers'];
    let configPathDuringCall: string | undefined;
    let configDirectoryDuringCall: string | undefined;
    const providerCall = vi.fn(async (_prompt: string, options: ProviderCallOptions) => {
      expect(options.permissionMode).toBe('readonly');
      mcpServersDuringCall = options.mcpServers;
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
    expect(plan.ctx.mcpServers).toBe(plan.ctx.taskStateMcpServers);
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
    expect(mcpServersDuringCall).toBe(plan.ctx.mcpServers);
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
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-conversation-task-state-mcp-'));
    const readOnlyToolNames = await listTaktToolNames('read-only');
    const providerCall = vi.fn(async (_prompt: string, options: ProviderCallOptions) => {
      expect(options.mcpServers).toBeUndefined();
      expect(options.preparedMcp).toBeUndefined();
      expect(options.allowedTools).not.toEqual(expect.arrayContaining(
        readOnlyToolNames.map(toClaudeMcpToolName),
      ));
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
    expect(capturedOptions[0]?.preparedMcp).not.toBe(capturedOptions[1]?.preparedMcp);
  });
});
