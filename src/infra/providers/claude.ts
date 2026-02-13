/**
 * Claude provider implementation
 */

import { callClaude, callClaudeCustom, callClaudeAgent, callClaudeSkill } from '../claude/client.js';
import type { ClaudeCallOptions } from '../claude/types.js';
import { resolveAnthropicApiKey } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

function toClaudeOptions(options: ProviderCallOptions): ClaudeCallOptions {
  const claudeSandbox = options.providerOptions?.claude?.sandbox;
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    allowedTools: options.allowedTools,
    mcpServers: options.mcpServers,
    model: options.model,
    maxTurns: options.maxTurns,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    onPermissionRequest: options.onPermissionRequest,
    onAskUserQuestion: options.onAskUserQuestion,
    bypassPermissions: options.bypassPermissions,
    anthropicApiKey: options.anthropicApiKey ?? resolveAnthropicApiKey(),
    outputSchema: options.outputSchema,
    sandbox: claudeSandbox ? {
      allowUnsandboxedCommands: claudeSandbox.allowUnsandboxedCommands,
      excludedCommands: claudeSandbox.excludedCommands,
    } : undefined,
  };
}

/** Claude provider — delegates to Claude Code SDK */
export class ClaudeProvider implements Provider {
  setup(config: AgentSetup): ProviderAgent {
    if (config.claudeAgent) {
      const agentName = config.claudeAgent;
      return {
        call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
          callClaudeAgent(agentName, prompt, toClaudeOptions(options)),
      };
    }

    if (config.claudeSkill) {
      const skillName = config.claudeSkill;
      return {
        call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
          callClaudeSkill(skillName, prompt, toClaudeOptions(options)),
      };
    }

    const { name, systemPrompt } = config;
    if (systemPrompt) {
      return {
        call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
          callClaudeCustom(name, prompt, systemPrompt, toClaudeOptions(options)),
      };
    }

    return {
      call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
        callClaude(name, prompt, toClaudeOptions(options)),
    };
  }
}
