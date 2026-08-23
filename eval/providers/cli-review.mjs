import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManagedProcess } from '../../dist/shared/utils/spawn.js';

const evalDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createIsolatedWorkingDirectory(sourceDirectory, copyDirectory = cpSync) {
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'takt-prompt-eval-fixture-'));
  const cwd = join(isolatedRoot, 'project');
  try {
    copyDirectory(sourceDirectory, cwd, { recursive: true });
  } catch (error) {
    rmSync(isolatedRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    cwd,
    cleanup: () => rmSync(isolatedRoot, { recursive: true, force: true }),
  };
}

export function prepareWorkingDirectory(config) {
  const sourceDirectory = resolve(evalDirectory, config.working_dir);
  if (!config.isolate_working_dir) {
    return { sourceDirectory, cwd: sourceDirectory, cleanup: () => undefined };
  }

  const isolated = createIsolatedWorkingDirectory(sourceDirectory);
  return {
    sourceDirectory,
    ...isolated,
  };
}

export function rewriteWorkingDirectoryPaths(prompt, workingDirectory) {
  if (workingDirectory.sourceDirectory === workingDirectory.cwd) return prompt;
  return prompt.replaceAll(workingDirectory.sourceDirectory, workingDirectory.cwd);
}

export function resolveTimeoutMs(config) {
  const timeoutMs = config.timeout_ms;
  if (timeoutMs === undefined || timeoutMs === 0) return 0;
  if (
    typeof timeoutMs !== 'number'
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 2_147_483_647
  ) {
    throw new Error('timeout_ms must be 0 (disabled) or an integer from 1 through 2147483647');
  }
  return timeoutMs;
}

export async function runProcess(command, args, { cwd, input, timeoutMs, abortSignal }) {
  if (abortSignal?.aborted) {
    throw new Error(`${command} was aborted before it started`);
  }

  const controller = new AbortController();
  const managed = spawnManagedProcess(
    command,
    args,
    { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    controller.signal,
  );
  const { child } = managed;
  const stdout = [];
  const stderr = [];
  let timedOut = false;
  let aborted = false;
  let inputError;

  const stop = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const abort = () => {
    aborted = true;
    stop(new Error(`${command} was aborted`));
  };
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      stop(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs)
    : undefined;
  abortSignal?.addEventListener('abort', abort, { once: true });

  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.on('error', (error) => {
    inputError = error;
    stop(error);
  });

  try {
    child.stdin.end(input);
    const { code, signal } = await managed.wait();
    const output = Buffer.concat(stdout).toString('utf8');
    const errorOutput = Buffer.concat(stderr).toString('utf8');
    if (inputError !== undefined) throw inputError;
    if (aborted) throw new Error(`${command} was aborted`);
    if (timedOut) throw new Error(`${command} timed out after ${timeoutMs}ms: ${errorOutput}`);
    if (code !== 0) {
      const diagnosticOutput = errorOutput.length > 0 ? errorOutput : output;
      throw new Error(
        `${command} exited with code ${code}${signal ? ` after signal ${signal}` : ''}: ${diagnosticOutput}`,
      );
    }
    return output;
  } catch (error) {
    if (inputError !== undefined) throw inputError;
    if (aborted) throw new Error(`${command} was aborted`);
    if (timedOut) {
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      throw new Error(`${command} timed out after ${timeoutMs}ms: ${errorOutput}`);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abortSignal?.removeEventListener('abort', abort);
  }
}

export async function runCliReview(config, prompt, { cwd, abortSignal }) {
  const session = createCliReviewSession(config, { cwd, abortSignal });
  return session.run(prompt);
}

function readCodexSessionId(output) {
  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        return event.thread_id;
      }
    } catch {
      // Codex JSONL may be accompanied by non-JSON diagnostics.
    }
  }
  throw new Error('Codex did not report a session ID');
}

export function createCliReviewSession(config, { cwd, abortSignal }) {
  const timeoutMs = resolveTimeoutMs(config);
  if (config.cli === 'claude') {
    const sessionId = randomUUID();
    let started = false;
    return {
      run: async (prompt) => {
        const args = [
          '-p',
          '--model', config.model,
          '--allowed-tools', 'Read,Glob,Grep',
          '--permission-mode', 'dontAsk',
          '--setting-sources=project',
          ...(started ? ['--resume', sessionId] : ['--session-id', sessionId]),
        ];
        const output = await runProcess(
          'claude',
          args,
          { cwd, input: prompt, timeoutMs, abortSignal },
        );
        started = true;
        return output;
      },
    };
  }

  if (config.cli === 'codex') {
    let sessionId;
    return {
      run: async (prompt) => {
        const tempDirectory = mkdtempSync(join(tmpdir(), 'takt-prompt-eval-'));
        const outputPath = join(tempDirectory, 'output');
        try {
          const firstRun = sessionId === undefined;
          const args = firstRun
            ? [
              'exec',
              '-m', config.model,
              '-s', 'read-only',
              '--skip-git-repo-check',
              '-c', `model_reasoning_effort=${config.reasoning_effort}`,
              '--json',
              '-o', outputPath,
              '-',
            ]
            : [
              'exec', 'resume', sessionId,
              '-m', config.model,
              '--skip-git-repo-check',
              '-c', `model_reasoning_effort=${config.reasoning_effort}`,
              '-o', outputPath,
              '-',
            ];
          const processOutput = await runProcess(
            'codex',
            args,
            { cwd, input: prompt, timeoutMs, abortSignal },
          );
          if (firstRun) sessionId = readCodexSessionId(processOutput);
          return readFileSync(outputPath, 'utf8');
        } finally {
          rmSync(tempDirectory, { recursive: true, force: true });
        }
      },
    };
  }

  throw new Error(`Unsupported CLI provider: ${config.cli}`);
}

export default class CliReviewProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() {
    return `cli-review:${this.config.cli}:${this.config.model}`;
  }

  async callApi(prompt, _context, options = {}) {
    let workingDirectory;

    try {
      workingDirectory = prepareWorkingDirectory(this.config);
      const { cwd } = workingDirectory;
      const isolatedPrompt = rewriteWorkingDirectoryPaths(prompt, workingDirectory);
      const output = await runCliReview(this.config, isolatedPrompt, {
        cwd,
        abortSignal: options.abortSignal,
      });
      return { output };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      workingDirectory?.cleanup();
    }
  }
}
