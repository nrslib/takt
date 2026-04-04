import type { AgentResponse, PermissionMode } from '../../core/models/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import {
  type ClaudePermissionExpression,
  taktPermissionModeToClaudeExpression,
} from '../claude/permission-mode-expression.js';
import {
  HEADLESS_ABORTED_MESSAGE,
  type ExecError,
  runHeadlessCli,
} from './headless-spawn.js';
import { aggregateContentFromStdout } from './stream-json-lines.js';
import type { ClaudeHeadlessCallOptions } from './types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function buildUserPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt?.trim()) {
    return prompt;
  }
  return `${systemPrompt.trim()}\n\n${prompt}`;
}

function buildSpawnArgs(prompt: string, options: ClaudeHeadlessCallOptions): string[] {
  const args: string[] = [
    '-p',
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

  const effort = options.providerOptions?.claude?.effort;
  if (effort) {
    args.push('--effort', effort);
  }

  if (options.sessionId && UUID_RE.test(options.sessionId)) {
    args.push('--resume', options.sessionId);
  }

  args.push('--', buildUserPrompt(prompt, options.systemPrompt));
  return args;
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
  const args = buildSpawnArgs(prompt, options);

  try {
    const { stdout, stderr } = await runHeadlessCli(args, options);
    const content = aggregateContentFromStdout(stdout);
    const sessionId = options.sessionId;

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
      return {
        persona: agentName,
        status: 'error',
        content: message,
        timestamp: new Date(),
        sessionId,
        error: message,
      };
    }

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

    return {
      persona: agentName,
      status: 'done',
      content,
      timestamp: new Date(),
      sessionId,
    };
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
    return {
      persona: agentName,
      status: 'error',
      content: message,
      timestamp: new Date(),
      sessionId: options.sessionId,
      error: message,
    };
  }
}
