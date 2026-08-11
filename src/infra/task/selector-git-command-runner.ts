import type { SelectorGitCommandRunner, SelectorGitOutput } from '../../core/workflow/dynamic-parallel/selector-git-command-runner.js';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { formatProcessExitCause } from '../../shared/utils/process-exit.js';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { buildSafeGitEnvironment } from './git-environment.js';

const MAX_SELECTOR_GIT_ERROR_BYTES = 64 * 1024;

function hasGitControlEntry(cwd: string): boolean {
  let directory = resolve(cwd);
  while (true) {
    try {
      lstatSync(join(directory, '.git'));
      return true;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

class BoundedBufferCapture {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private totalBytes = 0;

  constructor(private readonly limit: number) {}

  append(raw: Buffer): void {
    this.totalBytes += raw.length;
    const remaining = Math.max(0, this.limit - this.capturedBytes);
    if (remaining === 0) return;
    const chunk = raw.subarray(0, remaining);
    this.chunks.push(chunk);
    this.capturedBytes += chunk.length;
  }

  snapshot(): { readonly output: Buffer; readonly bytes: number; readonly truncated: boolean } {
    return {
      output: Buffer.concat(this.chunks),
      bytes: this.totalBytes,
      truncated: this.totalBytes > this.capturedBytes,
    };
  }
}

function safeSelectorArgs(args: readonly string[]): readonly string[] {
  if (args[0] === 'ls-files') return args;
  if (args[0] !== 'diff') {
    throw new Error(`Unsupported selector Git command: ${args[0] ?? '(missing)'}`);
  }
  return [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    ...args.slice(1).filter((arg) => arg !== '--no-ext-diff' && arg !== '--no-textconv'),
  ];
}

export class GitSelectorCommandRunner implements SelectorGitCommandRunner {
  async isInsideWorkTree(cwd: string, signal: AbortSignal | undefined): Promise<boolean> {
    signal?.throwIfAborted();
    const managed = spawnManagedProcess('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      env: await buildSafeGitEnvironment(cwd, {
        allowGitHooks: false,
        allowGitFilters: false,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }, signal);
    const { child } = managed;
    if (child.stdout === null || child.stderr === null) {
      await managed.terminate();
      throw new Error('Unable to determine selector Git worktree');
    }
    const stdout = new BoundedBufferCapture(16);
    const stderr = new BoundedBufferCapture(MAX_SELECTOR_GIT_ERROR_BYTES);
    child.stdout.on('data', (raw: Buffer) => stdout.append(raw));
    child.stderr.on('data', (raw: Buffer) => stderr.append(raw));
    const result = await managed.wait();
    signal?.throwIfAborted();
    const output = stdout.snapshot().output.toString('utf-8').trim();
    if (result.code === 0 && result.signal === null) {
      if (output === 'true') return true;
      if (output === 'false') return false;
    } else if (result.code !== 0 && result.signal === null && !hasGitControlEntry(cwd)) {
      return false;
    }

    const errorOutput = stderr.snapshot();
    const detail = errorOutput.output.toString('utf-8').trim();
    const truncation = errorOutput.truncated
      ? ` [stderr truncated after ${MAX_SELECTOR_GIT_ERROR_BYTES} bytes]`
      : '';
    throw new Error(
      `Unable to determine selector Git worktree (git exited with ${formatProcessExitCause(result.code, result.signal)})`
      + (detail.length === 0 ? truncation : `: ${detail}${truncation}`),
    );
  }

  async run(
    cwd: string,
    args: readonly string[],
    captureLimit: number,
    signal: AbortSignal | undefined,
  ): Promise<SelectorGitOutput> {
    signal?.throwIfAborted();
    const managed = spawnManagedProcess('git', safeSelectorArgs(args), {
      cwd,
      env: await buildSafeGitEnvironment(cwd, {
        allowGitHooks: false,
        allowGitFilters: false,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }, signal);
    const { child } = managed;
    if (child.stdout === null || child.stderr === null) {
      await managed.terminate();
      throw new Error('Unable to read selector Git input');
    }
    const stdout = new BoundedBufferCapture(captureLimit);
    const stderr = new BoundedBufferCapture(MAX_SELECTOR_GIT_ERROR_BYTES);
    child.stdout.on('data', (raw: Buffer) => stdout.append(raw));
    child.stderr.on('data', (raw: Buffer) => stderr.append(raw));
    const result = await managed.wait();
    const output = stdout.snapshot();
    if (result.code !== 0 || result.signal !== null) {
      const errorOutput = stderr.snapshot();
      const detail = errorOutput.output.toString('utf-8').trim();
      const truncation = errorOutput.truncated
        ? ` [stderr truncated after ${MAX_SELECTOR_GIT_ERROR_BYTES} bytes]`
        : '';
      throw new Error(
        `Unable to read selector Git input (git exited with ${formatProcessExitCause(result.code, result.signal)})`
        + (detail.length === 0 ? truncation : `: ${detail}${truncation}`),
      );
    }
    return { output: output.output, bytes: output.bytes };
  }
}
