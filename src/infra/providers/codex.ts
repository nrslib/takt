/**
 * Codex provider implementation
 */

import { callCodex, callCodexCustom, type CodexCallOptions } from '../codex/index.js';
import { resolveOpenaiApiKey, resolveCodexCliPath } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

function toCodexOptions(options: ProviderCallOptions): CodexCallOptions {
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    reasoningEffort: options.providerOptions?.codex?.reasoningEffort,
    permissionMode: options.permissionMode,
    networkAccess: options.providerOptions?.codex?.networkAccess,
    onStream: options.onStream,
    openaiApiKey: options.openaiApiKey ?? resolveOpenaiApiKey(),
    codexPathOverride: resolveCodexCliPath(),
    outputSchema: options.outputSchema,
  };
}

/** Codex provider — delegates to OpenAI Codex SDK */
export class CodexProvider implements Provider {
  readonly supportsStructuredOutput = true;

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    if (systemPrompt) {
      return {
        call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
          return callCodexCustom(name, prompt, systemPrompt, toCodexOptions(options));
        },
      };
    }

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        return callCodex(name, prompt, toCodexOptions(options));
      },
    };
  }
}
