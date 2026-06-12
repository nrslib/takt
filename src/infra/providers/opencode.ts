/**
 * OpenCode provider implementation
 */

import { callOpenCode, callOpenCodeCustom, type OpenCodeCallOptions } from '../opencode/index.js';
import { mapsToOpenCodeEditPermission } from '../opencode/allowedTools.js';
import { resolveOpencodeApiKey } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const OPENCODE_TOOL_NAMING_ADDENDUM = [
  'OpenCode tool names are lowercase.',
  'Use bash for shell commands, glob for file discovery, grep for search, read for file reads, edit/write for changes, and todowrite for todos.',
  'Do not call run, list, todo, or todo_write.',
].join(' ');

function toOpenCodeOptions(options: ProviderCallOptions): OpenCodeCallOptions {
  if (!options.model) {
    throw new Error("OpenCode provider requires model in 'provider/model' format (e.g. 'opencode/big-pickle').");
  }

  const openCodeAllowedTools = options.allowedTools;

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    allowedTools: openCodeAllowedTools,
    permissionMode: options.permissionMode,
    networkAccess: options.providerOptions?.opencode?.networkAccess,
    variant: options.providerOptions?.opencode?.variant,
    onStream: options.onStream,
    onAskUserQuestion: options.onAskUserQuestion,
    opencodeApiKey: options.opencodeApiKey ?? resolveOpencodeApiKey(),
  };
}

/** OpenCode provider — delegates to OpenCode SDK */
export class OpenCodeProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsNativeImageInput = false;

  getRuntimeInstructions(): string | null {
    return OPENCODE_TOOL_NAMING_ADDENDUM;
  }

  keepsAllowedToolWithoutEdit(tool: string): boolean {
    return !mapsToOpenCodeEditPermission(tool);
  }

  setup(config: AgentSetup): ProviderAgent {
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
