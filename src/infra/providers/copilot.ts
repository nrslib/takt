/**
 * Copilot provider implementation
 */

import { callCopilot, callCopilotCustom, type CopilotCallOptions } from '../copilot/index.js';
import { resolveCopilotGithubToken, resolveCopilotCliPath } from '../config/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';
import { createStrictInternalAgentIsolationError } from '../../shared/types/provider.js';

const log = createLogger('copilot-provider');

function toCopilotOptions(options: ProviderCallOptions): CopilotCallOptions {
  if (options.internalAgentIsolation !== undefined) {
    throw createStrictInternalAgentIsolationError('copilot');
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
    log.info('Copilot provider does not support allowedTools; ignoring');
  }
  if (options.outputSchema) {
    log.info('Copilot provider does not support outputSchema; ignoring');
  }
  if (options.imageAttachments && options.imageAttachments.length > 0) {
    log.info('Copilot provider does not support imageAttachments; ignoring');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    effort: options.providerOptions?.copilot?.effort,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    copilotGithubToken: options.copilotGithubToken ?? resolveCopilotGithubToken(),
    copilotCliPath: resolveCopilotCliPath(),
    childProcessEnv: options.childProcessEnv,
    preparedMcp: options.preparedMcp,
  };
}

/** Copilot provider — delegates to GitHub Copilot CLI */
export class CopilotProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsIsolatedStructuredExecution = false;
  readonly supportsNativeImageInput = false;
  readonly supportsStrictInternalAgentIsolation = false;
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set(['stdio', 'http']);

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(_tool: string): boolean {
    return true;
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    if (systemPrompt) {
      return {
        call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
          return callCopilotCustom(name, prompt, systemPrompt, toCopilotOptions(options));
        },
      };
    }

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        return callCopilot(name, prompt, toCopilotOptions(options));
      },
    };
  }

  setupIsolatedStructured(config: AgentSetup): ProviderAgent {
    const call = async (_prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => ({
      persona: config.name,
      status: 'error',
      content: 'Provider "copilot" does not support isolated structured execution',
      timestamp: new Date(),
      sessionId: options.sessionId,
      error: 'Provider "copilot" does not support isolated structured execution',
    });
    return { call };
  }
}
