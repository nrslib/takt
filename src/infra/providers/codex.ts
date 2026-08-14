/**
 * Codex provider implementation
 */

import {
  callCodex,
  callCodexCustom,
  type CodexCallOptions,
} from '../codex/index.js';
import { resolveOpenaiApiKey, resolveCodexCliPath } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import {
  assertOutputSchema,
  type AgentSetup,
  type Provider,
  type ProviderAgent,
  type ProviderCallOptions,
} from './types.js';

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
    baseUrl: options.providerOptions?.codex?.baseUrl,
    skills: options.internalAgentIsolation === 'strict-readonly'
      ? { repo: false, user: false }
      : {
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
    const call = async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
      const isolatedOptions: ProviderCallOptions = {
        ...options,
        sessionId: undefined,
        internalAgentIsolation: 'strict-readonly',
        permissionMode: 'readonly',
        allowedTools: [],
        mcpServers: undefined,
        imageAttachments: undefined,
        outputSchema: assertOutputSchema(options.outputSchema, 'codex'),
      };
      const codexOptions = toCodexOptions(isolatedOptions);
      return systemPrompt
        ? callCodexCustom(name, prompt, `${systemPrompt}\n\n`, codexOptions)
        : callCodex(name, prompt, codexOptions);
    };
    return { call };
  }
}
