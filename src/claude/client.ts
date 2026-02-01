/**
 * High-level Claude client for agent interactions
 *
 * Uses the Claude Agent SDK for native TypeScript integration.
 */

import { executeClaudeCli, type ClaudeSpawnOptions, type StreamCallback, type PermissionHandler, type AskUserQuestionHandler } from './process.js';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AgentResponse, Status, PermissionMode } from '../models/types.js';
import { createLogger } from '../utils/debug.js';

const log = createLogger('client');

/** Options for calling Claude */
export interface ClaudeCallOptions {
  cwd: string;
  sessionId?: string;
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  /** SDK agents to register for sub-agent execution */
  agents?: Record<string, AgentDefinition>;
  /** Permission mode for tool execution (from workflow step) */
  permissionMode?: PermissionMode;
  /** Enable streaming mode with callback for real-time output */
  onStream?: StreamCallback;
  /** Custom permission handler for interactive permission prompts */
  onPermissionRequest?: PermissionHandler;
  /** Custom handler for AskUserQuestion tool */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Bypass all permission checks (sacrifice-my-pc mode) */
  bypassPermissions?: boolean;
  /** Anthropic API key to inject via env (bypasses CLI auth) */
  anthropicApiKey?: string;
}

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
  // Limit pattern length
  if (pattern.length > 200) {
    return false;
  }

  // Dangerous patterns that can cause ReDoS
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

/** Determine status from result */
function determineStatus(
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

/** Call Claude with an agent prompt */
export async function callClaude(
  agentType: string,
  prompt: string,
  options: ClaudeCallOptions
): Promise<AgentResponse> {
  const spawnOptions: ClaudeSpawnOptions = {
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

  const result = await executeClaudeCli(prompt, spawnOptions);
  const status = determineStatus(result);

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
export async function callClaudeCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: ClaudeCallOptions
): Promise<AgentResponse> {
  const spawnOptions: ClaudeSpawnOptions = {
    cwd: options.cwd,
    sessionId: options.sessionId,
    allowedTools: options.allowedTools,
    model: options.model,
    maxTurns: options.maxTurns,
    systemPrompt,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    onPermissionRequest: options.onPermissionRequest,
    onAskUserQuestion: options.onAskUserQuestion,
    bypassPermissions: options.bypassPermissions,
    anthropicApiKey: options.anthropicApiKey,
  };

  const result = await executeClaudeCli(prompt, spawnOptions);
  const status = determineStatus(result);

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

/**
 * Detect judge rule index from [JUDGE:N] tag pattern.
 * Returns 0-based rule index, or -1 if no match.
 */
export function detectJudgeIndex(content: string): number {
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
export function buildJudgePrompt(
  agentOutput: string,
  aiConditions: { index: number; text: string }[],
): string {
  const conditionList = aiConditions
    .map((c) => `| ${c.index + 1} | ${c.text} |`)
    .join('\n');

  return [
    '# Judge Task',
    '',
    'You are a judge evaluating an agent\'s output against a set of conditions.',
    'Read the agent output below, then determine which condition best matches.',
    '',
    '## Agent Output',
    '```',
    agentOutput,
    '```',
    '',
    '## Conditions',
    '| # | Condition |',
    '|---|-----------|',
    conditionList,
    '',
    '## Instructions',
    'Output ONLY the tag `[JUDGE:N]` where N is the number of the best matching condition.',
    'Do not output anything else.',
  ].join('\n');
}

/**
 * Call AI judge to evaluate agent output against ai() conditions.
 * Uses a lightweight model (haiku) for cost efficiency.
 * Returns 0-based index of the matched ai() condition, or -1 if no match.
 */
export async function callAiJudge(
  agentOutput: string,
  aiConditions: { index: number; text: string }[],
  options: { cwd: string },
): Promise<number> {
  const prompt = buildJudgePrompt(agentOutput, aiConditions);

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

  return detectJudgeIndex(result.content);
}

/** Call a Claude Code built-in agent (using claude --agent flag if available) */
export async function callClaudeAgent(
  claudeAgentName: string,
  prompt: string,
  options: ClaudeCallOptions
): Promise<AgentResponse> {
  // For now, use system prompt approach
  // In future, could use --agent flag if Claude CLI supports it
  const systemPrompt = `You are the ${claudeAgentName} agent. Follow the standard ${claudeAgentName} workflow.`;

  return callClaudeCustom(claudeAgentName, prompt, systemPrompt, options);
}

/** Call a Claude Code skill (using /skill command) */
export async function callClaudeSkill(
  skillName: string,
  prompt: string,
  options: ClaudeCallOptions
): Promise<AgentResponse> {
  // Prepend skill invocation to prompt
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
