import { crossSpawn, guardChildProcessStreams } from '../../shared/utils/index.js';
import { buildEnvWithNestedObservabilitySnapshot } from '../../shared/telemetry/index.js';
import { isRateLimitMarkerNotice } from '../rate-limit/detection.js';
import {
  tryExtractRateLimitNoticeFromStreamJsonLine,
  tryExtractTextFromStreamJsonLine,
  tryExtractThinkingFromStreamJsonLine,
  tryExtractToolResultFromStreamJsonLine,
  tryExtractToolUseFromStreamJsonLine,
} from './stream-json-lines.js';
import type { ClaudeHeadlessCallOptions } from './types.js';

const HEADLESS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const HEADLESS_FORCE_KILL_DELAY_MS = 1_000;
export const HEADLESS_ABORTED_MESSAGE = 'Claude CLI execution aborted';
export const HEADLESS_RATE_LIMIT_MESSAGE = 'Claude CLI stream reported a rate limit';
const CLAUDE_COMMAND = 'claude';

function buildHeadlessEnv(options: ClaudeHeadlessCallOptions): NodeJS.ProcessEnv {
  const env = buildEnvWithNestedObservabilitySnapshot(process.env, options.childProcessEnv);
  if (options.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = options.anthropicApiKey;
  }
  if (options.baseUrl !== undefined) {
    env.ANTHROPIC_BASE_URL = options.baseUrl;
  }
  return env;
}

export type ExecError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

function createExecError(
  message: string,
  params: {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals | null;
    name?: string;
  } = {},
): ExecError {
  const error = new Error(message) as ExecError;
  if (params.name) {
    error.name = params.name;
  }
  error.code = params.code;
  error.stdout = params.stdout;
  error.stderr = params.stderr;
  error.signal = params.signal;
  return error;
}

export function runHeadlessCli(
  args: string[],
  options: ClaudeHeadlessCallOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const executable = options.claudeCliPath ?? CLAUDE_COMMAND;
    const child = crossSpawn(executable, args, {
      cwd: options.cwd,
      env: buildHeadlessEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let childClosed = false;

    const clearForceKillTimer = (): void => {
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
    };

    const scheduleForceKill = (): void => {
      clearForceKillTimer();
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        if (!settled && !childClosed) {
          child.kill('SIGKILL');
        }
      }, HEADLESS_FORCE_KILL_DELAY_MS);
      forceKillTimer.unref?.();
    };

    const abortHandler = (): void => {
      if (settled) {
        return;
      }
      child.kill('SIGTERM');
      scheduleForceKill();
    };

    const cleanup = (): void => {
      clearForceKillTimer();
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
      guardTeardown();
    };

    const resolveOnce = (result: { stdout: string; stderr: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectOnce = (error: ExecError, terminateChild = false): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (terminateChild) {
        child.kill('SIGTERM');
      }
      cleanup();
      reject(error);
    };

    const rejectWithRateLimit = (): void => {
      child.kill('SIGTERM');
      rejectOnce(
        createExecError(HEADLESS_RATE_LIMIT_MESSAGE, {
          stdout,
          stderr,
        }),
      );
    };

    let stderrLineBuffer = '';

    // setEncoding('utf8') 後の 'data' は string だが、Node の型は Buffer | string のまま。
    // ストリームを差し替えるテストやラッパーが Buffer を流す場合に備えて文字列化を一本化する。
    const toUtf8Text = (chunk: Buffer | string): string =>
      (typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));

    const appendChunk = (target: 'stdout' | 'stderr', text: string): void => {
      const byteLength = Buffer.byteLength(text);

      if (target === 'stdout') {
        stdoutBytes += byteLength;
        if (stdoutBytes > HEADLESS_MAX_BUFFER_BYTES) {
          child.kill('SIGTERM');
          rejectOnce(
            createExecError('Claude CLI stdout exceeded buffer limit', {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
              stdout,
              stderr,
            }),
          );
          return;
        }
        stdout += text;
        return;
      }

      stderrBytes += byteLength;
      if (stderrBytes > HEADLESS_MAX_BUFFER_BYTES) {
        child.kill('SIGTERM');
        rejectOnce(
          createExecError('Claude CLI stderr exceeded buffer limit', {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            stdout,
            stderr,
          }),
        );
        return;
      }
      stderr += text;
      // stderr は stream-json ではないので、1 行全体が rate limit 通知文になっている行だけを見る。
      // 改行で確定した行だけを判定し、途中で切れた最終行は close 時にまとめて見る。
      stderrLineBuffer += text;
      const stderrLines = stderrLineBuffer.split('\n');
      stderrLineBuffer = stderrLines.pop() ?? '';
      if (stderrLines.some((line) => isRateLimitMarkerNotice(line))) {
        rejectWithRateLimit();
      }
    };

    let lineBuffer = '';

    const flushLines = (final = false): void => {
      const parts = lineBuffer.split('\n');
      lineBuffer = final ? '' : (parts.pop() ?? '');
      // stdout can keep arriving after the call has settled (the listener stays
      // attached until close): keep trimming lineBuffer, but deliver no more events.
      if (settled) return;

      // rate limit 通知は構造化された stream-json イベント単位で判定する。
      // 累積 stdout の部分一致では tool_result 内の文字列でも CLI を止めてしまう (#1674)。
      for (const line of parts) {
        if (tryExtractRateLimitNoticeFromStreamJsonLine(line) !== undefined) {
          rejectWithRateLimit();
          return;
        }
      }

      if (!options.onStream) return;

      try {
        for (const line of parts) {
          const toolUses = tryExtractToolUseFromStreamJsonLine(line);
          for (const toolUse of toolUses) {
            options.onStream({ type: 'tool_use', data: toolUse });
          }
          const toolResults = tryExtractToolResultFromStreamJsonLine(line);
          for (const toolResult of toolResults) {
            options.onStream({ type: 'tool_result', data: toolResult });
          }
          const thinking = tryExtractThinkingFromStreamJsonLine(line);
          if (thinking) {
            options.onStream({ type: 'thinking', data: { thinking } });
            continue;
          }
          const text = tryExtractTextFromStreamJsonLine(line);
          if (text) {
            options.onStream({ type: 'text', data: { text } });
          }
        }
      } catch (error) {
        // onStream runs inside the child's stdout/close listeners. An exception
        // escaping here never reaches the promise, so the call would neither
        // resolve nor reject (#1580). Fail the call and stop the child instead.
        rejectOnce(error instanceof Error ? error : new Error(String(error)), true);
      }
    };

    // チャンク境界で分割されたマルチバイト文字（通知文の ’ など）を壊さないよう、ストリーム側で UTF-8 デコードする。
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = toUtf8Text(chunk);
      appendChunk('stdout', text);
      lineBuffer += text;
      flushLines(false);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => appendChunk('stderr', toUtf8Text(chunk)));

    const guardTeardown = guardChildProcessStreams(child, (error, source) => {
      if (source === 'process') {
        rejectOnce(
          createExecError(error.message, {
            code: (error as NodeJS.ErrnoException).code,
            stdout,
            stderr,
          }),
        );
        return;
      }
      rejectOnce(
        createExecError(`Claude CLI ${source} stream error: ${error.message}`, {
          stdout,
          stderr,
        }),
        true,
      );
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      childClosed = true;
      if (settled) {
        return;
      }

      flushLines(true);
      if (settled) {
        return;
      }
      // 改行なしで終わった stderr の最終行が通知文なら、ここで一度だけ判定する。
      if (isRateLimitMarkerNotice(stderrLineBuffer)) {
        rejectWithRateLimit();
        return;
      }

      if (options.abortSignal?.aborted) {
        rejectOnce(
          createExecError(HEADLESS_ABORTED_MESSAGE, {
            name: 'AbortError',
            stdout,
            stderr,
            signal,
          }),
        );
        return;
      }

      if (code === 0) {
        resolveOnce({ stdout, stderr });
        return;
      }

      const message = signal
        ? `Claude CLI terminated by signal ${signal}`
        : code === null
          ? 'Claude CLI exited without an exit code'
          : `Claude CLI exited with code ${code}`;

      rejectOnce(
        createExecError(message, {
          code: code ?? undefined,
          stdout,
          stderr,
          signal,
        }),
      );
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
