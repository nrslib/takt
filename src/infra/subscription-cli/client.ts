import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, PermissionMode } from '../../core/models/index.js';
import { SUBSCRIPTION_ONLY_FORBIDDEN_ENV_NAMES } from '../../core/subscription-only/policy.js';
import { buildEnvWithNestedObservabilitySnapshot } from '../../shared/telemetry/index.js';
import { crossSpawn, getErrorMessage } from '../../shared/utils/index.js';
import type { ProviderType, StreamCallback } from '../../shared/types/provider.js';

export type SubscriptionCliProviderType =
  | 'codex-cli'
  | 'opencode-cli'
  | 'cursor-cli'
  | 'agy-cli';

export interface SubscriptionCliInvocationOptions {
  cwd: string;
  systemPrompt?: string;
  model?: string;
  sessionId?: string;
  permissionMode?: PermissionMode;
  commandPath?: string;
  outputPath?: string;
}

export interface SubscriptionCliCallOptions extends SubscriptionCliInvocationOptions {
  provider: SubscriptionCliProviderType;
  abortSignal?: AbortSignal;
  onStream?: StreamCallback;
  childProcessEnv?: Readonly<Record<string, string>>;
}

export interface SubscriptionCliInvocation {
  command: string;
  args: string[];
  stdin?: string;
  outputPath?: string;
}

type ExecResult = {
  stdout: string;
  stderr: string;
};

type ExecError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

const SUBSCRIPTION_CLI_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SUBSCRIPTION_CLI_FORCE_KILL_DELAY_MS = 1_000;

function isSubscriptionCliProvider(provider: ProviderType): provider is SubscriptionCliProviderType {
  return provider === 'codex-cli'
    || provider === 'opencode-cli'
    || provider === 'cursor-cli'
    || provider === 'agy-cli';
}

function buildPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }
  return `${systemPrompt}\n\n${prompt}`;
}

function mapCodexCliSandboxMode(mode?: PermissionMode): 'read-only' | 'workspace-write' {
  if (mode === 'full') {
    throw new Error('codex-cli provider does not support full permission mode because it would disable local sandboxing.');
  }
  return mode === 'readonly' ? 'read-only' : 'workspace-write';
}

export function buildSubscriptionOnlyEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  childProcessEnv?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env = buildEnvWithNestedObservabilitySnapshot(baseEnv, childProcessEnv);

  // Subscription-only providers must never inherit API-key billing credentials.
  // The delete happens after childProcessEnv is merged so nested runs cannot
  // reintroduce a forbidden key through observability handoff or explicit env.
  for (const key of SUBSCRIPTION_ONLY_FORBIDDEN_ENV_NAMES) {
    delete env[key];
  }
  return env;
}

export function buildSubscriptionCliInvocation(
  provider: ProviderType,
  prompt: string,
  options: SubscriptionCliInvocationOptions,
): SubscriptionCliInvocation {
  if (!isSubscriptionCliProvider(provider)) {
    throw new Error(`Provider is not subscription-only CLI provider: ${provider}`);
  }

  const fullPrompt = buildPrompt(prompt, options.systemPrompt);

  if (provider === 'codex-cli') {
    const args = [
      'exec',
      '--sandbox',
      mapCodexCliSandboxMode(options.permissionMode),
      '--cd',
      options.cwd,
    ];
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.outputPath) {
      args.push('--output-last-message', options.outputPath);
    }
    args.push('-');
    return {
      command: options.commandPath ?? 'codex',
      args,
      stdin: fullPrompt,
      outputPath: options.outputPath,
    };
  }

  if (provider === 'opencode-cli') {
    return {
      command: options.commandPath ?? 'opencode',
      args: ['run', fullPrompt],
    };
  }

  if (provider === 'agy-cli') {
    const args: string[] = [];
    if (options.model) {
      args.push('--model', options.model);
    }
    args.push('-p', fullPrompt);
    return {
      command: options.commandPath ?? 'agy',
      args,
    };
  }

  const args = ['-p', '--trust', '--output-format', 'json', '--workspace', options.cwd];
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }
  if (options.permissionMode === 'full') {
    args.push('--force');
  }
  args.push('--', fullPrompt);
  return {
    command: options.commandPath ?? 'cursor-agent',
    args,
  };
}

function toExecError(rawError: unknown): ExecError {
  if (rawError instanceof Error) {
    return rawError as ExecError;
  }
  return new Error(getErrorMessage(rawError)) as ExecError;
}

function trimDetail(value: string | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function execSubscriptionCli(
  invocation: SubscriptionCliInvocation,
  options: SubscriptionCliCallOptions,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = crossSpawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: buildSubscriptionOnlyEnv(process.env, options.childProcessEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (abortTimer !== undefined) {
        clearTimeout(abortTimer);
      }
      options.abortSignal?.removeEventListener('abort', abortHandler);
    };

    const rejectOnce = (error: ExecError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const abortHandler = (): void => {
      if (settled) return;
      child.kill('SIGTERM');
      abortTimer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, SUBSCRIPTION_CLI_FORCE_KILL_DELAY_MS);
      abortTimer.unref?.();
    };

    const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const bytes = Buffer.byteLength(text);
      if (target === 'stdout') {
        stdoutBytes += bytes;
        if (stdoutBytes > SUBSCRIPTION_CLI_MAX_BUFFER_BYTES) {
          child.kill('SIGTERM');
          rejectOnce(Object.assign(new Error('subscription CLI stdout exceeded buffer limit'), { stdout, stderr }));
          return;
        }
        stdout += text;
        return;
      }
      stderrBytes += bytes;
      if (stderrBytes > SUBSCRIPTION_CLI_MAX_BUFFER_BYTES) {
        child.kill('SIGTERM');
        rejectOnce(Object.assign(new Error('subscription CLI stderr exceeded buffer limit'), { stdout, stderr }));
        return;
      }
      stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => appendChunk('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => appendChunk('stderr', chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      rejectOnce(Object.assign(new Error(error.message), { code: error.code, stdout, stderr }));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (options.abortSignal?.aborted) {
        rejectOnce(Object.assign(new Error('Subscription CLI execution aborted'), {
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
      rejectOnce(Object.assign(
        new Error(signal ? `subscription CLI terminated by signal ${signal}` : `subscription CLI exited with code ${code ?? 'unknown'}`),
        { code: code ?? undefined, stdout, stderr, signal },
      ));
    });

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        abortHandler();
      } else {
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    if (invocation.stdin !== undefined) {
      child.stdin?.end(invocation.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstText(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function extractCursorContent(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const record = toRecord(parsed);
    if (!record) {
      return undefined;
    }
    const nested = [record.data, record.response, record.payload]
      .map((value) => toRecord(value))
      .filter((value): value is Record<string, unknown> => value !== undefined);
    return firstText([
      record.content,
      record.text,
      record.output,
      record.result,
      record.message,
      ...nested.flatMap((value) => [value.content, value.text, value.output, value.result, value.message]),
    ]);
  } catch {
    return undefined;
  }
}

async function readCodexOutput(invocation: SubscriptionCliInvocation, stdout: string): Promise<string> {
  if (!invocation.outputPath) {
    return stdout.trim();
  }
  try {
    const content = await readFile(invocation.outputPath, 'utf-8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : stdout.trim();
  } catch {
    return stdout.trim();
  }
}

async function resolveContent(
  provider: SubscriptionCliProviderType,
  invocation: SubscriptionCliInvocation,
  stdout: string,
): Promise<string> {
  if (provider === 'codex-cli') {
    return readCodexOutput(invocation, stdout);
  }
  if (provider === 'cursor-cli') {
    return extractCursorContent(stdout) ?? stdout.trim();
  }
  return stdout.trim();
}

function buildErrorResponse(
  agentType: string,
  options: SubscriptionCliCallOptions,
  error: ExecError,
): AgentResponse {
  const detail = trimDetail(error.stderr) || trimDetail(error.stdout) || getErrorMessage(error);
  const message = error.code === 'ENOENT'
    ? `${options.provider} binary not found. Install the CLI and ensure it is on PATH.`
    : `${options.provider} failed: ${detail}`;
  options.onStream?.({
    type: 'result',
    data: {
      result: '',
      success: false,
      error: message,
      sessionId: options.sessionId ?? '',
    },
  });
  return {
    persona: agentType,
    status: 'error',
    content: message,
    error: message,
    timestamp: new Date(),
    sessionId: options.sessionId,
  };
}

export async function callSubscriptionCli(
  agentType: string,
  prompt: string,
  options: SubscriptionCliCallOptions,
): Promise<AgentResponse> {
  let tempDir: string | undefined;
  try {
    let outputPath = options.outputPath;
    if (options.provider === 'codex-cli' && outputPath === undefined) {
      tempDir = await mkdtemp(join(tmpdir(), 'takt-codex-cli-'));
      outputPath = join(tempDir, 'last-message.txt');
    }

    const invocation = buildSubscriptionCliInvocation(options.provider, prompt, {
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      model: options.model,
      sessionId: options.sessionId,
      permissionMode: options.permissionMode,
      commandPath: options.commandPath,
      outputPath,
    });

    const { stdout } = await execSubscriptionCli(invocation, options);
    const content = await resolveContent(options.provider, invocation, stdout);
    options.onStream?.({ type: 'text', data: { text: content } });
    options.onStream?.({
      type: 'result',
      data: {
        result: content,
        success: true,
        sessionId: options.sessionId ?? '',
      },
    });
    return {
      persona: agentType,
      status: 'done',
      content,
      timestamp: new Date(),
      sessionId: options.sessionId,
    };
  } catch (rawError) {
    return buildErrorResponse(agentType, options, toExecError(rawError));
  } finally {
    if (tempDir !== undefined) {
      await rm(tempDir, { force: true, recursive: true });
    }
  }
}
