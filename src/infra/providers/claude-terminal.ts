import { callClaudeTerminal } from '../claude-terminal/client.js';
import type { ClaudeTerminalCallOptions } from '../claude-terminal/types.js';
import { resolveClaudeCliPath } from '../config/index.js';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { AgentResponse } from '../../core/models/index.js';
import { validateClaudeEffortCompatibility } from '../../core/workflow/claude-effort-compatibility.js';
import { AGENT_FAILURE_CATEGORIES } from '../../shared/types/agent-failure.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

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
  validateClaudeEffortCompatibility(options.model, claudeOptions?.effort);
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    effort: claudeOptions?.effort,
    allowedTools: options.allowedTools,
    mcpServers: options.mcpServers,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    permissionMode: options.permissionMode,
    bypassPermissions: options.bypassPermissions,
    backend: terminalOptions?.backend,
    timeoutMs: terminalOptions?.timeoutMs,
    keepSession: terminalOptions?.keepSession,
    transcriptPollIntervalMs: terminalOptions?.transcriptPollIntervalMs,
    onStream: options.onStream,
    onPermissionRequest: options.onPermissionRequest,
    onAskUserQuestion: options.onAskUserQuestion,
    outputSchema: options.outputSchema,
    pathToClaudeCodeExecutable: resolveClaudeCliPath() ?? undefined,
  };
}

export class ClaudeTerminalProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsNativeImageInput = false;

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
}
