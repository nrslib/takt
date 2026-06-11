/**
 * OpenCode provider implementation
 */

import { callOpenCodeCustom, type OpenCodeCallOptions } from '../opencode/index.js';
import { resolveOpencodeApiKey } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const OPENCODE_TOOL_NAMING_ADDENDUM = [
  'OpenCode tool names are lowercase.',
  'Use bash for shell commands, glob for file discovery, grep for search, read for file reads, edit/write for changes, and todowrite for todos.',
  'Do not call run, list, todo, or todo_write.',
].join(' ');

function buildOpenCodeSystemPrompt(systemPrompt: string | undefined): string {
  return systemPrompt
    ? `${systemPrompt}\n\n${OPENCODE_TOOL_NAMING_ADDENDUM}`
    : OPENCODE_TOOL_NAMING_ADDENDUM;
}

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
    outputSchema: options.outputSchema,
  };
}

/** OpenCode provider — delegates to OpenCode SDK */
export class OpenCodeProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsNativeImageInput = false;

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    const openCodeSystemPrompt = buildOpenCodeSystemPrompt(systemPrompt);

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        return callOpenCodeCustom(name, prompt, openCodeSystemPrompt, toOpenCodeOptions(options));
      },
    };
  }
}
