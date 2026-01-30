/**
 * Provider abstraction layer
 *
 * Provides a unified interface for different agent providers (Claude, Codex, Mock).
 * This enables adding new providers without modifying the runner logic.
 */

import type { StreamCallback, PermissionHandler, AskUserQuestionHandler } from '../claude/process.js';
import type { AgentResponse, PermissionMode } from '../models/types.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { MockProvider } from './mock.js';

/** Common options for all providers */
export interface ProviderCallOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  /** Maximum number of agentic turns */
  maxTurns?: number;
  /** Permission mode for tool execution (from workflow step) */
  permissionMode?: PermissionMode;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  bypassPermissions?: boolean;
}

/** Provider interface - all providers must implement this */
export interface Provider {
  /** Call the provider with a prompt (using systemPrompt from options if provided) */
  call(agentName: string, prompt: string, options: ProviderCallOptions): Promise<AgentResponse>;

  /** Call the provider with explicit system prompt */
  callCustom(agentName: string, prompt: string, systemPrompt: string, options: ProviderCallOptions): Promise<AgentResponse>;
}

/** Provider type */
export type ProviderType = 'claude' | 'codex' | 'mock';

/** Provider registry */
const providers: Record<ProviderType, Provider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  mock: new MockProvider(),
};

/**
 * Get a provider instance by type
 */
export function getProvider(type: ProviderType): Provider {
  const provider = providers[type];
  if (!provider) {
    throw new Error(`Unknown provider type: ${type}`);
  }
  return provider;
}

/**
 * Register a custom provider
 */
export function registerProvider(type: string, provider: Provider): void {
  (providers as Record<string, Provider>)[type] = provider;
}
