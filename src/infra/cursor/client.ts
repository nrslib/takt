/**
 * Cursor Agent CLI integration for agent interactions
 */

import type { AgentResponse } from '../../core/models/index.js';
import { crossSpawn, getErrorMessage, guardChildProcessStreams, createLogger } from '../../shared/utils/index.js';
import { buildEnvWithNestedObservabilitySnapshot } from '../../shared/telemetry/index.js';
import { AGENT_FAILURE_CATEGORIES, type AgentFailureCategory } from '../../shared/types/agent-failure.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import type { CursorCallOptions } from './types.js';
import { formatProcessExitCause } from '../../shared/utils/process-exit.js';
import {
  emitStructuredEvents,
  extractStructuredText,
  firstNonEmptyString,
  parseValidJsonLines,
  toRecord,
} from '../structured-cli-output.js';

export type { CursorCallOptions } from './types.js';

const CURSOR_COMMAND = 'cursor-agent';
const CURSOR_ABORTED_MESSAGE = 'Cursor execution aborted';
const CURSOR_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const CURSOR_FORCE_KILL_DELAY_MS_DEFAULT = 1_000;
const CURSOR_ERROR_DETAIL_MAX_LENGTH = 400;
const CURSOR_CLI_CONFIG_RENAME_MAX_RETRIES = 8;
const CURSOR_CLI_CONFIG_RENAME_RETRY_BASE_DELAY_MS = 1_000;
const CURSOR_CLI_CONFIG_RENAME_RETRY_MAX_DELAY_MS = 30_000;

const log = createLogger('cursor-client');

function resolveForceKillDelayMs(): number {
  const raw = process.env.TAKT_CURSOR_FORCE_KILL_DELAY_MS;
  if (!raw) {
    return CURSOR_FORCE_KILL_DELAY_MS_DEFAULT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return CURSOR_FORCE_KILL_DELAY_MS_DEFAULT;
  }

  return parsed;
}

type CursorExecResult = {
  stdout: string;
  stderr: string;
};

type CursorExecError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

function buildPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }
  return `${systemPrompt}\n\n${prompt}`;
}

function buildArgs(prompt: string, options: CursorCallOptions): string[] {
  // Runtime MCP adapter route (issue #1137): when the runner prepared MCP
  // material with an isolated `configRoot`, point `--workspace` at the
  // isolated root so Cursor CLI picks up the `.cursor/mcp.json` the adapter
  // wrote there (order.md:203-207). The adapter owns cleanup.
  const workspace = options.preparedMcp?.configRoot ?? options.cwd;
  const args = ['-p', '--trust', '--output-format', 'stream-json', '--workspace', workspace];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  if (options.permissionMode === 'full') {
    args.push('--force');
  }

  if (options.preparedMcp?.args && options.preparedMcp.args.length > 0) {
    args.push(...options.preparedMcp.args);
  }

  args.push('--', buildPrompt(prompt, options.systemPrompt));
  return args;
}

function buildEnv(options: CursorCallOptions): NodeJS.ProcessEnv {
  const env = buildEnvWithNestedObservabilitySnapshot(process.env, options.childProcessEnv);
  if (options.cursorApiKey) {
    env.CURSOR_API_KEY = options.cursorApiKey;
  }
  return env;
}

function createExecError(
  message: string,
  params: {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals | null;
    name?: string;
  } = {},
): CursorExecError {
  const error = new Error(message) as CursorExecError;
  if (params.name) {
    error.name = params.name;
  }
  error.code = params.code;
  error.stdout = params.stdout;
  error.stderr = params.stderr;
  error.signal = params.signal;
  return error;
}

function execCursor(args: string[], options: CursorCallOptions): Promise<CursorExecResult> {
  return new Promise<CursorExecResult>((resolve, reject) => {
    const child = crossSpawn(options.cursorCliPath ?? CURSOR_COMMAND, args, {
      cwd: options.cwd,
      env: buildEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;

    const abortHandler = (): void => {
      if (settled) return;
      child.kill('SIGTERM');
      const forceKillDelayMs = resolveForceKillDelayMs();
      abortTimer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, forceKillDelayMs);
      abortTimer.unref?.();
    };

    const cleanup = (): void => {
      if (abortTimer !== undefined) {
        clearTimeout(abortTimer);
      }
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
      guardTeardown();
    };

    const resolveOnce = (result: CursorExecResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectOnce = (error: CursorExecError, terminateChild = false): void => {
      if (settled) return;
      settled = true;
      if (terminateChild) {
        child.kill('SIGTERM');
      }
      cleanup();
      reject(error);
    };

    const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const byteLength = Buffer.byteLength(text);

      if (target === 'stdout') {
        stdoutBytes += byteLength;
        if (stdoutBytes > CURSOR_MAX_BUFFER_BYTES) {
          child.kill('SIGTERM');
          rejectOnce(createExecError('cursor-agent stdout exceeded buffer limit', {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            stdout,
            stderr,
          }));
          return;
        }
        stdout += text;
        return;
      }

      stderrBytes += byteLength;
      if (stderrBytes > CURSOR_MAX_BUFFER_BYTES) {
        child.kill('SIGTERM');
        rejectOnce(createExecError('cursor-agent stderr exceeded buffer limit', {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stdout,
          stderr,
        }));
        return;
      }
      stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => appendChunk('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => appendChunk('stderr', chunk));

    const guardTeardown = guardChildProcessStreams(child, (error, source) => {
      if (source === 'process') {
        rejectOnce(createExecError(error.message, {
          code: (error as NodeJS.ErrnoException).code,
          stdout,
          stderr,
        }));
        return;
      }
      rejectOnce(createExecError(`cursor-agent ${source} stream error: ${error.message}`, {
        stdout,
        stderr,
      }), true);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;

      if (options.abortSignal?.aborted) {
        rejectOnce(createExecError(CURSOR_ABORTED_MESSAGE, {
          name: 'AbortError',
          stdout,
          stderr,
          signal,
        }));
        return;
      }

      if (code === 0) {
        resolveOnce({ stdout, stderr });
        return;
      }

      rejectOnce(createExecError(
        `cursor-agent exited with ${formatProcessExitCause(code, signal)}`,
        {
          ...(typeof code === 'number' ? { code } : {}),
          stdout,
          stderr,
          signal,
        },
      ));
    });

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        abortHandler();
      } else {
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }
  });
}

function extractSessionId(payload: unknown): string | undefined {
  const record = toRecord(payload);
  if (!record) {
    return undefined;
  }

  const nestedData = toRecord(record.data);
  const nestedPayload = toRecord(record.payload);
  const nestedResponse = toRecord(record.response);

  return firstNonEmptyString([
    record.sessionId,
    record.session_id,
    record.chatId,
    record.chat_id,
    nestedData?.sessionId,
    nestedData?.session_id,
    nestedData?.chatId,
    nestedData?.chat_id,
    nestedPayload?.sessionId,
    nestedPayload?.session_id,
    nestedPayload?.chatId,
    nestedPayload?.chat_id,
    nestedResponse?.sessionId,
    nestedResponse?.session_id,
    nestedResponse?.chatId,
    nestedResponse?.chat_id,
  ]);
}

function trimDetail(value: string | undefined, fallback = ''): string {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > CURSOR_ERROR_DETAIL_MAX_LENGTH
    ? `${normalized.slice(0, CURSOR_ERROR_DETAIL_MAX_LENGTH)}...`
    : normalized;
}

function isAuthenticationError(error: CursorExecError): boolean {
  const message = [
    trimDetail(error.message),
    trimDetail(error.stderr),
    trimDetail(error.stdout),
  ].join('\n').toLowerCase();

  const patterns = [
    'authentication',
    'unauthorized',
    'forbidden',
    'api key',
    'not logged in',
    'login required',
    'cursor_api_key',
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

function isCursorCliConfigRenameEnoent(error: CursorExecError): boolean {
  if (error.code !== 1) {
    return false;
  }

  const detail = [
    error.message,
    error.stderr,
    error.stdout,
  ].filter((value): value is string => typeof value === 'string').join('\n');

  return /\bENOENT\b/i.test(detail)
    && /\brename\b/i.test(detail)
    && /cli-config\.json\.tmp/i.test(detail)
    && /(?:->|to)\s*['"]?[^'"\r\n]*cli-config\.json(?:['"]|\s|$)/i.test(detail);
}

async function waitForCursorCliConfigRenameRetryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  const delayMs = Math.min(
    CURSOR_CLI_CONFIG_RENAME_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)),
    CURSOR_CLI_CONFIG_RENAME_RETRY_MAX_DELAY_MS,
  );

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error(CURSOR_ABORTED_MESSAGE));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function classifyExecutionError(error: CursorExecError, options: CursorCallOptions): string {
  if (options.abortSignal?.aborted || error.name === 'AbortError') {
    return CURSOR_ABORTED_MESSAGE;
  }

  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'Cursor Agent CLI output exceeded buffer limit';
  }

  if (error.code === 'ENOENT') {
    return 'cursor-agent binary not found. Install Cursor Agent CLI and ensure `cursor-agent` is in PATH.';
  }

  if (isAuthenticationError(error)) {
    return 'Cursor authentication failed. Run `cursor-agent login` or set TAKT_CURSOR_API_KEY/cursor_api_key.';
  }

  if (typeof error.code === 'number') {
    const detail = trimDetail(error.stderr, trimDetail(error.stdout, getErrorMessage(error)));
    return `Cursor Agent CLI exited with code ${error.code}: ${detail}`;
  }

  return getErrorMessage(error);
}

interface CursorToolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly result?: unknown;
}

function extractCursorToolCall(root: Record<string, unknown>): CursorToolCall | undefined {
  const toolCall = toRecord(root.tool_call ?? root.toolCall);
  if (toolCall === undefined) {
    return undefined;
  }

  const entry = Object.entries(toolCall).find(([, value]) => toRecord(value) !== undefined);
  if (entry === undefined) {
    return undefined;
  }

  const [kind, rawDetails] = entry;
  const details = toRecord(rawDetails);
  if (details === undefined) {
    return undefined;
  }
  const args = toRecord(details.args);
  const nestedArgs = toRecord(args?.args ?? args?.input);
  const tool = firstNonEmptyString([
    args?.name,
    args?.toolName,
    details.name,
    details.toolName,
    kind === 'mcpToolCall' ? undefined : kind,
  ]);
  if (tool === undefined) {
    return undefined;
  }

  return {
    tool,
    input: nestedArgs ?? args ?? toRecord(details.input) ?? {},
    ...(Object.prototype.hasOwnProperty.call(details, 'result') ? { result: details.result } : {}),
  };
}

function cursorToolResult(call: CursorToolCall): { content: string; isError: boolean } | undefined {
  if (call.result === undefined) {
    return undefined;
  }
  const result = toRecord(call.result);
  const hasSuccess = result !== undefined && Object.prototype.hasOwnProperty.call(result, 'success');
  const payload = result?.success === false
    ? result.error
    : hasSuccess ? result?.success : result?.error ?? call.result;
  const content = extractStructuredText(payload) ?? '';
  return {
    content,
    isError: result?.isError === true
      || result?.error !== undefined
      || (hasSuccess && result?.success === false),
  };
}

function parseCursorStreamEvent(
  value: unknown,
  pendingTools: Map<string, CursorToolCall>,
): { event?: StreamEvent; content?: string; sessionId?: string; terminalResult?: string } {
  const root = toRecord(value);
  if (root === undefined) {
    return {};
  }

  const sessionId = extractSessionId(root);
  if (root.type === 'tool_call') {
    const id = firstNonEmptyString([root.call_id, root.callId]);
    const call = extractCursorToolCall(root);
    if (id === undefined) {
      return { sessionId };
    }
    if (root.subtype === 'started') {
      if (call === undefined) {
        return { sessionId };
      }
      pendingTools.set(id, call);
      return {
        sessionId,
        event: { type: 'tool_use', data: { id, tool: call.tool, input: call.input } },
      };
    }
    if (root.subtype === 'completed') {
      const pendingCall = pendingTools.get(id);
      const completedCall = call === undefined
        ? pendingCall
        : { ...pendingCall, ...call };
      if (completedCall === undefined) {
        return { sessionId };
      }
      const result = cursorToolResult(completedCall);
      pendingTools.delete(id);
      return result === undefined
        ? { sessionId }
        : {
          sessionId,
          event: { type: 'tool_result', data: { id, content: result.content, isError: result.isError } },
        };
    }
    return { sessionId };
  }

  if (root.type === 'result') {
    const result = extractStructuredText(root.result);
    return {
      sessionId,
      ...(result === undefined ? {} : { terminalResult: result }),
    };
  }

  if (root.type === 'assistant') {
    const message = toRecord(root.message);
    const content = extractStructuredText(message?.content ?? message?.text);
    return {
      sessionId,
      ...(content === undefined ? {} : { content }),
    };
  }

  const legacyContent = root.type === undefined ? extractStructuredText(root.content) : undefined;
  return {
    sessionId,
    ...(legacyContent === undefined ? {} : { terminalResult: legacyContent }),
  };
}

function parseCursorOutput(
  stdout: string,
): { content: string; sessionId?: string; events: StreamEvent[] } | { error: string } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { error: 'cursor-agent returned empty output' };
  }

  const lines = parseValidJsonLines(stdout);
  if (lines.length === 0) {
    return { error: `Failed to parse cursor-agent JSON output: ${trimDetail(trimmed, '<empty>')}` };
  }

  const pendingTools = new Map<string, CursorToolCall>();
  const events: StreamEvent[] = [];
  const assistantContent: string[] = [];
  let content: string | undefined;
  let sessionId: string | undefined;
  for (const line of lines) {
    const parsed = parseCursorStreamEvent(line, pendingTools);
    sessionId = parsed.sessionId ?? sessionId;
    if (parsed.event !== undefined) {
      events.push(parsed.event);
    }
    if (parsed.content !== undefined) {
      assistantContent.push(parsed.content);
    }
    if (parsed.terminalResult !== undefined) {
      content = parsed.terminalResult;
    }
  }

  content = content ?? assistantContent.join('');
  if (!content) {
    return {
      error: `Failed to extract assistant content from cursor-agent JSON output: ${trimDetail(trimmed, '<empty>')}`,
    };
  }

  return { content, sessionId, events };
}

function toCursorExecError(rawError: unknown): CursorExecError {
  if (rawError instanceof Error) {
    return rawError as CursorExecError;
  }

  return createExecError(getErrorMessage(rawError));
}

function emitCursorErrorResult(
  options: CursorCallOptions,
  message: string,
  failureCategory?: AgentFailureCategory,
): void {
  if (!options.onStream) {
    return;
  }

  options.onStream({
    type: 'result',
    data: {
      result: '',
      success: false,
      error: message,
      sessionId: options.sessionId ?? '',
      ...(failureCategory ? { failureCategory } : {}),
    },
  });
}

function buildCursorErrorResponse(
  agentType: string,
  message: string,
  options: CursorCallOptions,
  failureCategory?: AgentFailureCategory,
): AgentResponse {
  return {
    persona: agentType,
    status: 'error',
    content: message,
    timestamp: new Date(),
    sessionId: options.sessionId,
    ...(failureCategory ? { error: message, failureCategory } : {}),
  };
}

/**
 * Client for Cursor Agent CLI interactions.
 */
export class CursorClient {
  async call(agentType: string, prompt: string, options: CursorCallOptions): Promise<AgentResponse> {
    const args = buildArgs(prompt, options);
    let cliConfigRenameRetryCount = 0;

    try {
      while (true) {
        options.onActivity?.({ kind: 'attempt_started' });
        try {
          const { stdout } = await execCursor(args, options);
          const parsed = parseCursorOutput(stdout);
          if ('error' in parsed) {
            emitCursorErrorResult(options, parsed.error);
            return buildCursorErrorResponse(agentType, parsed.error, options);
          }

          const sessionId = parsed.sessionId ?? options.sessionId;
          if (options.onStream) {
            emitStructuredEvents(options.onStream, parsed.events);
            options.onStream({ type: 'text', data: { text: parsed.content } });
            options.onStream({
              type: 'result',
              data: {
                result: parsed.content,
                success: true,
                sessionId: sessionId ?? '',
              },
            });
          }

          return {
            persona: agentType,
            status: 'done',
            content: parsed.content,
            timestamp: new Date(),
            sessionId,
          };
        } catch (rawError) {
          const error = toCursorExecError(rawError);
          if (
            isCursorCliConfigRenameEnoent(error)
            && cliConfigRenameRetryCount < CURSOR_CLI_CONFIG_RENAME_MAX_RETRIES
          ) {
            cliConfigRenameRetryCount += 1;
            try {
              await waitForCursorCliConfigRenameRetryDelay(cliConfigRenameRetryCount, options.abortSignal);
            } catch (delayError) {
              const message = classifyExecutionError(toCursorExecError(delayError), options);
              emitCursorErrorResult(options, message);
              return buildCursorErrorResponse(agentType, message, options);
            }
            continue;
          }

          const message = classifyExecutionError(error, options);
          const failureCategory = isCursorCliConfigRenameEnoent(error)
            ? AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR
            : undefined;
          emitCursorErrorResult(options, message, failureCategory);
          return buildCursorErrorResponse(agentType, message, options, failureCategory);
        }
      }
    } finally {
      try {
        await options.preparedMcp?.dispose?.();
      } catch (error) {
        log.error('Failed to clean up Cursor MCP config', {
          error: getErrorMessage(error),
        });
      }
    }
  }

  async callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: CursorCallOptions,
  ): Promise<AgentResponse> {
    return this.call(agentName, prompt, {
      ...options,
      systemPrompt,
    });
  }
}

const defaultClient = new CursorClient();

export async function callCursor(
  agentType: string,
  prompt: string,
  options: CursorCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}

export async function callCursorCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: CursorCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callCustom(agentName, prompt, systemPrompt, options);
}
