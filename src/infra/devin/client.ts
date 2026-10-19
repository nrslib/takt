import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { AgentResponse, ProviderUsageSnapshot } from '../../core/models/index.js';
import { AGENT_FAILURE_CATEGORIES, type AgentFailureCategory } from '../../shared/types/agent-failure.js';
import { createLogger, ensureCurrentTmpDirExists, getErrorMessage } from '../../shared/utils/index.js';
import { buildRateLimitedResponseFields, containsRateLimitError } from '../rate-limit/detection.js';
import { runDevinAcpPrompt } from './acp.js';
import { writeGeneratedConfig } from './config.js';
import { createExecError, spawnDevinAcp, type DevinExecError } from './process.js';
import type { DevinCallOptions } from './types.js';

export type { DevinCallOptions } from './types.js';

const log = createLogger('devin-client');

const DEVIN_ABORTED_MESSAGE = 'Devin execution aborted';
const DEVIN_ERROR_DETAIL_MAX_LENGTH = 400;
const DEVIN_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function buildPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }
  return `${systemPrompt}\n\n${prompt}`;
}

function validateSessionId(sessionId: string): void {
  if (!DEVIN_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Invalid Devin session ID. Only letters, numbers, dot, underscore, colon, and hyphen are allowed.');
  }
}

function buildArgs(configFilePath: string, options: DevinCallOptions): string[] {
  const args = [
    '--config', configFilePath,
    // TAKT manages its own working directories (including worktree clones), so
    // the workspace trust check is skipped. The flag is global; `devin acp`
    // has no `--config` / `--permission-mode` options of its own — permission
    // rules still apply to ACP sessions, and uncovered actions are answered
    // through session/request_permission.
    '--respect-workspace-trust', 'false',
    'acp',
  ];

  // `--model` only applies to session creation; a resumed session keeps the
  // model it was created with, so the flag is omitted when resuming.
  if (options.model && !options.sessionId) {
    args.push('--model', options.model);
  }

  return args;
}

function trimDetail(value: string | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > DEVIN_ERROR_DETAIL_MAX_LENGTH
    ? `${normalized.slice(0, DEVIN_ERROR_DETAIL_MAX_LENGTH)}...`
    : normalized;
}

function selectErrorDetail(error: DevinExecError): string {
  const stderr = trimDetail(error.stderr);
  if (stderr) {
    return error.stderr ?? '';
  }

  return getErrorMessage(error);
}

function isAuthenticationError(error: DevinExecError): boolean {
  const message = [
    trimDetail(error.message),
    trimDetail(error.stderr),
  ].join('\n').toLowerCase();

  const patterns = [
    'authentication',
    'unauthorized',
    'forbidden',
    'not logged in',
    'login required',
    'invalid credentials',
    'api key',
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

function classifyExecutionError(error: DevinExecError, options: DevinCallOptions): string {
  if (options.abortSignal?.aborted || error.name === 'AbortError') {
    return DEVIN_ABORTED_MESSAGE;
  }

  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'Devin CLI output exceeded buffer limit';
  }

  if (error.code === 'ENOENT') {
    return 'devin binary not found. Install Devin CLI and ensure `devin` is in PATH, or set TAKT_DEVIN_CLI_PATH/devin_cli_path.';
  }

  if (isAuthenticationError(error)) {
    return 'Devin CLI authentication failed. Run `devin auth login`.';
  }

  if (typeof error.code === 'number') {
    const detail = trimDetail(selectErrorDetail(error));
    return `Devin CLI exited with code ${error.code}: ${detail}`;
  }

  return getErrorMessage(error);
}

function usageMissingSnapshot(): ProviderUsageSnapshot {
  return { usageMissing: true, reason: USAGE_MISSING_REASONS.NOT_AVAILABLE };
}

function emitResult(
  options: DevinCallOptions,
  result: string,
  success: boolean,
  error: string | undefined,
  sessionId: string | undefined,
  failureCategory?: AgentFailureCategory,
): void {
  options.onStream?.({
    type: 'result',
    data: {
      result,
      success,
      error,
      sessionId: sessionId ?? '',
      failureCategory,
    },
  });
}

export class DevinClient {
  async call(agentType: string, prompt: string, options: DevinCallOptions): Promise<AgentResponse> {
    let tmpDir: string | undefined;
    try {
      if (options.sessionId) {
        validateSessionId(options.sessionId);
      }
      tmpDir = await mkdtemp(join(ensureCurrentTmpDirExists(), 'takt-devin-'));

      // Every call gets a generated `--config` seeded from the user's own
      // config file: the flag replaces that file entirely, so merging it keeps
      // model selection and user settings identical across permission modes
      // while TAKT's permission rules are layered on top. The rules apply to
      // ACP sessions exactly as they did in print mode.
      const configFilePath = await writeGeneratedConfig(tmpDir, options);
      const args = buildArgs(configFilePath, options);

      options.onActivity?.({ kind: 'attempt_started' });
      const proc = spawnDevinAcp(args, options);
      const outcome = await runDevinAcpPrompt(proc, buildPrompt(prompt, options.systemPrompt), options);
      const { sessionId, providerUsage } = outcome;

      if (outcome.stopReason === 'cancelled' || options.abortSignal?.aborted) {
        throw createExecError(DEVIN_ABORTED_MESSAGE, { name: 'AbortError' });
      }

      const content = outcome.content.trim();
      if (content.length === 0) {
        const emptyError = outcome.stopReason === 'end_turn'
          ? 'devin returned empty output'
          : `devin returned empty output (stop reason: ${outcome.stopReason})`;
        emitResult(options, '', false, emptyError, sessionId);
        return {
          persona: agentType,
          status: 'error',
          content: emptyError,
          error: emptyError,
          timestamp: new Date(),
          sessionId,
          providerUsage,
        };
      }

      if (containsRateLimitError(content)) {
        const rateLimitedFields = buildRateLimitedResponseFields('devin', 'error_text', content);
        emitResult(options, '', false, rateLimitedFields.error, sessionId);
        return {
          persona: agentType,
          timestamp: new Date(),
          sessionId,
          providerUsage,
          ...rateLimitedFields,
        };
      }

      // A turn that stopped for a reason other than `end_turn` (`max_tokens`,
      // `max_turn_requests`, `refusal`) produced incomplete output; the
      // partial text is kept in content but must not reach the judge as a
      // completed step. `cancelled` is handled above.
      if (outcome.stopReason !== 'end_turn') {
        const stopError = `devin returned incomplete output (stop reason: ${outcome.stopReason})`;
        emitResult(options, content, false, stopError, sessionId, AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR);
        return {
          persona: agentType,
          status: 'error',
          content,
          error: stopError,
          failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
          timestamp: new Date(),
          sessionId,
          providerUsage,
        };
      }

      emitResult(options, content, true, undefined, sessionId);

      return {
        persona: agentType,
        status: 'done',
        content,
        timestamp: new Date(),
        sessionId,
        providerUsage,
      };
    } catch (rawError) {
      const error = rawError as DevinExecError;
      const combined = `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${getErrorMessage(error)}`;
      const aborted = options.abortSignal?.aborted || error.name === 'AbortError';
      if (!aborted && containsRateLimitError(combined)) {
        const rateLimitedFields = buildRateLimitedResponseFields('devin', 'error_text', trimDetail(combined));
        emitResult(options, '', false, rateLimitedFields.error, options.sessionId);
        return {
          persona: agentType,
          timestamp: new Date(),
          sessionId: options.sessionId,
          providerUsage: usageMissingSnapshot(),
          ...rateLimitedFields,
        };
      }
      const message = classifyExecutionError(error, options);
      emitResult(options, '', false, message, options.sessionId);
      return {
        persona: agentType,
        status: 'error',
        content: message,
        error: message,
        timestamp: new Date(),
        sessionId: options.sessionId,
        providerUsage: usageMissingSnapshot(),
      };
    } finally {
      try {
        await options.preparedMcp?.dispose?.();
      } catch (error) {
        log.debug('Failed to clean up Devin MCP material', { error: getErrorMessage(error) });
      }
      if (tmpDir !== undefined) {
        try {
          await rm(tmpDir, { recursive: true, force: true });
        } catch (error) {
          log.debug('Failed to clean up Devin tmp dir', { dir: tmpDir, error: getErrorMessage(error) });
        }
      }
    }
  }
}

const defaultClient = new DevinClient();

export async function callDevin(
  agentType: string,
  prompt: string,
  options: DevinCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}
