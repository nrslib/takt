/**
 * Codex provider implementation
 */

import { execFileSync } from 'node:child_process';
import { callCodex, callCodexCustom, type CodexCallOptions } from '../codex/index.js';
import { resolveOpenaiApiKey } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { Provider, ProviderCallOptions } from './types.js';

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

/** Codex provider - wraps existing Codex client */
export class CodexProvider implements Provider {
  async call(agentName: string, prompt: string, options: ProviderCallOptions): Promise<AgentResponse> {
    if (!isInsideGitRepo(options.cwd)) {
      return {
        agent: agentName,
        status: 'blocked',
        content: NOT_GIT_REPO_MESSAGE,
        timestamp: new Date(),
      };
    }

    const callOptions: CodexCallOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      model: options.model,
      systemPrompt: options.systemPrompt,
      permissionMode: options.permissionMode,
      onStream: options.onStream,
      openaiApiKey: options.openaiApiKey ?? resolveOpenaiApiKey(),
    };

    return callCodex(agentName, prompt, callOptions);
  }

  async callCustom(agentName: string, prompt: string, systemPrompt: string, options: ProviderCallOptions): Promise<AgentResponse> {
    if (!isInsideGitRepo(options.cwd)) {
      return {
        agent: agentName,
        status: 'blocked',
        content: NOT_GIT_REPO_MESSAGE,
        timestamp: new Date(),
      };
    }

    const callOptions: CodexCallOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      model: options.model,
      permissionMode: options.permissionMode,
      onStream: options.onStream,
      openaiApiKey: options.openaiApiKey ?? resolveOpenaiApiKey(),
    };

    return callCodexCustom(agentName, prompt, systemPrompt, callOptions);
  }
}
