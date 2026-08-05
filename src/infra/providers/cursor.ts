/**
 * Cursor provider implementation
 */

import { callCursor, callCursorCustom, type CursorCallOptions } from '../cursor/index.js';
import { resolveCursorApiKey, resolveCursorCliPath } from '../config/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const log = createLogger('cursor-provider');

function toCursorOptions(options: ProviderCallOptions): CursorCallOptions {
  if (options.allowedTools && options.allowedTools.length > 0) {
    log.info('Cursor provider does not support allowedTools; ignoring');
  }
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    log.info('Cursor provider does not support mcpServers; ignoring');
  }
  if (options.outputSchema) {
    log.info('Cursor provider does not support outputSchema; ignoring');
  }
  if (options.imageAttachments && options.imageAttachments.length > 0) {
    log.info('Cursor provider does not support imageAttachments; ignoring');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    cursorApiKey: options.cursorApiKey ?? resolveCursorApiKey(),
    cursorCliPath: resolveCursorCliPath(),
    childProcessEnv: options.childProcessEnv,
  };
}

/** Cursor provider — delegates to Cursor Agent CLI */
export class CursorProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsIsolatedStructuredExecution = false;
  readonly supportsNativeImageInput = false;
  readonly supportsStrictInternalAgentIsolation = false;

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
          return callCursorCustom(name, prompt, systemPrompt, toCursorOptions(options));
        },
      };
    }

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        return callCursor(name, prompt, toCursorOptions(options));
      },
    };
  }

  setupIsolatedStructured(config: AgentSetup): ProviderAgent {
    const call = async (_prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => ({
      persona: config.name,
      status: 'error',
      content: 'Provider "cursor" does not support isolated structured execution',
      timestamp: new Date(),
      sessionId: options.sessionId,
      error: 'Provider "cursor" does not support isolated structured execution',
    });
    return { call };
  }
}
