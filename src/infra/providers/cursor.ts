/**
 * Cursor provider implementation
 */

import { callCursor, callCursorCustom, type CursorCallOptions } from '../cursor/index.js';
import { resolveCursorApiKey, resolveCursorCliPath, loadProjectConfig } from '../config/index.js';
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

  const projectConfig = loadProjectConfig(options.cwd);
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    cursorApiKey: options.cursorApiKey ?? resolveCursorApiKey(),
    cursorCliPath: resolveCursorCliPath(projectConfig),
  };
}

/** Cursor provider — delegates to Cursor Agent CLI */
export class CursorProvider implements Provider {
  setup(config: AgentSetup): ProviderAgent {
    if (config.claudeAgent) {
      throw new Error('Claude Code agent calls are not supported by the Cursor provider');
    }
    if (config.claudeSkill) {
      throw new Error('Claude Code skill calls are not supported by the Cursor provider');
    }

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
}
