import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, PermissionMode } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import {
  type ClaudePermissionExpression,
  taktPermissionModeToClaudeExpression,
} from '../claude/permission-mode-expression.js';
import {
  HEADLESS_ABORTED_MESSAGE,
  type ExecError,
  runHeadlessCli,
} from './headless-spawn.js';
import { aggregateContentFromStdout, extractSessionIdFromStdout } from './stream-json-lines.js';
import type { ClaudeHeadlessCallOptions } from './types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const log = createLogger('claude-headless');

function resolveCliPermissionMode(
  mode: PermissionMode | undefined,
  bypassPermissions: boolean | undefined,
): ClaudePermissionExpression {
  if (bypassPermissions) {
    return 'bypassPermissions';
  }
  if (mode !== undefined) {
    return taktPermissionModeToClaudeExpression(mode);
  }
  return 'default';
}

function resolveSessionArgs(options: ClaudeHeadlessCallOptions): { args: string[]; sessionId: string } {
  if (options.sessionId) {
    if (!UUID_RE.test(options.sessionId)) {
      throw new Error(`Claude headless sessionId must be a valid UUID: ${options.sessionId}`);
    }
    return {
      args: ['--resume', options.sessionId],
      sessionId: options.sessionId,
    };
  }

  const sessionId = randomUUID();
  return {
    args: ['--session-id', sessionId],
    sessionId,
  };
}

type PreparedSpawnResources = {
  mcpConfigArg?: string;
  cleanup: () => Promise<void>;
};

async function prepareMcpConfig(options: ClaudeHeadlessCallOptions): Promise<PreparedSpawnResources> {
  if (!options.mcpServers || Object.keys(options.mcpServers).length === 0) {
    return { cleanup: async () => {} };
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'takt-claude-mcp-'));
  const configPath = join(tempDir, 'mcp-config.json');

  try {
    await chmod(tempDir, 0o700);
    await writeFile(configPath, JSON.stringify({ mcpServers: options.mcpServers }), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await chmod(configPath, 0o600);
  } catch (raw) {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (cleanupRaw) {
      log.error('Failed to clean up Claude MCP temp directory after prepare failure', {
        error: getErrorMessage(cleanupRaw),
        tempDir,
      });
    }
    throw raw;
  }

  return {
    mcpConfigArg: configPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function buildSettingsArg(options: ClaudeHeadlessCallOptions): string | undefined {
  const sandbox = options.sandbox;
  if (!sandbox) {
    return undefined;
  }

  const settingsSandbox = {
    ...(sandbox.allowUnsandboxedCommands !== undefined
      ? { allowUnsandboxedCommands: sandbox.allowUnsandboxedCommands }
      : {}),
    ...(sandbox.excludedCommands !== undefined
      ? { excludedCommands: sandbox.excludedCommands }
      : {}),
  };

  if (Object.keys(settingsSandbox).length === 0) {
    return undefined;
  }

  return JSON.stringify({ sandbox: settingsSandbox });
}

async function buildSpawnArgs(
  prompt: string,
  options: ClaudeHeadlessCallOptions,
): Promise<{ args: string[]; expectedSessionId: string; cleanup: () => Promise<void> }> {
  const session = resolveSessionArgs(options);
  const preparedResources = await prepareMcpConfig(options);
  const args: string[] = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    resolveCliPermissionMode(options.permissionMode, options.bypassPermissions),
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowed-tools', options.allowedTools.join(','));
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }

  if (options.systemPrompt?.trim()) {
    args.push('--system-prompt', options.systemPrompt.trim());
  }

  if (preparedResources.mcpConfigArg) {
    args.push('--mcp-config', preparedResources.mcpConfigArg);
  }

  const settings = buildSettingsArg(options);
  if (settings) {
    args.push('--settings', settings);
  }

  args.push(...session.args);
  args.push('--', prompt);
  return {
    args,
    expectedSessionId: session.sessionId,
    cleanup: preparedResources.cleanup,
  };
}

function classifyError(error: ExecError, options: ClaudeHeadlessCallOptions): string {
  if (options.abortSignal?.aborted || error.name === 'AbortError') {
    return HEADLESS_ABORTED_MESSAGE;
  }
  if (error.code === 'ENOENT') {
    return 'claude CLI not found. Install Claude Code and ensure `claude` is in PATH, or set claude_cli_path in config.';
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return getErrorMessage(error);
  }
  if (typeof error.code === 'number') {
    const detail = (error.stderr ?? error.stdout ?? '').trim() || getErrorMessage(error);
    return `Claude CLI failed (${error.code}): ${detail}`;
  }
  return getErrorMessage(error);
}

export async function callClaudeHeadless(
  agentName: string,
  prompt: string,
  options: ClaudeHeadlessCallOptions,
): Promise<AgentResponse> {
  let cleanup: (() => Promise<void>) | undefined;
  let response: AgentResponse;

  try {
    const prepared = await buildSpawnArgs(prompt, options);
    cleanup = prepared.cleanup;
    const { args, expectedSessionId } = prepared;
    const { stdout, stderr } = await runHeadlessCli(args, options);
    const content = aggregateContentFromStdout(stdout);
    const sessionId = extractSessionIdFromStdout(stdout) ?? expectedSessionId;

    if (!content) {
      const hint = stderr.trim() || stdout.trim().slice(0, 500) || 'no parseable stream-json output';
      const message = `Claude CLI returned no assistant text. ${hint}`;
      if (options.onStream) {
        options.onStream({
          type: 'result',
          data: {
            result: '',
            success: false,
            error: message,
            sessionId: sessionId ?? '',
          },
        });
      }
      response = {
        persona: agentName,
        status: 'error',
        content: message,
        timestamp: new Date(),
        sessionId,
        error: message,
      };
    } else {
      if (options.onStream) {
        options.onStream({
          type: 'result',
          data: {
            result: content,
            success: true,
            sessionId: sessionId ?? '',
          },
        });
      }

      response = {
        persona: agentName,
        status: 'done',
        content,
        timestamp: new Date(),
        sessionId,
      };
    }
  } catch (raw) {
    const error = raw as ExecError;
    const message = classifyError(error, options);
    if (options.onStream) {
      options.onStream({
        type: 'result',
        data: {
          result: '',
          success: false,
          error: message,
          sessionId: options.sessionId ?? '',
        },
      });
    }
    response = {
      persona: agentName,
      status: 'error',
      content: message,
      timestamp: new Date(),
      sessionId: options.sessionId,
      error: message,
    };
  }

  try {
    await cleanup?.();
  } catch (raw) {
    const cleanupError = raw as Error;
    log.error('Failed to clean up Claude MCP config', {
      agentName,
      error: getErrorMessage(cleanupError),
    });
  }

  return response;
}
