import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/index.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import type { Provider, ProviderAgent, ProviderCallOptions } from '../infra/providers/types.js';

function createFakeCopilotProvider(
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

function createGrillMePlan(projectCwd: string, provider: Provider) {
  return createAssistantConversationPlan(projectCwd, {
    assistantMode: 'grill-me',
    formalSpec: false,
    formalSpecComments: true,
    resolvedSessionContext: {
      provider,
      providerType: 'copilot',
      model: 'copilot-model',
      lang: 'en',
      personaName: 'grill-me-interactive',
      sessionId: undefined,
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
    const { provider } = createFakeCopilotProvider(providerCall);
    const plan = createGrillMePlan(projectCwd, provider);

    expect(plan.strategy.permissionMode).toBe('readonly');
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
        permissionMode: plan.strategy.permissionMode,
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
    const { provider } = createFakeCopilotProvider(providerCall);
    const plan = createGrillMePlan(projectCwd, provider);
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
        permissionMode: plan.strategy.permissionMode,
      },
    );

    expect(outcome.result).toBeNull();
    expect(outcome.error).toContain('readonly permission mode');
    expect(providerCall).not.toHaveBeenCalled();
  });
});
