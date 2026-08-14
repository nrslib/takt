import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runProcess(command, args, { cwd, input, timeoutMs, abortSignal }) {
  if (abortSignal?.aborted) {
    return Promise.reject(new Error(`${command} was aborted before it started`));
  }

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKillTimer;
    let inputError;

    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    const abort = () => {
      aborted = true;
      stop();
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener('abort', abort);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    abortSignal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if (settled) return;
      inputError = error;
      stop();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (inputError !== undefined) {
        rejectRun(inputError);
        return;
      }
      if (aborted) {
        rejectRun(new Error(`${command} was aborted`));
        return;
      }
      if (code !== 0) {
        const reason = timedOut
          ? `timed out after ${timeoutMs}ms`
          : `exited with code ${code}${signal ? ` after signal ${signal}` : ''}`;
        rejectRun(new Error(`${command} ${reason}: ${errorOutput}`));
        return;
      }
      resolveRun(output);
    });

    child.stdin.end(input);
  });
}

export default class CliReviewProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() {
    return `cli-review:${this.config.cli}:${this.config.model}`;
  }

  async callApi(prompt, _context, options = {}) {
    const cwd = resolve(evalDirectory, this.config.working_dir);
    const timeoutMs = this.config.timeout_ms ?? 900_000;

    try {
      if (this.config.cli === 'claude') {
        const output = await runProcess('claude', [
          '-p',
          '--model', this.config.model,
          '--allowed-tools', 'Read,Glob,Grep',
          '--permission-mode', 'dontAsk',
          '--setting-sources=project',
          '--no-session-persistence',
        ], { cwd, input: prompt, timeoutMs, abortSignal: options.abortSignal });
        return { output };
      }

      if (this.config.cli === 'codex') {
        const tempDirectory = mkdtempSync(join(tmpdir(), 'takt-prompt-eval-'));
        const outputPath = join(tempDirectory, 'output');
        try {
          await runProcess('codex', [
            'exec',
            '-m', this.config.model,
            '-s', 'read-only',
            '--skip-git-repo-check',
            '-c', `model_reasoning_effort=${this.config.reasoning_effort}`,
            '-o', outputPath,
            '-',
          ], { cwd, input: prompt, timeoutMs, abortSignal: options.abortSignal });
          return { output: readFileSync(outputPath, 'utf8') };
        } finally {
          rmSync(tempDirectory, { recursive: true, force: true });
        }
      }

      return { error: `Unsupported CLI provider: ${this.config.cli}` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
