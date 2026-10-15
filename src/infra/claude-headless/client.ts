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
import { buildRateLimitedResponseFields, classifyRateLimitError, findRateLimitMarkerNoticeLine } from '../rate-limit/detection.js';
import { RATE_LIMIT_MAX_RETRIES, waitForRateLimitRetry } from '../rate-limit/retry.js';
import { parseValidJsonLines } from '../structured-cli-output.js';

const log = createLogger('claude-headless');

type HeadlessRateLimitOutcome = {
  text: string;
  source: 'sdk_error' | 'stream_marker';
};

function selectRateLimitOutcome(error: ExecError): HeadlessRateLimitOutcome | undefined {
  // stdout は stream-json のイベント単位、stderr は 1 行単位で通知文を探す (#1674)。
  const streamMarkerText = findRateLimitNoticeInStdout(error.stdout)
    ?? findRateLimitMarkerNoticeLine(error.stderr);
  if (streamMarkerText) {
    return { text: streamMarkerText, source: 'stream_marker' };
  }

  const parsed = aggregateResultFromStdout(error.stdout ?? '');
  // 構造化stdoutのtool出力・成功本文を失敗原因へ混ぜない。
  const candidates = [error.stderr, parsed.hasResult && !parsed.success ? parsed.error : undefined,
    parseValidJsonLines(error.stdout ?? '').length === 0 ? error.stdout : undefined,
    typeof error.code !== 'number' ? getErrorMessage(error) : undefined];
  const rateLimitText = candidates.find((text) => classifyRateLimitError(text) === 'Exhausted')
    ?? candidates.find((text) => classifyRateLimitError(text) === 'Transient');
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

/**
 * Build CLI arguments while preserving tool isolation and MCP cleanup ownership.
 * Empty allowlists isolate built-in/MCP tools and ambient Skills/settings;
 * undefined keeps provider defaults. Strict readonly may still permit Read for
 * explicitly authorized artifact paths.
 */
async function buildSpawnArgs(
  options: ClaudeHeadlessCallOptions,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const isStrictReadonly = options.internalAgentIsolation === 'strict-readonly';
  const isToolIsolated = isStrictReadonly || options.allowedTools?.length === 0;
  const readonlyArtifactPaths = isStrictReadonly
    ? resolveReadonlyArtifactReadPaths(options)
    : [];
  // Runtime MCP adapter route (issue #1137): when the runner prepared MCP
  // material, consume `preparedMcp.args` (`--strict-mcp-config`/`--mcp-config`)
  // so temp-file ownership and cleanup live in the adapter. Fall back to the
  // legacy `prepareClaudeMcpConfig` only when runtime MCP is not in use.
  const preparedMcp = options.preparedMcp;
  const legacyMcpConfig = preparedMcp === undefined
    ? await prepareClaudeMcpConfig(isToolIsolated ? undefined : options.mcpServers)
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
  if (isToolIsolated) {
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

  if (!isToolIsolated && preparedMcp?.args && preparedMcp.args.length > 0) {
    args.push(...preparedMcp.args);
  } else if (!isToolIsolated && legacyMcpConfig.path) {
    args.push('--mcp-config', legacyMcpConfig.path);
  }

  const settings = buildSettingsArg(options, readonlyArtifactPaths);
  if (settings) {
    args.push('--settings', settings);
  }

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
  let terminalContent = '';

  try {
    if (options.skillsEnabled === false) {
      await assertClaudeSkillsDisableSupported(
        options.claudeCliPath ?? 'claude',
        options.abortSignal,
      );
    }
    const prepared = await buildSpawnArgs(options);
    cleanup = prepared.cleanup;
    let retries = 0;
    while (true) {
      if (options.abortSignal?.aborted) throw new Error(HEADLESS_ABORTED_MESSAGE);
      const session = resolveSessionArgs(options);
      options.onActivity?.({ kind: 'attempt_started' });
      try {
        const { stdout, stderr } = await runHeadlessCli([...prepared.args, ...session.args, '--', prompt], options);
        const parsed = aggregateResultFromStdout(stdout);
        response = buildClaudeHeadlessResponse({
          agentName, parsed, stdout, stderr,
          sessionId: extractSessionIdFromStdout(stdout) ?? session.sessionId,
          outputSchema: options.outputSchema,
        });
        terminalContent = response.status === 'rate_limited' ? '' : parsed.content;
      } catch (raw) {
        terminalContent = '';
        response = buildHeadlessErrorResponse(agentName, raw as ExecError, options);
      }
      if (response.status !== 'rate_limited' || classifyRateLimitError(response.error) !== 'Transient'
        || retries >= RATE_LIMIT_MAX_RETRIES) break;
      await waitForRateLimitRetry(++retries, options.abortSignal);
    }
  } catch (raw) {
    terminalContent = '';
    response = buildHeadlessErrorResponse(agentName, raw as ExecError, options);
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

  options.onStream?.({ type: 'result', data: {
    result: terminalContent,
    success: response.status === 'done',
    sessionId: response.sessionId ?? '',
    ...(response.error === undefined ? {} : { error: response.error }),
  } });
  return response;
}

function buildHeadlessErrorResponse(agentName: string, error: ExecError, options: ClaudeHeadlessCallOptions): AgentResponse {
  const classified = classifyError(error, options);
  const outcome = classified.allowRateLimitDetection ? selectRateLimitOutcome(error) : undefined;
  return {
    persona: agentName,
    timestamp: new Date(),
    sessionId: options.sessionId,
    ...(outcome ? buildRateLimitedResponseFields('claude-headless', outcome.source, outcome.text)
      : { status: 'error' as const, content: classified.message, error: classified.message }),
  };
}
