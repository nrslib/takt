/**
 * Claude headless CLI MCP adapter (issue #1137).
 *
 * Thin wrapper over the shared Claude CLI adapter factory. The provider name
 * `'claude'` is the only difference from `claude-terminal`
 * (Policy「DRY」).
 */

import { createClaudeCliMcpAdapter } from './claude-cli-shared.js';

export function createClaudeHeadlessMcpAdapter() {
  return createClaudeCliMcpAdapter('claude');
}