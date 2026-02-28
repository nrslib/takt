/**
 * Type definitions for the provider abstraction layer
 */

import type { StreamCallback, PermissionHandler, AskUserQuestionHandler } from '../claude/index.js';
import type { AgentResponse, PermissionMode, McpServerConfig, MovementProviderOptions } from '../../core/models/index.js';

/** Agent setup configuration — determines HOW the provider invokes the agent */
export interface AgentSetup {
  /** Display name for this agent */
  name: string;
  /** System prompt for the agent (persona content, inline prompt, etc.) */
  systemPrompt?: string;
  /** Delegate to a Claude Code agent by name (Claude provider only) */
  claudeAgent?: string;
  /** Delegate to a Claude Code skill by name (Claude provider only) */
  claudeSkill?: string;
}

/** Runtime options passed at call time */
export interface ProviderCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  providerOptions?: MovementProviderOptions;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  bypassPermissions?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  opencodeApiKey?: string;
  cursorApiKey?: string;
  copilotGithubToken?: string;
  outputSchema?: Record<string, unknown>;
}

/** A configured agent ready to be called */
export interface ProviderAgent {
  call(prompt: string, options: ProviderCallOptions): Promise<AgentResponse>;
}

/** Provider interface — creates configured agents from setup */
export interface Provider {
  setup(config: AgentSetup): ProviderAgent;
}

/** Provider type */
export type ProviderType = 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot' | 'mock';
