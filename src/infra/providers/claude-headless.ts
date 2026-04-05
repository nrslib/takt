import { callClaudeHeadless } from '../claude-headless/client.js';
import type { ClaudeHeadlessCallOptions } from '../claude-headless/types.js';
import { resolveClaudeCliPath } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

function toHeadlessOptions(options: ProviderCallOptions): ClaudeHeadlessCallOptions {
  const claudeOptions = options.providerOptions?.claude;
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    effort: claudeOptions?.effort,
    allowedTools: options.allowedTools,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    bypassPermissions: options.bypassPermissions,
    sandbox: claudeOptions?.sandbox,
    onStream: options.onStream,
    claudeCliPath: resolveClaudeCliPath() ?? undefined,
    outputSchema: options.outputSchema,
  };
}

export class ClaudeHeadlessProvider implements Provider {
  readonly supportsStructuredOutput = true;

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;

    return {
      call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
        callClaudeHeadless(name, prompt, {
          ...toHeadlessOptions(options),
          systemPrompt: systemPrompt ?? undefined,
        }),
    };
  }
}
