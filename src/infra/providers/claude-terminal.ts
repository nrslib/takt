import { callClaudeTerminal } from '../claude-terminal/client.js';
import type { ClaudeTerminalCallOptions } from '../claude-terminal/types.js';
import { resolveClaudeCliPath } from '../config/index.js';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { AgentResponse } from '../../core/models/index.js';
import { AGENT_FAILURE_CATEGORIES } from '../../shared/types/agent-failure.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { keepsAllowedToolWithoutEdit as keepsClaudeAllowedToolWithoutEdit } from './allowed-tool-edit-policy.js';
import {
  assertOutputSchema,
  type AgentSetup,
  type Provider,
  type ProviderAgent,
  type ProviderCallOptions,
} from './types.js';

function createProviderErrorResponse(
  agentName: string,
  options: ProviderCallOptions,
  message: string,
): AgentResponse {
  return {
    persona: agentName,
    status: 'error',
    content: message,
    timestamp: new Date(),
    sessionId: options.sessionId,
    error: message,
    failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
    providerUsage: {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
    },
  };
}

function createCaughtProviderErrorResponse(
  agentName: string,
  options: ProviderCallOptions,
  error: unknown,
): AgentResponse {
  return createProviderErrorResponse(
    agentName,
    options,
    `Claude terminal provider failed: ${getErrorMessage(error)}`,
  );
}

function toTerminalOptions(options: ProviderCallOptions): ClaudeTerminalCallOptions {
  const claudeOptions = options.providerOptions?.claude;
  const terminalOptions = options.providerOptions?.claudeTerminal;
  const skillsEnabled = options.internalAgentIsolation === 'strict-readonly'
    ? false
    : claudeOptions?.skills?.enabled;
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    internalAgentIsolation: options.internalAgentIsolation,
    model: options.model,
    effort: options.effort ?? claudeOptions?.effort,
    skillsEnabled,
    allowedTools: options.allowedTools,
    mcpServers: options.mcpServers,
    preparedMcp: options.preparedMcp,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    permissionMode: options.permissionMode,
    bypassPermissions: options.bypassPermissions,
    backend: terminalOptions?.backend,
    callTimeoutMs: terminalOptions?.guards?.callTimeoutMs,
    timeoutMs: terminalOptions?.timeoutMs,
    keepSession: terminalOptions?.keepSession,
    transcriptPollIntervalMs: terminalOptions?.transcriptPollIntervalMs,
    onStream: options.onStream,
    onActivity: options.onActivity,
    onPermissionRequest: options.onPermissionRequest,
    onAskUserQuestion: options.onAskUserQuestion,
    outputSchema: options.outputSchema,
    pathToClaudeCodeExecutable: resolveClaudeCliPath() ?? undefined,
    childProcessEnv: options.childProcessEnv,
  };
}

export class ClaudeTerminalProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsIsolatedStructuredExecution = true;
  readonly supportsToolFreeExecution = true;
  readonly supportsNativeImageInput = false;
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set(['stdio', 'sse', 'http']);
  readonly supportsStrictMcpConfig = true;

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(tool: string): boolean {
    return keepsClaudeAllowedToolWithoutEdit(tool);
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        try {
          return await callClaudeTerminal(name, prompt, {
            ...toTerminalOptions(options),
            systemPrompt: systemPrompt ?? undefined,
          });
        } catch (error) {
          return createCaughtProviderErrorResponse(name, options, error);
        }
      },
    };
  }

  setupIsolatedStructured(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    const call = async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
      try {
        const isolatedOptions: ProviderCallOptions = {
          ...options,
          sessionId: undefined,
          internalAgentIsolation: 'strict-readonly',
          allowedTools: [],
          mcpServers: undefined,
          preparedMcp: undefined,
          imageAttachments: undefined,
          outputSchema: assertOutputSchema(options.outputSchema, 'claude-terminal'),
        };
        const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
        return await callClaudeTerminal(name, fullPrompt, {
          ...toTerminalOptions(isolatedOptions),
          systemPrompt: '',
        });
      } catch (error) {
        return createCaughtProviderErrorResponse(name, options, error);
      }
    };
    return { call };
  }
}
