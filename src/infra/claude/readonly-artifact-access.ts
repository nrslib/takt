import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PermissionMode } from '../../core/models/index.js';
import type { InternalAgentIsolation } from '../../shared/types/provider.js';

export interface ReadonlyArtifactReadRequest {
  readonly cwd: string;
  readonly allowReadonlyFileRead?: boolean;
  readonly readonlyFileReadPaths?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly permissionMode?: PermissionMode;
  readonly internalAgentIsolation?: InternalAgentIsolation;
}

export interface ClaudeCliReadonlyArtifactHook {
  readonly matcher: 'Read';
  readonly hooks: readonly [{
    readonly type: 'command';
    readonly command: string;
    readonly args: readonly string[];
  }];
}

/** Resolve the explicit /verify Read opt-in to existing, regular artifact files. */
export function resolveReadonlyArtifactReadPaths(options: ReadonlyArtifactReadRequest): string[] {
  if (
    options.allowReadonlyFileRead !== true
    || options.permissionMode !== 'readonly'
    || options.internalAgentIsolation !== 'strict-readonly'
    || options.allowedTools?.length !== 1
    || options.allowedTools[0] !== 'Read'
    || !Array.isArray(options.readonlyFileReadPaths)
    || options.readonlyFileReadPaths.length === 0
  ) {
    return [];
  }

  const resolvedPaths = new Set<string>();
  for (const path of options.readonlyFileReadPaths) {
    if (typeof path !== 'string' || path.trim().length === 0 || path.includes('\0')) {
      return [];
    }
    try {
      const resolvedPath = realpathSync(resolve(options.cwd, path));
      if (!statSync(resolvedPath).isFile()) {
        return [];
      }
      resolvedPaths.add(resolvedPath);
    } catch {
      return [];
    }
  }
  return [...resolvedPaths];
}

/** Compare the actual file reached by a Read request with the exact artifacts. */
export function isReadonlyArtifactReadAllowed(
  filePath: unknown,
  cwd: string,
  allowedPaths: readonly string[],
): boolean {
  if (typeof filePath !== 'string' || filePath.trim().length === 0 || filePath.includes('\0') || allowedPaths.length === 0) {
    return false;
  }
  try {
    const resolvedPath = realpathSync(resolve(cwd, filePath));
    return statSync(resolvedPath).isFile() && allowedPaths.includes(resolvedPath);
  } catch {
    return false;
  }
}

/** Build a CLI PreToolUse hook without a shell command string or helper file. */
export function createClaudeCliReadonlyArtifactHook(
  allowedPaths: readonly string[],
  cwd: string,
): ClaudeCliReadonlyArtifactHook {
  const source = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const allowed = new Set(${JSON.stringify(allowedPaths)});`,
    `const fallbackCwd = ${JSON.stringify(cwd)};`,
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  let allowedRead = false;',
    '  try {',
    '    const event = JSON.parse(input);',
    "    const filePath = event.tool_name === 'Read' ? event.tool_input?.file_path : undefined;",
    "    const cwd = typeof event.cwd === 'string' ? event.cwd : fallbackCwd;",
    "    if (typeof filePath === 'string' && filePath.trim() !== '' && !filePath.includes('\\0')) {",
    '      const resolvedPath = fs.realpathSync(path.resolve(cwd, filePath));',
    '      allowedRead = fs.statSync(resolvedPath).isFile() && allowed.has(resolvedPath);',
    '    }',
    '  } catch {}',
    '  if (allowedRead) process.exit(0);',
    "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Read is limited to verification artifacts' } }));",
    '});',
  ].join('\n');

  return {
    matcher: 'Read',
    hooks: [{ type: 'command', command: process.execPath, args: ['-e', source] }],
  };
}
