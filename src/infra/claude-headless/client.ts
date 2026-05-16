import { randomUUID } from 'node:crypto';
import type { AgentResponse, PermissionMode } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { prepareClaudeMcpConfig } from '../claude/mcp-config.js';
import {
  type ClaudePermissionExpression,
  taktPermissionModeToClaudeExpression,
} from '../claude/permission-mode-expression.js';
import {
  HEADLESS_ABORTED_MESSAGE,
  type ExecError,
  runHeadlessCli,
} from './headless-spawn.js';
import {
  aggregateResultFromStdout,
  extractSessionIdFromStdout,
} from './stream-json-lines.js';
import { buildClaudeHeadlessResponse } from './result-response.js';
import type { ClaudeHeadlessCallOptions } from './types.js';
import { buildRateLimitedResponseFields, containsRateLimitError, containsRateLimitMarker } from '../rate-limit/detection.js';

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
  const preparedMcpConfig = await prepareClaudeMcpConfig(options.mcpServers);
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

  if (options.outputSchema) {
    args.push('--json-schema', JSON.stringify(options.outputSchema));
  }

  if (preparedMcpConfig.path) {
    args.push('--mcp-config', preparedMcpConfig.path);
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
    cleanup: preparedMcpConfig.cleanup,
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
    const parsed = aggregateResultFromStdout(stdout);
    const sessionId = extractSessionIdFromStdout(stdout) ?? expectedSessionId;
    response = buildClaudeHeadlessResponse({
      agentName,
      parsed,
      stdout,
      stderr,
      sessionId,
      outputSchema: options.outputSchema,
      onStream: options.onStream,
    });
  } catch (raw) {
    const error = raw as ExecError;
    const message = classifyError(error, options);
    const hasStreamMarker = containsRateLimitMarker(error.stdout) || containsRateLimitMarker(error.stderr);
    const isRateLimited = containsRateLimitError(message) || containsRateLimitError(error.stderr) || hasStreamMarker;
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
      timestamp: new Date(),
      sessionId: options.sessionId,
      ...(isRateLimited
        ? buildRateLimitedResponseFields('claude', hasStreamMarker ? 'stream_marker' : 'sdk_error', error.stdout ?? error.stderr ?? message)
        : {
          status: 'error' as const,
          content: message,
          error: message,
        }),
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
