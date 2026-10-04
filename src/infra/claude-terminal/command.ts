import { randomUUID } from 'node:crypto';
import {
  taktPermissionModeToClaudeExpression,
  type ClaudePermissionExpression,
} from '../claude/permission-mode-expression.js';
import type { BuildClaudeTerminalCommandOptions, ClaudeTerminalCommand } from './types.js';
import {
  createClaudeCliReadonlyArtifactHook,
  resolveReadonlyArtifactReadPaths,
} from '../claude/readonly-artifact-access.js';

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
  const isStrictReadonly = options.internalAgentIsolation === 'strict-readonly';
  const readonlyArtifactPaths = isStrictReadonly
    ? resolveReadonlyArtifactReadPaths({ ...options, cwd: options.cwd ?? process.cwd() })
    : [];
  const permissionMode = resolvePermissionMode(options);
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (isStrictReadonly) {
    const readOnlyTools = readonlyArtifactPaths.length > 0 ? 'Read' : '';
    args.push('--tools', readOnlyTools, '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands');
  } else if (options.skillsEnabled === false) {
    args.push('--disable-slash-commands');
  }
  if (!isStrictReadonly && options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowed-tools', options.allowedTools.join(','));
  }
  if (!isStrictReadonly && options.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath);
  }
  if (options.preparedMcpArgs && options.preparedMcpArgs.length > 0) {
    args.push(...options.preparedMcpArgs);
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
  if (readonlyArtifactPaths.length > 0) {
    args.push('--settings', JSON.stringify({
      hooks: {
        PreToolUse: [createClaudeCliReadonlyArtifactHook(readonlyArtifactPaths, options.cwd ?? process.cwd())],
      },
    }));
  }

  return {
    executable: options.pathToClaudeCodeExecutable ?? 'claude',
    args,
  };
}

export function createClaudeTerminalSessionName(): string {
  return `takt-claude-terminal-${randomUUID()}`;
}
