/**
 * Codex provider implementation
 */

import {
  callCodex,
  callCodexCustom,
  callCodexIsolatedStructured,
  type CodexCallOptions,
} from '../codex/index.js';
import { resolveOpenaiApiKey, resolveCodexCliPath } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

function toCodexOptions(options: ProviderCallOptions): CodexCallOptions {
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    internalAgentIsolation: options.internalAgentIsolation,
    model: options.model,
    reasoningEffort: options.providerOptions?.codex?.reasoningEffort,
    permissionMode: options.permissionMode,
    networkAccess: options.providerOptions?.codex?.networkAccess,
    onStream: options.onStream,
    openaiApiKey: options.openaiApiKey ?? resolveOpenaiApiKey(),
    baseUrl: options.providerOptions?.codex?.baseUrl,
    skills: {
      repo: options.providerOptions?.codex?.skills?.repo ?? false,
      user: options.providerOptions?.codex?.skills?.user ?? false,
    },
    codexPathOverride: resolveCodexCliPath(),
    outputSchema: options.outputSchema,
    imageAttachments: options.imageAttachments,
    failureDir: options.failureDir,
    childProcessEnv: options.childProcessEnv,
  };
}

/** Codex provider — delegates to OpenAI Codex SDK */
export class CodexProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsIsolatedStructuredExecution = true;
  readonly supportsNativeImageInput = true;
  readonly supportsStrictInternalAgentIsolation = true;

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(_tool: string): boolean {
    return true;
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    const call = async (
      prompt: string,
      options: ProviderCallOptions,
    ): Promise<AgentResponse> => {
      const codexOptions = toCodexOptions(options);
      return systemPrompt
        ? callCodexCustom(name, prompt, systemPrompt, codexOptions)
        : callCodex(name, prompt, codexOptions);
    };
    return { call };
  }

  setupIsolatedStructured(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    const call = async (
      prompt: string,
      options: ProviderCallOptions,
    ): Promise<AgentResponse> => {
      const codexOptions = toCodexOptions(options);
      return callCodexIsolatedStructured(
        name,
        systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
        codexOptions,
      );
    };
    return { call };
  }
}
