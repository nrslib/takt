import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { AgentResponse, ProviderUsageSnapshot } from '../../core/models/index.js';
import { createLogger, ensureCurrentTmpDirExists, getErrorMessage, stripAnsi } from '../../shared/utils/index.js';
import { buildRateLimitedResponseFields, containsRateLimitError } from '../rate-limit/detection.js';
import { writeGeneratedConfig } from './config.js';
import { DEVIN_SESSION_ID_PATTERN, readDevinExport } from './export.js';
import { execDevin, type DevinExecError } from './process.js';
import type { DevinCallOptions } from './types.js';

export type { DevinCallOptions } from './types.js';

const log = createLogger('devin-client');

const DEVIN_ABORTED_MESSAGE = 'Devin execution aborted';
const DEVIN_ERROR_DETAIL_MAX_LENGTH = 400;

function buildPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }
  return `${systemPrompt}\n\n${prompt}`;
}

function buildPermissionModeArg(options: DevinCallOptions): string {
  if (options.permissionMode === 'full') {
    return 'dangerous';
  }
  if (options.permissionMode === 'edit') {
    return 'accept-edits';
  }
  return 'auto';
}

function validateSessionId(sessionId: string): void {
  if (!DEVIN_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Invalid Devin session ID. Only letters, numbers, dot, underscore, colon, and hyphen are allowed.');
  }
}

interface DevinInvocation {
  promptFilePath: string;
  exportFilePath: string;
  configFilePath: string;
}

function buildArgs(invocation: DevinInvocation, options: DevinCallOptions): string[] {
  const args = [
    '-p',
    '--prompt-file', invocation.promptFilePath,
    '--permission-mode', buildPermissionModeArg(options),
    // Non-interactive print mode cannot show the workspace trust prompt and
    // fails outright in an untrusted directory. TAKT manages its own working
    // directories (including worktree clones), so the check is skipped.
    '--respect-workspace-trust', 'false',
    '--export', invocation.exportFilePath,
    '--config', invocation.configFilePath,
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.sessionId) {
    validateSessionId(options.sessionId);
    args.push('-r', options.sessionId);
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

  const stdout = trimDetail(error.stdout);
  if (stdout) {
    return error.stdout ?? '';
  }

  return getErrorMessage(error);
}

function isAuthenticationError(error: DevinExecError): boolean {
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

function cleanDevinOutput(raw: string): string {
  return stripAnsi(raw).trim();
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
): void {
  options.onStream?.({
    type: 'result',
    data: {
      result,
      success,
      error,
      sessionId: sessionId ?? '',
    },
  });
}

export class DevinClient {
  async call(agentType: string, prompt: string, options: DevinCallOptions): Promise<AgentResponse> {
    let tmpDir: string | undefined;
    try {
      tmpDir = await mkdtemp(join(ensureCurrentTmpDirExists(), 'takt-devin-'));
      const promptFilePath = join(tmpDir, 'prompt.txt');
      const promptText = buildPrompt(prompt, options.systemPrompt);
      await writeFile(promptFilePath, promptText, 'utf-8');

      // Every call gets a generated `--config` seeded from the user's own
      // config file: the flag replaces that file entirely, so merging it keeps
      // model selection and user settings identical across permission modes
      // while TAKT's permission rules are layered on top.
      const invocation: DevinInvocation = {
        promptFilePath,
        exportFilePath: join(tmpDir, 'export.json'),
        configFilePath: await writeGeneratedConfig(tmpDir, options),
      };

      const args = buildArgs(invocation, options);
      options.onActivity?.({ kind: 'attempt_started' });
      const { stdout } = await execDevin(args, options);
      const exportData = await readDevinExport(invocation.exportFilePath);
      const providerUsage = exportData?.providerUsage ?? usageMissingSnapshot();
      const content = cleanDevinOutput(stdout);
      if (content.length === 0) {
        const emptyError = 'devin returned empty output';
        emitResult(options, '', false, emptyError, options.sessionId);
        return {
          persona: agentType,
          status: 'error',
          content: emptyError,
          error: emptyError,
          timestamp: new Date(),
          sessionId: options.sessionId,
          providerUsage,
        };
      }

      if (containsRateLimitError(content)) {
        const rateLimitedFields = buildRateLimitedResponseFields('devin', 'error_text', content);
        emitResult(options, '', false, rateLimitedFields.error, options.sessionId);
        return {
          persona: agentType,
          timestamp: new Date(),
          sessionId: options.sessionId,
          providerUsage,
          ...rateLimitedFields,
        };
      }

      const resolvedSessionId = options.sessionId ?? exportData?.sessionId;

      options.onStream?.({ type: 'text', data: { text: content } });
      emitResult(options, content, true, undefined, resolvedSessionId);

      return {
        persona: agentType,
        status: 'done',
        content,
        timestamp: new Date(),
        sessionId: resolvedSessionId,
        providerUsage,
      };
    } catch (rawError) {
      const error = rawError as DevinExecError;
      const combined = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
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
