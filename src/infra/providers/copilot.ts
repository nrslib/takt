/**
 * Copilot provider implementation
 */

import { callCopilot, callCopilotCustom, type CopilotCallOptions } from '../copilot/index.js';
import { resolveCopilotGithubToken, resolveCopilotCliPath, loadProjectConfig } from '../config/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const log = createLogger('copilot-provider');

function toCopilotOptions(options: ProviderCallOptions): CopilotCallOptions {
  if (options.allowedTools && options.allowedTools.length > 0) {
    log.info('Copilot provider does not support allowedTools; ignoring');
  }
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    log.info('Copilot provider does not support mcpServers in non-interactive mode; ignoring');
  }
  if (options.outputSchema) {
    log.info('Copilot provider does not support outputSchema; ignoring');
  }

  const projectConfig = loadProjectConfig(options.cwd);
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    copilotGithubToken: options.copilotGithubToken ?? resolveCopilotGithubToken(),
    copilotCliPath: resolveCopilotCliPath(projectConfig),
  };
}

/** Copilot provider — delegates to GitHub Copilot CLI */
export class CopilotProvider implements Provider {
  setup(config: AgentSetup): ProviderAgent {
    if (config.claudeAgent) {
      throw new Error('Claude Code agent calls are not supported by the Copilot provider');
    }
    if (config.claudeSkill) {
      throw new Error('Claude Code skill calls are not supported by the Copilot provider');
    }

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
}
