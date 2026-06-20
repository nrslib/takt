import * as childProcess from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { stripAnsi } from '../../shared/utils/text.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import {
  buildEnvWithNestedObservabilitySnapshot,
  pickNestedObservabilityEnv,
} from '../../shared/telemetry/index.js';
import { createClaudeTerminalSessionName } from './command.js';
import type { TerminalBackend, TerminalSession, TerminalStartOptions } from './types.js';

const log = createLogger('claude-terminal-tmux');
const CLAUDE_READY_TIMEOUT_MS = 60000;
const PANE_CHANGE_TIMEOUT_MS = 5000;
const PANE_POLL_INTERVAL_MS = 100;
const CLAUDE_READY_TAIL_LINES = 3;
const CLAUDE_BUSY_PATTERN = /(Running|thinking|Searching|Reading|Writing|Editing|Crunched)/i;
const CLAUDE_PROMPT_PATTERN = /^[❯❱>](?:\s+(?!\d+\.\s)|$)/;

function getProperty(error: object, property: string): unknown {
  return (error as Record<string, unknown>)[property];
}

function getFailureCode(error: ExecFileException): string | undefined {
  const code = getProperty(error, 'code');
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  return undefined;
}

function getFailureStderr(error: ExecFileException): string | undefined {
  const stderr = getProperty(error, 'stderr');
  if (typeof stderr !== 'string') {
    return undefined;
  }
  const trimmed = stderr.trim();
  return trimmed.length > 0 ? redactSensitiveClaudeArgs(trimmed) : undefined;
}

function redactSensitiveClaudeArgs(text: string): string {
  return text
    .replace(/(--system-prompt(?:=|\s+)).*/g, '$1[redacted]')
    .replace(/(--json-schema(?:=|\s+)).*/g, '$1[redacted]');
}

function formatTmuxError(error: unknown): Error {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return new Error('tmux command not found. Install tmux to use provider: claude-terminal.');
  }
  if (error && typeof error === 'object') {
    const execError = error as ExecFileException;
    const code = getFailureCode(execError);
    const stderr = getFailureStderr(execError);
    const codeText = code ? ` with code ${code}` : '';
    const stderrText = stderr ? `: ${stderr}` : '.';
    return new Error(`tmux command failed${codeText}${stderrText}`);
  }
  return new Error('tmux command failed.');
}

async function runTmux(args: string[], options?: {
  cwd?: string;
  childProcessEnv?: Readonly<Record<string, string>>;
}): Promise<string> {
  if (!childProcess.execFile) {
    throw new Error('node:child_process.execFile is required to run tmux.');
  }
  const execFileAsync = promisify(childProcess.execFile) as (
    file: string,
    args: string[],
    options: { cwd?: string; encoding: BufferEncoding; maxBuffer: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  const env = buildEnvWithNestedObservabilitySnapshot(process.env, options?.childProcessEnv);
  try {
    const result = await execFileAsync('tmux', args, {
      cwd: options?.cwd,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 4,
      env,
    });
    return result.stdout;
  } catch (error) {
    throw formatTmuxError(error as ExecFileException);
  }
}

function buildNewSessionEnvArgs(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): string[] {
  return Object.entries(pickNestedObservabilityEnv(childProcessEnv))
    .filter(([key, value]) => value !== undefined && isTmuxArgSafeEnvKey(key))
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

function isTmuxArgSafeEnvKey(key: string): boolean {
  return !key.endsWith('_HEADERS')
    && !key.endsWith('_CLIENT_CERTIFICATE')
    && !key.endsWith('_CLIENT_KEY');
}

async function loadBuffer(bufferName: string, text: string): Promise<void> {
  if (!childProcess.spawn) {
    throw new Error('node:child_process.spawn is required to run tmux.');
  }
  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn('tmux', ['load-buffer', '-b', bufferName, '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(formatTmuxError(error)));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tmux load-buffer failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(text);
  });
}

async function capturePane(session: TerminalSession, lines: number): Promise<string> {
  return runTmux(['capture-pane', '-p', '-t', session.name, '-S', `-${lines}`]);
}

function isClaudeInputReady(capturedPane: string): boolean {
  const plain = stripAnsi(capturedPane);
  const tailLines = plain
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-CLAUDE_READY_TAIL_LINES);
  const hasPrompt = tailLines.some((line) => CLAUDE_PROMPT_PATTERN.test(line));
  const isBusy = CLAUDE_BUSY_PATTERN.test(tailLines.join('\n'));
  return hasPrompt && !isBusy;
}

async function waitForClaudeInputReady(session: TerminalSession): Promise<void> {
  const deadline = Date.now() + CLAUDE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const captured = await capturePane(session, 20);
    if (isClaudeInputReady(captured)) {
      return;
    }
    await sleep(PANE_POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for Claude terminal input prompt.');
}

async function waitForPaneChange(session: TerminalSession, before: string): Promise<void> {
  const deadline = Date.now() + PANE_CHANGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const captured = await capturePane(session, 40);
    if (captured !== before) {
      return;
    }
    await sleep(PANE_POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for Claude terminal paste to appear in pane.');
}

export class TmuxTerminalBackend implements TerminalBackend {
  async start(options: TerminalStartOptions): Promise<TerminalSession> {
    const name = createClaudeTerminalSessionName();
    await runTmux([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      options.cwd,
      ...buildNewSessionEnvArgs(options.childProcessEnv),
      options.command.executable,
      ...options.command.args,
    ], { cwd: options.cwd, childProcessEnv: options.childProcessEnv });
    return { id: name, name };
  }

  async pasteText(session: TerminalSession, text: string): Promise<void> {
    const bufferName = `${session.name}-prompt`;
    await waitForClaudeInputReady(session);
    const beforePaste = await capturePane(session, 40);
    await loadBuffer(bufferName, text);
    let pasteError: unknown;
    try {
      await runTmux(['paste-buffer', '-p', '-b', bufferName, '-t', session.name]);
      await waitForPaneChange(session, beforePaste);
      await runTmux(['send-keys', '-t', session.name, 'Enter']);
    } catch (error) {
      pasteError = error;
    }

    try {
      await runTmux(['delete-buffer', '-b', bufferName]);
    } catch (deleteError) {
      if (!pasteError) {
        throw deleteError;
      }
      log.error('Failed to delete Claude terminal tmux buffer after paste failure', {
        buffer: bufferName,
        error: getErrorMessage(deleteError),
      });
    }

    if (pasteError) {
      throw pasteError;
    }
  }

  async stop(session: TerminalSession): Promise<void> {
    await runTmux(['kill-session', '-t', session.name]);
  }
}
