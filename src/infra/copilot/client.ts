/**
 * GitHub Copilot CLI integration for agent interactions
 *
 * Wraps the `copilot` CLI (@github/copilot) as a child process,
 * following the same pattern as the Cursor provider.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentResponse } from '../../core/models/index.js';
import { buildEnvWithNestedObservabilitySnapshot } from '../../shared/telemetry/index.js';
import { formatProcessExitCause } from '../../shared/utils/process-exit.js';
import {
  createLogger,
  ensureCurrentTmpDirExists,
  getErrorMessage,
  spawnManagedProcess,
} from '../../shared/utils/index.js';
import type { CopilotCallOptions } from './types.js';

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

    const toText = (chunk: Buffer | string): string =>
      typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

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
      const text = toText(chunk);
      appendChunk('stdout', text);
      if (!overflowed && options.onStream) {
        if (text) {
          options.onStream({ type: 'text', data: { text } });
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => appendChunk('stderr', toText(chunk)));

    void managed.wait().then(
      ({ code, signal }) => {
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

/**
 * Parse Copilot CLI output.
 *
 * Since Copilot CLI does not support JSON output mode,
 * we use --silent --no-color and treat stdout as plain text content.
 */
function parseCopilotOutput(stdout: string): { content: string } | { error: string } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { error: 'copilot returned empty output' };
  }

  return { content: trimmed };
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
    const { stdout } = await execCopilot(args, options);
    const parsed = parseCopilotOutput(stdout);
    if ('error' in parsed) {
      return executionErrorOutcome(parsed.error, resumableSessionId);
    }
    const extractedSessionId = shareFilePath === undefined
      ? undefined
      : await extractSessionId(shareFilePath);
    return {
      status: 'done',
      content: parsed.content,
      sessionId: extractedSessionId ?? resumableSessionId,
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
