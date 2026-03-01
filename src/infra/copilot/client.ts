/**
 * GitHub Copilot CLI integration for agent interactions
 *
 * Wraps the `copilot` CLI (@github/copilot) as a child process,
 * following the same pattern as the Cursor provider.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
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

  // --share exports session transcript to a markdown file, which we parse
  // to extract the session ID for later resumption.
  if (options.shareFilePath) {
    args.push('--share', options.shareFilePath);
  }

  return args;
}

function buildEnv(copilotGithubToken?: string): NodeJS.ProcessEnv {
  if (!copilotGithubToken) {
    return process.env;
  }

  return {
    ...process.env,
    COPILOT_GITHUB_TOKEN: copilotGithubToken,
  };
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

function execCopilot(args: string[], options: CopilotCallOptions): Promise<CopilotExecResult> {
  return new Promise<CopilotExecResult>((resolve, reject) => {
    const child = spawn(options.copilotCliPath ?? COPILOT_COMMAND, args, {
      cwd: options.cwd,
      env: buildEnv(options.copilotGithubToken),
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
      const byteLength = Buffer.byteLength(text);

      if (target === 'stdout') {
        stdoutBytes += byteLength;
        if (stdoutBytes > COPILOT_MAX_BUFFER_BYTES) {
          child.kill('SIGTERM');
          rejectOnce(createExecError('copilot stdout exceeded buffer limit', {
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
        child.kill('SIGTERM');
        rejectOnce(createExecError('copilot stderr exceeded buffer limit', {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stdout,
          stderr,
        }));
        return;
      }
      stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = toText(chunk);
      appendChunk('stdout', text);
      if (options.onStream) {
        if (text) {
          options.onStream({ type: 'text', data: { text } });
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => appendChunk('stderr', toText(chunk)));

    child.on('error', (error: NodeJS.ErrnoException) => {
      rejectOnce(createExecError(error.message, {
        code: error.code,
        stdout,
        stderr,
      }));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;

      if (options.abortSignal?.aborted) {
        rejectOnce(createExecError(COPILOT_ABORTED_MESSAGE, {
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
        signal
          ? `copilot terminated by signal ${signal}`
          : `copilot exited with code ${code ?? 'unknown'}`,
        {
          code: code ?? undefined,
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

function cleanupTmpDir(dir?: string): void {
  if (dir) {
    rm(dir, { recursive: true, force: true }).catch((err) => {
      log.debug('Failed to clean up tmp dir', { dir, err });
    });
  }
}

async function extractAndCleanupSessionId(shareFilePath: string, shareTmpDir: string): Promise<string | undefined> {
  try {
    const content = await readFile(shareFilePath, 'utf-8');
    return extractSessionIdFromShareFile(content);
  } catch (err) {
    log.debug('readFile share transcript failed', { shareFilePath, err });
    return undefined;
  } finally {
    cleanupTmpDir(shareTmpDir);
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

/**
 * Client for GitHub Copilot CLI interactions.
 */
export class CopilotClient {
  async call(agentType: string, prompt: string, options: CopilotCallOptions): Promise<AgentResponse> {
    let shareTmpDir: string | undefined;
    let shareFilePath: string | undefined;
    try {
      shareTmpDir = await mkdtemp(join(tmpdir(), 'takt-copilot-'));
      shareFilePath = join(shareTmpDir, 'session.md');
    } catch (err) {
      log.debug('mkdtemp failed, skipping session extraction', { err });
    }

    const args = buildArgs(prompt, { ...options, shareFilePath });

    try {
      const { stdout } = await execCopilot(args, options);
      const parsed = parseCopilotOutput(stdout);
      if ('error' in parsed) {
        if (options.onStream) {
          options.onStream({
            type: 'result',
            data: {
              result: '',
              success: false,
              error: parsed.error,
              sessionId: options.sessionId ?? '',
            },
          });
        }
        cleanupTmpDir(shareTmpDir);
        return {
          persona: agentType,
          status: 'error',
          content: parsed.error,
          timestamp: new Date(),
          sessionId: options.sessionId,
        };
      }

      const extractedSessionId = (shareFilePath && shareTmpDir)
        ? await extractAndCleanupSessionId(shareFilePath, shareTmpDir)
        : undefined;
      const sessionId = extractedSessionId ?? options.sessionId;

      if (options.onStream) {
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
      cleanupTmpDir(shareTmpDir);
      const error = rawError as CopilotExecError;
      const message = classifyExecutionError(error, options);
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
        persona: agentType,
        status: 'error',
        content: message,
        timestamp: new Date(),
        sessionId: options.sessionId,
      };
    }
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
