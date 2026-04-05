/**
 * High-level Claude client for agent interactions
 *
 * Uses the Claude Agent SDK for native TypeScript integration.
 */

import { executeClaudeCli } from './process.js';
import type { ClaudeSpawnOptions, ClaudeCallOptions } from './types.js';
import type { AgentResponse, Status } from '../../core/models/index.js';
import { createLogger } from '../../shared/utils/index.js';

export type { ClaudeCallOptions } from './types.js';

const log = createLogger('client');

/**
 * High-level Claude client for calling Claude with various configurations.
 *
 * Handles agent prompts, custom agents, and AI judge evaluation.
 */
export class ClaudeClient {
  /** Determine status from execution result */
  private static determineStatus(
    result: { success: boolean; interrupted?: boolean; content: string; fullContent?: string },
  ): Status {
    if (!result.success) {
      return 'error';
    }
    return 'done';
  }

  /** Convert ClaudeCallOptions to ClaudeSpawnOptions */
  private static toSpawnOptions(options: ClaudeCallOptions): ClaudeSpawnOptions {
    return {
      cwd: options.cwd,
      abortSignal: options.abortSignal,
      sessionId: options.sessionId,
      allowedTools: options.allowedTools,
      mcpServers: options.mcpServers,
      model: options.model,
      effort: options.effort,
      maxTurns: options.maxTurns,
      systemPrompt: options.systemPrompt,
      agents: options.agents,
      permissionMode: options.permissionMode,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
      anthropicApiKey: options.anthropicApiKey,
      outputSchema: options.outputSchema,
      sandbox: options.sandbox,
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    };
  }

  /** Call Claude with an agent prompt */
  async call(
    agentType: string,
    prompt: string,
    options: ClaudeCallOptions,
  ): Promise<AgentResponse> {
    const spawnOptions = ClaudeClient.toSpawnOptions(options);
    const result = await executeClaudeCli(prompt, spawnOptions);
    const status = ClaudeClient.determineStatus(result);

    if (!result.success && result.error) {
      log.error('Agent query failed', { agent: agentType, error: result.error });
    }

    return {
      persona: agentType,
      status,
      content: result.content,
      timestamp: new Date(),
      sessionId: result.sessionId,
      error: result.error,
      structuredOutput: result.structuredOutput,
      providerUsage: result.providerUsage,
    };
  }

  /** Call Claude with a custom agent configuration */
  async callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: ClaudeCallOptions,
  ): Promise<AgentResponse> {
    const spawnOptions: ClaudeSpawnOptions = {
      ...ClaudeClient.toSpawnOptions(options),
      systemPrompt,
    };
    const result = await executeClaudeCli(prompt, spawnOptions);
    const status = ClaudeClient.determineStatus(result);

    if (!result.success && result.error) {
      log.error('Agent query failed', { agent: agentName, error: result.error });
    }

    return {
      persona: agentName,
      status,
      content: result.content,
      timestamp: new Date(),
      sessionId: result.sessionId,
      error: result.error,
      structuredOutput: result.structuredOutput,
      providerUsage: result.providerUsage,
    };
  }

}

// ---- Module-level functions ----

const defaultClient = new ClaudeClient();

export async function callClaude(
  agentType: string,
  prompt: string,
  options: ClaudeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}

export async function callClaudeCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: ClaudeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callCustom(agentName, prompt, systemPrompt, options);
}
