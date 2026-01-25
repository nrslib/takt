/**
 * Agent execution runners
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  callClaude,
  callClaudeCustom,
  callClaudeAgent,
  callClaudeSkill,
  ClaudeCallOptions,
} from '../claude/client.js';
import { type StreamCallback, type PermissionHandler, type AskUserQuestionHandler } from '../claude/process.js';
import { loadCustomAgents, loadAgentPrompt } from '../config/loader.js';
import type { AgentResponse, CustomAgentConfig } from '../models/types.js';

export type { StreamCallback };

/** Common options for running agents */
export interface RunAgentOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
  /** Resolved path to agent prompt file */
  agentPath?: string;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Bypass all permission checks (sacrifice-my-pc mode) */
  bypassPermissions?: boolean;
}

/** Default tools for each built-in agent type */
const DEFAULT_AGENT_TOOLS: Record<string, string[]> = {
  coder: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch'],
  architect: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  supervisor: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
};

/** Get git diff for review context */
export function getGitDiff(cwd: string): string {
  try {
    // First check if HEAD exists (new repos may not have any commits)
    try {
      execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      // No commits yet, return empty diff
      return '';
    }

    const diff = execSync('git diff HEAD', {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 10, // 10MB
      stdio: 'pipe',
    });
    return diff.trim();
  } catch {
    return '';
  }
}

/** Run a custom agent */
export async function runCustomAgent(
  agentConfig: CustomAgentConfig,
  task: string,
  options: RunAgentOptions
): Promise<AgentResponse> {
  // If agent references a Claude Code agent
  if (agentConfig.claudeAgent) {
    const callOptions: ClaudeCallOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      allowedTools: agentConfig.allowedTools,
      model: options.model || agentConfig.model,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
    };
    return callClaudeAgent(agentConfig.claudeAgent, task, callOptions);
  }

  // If agent references a Claude Code skill
  if (agentConfig.claudeSkill) {
    const callOptions: ClaudeCallOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      allowedTools: agentConfig.allowedTools,
      model: options.model || agentConfig.model,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
    };
    return callClaudeSkill(agentConfig.claudeSkill, task, callOptions);
  }

  // Custom agent with prompt
  const systemPrompt = loadAgentPrompt(agentConfig);
  const tools = agentConfig.allowedTools || ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
  const callOptions: ClaudeCallOptions = {
    cwd: options.cwd,
    sessionId: options.sessionId,
    allowedTools: tools,
    model: options.model || agentConfig.model,
    statusPatterns: agentConfig.statusPatterns,
    onStream: options.onStream,
    onPermissionRequest: options.onPermissionRequest,
    onAskUserQuestion: options.onAskUserQuestion,
    bypassPermissions: options.bypassPermissions,
  };

  return callClaudeCustom(agentConfig.name, task, systemPrompt, callOptions);
}

/**
 * Load agent prompt from file path.
 */
function loadAgentPromptFromPath(agentPath: string): string {
  if (!existsSync(agentPath)) {
    throw new Error(`Agent file not found: ${agentPath}`);
  }
  return readFileSync(agentPath, 'utf-8');
}

/**
 * Get agent name from path or spec.
 * For agents in subdirectories, includes parent dir for pattern matching.
 * - "~/.takt/agents/default/coder.md" -> "coder"
 * - "~/.takt/agents/research/supervisor.md" -> "research/supervisor"
 * - "./coder.md" -> "coder"
 * - "coder" -> "coder"
 */
function extractAgentName(agentSpec: string): string {
  if (!agentSpec.endsWith('.md')) {
    return agentSpec;
  }

  const name = basename(agentSpec, '.md');
  const dir = basename(dirname(agentSpec));

  // If in 'default' directory, just use the agent name
  // Otherwise, include the directory for disambiguation (e.g., 'research/supervisor')
  if (dir === 'default' || dir === 'agents' || dir === '.') {
    return name;
  }

  return `${dir}/${name}`;
}

/** Run an agent by name or path */
export async function runAgent(
  agentSpec: string,
  task: string,
  options: RunAgentOptions
): Promise<AgentResponse> {
  const agentName = extractAgentName(agentSpec);

  // If agentPath is provided (from workflow), use it to load prompt
  if (options.agentPath) {
    if (!existsSync(options.agentPath)) {
      throw new Error(`Agent file not found: ${options.agentPath}`);
    }
    const systemPrompt = loadAgentPromptFromPath(options.agentPath);
    const tools = DEFAULT_AGENT_TOOLS[agentName] || ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

    const callOptions: ClaudeCallOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      allowedTools: tools,
      model: options.model,
      systemPrompt,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
    };

    return callClaude(agentName, task, callOptions);
  }

  // Fallback: Look for custom agent by name
  const customAgents = loadCustomAgents();
  const agentConfig = customAgents.get(agentName);

  if (agentConfig) {
    return runCustomAgent(agentConfig, task, options);
  }

  throw new Error(`Unknown agent: ${agentSpec}`);
}
