/**
 * OpenCode provider implementation
 */

import {
  callOpenCode,
  callOpenCodeCustom,
  compactOpenCodeSession,
  type OpenCodeCallOptions,
  type OpenCodeCompactSessionOptions,
} from '../opencode/index.js';
import { keepsOpenCodeAllowedToolWithoutEdit } from '../opencode/allowedTools.js';
import { resolveOpenCodeAllowedPermissions } from '../opencode/types.js';
import { resolveOpencodeApiKey } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { PermissionMode } from '../../core/models/index.js';
import {
  createProviderErrorFailure,
  formatAgentFailure,
} from '../../shared/types/agent-failure.js';
import { createLogger } from '../../shared/utils/index.js';
import {
  assertOutputSchema,
  type AgentSetup,
  type Provider,
  type ProviderAgent,
  type ProviderCallOptions,
  type ProviderCompactSessionOptions,
} from './types.js';

const log = createLogger('opencode-provider');

const OPENCODE_TOOL_NAMING_FALLBACK = [
  'OpenCode tool names are lowercase.',
  'Use bash for shell commands, glob for file discovery, grep for search, read for file reads, edit/write for changes, and todowrite for todos.',
].join(' ');
const OPENCODE_MODEL_REQUIRED_MESSAGE = "OpenCode provider requires model in 'provider/model' format (e.g. 'opencode/big-pickle').";

function buildToolNamingInstruction(
  allowedTools: string[],
  mode: PermissionMode | undefined,
  networkAccess: boolean | undefined,
): string | null {
  const names = resolveOpenCodeAllowedPermissions(mode, networkAccess, allowedTools);
  if (names.length === 0) {
    return null;
  }
  return `You have ONLY these tools: ${names.join(', ')}. No other tools exist. Do not attempt to call any tool not in this list.`;
}

function toOpenCodeOptions(options: ProviderCallOptions): OpenCodeCallOptions {
  const model = requireOpenCodeModel(options.model);

  const openCodeAllowedTools = options.allowedTools;
  if (options.imageAttachments && options.imageAttachments.length > 0) {
    log.info('OpenCode provider does not support imageAttachments; ignoring');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model,
    allowedTools: openCodeAllowedTools,
    permissionMode: options.permissionMode,
    networkAccess: options.providerOptions?.opencode?.networkAccess,
    variant: options.providerOptions?.opencode?.variant,
    guards: options.providerOptions?.opencode?.guards,
    onStream: options.onStream,
    onActivity: options.onActivity,
    onAskUserQuestion: options.onAskUserQuestion,
    opencodeApiKey: options.opencodeApiKey ?? resolveOpencodeApiKey(),
    childProcessEnv: options.childProcessEnv,
    outputSchema: options.outputSchema,
    language: options.language,
    preparedMcp: options.preparedMcp,
  };
}

function toOpenCodeCompactSessionOptions(options: ProviderCompactSessionOptions): OpenCodeCompactSessionOptions {
  const model = requireOpenCodeModel(options.model);

  return {
    cwd: options.cwd,
    sessionId: options.sessionId,
    model,
    abortSignal: options.abortSignal,
    opencodeApiKey: resolveOpencodeApiKey(),
    childProcessEnv: options.childProcessEnv,
  };
}

function requireOpenCodeModel(model: string | undefined): string {
  if (!model) {
    throw new Error(OPENCODE_MODEL_REQUIRED_MESSAGE);
  }
  return model;
}

function requireIsolatedStructuredOutput(
  agentType: string,
  response: AgentResponse,
): AgentResponse {
  if (response.status !== 'done' || response.structuredOutput !== undefined) {
    return response;
  }
  const excerpt = response.content.trim();
  const failure = createProviderErrorFailure(
    excerpt === ''
      ? 'OpenCode isolated structured execution returned an empty response with no structured output'
      : `OpenCode isolated structured execution returned no structured output: ${excerpt.slice(0, 200)}`,
  );
  const content = formatAgentFailure(failure);
  log.warn('OpenCode isolated structured execution produced no structured output', {
    agentType,
    contentLength: response.content.length,
  });
  return {
    ...response,
    status: 'error',
    content,
    error: content,
    failureCategory: failure.category,
  };
}

/** OpenCode provider — delegates to OpenCode SDK */
export class OpenCodeProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsIsolatedStructuredExecution = true;
  readonly supportsNativeImageInput = false;
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set(['stdio', 'http']);

  getRuntimeInstructions(allowedTools?: string[], permissionMode?: PermissionMode, networkAccess?: boolean): string | null {
    if (allowedTools === undefined) {
      return OPENCODE_TOOL_NAMING_FALLBACK;
    }
    if (allowedTools.length === 0) {
      return null;
    }
    return buildToolNamingInstruction(allowedTools, permissionMode, networkAccess);
  }

  keepsAllowedToolWithoutEdit(tool: string): boolean {
    return keepsOpenCodeAllowedToolWithoutEdit(tool);
  }

  async compactSession(options: ProviderCompactSessionOptions): Promise<void> {
    await compactOpenCodeSession(toOpenCodeCompactSessionOptions(options));
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
        outputSchema: assertOutputSchema(options.outputSchema, 'opencode'),
      };
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
      const response = await callOpenCodeCustom(
        name,
        fullPrompt,
        '',
        toOpenCodeOptions(isolatedOptions),
      );
      return requireIsolatedStructuredOutput(name, response);
    };
    return { call };
  }
}
