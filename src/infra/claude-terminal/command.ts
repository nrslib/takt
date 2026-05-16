import { randomUUID } from 'node:crypto';
import {
  taktPermissionModeToClaudeExpression,
  type ClaudePermissionExpression,
} from '../claude/permission-mode-expression.js';
import type { BuildClaudeTerminalCommandOptions, ClaudeTerminalCommand } from './types.js';

function resolvePermissionMode(options: BuildClaudeTerminalCommandOptions): ClaudePermissionExpression | undefined {
  if (options.bypassPermissions) {
    return 'bypassPermissions';
  }
  if (options.permissionMode === undefined) {
    return undefined;
  }
  return taktPermissionModeToClaudeExpression(options.permissionMode);
}

export function buildClaudeTerminalCommand(
  options: BuildClaudeTerminalCommandOptions,
): ClaudeTerminalCommand {
  const args: string[] = [];
  const permissionMode = resolvePermissionMode(options);

  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowed-tools', options.allowedTools.join(','));
  }
  if (options.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath);
  }
  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }
  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  } else if (options.newSessionId) {
    args.push('--session-id', options.newSessionId);
  }
  if (options.systemPrompt?.trim()) {
    args.push('--system-prompt', options.systemPrompt.trim());
  }
  if (options.outputSchema) {
    args.push('--json-schema', JSON.stringify(options.outputSchema));
  }

  return {
    executable: options.pathToClaudeCodeExecutable ?? 'claude',
    args,
  };
}

export function createClaudeTerminalSessionName(): string {
  return `takt-claude-terminal-${randomUUID()}`;
}
