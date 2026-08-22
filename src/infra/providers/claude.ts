import { callClaude, callClaudeCustom } from '../claude/client.js';
import type { ClaudeCallOptions } from '../claude/types.js';
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

function toClaudeOptions(options: ProviderCallOptions): ClaudeCallOptions {
  const claudeSandbox = options.providerOptions?.claude?.sandbox;
  const effort = options.providerOptions?.claude?.effort;
  const skillsEnabled = options.internalAgentIsolation === 'strict-readonly'
    ? false
    : options.providerOptions?.claude?.skills?.enabled;
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    internalAgentIsolation: options.internalAgentIsolation,
    allowedTools: options.allowedTools,
    mcpServers: options.mcpServers,
    ...(options.preparedMcp !== undefined ? { preparedMcp: options.preparedMcp } : {}),
    model: options.model,
    effort,
    skillsEnabled,
    maxTurns: options.maxTurns,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    onActivity: options.onActivity,
    onPermissionRequest: options.onPermissionRequest,
    onAskUserQuestion: options.onAskUserQuestion,
    bypassPermissions: options.bypassPermissions,
    anthropicApiKey: options.anthropicApiKey ?? resolveAnthropicApiKey(),
    baseUrl: options.providerOptions?.claude?.baseUrl,
    outputSchema: options.outputSchema,
    imageAttachments: options.imageAttachments,
    sandbox: claudeSandbox ? {
      allowUnsandboxedCommands: claudeSandbox.allowUnsandboxedCommands,
      excludedCommands: claudeSandbox.excludedCommands,
    } : undefined,
    pathToClaudeCodeExecutable: resolveClaudeCliPath(),
    childProcessEnv: options.childProcessEnv,
  };
}

export class ClaudeProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsIsolatedStructuredExecution = true;
  readonly supportsNativeImageInput = true;
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set(['stdio', 'sse', 'http']);
  readonly supportsStrictMcpConfig = true;

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(tool: string): boolean {
    return keepsClaudeAllowedToolWithoutEdit(tool);
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    if (systemPrompt) {
      return {
        call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
          callClaudeCustom(name, prompt, systemPrompt, toClaudeOptions(options)),
      };
    }

    return {
      call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
        callClaude(name, prompt, toClaudeOptions(options)),
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
        preparedMcp: undefined,
        imageAttachments: undefined,
        outputSchema: assertOutputSchema(options.outputSchema, 'claude'),
      };
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
      return callClaudeCustom(name, fullPrompt, '', toClaudeOptions(isolatedOptions));
    };
    return { call };
  }
}
