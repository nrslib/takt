import { callClaudeHeadless } from '../claude-headless/client.js';
import type { ClaudeHeadlessCallOptions } from '../claude-headless/types.js';
import { resolveAnthropicApiKey, resolveClaudeCliPath } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import { keepsAllowedToolWithoutEdit as keepsClaudeAllowedToolWithoutEdit } from './allowed-tool-edit-policy.js';
import {
  assertOutputSchema,
  type AgentSetup,
  type Provider,
  type ProviderAgent,
  type ProviderCallOptions,
} from './types.js';

function toHeadlessOptions(options: ProviderCallOptions): ClaudeHeadlessCallOptions {
  const claudeOptions = options.providerOptions?.claude;
  const skillsEnabled = options.internalAgentIsolation === 'strict-readonly'
    ? false
    : claudeOptions?.skills?.enabled;
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    anthropicApiKey: options.anthropicApiKey ?? resolveAnthropicApiKey(),
    baseUrl: claudeOptions?.baseUrl,
    effort: claudeOptions?.effort,
    skillsEnabled,
    allowedTools: options.allowedTools,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    bypassPermissions: options.bypassPermissions,
    sandbox: claudeOptions?.sandbox,
    onStream: options.onStream,
    claudeCliPath: resolveClaudeCliPath() ?? undefined,
    outputSchema: options.outputSchema,
    childProcessEnv: options.childProcessEnv,
  };
}

export class ClaudeHeadlessProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsIsolatedStructuredExecution = true;
  readonly supportsNativeImageInput = false;

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(tool: string): boolean {
    return keepsClaudeAllowedToolWithoutEdit(tool);
  }

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

  setupIsolatedStructured(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    const call = (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
      const isolatedOptions: ProviderCallOptions = {
        ...options,
        sessionId: undefined,
        internalAgentIsolation: 'strict-readonly',
        allowedTools: [],
        mcpServers: undefined,
        imageAttachments: undefined,
        outputSchema: assertOutputSchema(options.outputSchema, 'claude-headless'),
      };
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
      return callClaudeHeadless(name, fullPrompt, {
        ...toHeadlessOptions(isolatedOptions),
        systemPrompt: '',
      });
    };
    return { call };
  }
}
