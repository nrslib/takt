/**
 * Codex provider implementation
 */

import { execFileSync } from 'node:child_process';
import { callCodex, callCodexCustom, type CodexCallOptions } from '../codex/index.js';
import { resolveOpenaiApiKey } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const NOT_GIT_REPO_MESSAGE =
  'Codex をご利用の場合 Git 管理下のディレクトリでのみ動作します。';

function isInsideGitRepo(cwd: string): boolean {
  try {
    const result = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return result === 'true';
  } catch {
    return false;
  }
}

function toCodexOptions(options: ProviderCallOptions): CodexCallOptions {
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    permissionMode: options.permissionMode,
    networkAccess: options.providerOptions?.codex?.networkAccess,
    onStream: options.onStream,
    openaiApiKey: options.openaiApiKey ?? resolveOpenaiApiKey(),
    outputSchema: options.outputSchema,
  };
}

function errorResponse(agentName: string): AgentResponse {
  return {
    persona: agentName,
    status: 'error',
    content: NOT_GIT_REPO_MESSAGE,
    timestamp: new Date(),
  };
}

/** Codex provider — delegates to OpenAI Codex SDK */
export class CodexProvider implements Provider {
  setup(config: AgentSetup): ProviderAgent {
    if (config.claudeAgent) {
      throw new Error('Claude Code agent calls are not supported by the Codex provider');
    }
    if (config.claudeSkill) {
      throw new Error('Claude Code skill calls are not supported by the Codex provider');
    }

    const { name, systemPrompt } = config;
    if (systemPrompt) {
      return {
        call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
          if (!isInsideGitRepo(options.cwd)) return errorResponse(name);
          return callCodexCustom(name, prompt, systemPrompt, toCodexOptions(options));
        },
      };
    }

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        if (!isInsideGitRepo(options.cwd)) return errorResponse(name);
        return callCodex(name, prompt, toCodexOptions(options));
      },
    };
  }
}
