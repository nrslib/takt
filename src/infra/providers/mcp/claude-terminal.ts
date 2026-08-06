/**
 * Claude terminal CLI MCP adapter (issue #1137).
 *
 * Thin wrapper over the shared Claude CLI adapter factory. The provider name
 * `'claude-terminal'` is the only difference from `claude`
 * (Policy「DRY」).
 */

import { createClaudeCliMcpAdapter } from './claude-cli-shared.js';

export function createClaudeTerminalMcpAdapter() {
  return createClaudeCliMcpAdapter('claude-terminal');
}