/**
 * High-level Claude client for agent interactions
 *
 * Uses the Claude Agent SDK for native TypeScript integration.
 */

import { executeClaudeCli } from './process.js';
import type { ClaudeSpawnOptions, ClaudeCallOptions } from './types.js';
import type { AgentResponse, Status } from '../../core/models/index.js';
import { createLogger } from '../../shared/utils/index.js';
import { getPrompt } from '../../shared/prompts/index.js';

// Re-export for backward compatibility
export type { ClaudeCallOptions } from './types.js';

const log = createLogger('client');

/**
 * Detect rule index from numbered tag pattern [STEP_NAME:N].
 * Returns 0-based rule index, or -1 if no match.
 *
 * Example: detectRuleIndex("... [PLAN:2] ...", "plan") → 1
 */
export function detectRuleIndex(content: string, stepName: string): number {
  const tag = stepName.toUpperCase();
  const regex = new RegExp(`\\[${tag}:(\\d+)\\]`, 'gi');
  const matches = [...content.matchAll(regex)];
  const match = matches.at(-1);
  if (match?.[1]) {
    const index = Number.parseInt(match[1], 10) - 1;
    return index >= 0 ? index : -1;
  }
  return -1;
}

/** Validate regex pattern for ReDoS safety */
export function isRegexSafe(pattern: string): boolean {
  if (pattern.length > 200) {
    return false;
  }

  const dangerousPatterns = [
    /\(\.\*\)\+/,      // (.*)+
    /\(\.\+\)\*/,      // (.+)*
    /\(\.\*\)\*/,      // (.*)*
    /\(\.\+\)\+/,      // (.+)+
    /\([^)]*\|[^)]*\)\+/, // (a|b)+
    /\([^)]*\|[^)]*\)\*/, // (a|b)*
  ];

  for (const dangerous of dangerousPatterns) {
    if (dangerous.test(pattern)) {
      return false;
    }
  }

  return true;
}

/**
 * High-level Claude client for calling Claude with various configurations.
 *
 * Handles agent prompts, custom agents, skills, and AI judge evaluation.
 */
export class ClaudeClient {
  /** Determine status from execution result */
  private static determineStatus(
    result: { success: boolean; interrupted?: boolean; content: string; fullContent?: string },
  ): Status {
    if (!result.success) {
      if (result.interrupted) {
        return 'interrupted';
      }
      return 'blocked';
    }
    return 'done';
  }

  /** Convert ClaudeCallOptions to ClaudeSpawnOptions */
  private static toSpawnOptions(options: ClaudeCallOptions): ClaudeSpawnOptions {
    return {
      cwd: options.cwd,
      sessionId: options.sessionId,
      allowedTools: options.allowedTools,
      model: options.model,
      maxTurns: options.maxTurns,
      systemPrompt: options.systemPrompt,
      agents: options.agents,
      permissionMode: options.permissionMode,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
      anthropicApiKey: options.anthropicApiKey,
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
      agent: agentType,
      status,
      content: result.content,
      timestamp: new Date(),
      sessionId: result.sessionId,
      error: result.error,
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
      agent: agentName,
      status,
      content: result.content,
      timestamp: new Date(),
      sessionId: result.sessionId,
      error: result.error,
    };
  }

  /** Call a Claude Code built-in agent */
  async callAgent(
    claudeAgentName: string,
    prompt: string,
    options: ClaudeCallOptions,
  ): Promise<AgentResponse> {
    const systemPrompt = getPrompt('claude.agentDefault', undefined, { agentName: claudeAgentName });
    return this.callCustom(claudeAgentName, prompt, systemPrompt, options);
  }

  /** Call a Claude Code skill (using /skill command) */
  async callSkill(
    skillName: string,
    prompt: string,
    options: ClaudeCallOptions,
  ): Promise<AgentResponse> {
    const fullPrompt = `/${skillName}\n\n${prompt}`;
    const spawnOptions: ClaudeSpawnOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      allowedTools: options.allowedTools,
      model: options.model,
      maxTurns: options.maxTurns,
      permissionMode: options.permissionMode,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
      anthropicApiKey: options.anthropicApiKey,
    };

    const result = await executeClaudeCli(fullPrompt, spawnOptions);

    if (!result.success && result.error) {
      log.error('Skill query failed', { skill: skillName, error: result.error });
    }

    return {
      agent: `skill:${skillName}`,
      status: result.success ? 'done' : 'blocked',
      content: result.content,
      timestamp: new Date(),
      sessionId: result.sessionId,
      error: result.error,
    };
  }

  /**
   * Detect judge rule index from [JUDGE:N] tag pattern.
   * Returns 0-based rule index, or -1 if no match.
   */
  static detectJudgeIndex(content: string): number {
    const regex = /\[JUDGE:(\d+)\]/i;
    const match = content.match(regex);
    if (match?.[1]) {
      const index = Number.parseInt(match[1], 10) - 1;
      return index >= 0 ? index : -1;
    }
    return -1;
  }

  /**
   * Build the prompt for the AI judge that evaluates agent output against ai() conditions.
   */
  static buildJudgePrompt(
    agentOutput: string,
    aiConditions: { index: number; text: string }[],
  ): string {
    const conditionList = aiConditions
      .map((c) => `| ${c.index + 1} | ${c.text} |`)
      .join('\n');

    return getPrompt('claude.judgePrompt', undefined, { agentOutput, conditionList });
  }

  /**
   * Call AI judge to evaluate agent output against ai() conditions.
   * Uses a lightweight model (haiku) for cost efficiency.
   * Returns 0-based index of the matched ai() condition, or -1 if no match.
   */
  async callAiJudge(
    agentOutput: string,
    aiConditions: { index: number; text: string }[],
    options: { cwd: string },
  ): Promise<number> {
    const prompt = ClaudeClient.buildJudgePrompt(agentOutput, aiConditions);

    const spawnOptions: ClaudeSpawnOptions = {
      cwd: options.cwd,
      model: 'haiku',
      maxTurns: 1,
    };

    const result = await executeClaudeCli(prompt, spawnOptions);
    if (!result.success) {
      log.error('AI judge call failed', { error: result.error });
      return -1;
    }

    return ClaudeClient.detectJudgeIndex(result.content);
  }
}

// ---- Backward-compatible module-level functions ----

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

export async function callClaudeAgent(
  claudeAgentName: string,
  prompt: string,
  options: ClaudeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callAgent(claudeAgentName, prompt, options);
}

export async function callClaudeSkill(
  skillName: string,
  prompt: string,
  options: ClaudeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callSkill(skillName, prompt, options);
}

export function detectJudgeIndex(content: string): number {
  return ClaudeClient.detectJudgeIndex(content);
}

export function buildJudgePrompt(
  agentOutput: string,
  aiConditions: { index: number; text: string }[],
): string {
  return ClaudeClient.buildJudgePrompt(agentOutput, aiConditions);
}

export async function callAiJudge(
  agentOutput: string,
  aiConditions: { index: number; text: string }[],
  options: { cwd: string },
): Promise<number> {
  return defaultClient.callAiJudge(agentOutput, aiConditions, options);
}
