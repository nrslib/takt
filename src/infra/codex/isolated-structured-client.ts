import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentResponse, ProviderUsageSnapshot } from '../../core/models/index.js';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import { buildEnvWithNestedObservabilitySnapshot } from '../../shared/telemetry/index.js';
import {
  createProviderErrorFailure,
  formatAgentFailure,
} from '../../shared/types/agent-failure.js';
import { getErrorMessage, parseStructuredOutput } from '../../shared/utils/index.js';
import {
  buildRateLimitedResponseFields,
  containsRateLimitError,
} from '../rate-limit/detection.js';
import type { CodexEvent, CodexItem } from './CodexStreamHandler.js';
import { extractProviderUsageFromTurnCompleted } from './client.js';
import type { CodexCallOptions } from './types.js';
import {
  boundCodexFailureMessage,
  type CodexFailureMessageOptions,
} from './failure-message.js';

const require = createRequire(import.meta.url);
const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_CHARS = 64 * 1024;
const ALLOWED_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
]);
const ITEM_EVENT_TYPES = new Set([
  'item.started',
  'item.updated',
  'item.completed',
]);
const ALLOWED_ITEM_TYPES = new Set([
  'agent_message',
  'reasoning',
]);
const DISABLED_TOOL_FEATURES = [
  'shell_tool',
  'unified_exec',
  'code_mode',
  'code_mode_host',
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'multi_agent',
  'multi_agent_v2',
] as const;

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function resolveCodexCommand(
  override: string | undefined,
): { command: string; prefixArgs: string[] } {
  if (override !== undefined) {
    return { command: override, prefixArgs: [] };
  }
  return {
    command: process.execPath,
    prefixArgs: [require.resolve('@openai/codex/bin/codex.js')],
  };
}

function appendConfig(args: string[], path: string, value: string): void {
  args.push('--config', `${path}=${value}`);
}

export function buildIsolatedCodexArgs(
  options: CodexCallOptions,
  outputSchemaPath: string,
): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    options.cwd,
    '--output-schema',
    outputSchemaPath,
  ];
  if (options.model !== undefined) {
    args.push('--model', options.model);
  }
  for (const feature of DISABLED_TOOL_FEATURES) {
    args.push('--disable', feature);
  }
  appendConfig(args, 'approval_policy', '"never"');
  appendConfig(args, 'mcp_servers', '{}');
  appendConfig(args, 'web_search', '"disabled"');
  if (options.reasoningEffort !== undefined) {
    appendConfig(args, 'model_reasoning_effort', JSON.stringify(options.reasoningEffort));
  }
  if (options.baseUrl !== undefined) {
    appendConfig(args, 'openai_base_url', JSON.stringify(options.baseUrl));
  }
  args.push('-');
  return args;
}

function extractTurnFailureMessage(event: CodexEvent): string {
  const error = event.error;
  if (
    error !== null
    && typeof error === 'object'
    && typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return 'Codex isolated structured turn failed';
}

function extractItem(event: CodexEvent): CodexItem | undefined {
  if (!ITEM_EVENT_TYPES.has(event.type)) {
    return undefined;
  }
  return event.item as CodexItem;
}

export function assertValidIsolatedCodexEvent(
  value: unknown,
): asserts value is CodexEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Strict isolated Codex execution emitted a malformed event');
  }
  const event = value as Record<string, unknown>;
  if (typeof event.type !== 'string' || !ALLOWED_EVENT_TYPES.has(event.type)) {
    const type = typeof event.type === 'string' ? event.type : '<missing>';
    throw new Error(
      `Strict isolated Codex execution emitted forbidden event type "${type}"`,
    );
  }
  if (event.type === 'turn.failed') {
    throw new Error(extractTurnFailureMessage(event as CodexEvent));
  }
  if (!ITEM_EVENT_TYPES.has(event.type)) {
    return;
  }
  if (event.item === null || typeof event.item !== 'object' || Array.isArray(event.item)) {
    throw new Error(
      `Strict isolated Codex execution emitted ${event.type} without an item object`,
    );
  }
  const item = event.item as Record<string, unknown>;
  if (typeof item.type !== 'string') {
    throw new Error(
      `Strict isolated Codex execution emitted ${event.type} without an item type`,
    );
  }
  if (!ALLOWED_ITEM_TYPES.has(item.type)) {
    throw new Error(
      `Strict isolated Codex execution emitted forbidden item type "${item.type}"`,
    );
  }
}

function createErrorResponse(
  agentType: string,
  error: unknown,
  options: CodexFailureMessageOptions,
): AgentResponse {
  const rawMessage = getErrorMessage(error);
  if (containsRateLimitError(rawMessage)) {
    const rateLimitedResponse = buildRateLimitedResponseFields('codex', 'sdk_error', rawMessage);
    return {
      persona: agentType,
      timestamp: new Date(),
      ...rateLimitedResponse,
      error: boundCodexFailureMessage(rateLimitedResponse.error, options, true),
    };
  }
  const failure = createProviderErrorFailure(rawMessage);
  const content = boundCodexFailureMessage(formatAgentFailure(failure), options, true);
  return {
    persona: agentType,
    status: 'error',
    content,
    error: content,
    failureCategory: failure.category,
    timestamp: new Date(),
  };
}

export async function callCodexIsolatedStructured(
  agentType: string,
  prompt: string,
  options: CodexCallOptions,
): Promise<AgentResponse> {
  try {
    options.abortSignal?.throwIfAborted();
  } catch (error) {
    return createErrorResponse(agentType, error, options);
  }
  if (options.sessionId !== undefined) {
    return createErrorResponse(
      agentType,
      'Strict isolated Codex execution does not accept a session',
      options,
    );
  }
  if (options.outputSchema === undefined) {
    return createErrorResponse(
      agentType,
      'Strict isolated Codex execution requires an output schema',
      options,
    );
  }
  if (options.imageAttachments !== undefined && options.imageAttachments.length > 0) {
    return createErrorResponse(
      agentType,
      'Strict isolated Codex execution does not accept image attachments',
      options,
    );
  }

  const outputSchemaPath = join(options.cwd, '.takt-isolated-output-schema.json');
  writeFileSync(outputSchemaPath, JSON.stringify(options.outputSchema), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const resolved = resolveCodexCommand(options.codexPathOverride);
  const args = [
    ...resolved.prefixArgs,
    ...buildIsolatedCodexArgs(options, outputSchemaPath),
  ];
  const env = buildEnvWithNestedObservabilitySnapshot(
    process.env,
    options.childProcessEnv,
  );
  env.PWD = options.cwd;
  delete env.OLDPWD;
  if (options.openaiApiKey !== undefined) {
    env.CODEX_API_KEY = options.openaiApiKey;
  }

  try {
    const child = spawn(resolved.command, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise<ExitResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const stdinSettledPromise = new Promise<Error | undefined>((resolve) => {
      child.stdin.once('error', (error: Error) => resolve(error));
      child.stdin.once('close', () => resolve(undefined));
    });
    let stderr = '';
    let idleTimedOut = false;
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimeout = (): void => {
      if (idleTimeout !== undefined) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => {
        idleTimedOut = true;
        child.kill();
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    resetIdleTimeout();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      resetIdleTimeout();
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
    });

    const abort = (): void => {
      child.kill();
    };
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    if (options.abortSignal?.aborted === true) {
      abort();
    }

    if (options.abortSignal?.aborted === true) {
      child.stdin.destroy();
    } else {
      child.stdin.end(prompt);
    }
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let lastAgentMessage = '';
    let providerUsage: ProviderUsageSnapshot | undefined;

    try {
      for await (const line of lines) {
        resetIdleTimeout();
        if (line.trim() === '') {
          continue;
        }
        const event: unknown = JSON.parse(line);
        assertValidIsolatedCodexEvent(event);
        if (event.type === 'turn.completed') {
          providerUsage = extractProviderUsageFromTurnCompleted(event);
          continue;
        }
        const item = extractItem(event);
        if (
          event.type === 'item.completed'
          && item?.type === 'agent_message'
          && typeof item.text === 'string'
        ) {
          lastAgentMessage = item.text;
        }
      }

      const exit = await exitPromise;
      const stdinError = await stdinSettledPromise;
      if (idleTimedOut) {
        throw new Error('Codex isolated structured execution timed out');
      }
      options.abortSignal?.throwIfAborted();
      if (stdinError !== undefined) {
        throw stdinError;
      }
      if (exit.code !== 0) {
        throw new Error(
          stderr.trim()
            || `Codex isolated structured execution exited with code ${exit.code ?? exit.signal ?? 'unknown'}`,
        );
      }

      const content = lastAgentMessage.trim();
      const structuredOutput = parseStructuredOutput(content, true);
      return {
        persona: agentType,
        status: 'done',
        content,
        structuredOutput,
        providerUsage: providerUsage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
        timestamp: new Date(),
      };
    } finally {
      if (idleTimeout !== undefined) {
        clearTimeout(idleTimeout);
      }
      options.abortSignal?.removeEventListener('abort', abort);
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
  } catch (error) {
    return createErrorResponse(agentType, error, options);
  }
}
