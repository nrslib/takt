/**
 * GitHub Copilot CLI integration for agent interactions
 *
 * Wraps the `copilot` CLI (@github/copilot) as a child process,
 * following the same pattern as the Cursor provider.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentResponse } from '../../core/models/index.js';
import { buildEnvWithNestedObservabilitySnapshot } from '../../shared/telemetry/index.js';
import { formatProcessExitCause } from '../../shared/utils/process-exit.js';
import {
  createLogger,
  ensureCurrentTmpDirExists,
  getErrorMessage,
  spawnManagedProcess,
} from '../../shared/utils/index.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import type { CopilotCallOptions } from './types.js';
import {
  emitStructuredEvents,
  extractStructuredText,
  firstNonEmptyString,
  parseJsonLines,
  toRecord,
} from '../structured-cli-output.js';

const log = createLogger('copilot-client');

export type { CopilotCallOptions } from './types.js';

const COPILOT_COMMAND = 'copilot';
const COPILOT_ABORTED_MESSAGE = 'Copilot execution aborted';
const COPILOT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const COPILOT_FORCE_KILL_DELAY_MS_DEFAULT = 1_000;
const COPILOT_ERROR_DETAIL_MAX_LENGTH = 400;

function resolveForceKillDelayMs(): number {
  const raw = process.env.TAKT_COPILOT_FORCE_KILL_DELAY_MS;
  if (!raw) {
    return COPILOT_FORCE_KILL_DELAY_MS_DEFAULT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return COPILOT_FORCE_KILL_DELAY_MS_DEFAULT;
  }

  return parsed;
}

type CopilotExecResult = {
  stdout: string;
  stderr: string;
};

type CopilotExecError = Error & {
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

function buildArgs(prompt: string, options: CopilotCallOptions & { shareFilePath?: string }): string[] {
  const args = [
    '-p',
    buildPrompt(prompt, options.systemPrompt),
    '--silent',
    '--no-color',
    '--no-auto-update',
    '--output-format=json',
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }

  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  // Note: -p mode is already non-interactive. --autopilot and
  // --max-autopilot-continues are not used because they conflict with
  // permission flags in Copilot CLI v0.0.418+ and -p already implies
  // single-prompt execution.
  if (options.permissionMode === 'full') {
    args.push('--yolo');
  } else if (options.permissionMode === 'edit') {
    args.push('--allow-all-tools', '--no-ask-user');
  }

  // Runtime MCP adapter route (issue #1137): pass the adapter-prepared
  // `--additional-mcp-config=@<path>` arg so the runtime-resolved MCP
  // servers become the session's effective set (order.md:216-219).
  if (options.preparedMcp?.args && options.preparedMcp.args.length > 0) {
    args.push(...options.preparedMcp.args);
  }

  // --share exports session transcript to a markdown file, which we parse
  // to extract the session ID for later resumption.
  if (options.shareFilePath) {
    args.push('--share', options.shareFilePath);
  }

  return args;
}

function buildEnv(options: CopilotCallOptions): NodeJS.ProcessEnv {
  const env = buildEnvWithNestedObservabilitySnapshot(process.env, options.childProcessEnv);
  if (options.copilotGithubToken) {
    env.COPILOT_GITHUB_TOKEN = options.copilotGithubToken;
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
): CopilotExecError {
  const error = new Error(message) as CopilotExecError;
  if (params.name) {
    error.name = params.name;
  }
  error.code = params.code;
  error.stdout = params.stdout;
  error.stderr = params.stderr;
  error.signal = params.signal;
  return error;
}

function execCopilot(
  args: string[],
  options: CopilotCallOptions,
  onStdout: (text: string) => void,
): Promise<CopilotExecResult> {
  return new Promise<CopilotExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationError: CopilotExecError | undefined;
    let overflowed = false;
    const terminationController = new AbortController();
    const managed = spawnManagedProcess(
      options.copilotCliPath ?? COPILOT_COMMAND,
      args,
      {
        cwd: options.cwd,
        env: buildEnv(options),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
      terminationController.signal,
      {
        terminationMode: 'child',
        terminationGraceMs: resolveForceKillDelayMs(),
      },
    );
    const child = managed.child;

    const requestTermination = (error: CopilotExecError): void => {
      if (settled || terminationController.signal.aborted) return;
      terminationError = error;
      terminationController.abort(error);
    };

    const abortHandler = (): void => {
      requestTermination(createExecError(COPILOT_ABORTED_MESSAGE, {
        name: 'AbortError',
        stdout,
        stderr,
      }));
    };

    const cleanup = (): void => {
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
    };

    const resolveOnce = (result: CopilotExecResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectOnce = (error: CopilotExecError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const appendChunk = (target: 'stdout' | 'stderr', text: string): void => {
      if (overflowed || settled) {
        return;
      }
      const byteLength = Buffer.byteLength(text);

      if (target === 'stdout') {
        stdoutBytes += byteLength;
        if (stdoutBytes > COPILOT_MAX_BUFFER_BYTES) {
          overflowed = true;
          requestTermination(createExecError('copilot stdout exceeded buffer limit', {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            stdout,
            stderr,
          }));
          return;
        }
        stdout += text;
        onStdout(text);
        return;
      }

      stderrBytes += byteLength;
      if (stderrBytes > COPILOT_MAX_BUFFER_BYTES) {
        overflowed = true;
        requestTermination(createExecError('copilot stderr exceeded buffer limit', {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stdout,
          stderr,
        }));
        return;
      }
      stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (overflowed || settled) {
        return;
      }
      const text = typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk);
      appendChunk('stdout', text);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => appendChunk('stderr', typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk)));

    void managed.wait().then(
      ({ code, signal }) => {
        appendChunk('stdout', stdoutDecoder.end());
        appendChunk('stderr', stderrDecoder.end());
        if (code === 0) {
          resolveOnce({ stdout, stderr });
          return;
        }
        rejectOnce(createExecError(
          `copilot exited with ${formatProcessExitCause(code, signal)}`,
          {
            ...(typeof code === 'number' ? { code } : {}),
            stdout,
            stderr,
            signal,
          },
        ));
      },
      (error: NodeJS.ErrnoException) => {
        if (terminationError !== undefined) {
          rejectOnce(terminationError);
          return;
        }
        rejectOnce(createExecError(error.message, {
          code: error.code,
          stdout,
          stderr,
        }));
      },
    );

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        abortHandler();
      } else {
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }
  });
}

const CREDENTIAL_PATTERNS = [
  /ghp_[A-Za-z0-9_]{36,}/g,
  /ghs_[A-Za-z0-9_]{36,}/g,
  /gho_[A-Za-z0-9_]{36,}/g,
  /github_pat_[A-Za-z0-9_]{82,}/g,
];

function redactCredentials(text: string): string {
  let result = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function trimDetail(value: string | undefined, fallback = ''): string {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return fallback;
  }
  const redacted = redactCredentials(normalized);
  return redacted.length > COPILOT_ERROR_DETAIL_MAX_LENGTH
    ? `${redacted.slice(0, COPILOT_ERROR_DETAIL_MAX_LENGTH)}...`
    : redacted;
}

function isAuthenticationError(error: CopilotExecError): boolean {
  const message = [
    trimDetail(error.message),
    trimDetail(error.stderr),
    trimDetail(error.stdout),
  ].join('\n').toLowerCase();

  const patterns = [
    'authentication',
    'unauthorized',
    'forbidden',
    'not logged in',
    'login required',
    'token',
    'copilot_github_token',
    'gh_token',
    'github_token',
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

function classifyExecutionError(error: CopilotExecError, options: CopilotCallOptions): string {
  if (options.abortSignal?.aborted || error.name === 'AbortError') {
    return COPILOT_ABORTED_MESSAGE;
  }

  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'Copilot CLI output exceeded buffer limit';
  }

  if (error.code === 'ENOENT') {
    return 'copilot binary not found. Install GitHub Copilot CLI (`npm install -g @github/copilot`) and ensure `copilot` is in PATH.';
  }

  if (isAuthenticationError(error)) {
    return 'Copilot authentication failed. Run `copilot auth login` or set TAKT_COPILOT_GITHUB_TOKEN / COPILOT_GITHUB_TOKEN / GH_TOKEN.';
  }

  if (typeof error.code === 'number') {
    const detail = trimDetail(error.stderr, trimDetail(error.stdout, getErrorMessage(error)));
    return `Copilot CLI exited with code ${error.code}: ${detail}`;
  }

  return getErrorMessage(error);
}

/**
 * Extract session ID from the --share markdown file content.
 *
 * The file format includes a line like:
 *   > **Session ID:** `107256ee-226c-4677-bf55-7b6b158ddadf`
 */
const SESSION_ID_PATTERN = /\*\*Session ID:\*\*\s*`([0-9a-f-]{36})`/i;

export function extractSessionIdFromShareFile(content: string): string | undefined {
  const match = content.match(SESSION_ID_PATTERN);
  return match?.[1];
}

async function cleanupTmpDir(dir: string | undefined): Promise<void> {
  if (dir === undefined) {
    return;
  }
  await rm(dir, { recursive: true, force: true });
}

async function extractSessionId(shareFilePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(shareFilePath, 'utf-8');
    return extractSessionIdFromShareFile(content);
  } catch (err) {
    log.debug('readFile share transcript failed', { shareFilePath, err });
    return undefined;
  }
}

interface CopilotParsedOutput {
  readonly content: string;
  readonly sessionId?: string;
  readonly events: readonly StreamEvent[];
}

function extractCopilotEventData(root: Record<string, unknown>): Record<string, unknown> {
  return toRecord(root.data) ?? root;
}

function parseCopilotOutput(stdout: string): CopilotParsedOutput | { error: string } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { error: 'copilot returned empty output' };
  }

  let lines: unknown[];
  try {
    lines = parseJsonLines(stdout, 'copilot');
  } catch {
    // Older Copilot CLI versions only emit text. Keep the response usable, but
    // do not treat that displayed text as a structured MCP result.
    return { content: trimmed, events: [] };
  }

  const parsed = collectCopilotOutput(lines);
  if (parsed.content.length === 0) {
    return {
      error: `Failed to extract assistant content from copilot JSONL output: ${trimDetail(trimmed, '<empty>')}`,
    };
  }
  return parsed;
}

function collectCopilotOutput(lines: unknown[]): CopilotParsedOutput {
  const events: StreamEvent[] = [];
  let content: string | undefined;
  let assistantMessageContent: string | undefined;
  let assistantDeltaContent = '';
  let sessionId: string | undefined;
  for (const line of lines) {
    const root = toRecord(line);
    if (root === undefined) {
      continue;
    }
    const data = extractCopilotEventData(root);
    sessionId = firstNonEmptyString([
      data.sessionId,
      data.session_id,
      root.sessionId,
      root.session_id,
    ]) ?? sessionId;
    const type = typeof root.type === 'string' ? root.type : undefined;

    if (type === 'tool.execution_start' || type === 'tool.user_requested') {
      const id = firstNonEmptyString([data.toolCallId, data.tool_call_id, data.id]);
      const tool = firstNonEmptyString([data.mcpToolName, data.toolName, data.tool_name]);
      if (id !== undefined && tool !== undefined) {
        const input = toRecord(data.arguments ?? data.input) ?? {};
        events.push({ type: 'tool_use', data: { id, tool, input } });
      }
      continue;
    }

    if (type === 'tool.execution_complete') {
      const id = firstNonEmptyString([data.toolCallId, data.tool_call_id, data.id]);
      if (id === undefined) {
        continue;
      }
      const result = toRecord(data.result);
      const error = toRecord(data.error);
      const resultContent = extractStructuredText(
        result?.content
          ?? result?.detailedContent
          ?? result?.contents
          ?? data.result
          ?? error?.message
          ?? data.error,
      ) ?? '';
      events.push({
        type: 'tool_result',
        data: {
          id,
          content: resultContent,
          isError: data.success === false || error !== undefined,
        },
      });
      continue;
    }

    if (type === 'assistant.message') {
      const message = extractStructuredText(data.content ?? data.deltaContent);
      if (message !== undefined && message.length > 0) {
        assistantMessageContent = message;
      }
      continue;
    }

    if (type === 'assistant.message_delta') {
      const message = extractStructuredText(data.content ?? data.deltaContent);
      if (message !== undefined && message.length > 0) {
        assistantDeltaContent += message;
      }
      continue;
    }

    if (type === 'result' || type === 'session.result') {
      const result = extractStructuredText(data.result ?? data.content ?? root.result);
      if (result !== undefined) {
        content = result;
      }
    }
  }

  return { content: content ?? assistantMessageContent ?? assistantDeltaContent, sessionId, events };
}

interface CopilotCallOutcome {
  readonly status: 'done' | 'error';
  readonly content: string;
  readonly sessionId?: string;
  readonly error?: string;
}

function executionErrorOutcome(
  message: string,
  sessionId: string | undefined,
): CopilotCallOutcome {
  return {
    status: 'error',
    content: message,
    error: message,
    sessionId,
  };
}

async function executeCopilotCall(
  prompt: string,
  options: CopilotCallOptions,
  shareFilePath: string | undefined,
): Promise<CopilotCallOutcome> {
  const resumableSessionId = options.sessionId;
  try {
    const args = buildArgs(prompt, { ...options, shareFilePath });
    let pendingLine = '';
    let streamedContent = '';
    const emitText = (content: string): void => {
      const remaining = content.startsWith(streamedContent) ? content.slice(streamedContent.length) : content;
      if (remaining.length > 0) {
        options.onStream?.({ type: 'text', data: { text: remaining } });
      }
      streamedContent = content;
    };
    const processLine = (line: string): void => {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        // Plain-text CLI responses are handled by the final output parser.
        return;
      }
      const parsed = collectCopilotOutput([value]);
      emitStructuredEvents(options.onStream, parsed.events);
      const root = toRecord(value);
      if (root?.type === 'assistant.message_delta') {
        emitText(streamedContent + parsed.content);
      } else if (root?.type === 'assistant.message') {
        emitText(parsed.content);
      }
    };
    const { stdout } = await execCopilot(args, options, (text) => {
      pendingLine += text;
      let newline: number;
      while ((newline = pendingLine.indexOf('\n')) !== -1) {
        processLine(pendingLine.slice(0, newline));
        pendingLine = pendingLine.slice(newline + 1);
      }
    });
    if (pendingLine.trim().length > 0) {
      processLine(pendingLine);
    }
    const parsed = parseCopilotOutput(stdout);
    if ('error' in parsed) {
      return executionErrorOutcome(parsed.error, resumableSessionId);
    }
    emitText(parsed.content);
    const extractedSessionId = shareFilePath === undefined
      ? undefined
      : await extractSessionId(shareFilePath);
    return {
      status: 'done',
      content: parsed.content,
      sessionId: extractedSessionId ?? parsed.sessionId ?? resumableSessionId,
    };
  } catch (rawError) {
    const error = rawError as CopilotExecError;
    return executionErrorOutcome(classifyExecutionError(error, options), resumableSessionId);
  }
}

async function finalizeCopilotCall(
  outcome: CopilotCallOutcome,
  shareTmpDir: string | undefined,
): Promise<CopilotCallOutcome> {
  try {
    await cleanupTmpDir(shareTmpDir);
    return outcome;
  } catch (error) {
    log.debug('Failed to clean up tmp dir', { dir: shareTmpDir, err: error });
    return outcome;
  }
}

function emitResult(
  outcome: CopilotCallOutcome,
  options: CopilotCallOptions,
): void {
  if (options.onStream === undefined) {
    return;
  }
  options.onStream({
    type: 'result',
    data: outcome.status === 'done'
      ? {
        result: outcome.content,
        success: true,
        sessionId: outcome.sessionId ?? '',
      }
      : {
        result: '',
        success: false,
        error: outcome.error ?? outcome.content,
        sessionId: outcome.sessionId ?? '',
      },
  });
}

/**
 * Client for GitHub Copilot CLI interactions.
 */
export class CopilotClient {
  async call(agentType: string, prompt: string, options: CopilotCallOptions): Promise<AgentResponse> {
    let shareTmpDir: string | undefined;
    let shareFilePath: string | undefined;
    try {
      const shareTmpParentDir = ensureCurrentTmpDirExists();
      shareTmpDir = await mkdtemp(join(shareTmpParentDir, 'takt-copilot-'));
      shareFilePath = join(shareTmpDir, 'session.md');
    } catch (err) {
      log.debug('mkdtemp failed, skipping session extraction', { err });
    }

    options.onActivity?.({ kind: 'attempt_started' });
    const executionOutcome = await executeCopilotCall(
      prompt,
      options,
      shareFilePath,
    );
    const outcome = await finalizeCopilotCall(executionOutcome, shareTmpDir);
    emitResult(outcome, options);
    return {
      persona: agentType,
      status: outcome.status,
      content: outcome.content,
      timestamp: new Date(),
      sessionId: outcome.sessionId,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    };
  }

  async callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: CopilotCallOptions,
  ): Promise<AgentResponse> {
    return this.call(agentName, prompt, {
      ...options,
      systemPrompt,
    });
  }
}

const defaultClient = new CopilotClient();

export async function callCopilot(
  agentType: string,
  prompt: string,
  options: CopilotCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}

export async function callCopilotCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: CopilotCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callCustom(agentName, prompt, systemPrompt, options);
}
