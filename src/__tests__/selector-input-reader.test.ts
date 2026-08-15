import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelectorInputReader } from '../core/workflow/dynamic-parallel/selector-input-reader.js';
import type {
  SelectorGitCommandRunner,
  SelectorGitOutput,
} from '../core/workflow/dynamic-parallel/selector-git-command-runner.js';
import { GitSelectorCommandRunner } from '../infra/task/selector-git-command-runner.js';

const temporaryDirectories: string[] = [];

class FakeGitCommandRunner implements SelectorGitCommandRunner {
  readonly calls: (readonly string[])[] = [];
  readonly captureLimits: (number | undefined)[] = [];

  constructor(
    private readonly trackedPaths: readonly string[],
    private readonly untrackedPaths: readonly string[] = [],
  ) {}

  async run(
    _cwd: string,
    args: readonly string[],
    captureLimit: number | undefined,
    _signal: AbortSignal | undefined,
  ): Promise<SelectorGitOutput> {
    this.calls.push(args);
    this.captureLimits.push(captureLimit);
    const paths = args[0] === 'ls-files' ? this.untrackedPaths : this.trackedPaths;
    const output = Buffer.from(paths.length === 0 ? '' : `${paths.join('\0')}\0`);
    return {
      output: output.subarray(0, captureLimit),
      bytes: output.length,
    };
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SelectorInputReader', () => {
  it('should return references and no report contents outside a Git repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-no-repository-'));
    temporaryDirectories.push(cwd);

    const result = await new SelectorInputReader(new GitSelectorCommandRunner()).readInputs(
      join(cwd, 'reports'),
      ['review-resolution.md', 'review-resolution.md'],
      cwd,
      undefined,
    );

    expect(result).toEqual({
      reportDirectory: join(cwd, 'reports'),
      reportNames: ['review-resolution.md'],
      changedPaths: [],
    });
  });

  it('should propagate a worktree probe failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-broken-repository-'));
    temporaryDirectories.push(cwd);
    const runner: SelectorGitCommandRunner = {
      isInsideWorkTree: async () => {
        throw new Error('worktree probe failed');
      },
      run: async () => ({ output: Buffer.alloc(0), bytes: 0 }),
    };

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    )).rejects.toThrow('worktree probe failed');
  });

  it('should enumerate tracked and untracked names, exclude run-local paths, and avoid per-path reads', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-paths-'));
    temporaryDirectories.push(cwd);
    const runner = new FakeGitCommandRunner(
      ['z.ts', '.takt/runs/tracked-internal.txt', 'a.ts'],
      ['z.ts', '.takt/runs/untracked-internal.txt', 'b.ts'],
    );

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      ['review.md', 'review-resolution.md'],
      cwd,
      undefined,
    );

    expect(result.reportNames).toEqual(['review.md', 'review-resolution.md']);
    expect(result.changedPaths).toEqual(['a.ts', 'b.ts', 'z.ts']);
    expect(runner.calls).toHaveLength(2);
    expect(runner.captureLimits).toEqual([undefined, undefined]);
    expect(runner.calls[0]).toContain('--name-only');
    expect(runner.calls[1]?.[0]).toBe('ls-files');
  });

  it('should pass an unlimited capture request for a large Git path list', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-large-path-list-'));
    temporaryDirectories.push(cwd);
    const paths = Array.from({ length: 100_000 }, (_, index) => `src/${index}.ts`);
    const runner = new FakeGitCommandRunner(paths);

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.changedPaths).toHaveLength(paths.length);
    expect(runner.captureLimits).toEqual([undefined, undefined]);
  });

  it('should return requested report names without checking their existence or contents', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-report-references-'));
    temporaryDirectories.push(cwd);
    const reportDirectory = join(cwd, 'reports');
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(join(reportDirectory, 'review-resolution.md'), Buffer.from([0xc3, 0x28]));
    const runner = new FakeGitCommandRunner([]);

    const result = await new SelectorInputReader(runner).readInputs(
      reportDirectory,
      ['review-resolution.md', 'missing.md'],
      cwd,
      undefined,
    );

    expect(result.reportDirectory).toBe(reportDirectory);
    expect(result.reportNames).toEqual(['review-resolution.md', 'missing.md']);
  });

  it('should stop before Git when the signal is already aborted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-aborted-'));
    temporaryDirectories.push(cwd);
    const controller = new AbortController();
    controller.abort(new Error('input collection aborted'));
    const runner = new FakeGitCommandRunner([]);

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      controller.signal,
    )).rejects.toThrow('input collection aborted');
    expect(runner.calls).toHaveLength(0);
  });
});
