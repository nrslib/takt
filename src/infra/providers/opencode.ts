/**
 * OpenCode provider implementation
 */

import { callOpenCode, callOpenCodeCustom, type OpenCodeCallOptions } from '../opencode/index.js';
import { resolveOpencodeApiKey } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

function toOpenCodeOptions(options: ProviderCallOptions): OpenCodeCallOptions {
  if (!options.model) {
    throw new Error("OpenCode provider requires model in 'provider/model' format (e.g. 'opencode/big-pickle').");
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    allowedTools: options.allowedTools,
    permissionMode: options.permissionMode,
    networkAccess: options.providerOptions?.opencode?.networkAccess,
    onStream: options.onStream,
    onAskUserQuestion: options.onAskUserQuestion,
    opencodeApiKey: options.opencodeApiKey ?? resolveOpencodeApiKey(),
    outputSchema: options.outputSchema,
  };
}

/** OpenCode provider — delegates to OpenCode SDK */
export class OpenCodeProvider implements Provider {
  setup(config: AgentSetup): ProviderAgent {
    if (config.claudeAgent) {
      throw new Error('Claude Code agent calls are not supported by the OpenCode provider');
    }
    if (config.claudeSkill) {
      throw new Error('Claude Code skill calls are not supported by the OpenCode provider');
    }

    const { name, systemPrompt } = config;
    if (systemPrompt) {
      return {
        call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
          return callOpenCodeCustom(name, prompt, systemPrompt, toOpenCodeOptions(options));
        },
      };
    }

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        return callOpenCode(name, prompt, toOpenCodeOptions(options));
      },
    };
  }
}
