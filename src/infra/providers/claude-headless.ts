import { callClaudeHeadless } from '../claude-headless/client.js';
import type { ClaudeHeadlessCallOptions } from '../claude-headless/types.js';
import { resolveClaudeCliPath } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

function toHeadlessOptions(options: ProviderCallOptions): ClaudeHeadlessCallOptions {
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    allowedTools: options.allowedTools,
    permissionMode: options.permissionMode,
    bypassPermissions: options.bypassPermissions,
    providerOptions: options.providerOptions,
    onStream: options.onStream,
    claudeCliPath: resolveClaudeCliPath() ?? undefined,
  };
}

export class ClaudeHeadlessProvider implements Provider {
  readonly supportsStructuredOutput = false;

  setup(config: AgentSetup): ProviderAgent {
    if (config.claudeAgent || config.claudeSkill) {
      throw new Error(
        'claudeAgent and claudeSkill require provider claude-sdk; headless claude does not support them.',
      );
    }

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
