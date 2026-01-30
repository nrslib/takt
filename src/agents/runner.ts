/**
 * Agent execution runners
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  callClaudeAgent,
  callClaudeSkill,
  type ClaudeCallOptions,
} from '../claude/client.js';
import { type StreamCallback, type PermissionHandler, type AskUserQuestionHandler } from '../claude/process.js';
import { loadCustomAgents, loadAgentPrompt } from '../config/loader.js';
import { loadGlobalConfig } from '../config/globalConfig.js';
import { loadProjectConfig } from '../config/projectConfig.js';
import { getProvider, type ProviderType, type ProviderCallOptions } from '../providers/index.js';
import type { AgentResponse, CustomAgentConfig, PermissionMode } from '../models/types.js';
import { createLogger } from '../utils/debug.js';

const log = createLogger('runner');

export type { StreamCallback };

/** Common options for running agents */
export interface RunAgentOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
  provider?: 'claude' | 'codex' | 'mock';
  /** Resolved path to agent prompt file */
  agentPath?: string;
  /** Allowed tools for this agent run */
  allowedTools?: string[];
  /** Maximum number of agentic turns */
  maxTurns?: number;
  /** Permission mode for tool execution (from workflow step) */
  permissionMode?: PermissionMode;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Bypass all permission checks (sacrifice-my-pc mode) */
  bypassPermissions?: boolean;
}

function resolveProvider(cwd: string, options?: RunAgentOptions, agentConfig?: CustomAgentConfig): ProviderType {
  // Mock provider must be explicitly specified (no fallback)
  if (options?.provider) return options.provider;
  if (agentConfig?.provider) return agentConfig.provider;
  const projectConfig = loadProjectConfig(cwd);
  if (projectConfig.provider) return projectConfig.provider;
  try {
    const globalConfig = loadGlobalConfig();
    if (globalConfig.provider) return globalConfig.provider;
  } catch {
    // Ignore missing global config; fallback below
  }
  return 'claude';
}

function resolveModel(cwd: string, options?: RunAgentOptions, agentConfig?: CustomAgentConfig): string | undefined {
  if (options?.model) return options.model;
  if (agentConfig?.model) return agentConfig.model;
  try {
    const globalConfig = loadGlobalConfig();
    if (globalConfig.model) return globalConfig.model;
  } catch {
    // Ignore missing global config
  }
  return undefined;
}


/** Run a custom agent */
export async function runCustomAgent(
  agentConfig: CustomAgentConfig,
  task: string,
  options: RunAgentOptions
): Promise<AgentResponse> {
  const allowedTools = options.allowedTools ?? agentConfig.allowedTools;

  // If agent references a Claude Code agent
  if (agentConfig.claudeAgent) {
    const callOptions: ClaudeCallOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      allowedTools,
      maxTurns: options.maxTurns,
      model: resolveModel(options.cwd, options, agentConfig),
      permissionMode: options.permissionMode,
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
      allowedTools,
      maxTurns: options.maxTurns,
      model: resolveModel(options.cwd, options, agentConfig),
      permissionMode: options.permissionMode,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
    };
    return callClaudeSkill(agentConfig.claudeSkill, task, callOptions);
  }

  // Custom agent with prompt
  const systemPrompt = loadAgentPrompt(agentConfig);

  const providerType = resolveProvider(options.cwd, options, agentConfig);
  const provider = getProvider(providerType);

  const callOptions: ProviderCallOptions = {
    cwd: options.cwd,
    sessionId: options.sessionId,
    allowedTools,
    maxTurns: options.maxTurns,
    model: resolveModel(options.cwd, options, agentConfig),
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    onPermissionRequest: options.onPermissionRequest,
    onAskUserQuestion: options.onAskUserQuestion,
    bypassPermissions: options.bypassPermissions,
  };

  return provider.callCustom(agentConfig.name, task, systemPrompt, callOptions);
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
  log.debug('Running agent', {
    agentSpec,
    agentName,
    provider: options.provider,
    model: options.model,
    hasAgentPath: !!options.agentPath,
    hasSession: !!options.sessionId,
    permissionMode: options.permissionMode,
  });

  // If agentPath is provided (from workflow), use it to load prompt
  if (options.agentPath) {
    if (!existsSync(options.agentPath)) {
      throw new Error(`Agent file not found: ${options.agentPath}`);
    }
    const systemPrompt = loadAgentPromptFromPath(options.agentPath);

    const providerType = resolveProvider(options.cwd, options);
    const provider = getProvider(providerType);

    const callOptions: ProviderCallOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns,
      model: resolveModel(options.cwd, options),
      systemPrompt,
      permissionMode: options.permissionMode,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
    };

    return provider.call(agentName, task, callOptions);
  }

  // Fallback: Look for custom agent by name
  const customAgents = loadCustomAgents();
  const agentConfig = customAgents.get(agentName);

  if (agentConfig) {
    return runCustomAgent(agentConfig, task, options);
  }

  throw new Error(`Unknown agent: ${agentSpec}`);
}
