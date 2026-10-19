import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentResponse } from '../../core/models/index.js';
import { createLogger, ensureCurrentTmpDirExists, getErrorMessage, stripAnsi } from '../../shared/utils/index.js';
import { buildRateLimitedResponseFields, containsRateLimitError } from '../rate-limit/detection.js';
import { execDevin, type DevinExecError } from './process.js';
import type { DevinCallOptions } from './types.js';

export type { DevinCallOptions } from './types.js';

const log = createLogger('devin-client');

const DEVIN_ABORTED_MESSAGE = 'Devin execution aborted';
const DEVIN_ERROR_DETAIL_MAX_LENGTH = 400;
const DEVIN_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

// Print mode cannot show approval prompts, and a mode that would prompt in a
// TUI instead auto-denies the action: `accept-edits` still denies `exec`, and
// `auto` approves read-only tools only. Permission enforcement is therefore
// done through a generated `--config` file — `allow` rules grant `exec` for
// TAKT's `edit` mode (which, per the kiro/cursor mapping, means file edits
// plus shell), while `deny` rules enforce `readonly`.
const READONLY_DENY_RULES = ['exec', 'edit', 'Write(**)', 'mcp__*'] as const;
const STRICT_READONLY_EXTRA_DENY_RULES = ['Fetch(**)'] as const;
const EDIT_ALLOW_RULES = ['exec', 'edit', 'Write(**)'] as const;

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

function buildReadonlyDenyRules(options: DevinCallOptions): readonly string[] {
  return options.internalAgentIsolation === 'strict-readonly'
    ? [...READONLY_DENY_RULES, ...STRICT_READONLY_EXTRA_DENY_RULES]
    : READONLY_DENY_RULES;
}

function validateSessionId(sessionId: string): void {
  if (!DEVIN_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Invalid Devin session ID. Only letters, numbers, dot, underscore, colon, and hyphen are allowed.');
  }
}

interface DevinInvocation {
  promptFilePath: string;
  exportFilePath: string;
  configFilePath?: string;
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
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.sessionId) {
    validateSessionId(options.sessionId);
    args.push('-r', options.sessionId);
  }

  if (invocation.configFilePath !== undefined) {
    args.push('--config', invocation.configFilePath);
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

// `--export` writes the session transcript (ATIF format) after each turn,
// including the real `session_id`. Reading it back is the only reliable way to
// learn a new session's ID in print mode: the ID is bound to this exact process,
// so parallel steps sharing a working directory can never pick up each other's
// session. A missing or malformed export (failed turn, CLI change) leaves the
// session unresolved — the next phase then simply starts a fresh session.
async function readExportedSessionId(exportFilePath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(exportFilePath, 'utf-8')) as { session_id?: unknown };
    const sessionId = parsed.session_id;
    return typeof sessionId === 'string' && DEVIN_SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined;
  } catch (error) {
    log.debug('Failed to read Devin session export; session ID unresolved for this turn', {
      error: getErrorMessage(error),
    });
    return undefined;
  }
}

// `shell.setup_complete` suppresses the first-run setup banner that Devin
// otherwise prints to stdout when handed a fresh `--config` file, which would
// pollute the captured response (and break JSON output contracts).
async function writePermissionsConfig(dir: string, options: DevinCallOptions): Promise<string> {
  const permissions = options.permissionMode === 'edit'
    ? { allow: [...EDIT_ALLOW_RULES] }
    : { deny: buildReadonlyDenyRules(options) };
  const config = {
    version: 1,
    shell: { setup_complete: true },
    permissions,
  };
  const configFilePath = join(dir, 'permissions-config.json');
  await writeFile(configFilePath, JSON.stringify(config), 'utf-8');
  return configFilePath;
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

      const invocation: DevinInvocation = { promptFilePath, exportFilePath: join(tmpDir, 'export.json') };
      // `edit` and `readonly` both need a generated `--config`: `edit` adds
      // `exec` allow rules because accept-edits auto-denies shell in print
      // mode, `readonly` adds deny rules because auto approves too much.
      if (options.permissionMode === 'readonly' || options.permissionMode === 'edit') {
        invocation.configFilePath = await writePermissionsConfig(tmpDir, options);
      }

      const args = buildArgs(invocation, options);
      options.onActivity?.({ kind: 'attempt_started' });
      const { stdout } = await execDevin(args, options);
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
        };
      }

      if (containsRateLimitError(content)) {
        const rateLimitedFields = buildRateLimitedResponseFields('devin', 'error_text', content);
        emitResult(options, '', false, rateLimitedFields.error, options.sessionId);
        return {
          persona: agentType,
          timestamp: new Date(),
          sessionId: options.sessionId,
          ...rateLimitedFields,
        };
      }

      const resolvedSessionId = options.sessionId ?? await readExportedSessionId(invocation.exportFilePath);

      options.onStream?.({ type: 'text', data: { text: content } });
      emitResult(options, content, true, undefined, resolvedSessionId);

      return {
        persona: agentType,
        status: 'done',
        content,
        timestamp: new Date(),
        sessionId: resolvedSessionId,
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
