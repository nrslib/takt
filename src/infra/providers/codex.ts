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
import { assertCodexConfigProfilePermissionControl } from '../../core/models/workflow-provider-options.js';
import {
  assertOutputSchema,
  type AgentSetup,
  type Provider,
  type ProviderAgent,
  type ProviderCallOptions,
} from './types.js';

function toCodexOptions(options: ProviderCallOptions): CodexCallOptions {
  const providerCodexOptions = options.providerOptions?.codex;
  assertCodexConfigProfilePermissionControl(providerCodexOptions);
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    reasoningEffort: options.effort ?? providerCodexOptions?.reasoningEffort,
    fastMode: providerCodexOptions?.fastMode,
    permissionMode: options.permissionMode,
    permissionControl: providerCodexOptions?.permissionControl,
    configProfile: providerCodexOptions?.configProfile,
    networkAccess: providerCodexOptions?.networkAccess,
    onStream: options.onStream,
    onActivity: options.onActivity,
    openaiApiKey: options.openaiApiKey ?? resolveOpenaiApiKey(),
    baseUrl: providerCodexOptions?.baseUrl,
    skills: options.internalAgentIsolation === 'strict-readonly'
      ? { repo: false, user: false }
      : {
          repo: providerCodexOptions?.skills?.repo ?? false,
          user: providerCodexOptions?.skills?.user ?? false,
        },
    codexPathOverride: resolveCodexCliPath(),
    outputSchema: options.outputSchema,
    imageAttachments: options.imageAttachments,
    failureDir: options.failureDir,
    childProcessEnv: options.childProcessEnv,
    preparedMcp: options.preparedMcp,
  };
}

/** Codex provider — delegates to OpenAI Codex SDK */
export class CodexProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsIsolatedStructuredExecution = true;
  readonly supportsNativeImageInput = true;
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set(['stdio', 'http']);

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
      // Isolated structured execution is intentionally strict-readonly and
      // disables MCP. Clear both fields explicitly so a prepared runtime MCP
      // configuration is never silently inherited by this provider path.
      const isolatedOptions: ProviderCallOptions = {
        ...options,
        sessionId: undefined,
        internalAgentIsolation: 'strict-readonly',
        permissionMode: 'readonly',
        allowedTools: [],
        mcpServers: undefined,
        preparedMcp: undefined,
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
