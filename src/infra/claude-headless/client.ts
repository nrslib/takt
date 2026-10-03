import { randomUUID } from 'node:crypto';
import type { AgentResponse, PermissionMode } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { prepareClaudeMcpConfig } from '../claude/mcp-config.js';
import { assertClaudeSkillsDisableSupported } from '../claude/cli-capability.js';
import {
  createClaudeCliReadonlyArtifactHook,
  resolveReadonlyArtifactReadPaths,
} from '../claude/readonly-artifact-access.js';
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
  findRateLimitNoticeInStdout,
} from './stream-json-lines.js';
import { buildClaudeHeadlessResponse } from './result-response.js';
import type { ClaudeHeadlessCallOptions } from './types.js';
import { buildRateLimitedResponseFields, containsRateLimitError, findRateLimitMarkerNoticeLine } from '../rate-limit/detection.js';

const log = createLogger('claude-headless');

type HeadlessRateLimitOutcome = {
  text: string;
  source: 'sdk_error' | 'stream_marker';
};

function findRateLimitErrorText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const parsed = aggregateResultFromStdout(text);
  return [parsed.error, parsed.content, parsed.displayText, text.trim()].find(
    (candidate): candidate is string => candidate !== undefined && containsRateLimitError(candidate),
  );
}

function selectRateLimitOutcome(error: ExecError, message: string): HeadlessRateLimitOutcome | undefined {
  // stdout は stream-json のイベント単位、stderr は 1 行単位で通知文を探す (#1674)。
  const streamMarkerText = findRateLimitNoticeInStdout(error.stdout)
    ?? findRateLimitMarkerNoticeLine(error.stderr);
  if (streamMarkerText) {
    return { text: streamMarkerText, source: 'stream_marker' };
  }

  const rateLimitText = [error.stderr, error.stdout, message]
    .map((text) => findRateLimitErrorText(text))
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

function buildSettingsArg(
  options: ClaudeHeadlessCallOptions,
  readonlyArtifactPaths: readonly string[],
): string | undefined {
  const sandbox = options.sandbox;
  const settings: Record<string, unknown> = {};
  if (sandbox) {
    const settingsSandbox = {
      ...(sandbox.allowUnsandboxedCommands !== undefined
        ? { allowUnsandboxedCommands: sandbox.allowUnsandboxedCommands }
        : {}),
      ...(sandbox.excludedCommands !== undefined
        ? { excludedCommands: sandbox.excludedCommands }
        : {}),
    };
    if (Object.keys(settingsSandbox).length > 0) {
      settings.sandbox = settingsSandbox;
    }
  }

  if (readonlyArtifactPaths.length > 0) {
    settings.hooks = {
      PreToolUse: [createClaudeCliReadonlyArtifactHook(readonlyArtifactPaths, options.cwd)],
    };
  }

  return Object.keys(settings).length === 0 ? undefined : JSON.stringify(settings);
}

async function buildSpawnArgs(
  prompt: string,
  options: ClaudeHeadlessCallOptions,
): Promise<{ args: string[]; expectedSessionId: string; cleanup: () => Promise<void> }> {
  const isStrictReadonly = options.internalAgentIsolation === 'strict-readonly';
  const readonlyArtifactPaths = isStrictReadonly
    ? resolveReadonlyArtifactReadPaths(options)
    : [];
  const session = resolveSessionArgs(options);
  // Runtime MCP adapter route (issue #1137): when the runner prepared MCP
  // material, consume `preparedMcp.args` (`--strict-mcp-config`/`--mcp-config`)
  // so temp-file ownership and cleanup live in the adapter. Fall back to the
  // legacy `prepareClaudeMcpConfig` only when runtime MCP is not in use.
  const preparedMcp = options.preparedMcp;
  const legacyMcpConfig = preparedMcp === undefined
    ? await prepareClaudeMcpConfig(isStrictReadonly ? undefined : options.mcpServers)
    : { path: undefined, cleanup: async () => {} };
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
    const readOnlyTools = readonlyArtifactPaths.length > 0 ? 'Read' : '';
    args.push('--tools', readOnlyTools, '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands');
  } else if (options.skillsEnabled === false) {
    args.push('--disable-slash-commands');
  }

  if (options.systemPrompt?.trim()) {
    args.push('--system-prompt', options.systemPrompt.trim());
  }

  if (options.outputSchema) {
    args.push('--json-schema', JSON.stringify(options.outputSchema));
  }

  if (preparedMcp?.args && preparedMcp.args.length > 0) {
    args.push(...preparedMcp.args);
  } else if (legacyMcpConfig.path) {
    args.push('--mcp-config', legacyMcpConfig.path);
  }

  const settings = buildSettingsArg(options, readonlyArtifactPaths);
  if (settings) {
    args.push('--settings', settings);
  }

  args.push(...session.args);
  args.push('--', prompt);
  const cleanup = async () => {
    const results = await Promise.allSettled([
      legacyMcpConfig.cleanup(),
      ...(preparedMcp === undefined ? [] : [preparedMcp.dispose()]),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw failed.reason;
    }
  };
  return {
    args,
    expectedSessionId: session.sessionId,
    cleanup,
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
  // Keep adapter disposal reachable even when argument construction fails
  // before buildSpawnArgs can return its combined cleanup callback.
  let cleanup: (() => Promise<void>) | undefined = options.preparedMcp === undefined
    ? undefined
    : () => options.preparedMcp!.dispose();
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
        ? buildRateLimitedResponseFields('claude-headless', rateLimitOutcome.source, rateLimitOutcome.text)
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
