/**
 * Provider MCP adapter registry (issue #1137).
 *
 * The factory returns the adapter for a given provider type. The engine layer
 * calls only `createMcpAdapter(provider)`; it never branches on provider names
 * for MCP config format (plan MCP-ADAPTER-SPLIT).
 */

import type { ProviderType } from '../../../shared/types/provider.js';
import type { ProviderMcpAdapter } from './types.js';
import { createClaudeSdkMcpAdapter } from './claude-sdk.js';
import { createClaudeHeadlessMcpAdapter } from './claude-headless.js';
import { createClaudeTerminalMcpAdapter } from './claude-terminal.js';
import { createCodexMcpAdapter } from './codex.js';
import { createOpenCodeMcpAdapter } from './opencode.js';
import { createCursorMcpAdapter } from './cursor.js';
import { createCopilotMcpAdapter } from './copilot.js';
import { createKiroMcpAdapter } from './kiro.js';
import { createMockMcpAdapter } from './mock.js';
import { createUnsupportedMcpAdapter } from './adapter.js';

export type {
  ProviderMcpAdapter,
  ProviderMcpContext,
  ProviderMcpValidationContext,
  PreparedProviderMcp,
  ResolvedMcpServers,
  McpServerConfig,
} from './types.js';

/** Factory that returns the adapter for a given provider type. */
export function createMcpAdapter(provider: ProviderType): ProviderMcpAdapter {
  switch (provider) {
    case 'claude-sdk':
      return createClaudeSdkMcpAdapter();
    case 'claude':
      return createClaudeHeadlessMcpAdapter();
    case 'claude-terminal':
      return createClaudeTerminalMcpAdapter();
    case 'codex':
      return createCodexMcpAdapter();
    case 'opencode':
      return createOpenCodeMcpAdapter();
    case 'cursor':
      return createCursorMcpAdapter();
    case 'copilot':
      return createCopilotMcpAdapter();
    case 'kiro':
      return createKiroMcpAdapter();
    case 'mock':
      return createMockMcpAdapter();
    case 'pi':
    case 'deepseek-harness':
      return createUnsupportedMcpAdapter(provider);
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unsupported provider for MCP adapter: ${String(exhaustive)}`);
    }
  }
}
