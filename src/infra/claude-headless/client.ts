import { randomUUID } from 'node:crypto';
import type { AgentResponse, PermissionMode } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { prepareClaudeMcpConfig } from '../claude/mcp-config.js';
import { assertClaudeSkillsDisableSupported } from '../claude/cli-capability.js';
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

type HeadlessRateLimitOutcome = {
  text: string;
  source: 'sdk_error' | 'stream_marker';
};

function findRateLimitText(
  text: string | undefined,
  predicate: (candidate: string) => boolean,
): string | undefined {
  if (!text) {
    return undefined;
  }

  const parsed = aggregateResultFromStdout(text);
  return [parsed.error, parsed.content, parsed.displayText, text.trim()].find(
    (candidate): candidate is string => candidate !== undefined && predicate(candidate),
  );
}

function selectRateLimitOutcome(error: ExecError, message: string): HeadlessRateLimitOutcome | undefined {
  const streamMarkerText = [error.stdout, error.stderr]
    .map((text) => findRateLimitText(text, containsRateLimitMarker))
    .find((text): text is string => text !== undefined);
  if (streamMarkerText) {
    return { text: streamMarkerText, source: 'stream_marker' };
  }

  const rateLimitText = [error.stderr, error.stdout, message]
    .map((text) => findRateLimitText(text, containsRateLimitError))
    .find((text): text is string => text !== undefined);
  if (rateLimitText) {
    return { text: rateLimitText, source: 'sdk_error' };
  }

  return undefined;
}

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
  const isStrictReadonly = options.internalAgentIsolation === 'strict-readonly';
  const session = resolveSessionArgs(options);
  const preparedMcpConfig = await prepareClaudeMcpConfig(isStrictReadonly ? undefined : options.mcpServers);
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

  if (!isStrictReadonly && options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowed-tools', options.allowedTools.join(','));
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (isStrictReadonly) {
    args.push('--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands');
  } else if (options.skillsEnabled === false) {
    args.push('--disable-slash-commands');
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

type ClassifiedHeadlessError = {
  message: string;
  allowRateLimitDetection: boolean;
};

function classifyError(
  error: ExecError,
  options: ClaudeHeadlessCallOptions,
): ClassifiedHeadlessError {
  if (options.abortSignal?.aborted || error.name === 'AbortError') {
    return {
      message: HEADLESS_ABORTED_MESSAGE,
      allowRateLimitDetection: false,
    };
  }
  if (error.code === 'ENOENT') {
    return {
      message: 'claude CLI not found. Install Claude Code and ensure `claude` is in PATH, or set claude_cli_path in config.',
      allowRateLimitDetection: false,
    };
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return {
      message: getErrorMessage(error),
      allowRateLimitDetection: false,
    };
  }
  if (typeof error.code === 'number') {
    const detail = (error.stderr ?? error.stdout ?? '').trim() || getErrorMessage(error);
    return {
      message: `Claude CLI failed (${error.code}): ${detail}`,
      allowRateLimitDetection: true,
    };
  }
  return {
    message: getErrorMessage(error),
    allowRateLimitDetection: true,
  };
}

export async function callClaudeHeadless(
  agentName: string,
  prompt: string,
  options: ClaudeHeadlessCallOptions,
): Promise<AgentResponse> {
  let cleanup: (() => Promise<void>) | undefined;
  let response: AgentResponse;

  try {
    if (options.skillsEnabled === false) {
      await assertClaudeSkillsDisableSupported(
        options.claudeCliPath ?? 'claude',
        options.abortSignal,
      );
    }
    const prepared = await buildSpawnArgs(prompt, options);
    cleanup = prepared.cleanup;
    const { args, expectedSessionId } = prepared;
    options.onActivity?.({ kind: 'attempt_started' });
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
    const classifiedError = classifyError(error, options);
    const rateLimitOutcome = classifiedError.allowRateLimitDetection
      ? selectRateLimitOutcome(error, classifiedError.message)
      : undefined;
    if (options.onStream) {
      options.onStream({
        type: 'result',
        data: {
          result: '',
          success: false,
          error: rateLimitOutcome?.text ?? classifiedError.message,
          sessionId: options.sessionId ?? '',
        },
      });
    }
    response = {
      persona: agentName,
      timestamp: new Date(),
      sessionId: options.sessionId,
      ...(rateLimitOutcome
        ? buildRateLimitedResponseFields('claude', rateLimitOutcome.source, rateLimitOutcome.text)
        : {
          status: 'error' as const,
          content: classifiedError.message,
          error: classifiedError.message,
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
