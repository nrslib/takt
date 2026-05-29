import type { AgentResponse } from '../../core/models/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { execKiro, type KiroExecError } from './process.js';
import type { KiroCallOptions } from './types.js';

export type { KiroCallOptions } from './types.js';

const KIRO_ABORTED_MESSAGE = 'Kiro execution aborted';
const KIRO_ERROR_DETAIL_MAX_LENGTH = 400;
const KIRO_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function buildPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }
  return `${systemPrompt}\n\n${prompt}`;
}

function buildTrustArgs(options: KiroCallOptions): string[] {
  if (options.permissionMode === 'full') {
    return ['--trust-all-tools'];
  }
  if (options.permissionMode === 'edit') {
    return ['--trust-tools=read,grep,write,shell'];
  }
  if (options.permissionMode === 'readonly') {
    return ['--trust-tools=read,grep'];
  }
  return [];
}

function validateSessionId(sessionId: string): void {
  if (!KIRO_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Invalid Kiro session ID. Only letters, numbers, dot, underscore, colon, and hyphen are allowed.');
  }
}

function validatePromptArgument(prompt: string): void {
  if (prompt.startsWith('-')) {
    throw new Error('Invalid Kiro prompt. Prompt must not start with a hyphen because Kiro CLI may parse it as an option.');
  }
}

function buildArgs(options: KiroCallOptions, prompt: string): string[] {
  validatePromptArgument(prompt);

  const args = [
    'chat',
    '--no-interactive',
    ...buildTrustArgs(options),
  ];

  if (options.sessionId) {
    validateSessionId(options.sessionId);
    args.push('--resume-id', options.sessionId);
  }

  args.push(prompt);

  return args;
}

function trimDetail(value: string | undefined, fallback = ''): string {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > KIRO_ERROR_DETAIL_MAX_LENGTH
    ? `${normalized.slice(0, KIRO_ERROR_DETAIL_MAX_LENGTH)}...`
    : normalized;
}

function redactDetail(value: string, kiroApiKey: string | undefined): string {
  if (!kiroApiKey) {
    return value;
  }
  return value.split(kiroApiKey).join('[REDACTED]');
}

function redactedTrimmedDetail(value: string | undefined, kiroApiKey: string | undefined): string {
  return trimDetail(redactDetail(value ?? '', kiroApiKey));
}

function selectErrorDetail(error: KiroExecError): string {
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

function isAuthenticationError(error: KiroExecError): boolean {
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
    'kiro_api_key',
    'kiro-api-key',
    'login required',
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

function classifyExecutionError(error: KiroExecError, options: KiroCallOptions): string {
  if (options.abortSignal?.aborted || error.name === 'AbortError') {
    return KIRO_ABORTED_MESSAGE;
  }

  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'Kiro CLI output exceeded buffer limit';
  }

  if (error.code === 'ENOENT') {
    return 'kiro-cli binary not found. Install Kiro CLI and ensure `kiro-cli` is in PATH, or set TAKT_KIRO_CLI_PATH/kiro_cli_path.';
  }

  if (isAuthenticationError(error)) {
    return 'Kiro authentication failed. Set TAKT_KIRO_API_KEY, kiro_api_key, or KIRO_API_KEY.';
  }

  if (typeof error.code === 'number') {
    const detail = redactedTrimmedDetail(selectErrorDetail(error), options.kiroApiKey);
    return `Kiro CLI exited with code ${error.code}: ${detail}`;
  }

  return redactDetail(getErrorMessage(error), options.kiroApiKey);
}

function emitResult(
  options: KiroCallOptions,
  result: string,
  success: boolean,
  error?: string,
): void {
  options.onStream?.({
    type: 'result',
    data: {
      result,
      success,
      error,
      sessionId: options.sessionId ?? '',
    },
  });
}

export class KiroClient {
  async call(agentType: string, prompt: string, options: KiroCallOptions): Promise<AgentResponse> {
    const promptText = buildPrompt(prompt, options.systemPrompt);

    try {
      const args = buildArgs(options, promptText);
      const { stdout } = await execKiro(args, options);
      const content = stdout.trim();
      if (!content) {
        const message = 'kiro-cli returned empty output';
        emitResult(options, '', false, message);
        return {
          persona: agentType,
          status: 'error',
          content: message,
          error: message,
          timestamp: new Date(),
          sessionId: options.sessionId,
        };
      }

      options.onStream?.({ type: 'text', data: { text: content } });
      emitResult(options, content, true);

      return {
        persona: agentType,
        status: 'done',
        content,
        timestamp: new Date(),
        sessionId: options.sessionId,
      };
    } catch (rawError) {
      const error = rawError as KiroExecError;
      const message = classifyExecutionError(error, options);
      emitResult(options, '', false, message);
      return {
        persona: agentType,
        status: 'error',
        content: message,
        error: message,
        timestamp: new Date(),
        sessionId: options.sessionId,
      };
    }
  }
}

const defaultClient = new KiroClient();

export async function callKiro(
  agentType: string,
  prompt: string,
  options: KiroCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}
