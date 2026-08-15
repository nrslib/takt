import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SelectorInputReader,
} from '../core/workflow/dynamic-parallel/selector-input-reader.js';
import {
  type SelectorGitCommandRunner,
  type SelectorGitOutput,
} from '../core/workflow/dynamic-parallel/selector-git-command-runner.js';
import { GitSelectorCommandRunner } from '../infra/task/selector-git-command-runner.js';

const temporaryDirectories: string[] = [];
const itWithGitMagicFileNames = process.platform === 'win32' ? it.skip : it;
const itWithUnixFileModes = process.platform === 'win32' ? it.skip : it;

function createGitDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'takt-selector-input-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, '.git'));
  return directory;
}

function createRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'takt-selector-repository-'));
  temporaryDirectories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: directory });
  return directory;
}

class FakeGitCommandRunner implements SelectorGitCommandRunner {
  active = 0;
  maxActive = 0;
  diffCalls = 0;

  constructor(
    private readonly trackedPaths: readonly string[],
    private readonly pathListBytes: number,
    private readonly diffOutput: (path: string) => Buffer,
    private readonly untrackedPaths: readonly string[] = [],
  ) {}

  async run(
    _cwd: string,
    args: readonly string[],
    captureLimit: number,
    _signal: AbortSignal | undefined,
  ): Promise<SelectorGitOutput> {
    if (args[0] === 'diff' && args.includes('--name-only')) {
      const output = Buffer.from(`${this.trackedPaths.join('\0')}\0`);
      return {
        output: output.subarray(0, captureLimit),
        bytes: this.pathListBytes,
      };
    }
    if (args[0] === 'ls-files') {
      const output = Buffer.from(
        this.untrackedPaths.length === 0
          ? ''
          : `${this.untrackedPaths.join('\0')}\0`,
      );
      return { output: output.subarray(0, captureLimit), bytes: output.length };
    }
    const path = args.at(-1)!;
    this.diffCalls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const fullOutput = this.diffOutput(path);
    this.active -= 1;
    return {
      output: fullOutput.subarray(0, captureLimit),
      bytes: fullOutput.length,
    };
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SelectorInputReader', () => {
  it('should return an empty working-tree diff when cwd is outside a Git repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-no-repository-'));
    temporaryDirectories.push(cwd);

    const result = await new SelectorInputReader(new GitSelectorCommandRunner()).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toBe('(no working tree changes)');
  });

  it('should reject when a Git control entry is broken', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-selector-broken-repository-'));
    temporaryDirectories.push(cwd);
    writeFileSync(join(cwd, '.git'), 'gitdir: /definitely/missing/takt-git-dir\n');

    await expect(new SelectorInputReader(new GitSelectorCommandRunner()).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    )).rejects.toThrow();
  });

  it('should propagate a worktree probe failure when the probe rejects', async () => {
    const cwd = createGitDirectory();
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

  it('should read the current staged, unstaged, deleted, and untracked changes against HEAD', async () => {
    const cwd = createRepository();
    writeFileSync(join(cwd, 'staged.txt'), 'before staged\n');
    writeFileSync(join(cwd, 'unstaged.txt'), 'before unstaged\n');
    writeFileSync(join(cwd, 'deleted.txt'), 'to be deleted\n');
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd });

    writeFileSync(join(cwd, 'staged.txt'), 'after staged\n');
    execFileSync('git', ['add', 'staged.txt'], { cwd });
    writeFileSync(join(cwd, 'unstaged.txt'), 'after unstaged\n');
    rmSync(join(cwd, 'deleted.txt'));
    writeFileSync(join(cwd, 'untracked.txt'), 'new untracked\n');

    const result = await new SelectorInputReader(new GitSelectorCommandRunner()).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain('after staged');
    expect(result.workingTreeDiff).toContain('after unstaged');
    expect(result.workingTreeDiff).toContain('to be deleted');
    expect(result.workingTreeDiff).toContain('new untracked');
  });

  itWithGitMagicFileNames('should preserve normal and literal Git path names in selector payloads', async () => {
    const cwd = createRepository();
    const normalPath = 'normal.txt';
    const specialTrackedPath = ':(glob)tracked-*.txt';
    const specialUntrackedPath = ':(exclude)untracked.txt';
    writeFileSync(join(cwd, normalPath), 'normal before\n');
    writeFileSync(join(cwd, specialTrackedPath), 'special before\n');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd });
    writeFileSync(join(cwd, normalPath), 'normal after\n');
    writeFileSync(join(cwd, specialTrackedPath), 'special tracked after\n');
    writeFileSync(join(cwd, specialUntrackedPath), 'special untracked content\n');

    const result = await new SelectorInputReader(new GitSelectorCommandRunner()).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain(`## ${normalPath}`);
    expect(result.workingTreeDiff).toContain(`## ${specialTrackedPath}`);
    expect(result.workingTreeDiff).toContain(`## ${specialUntrackedPath}`);
    expect(result.workingTreeDiff).toContain('normal after');
    expect(result.workingTreeDiff).toContain('special tracked after');
    expect(result.workingTreeDiff).toContain('special untracked content');
  });

  it('should use the current HEAD as its evidence boundary on each read', async () => {
    const cwd = createRepository();
    writeFileSync(join(cwd, 'source.txt'), 'initial\n');
    execFileSync('git', ['add', 'source.txt'], { cwd });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd });
    writeFileSync(join(cwd, 'source.txt'), 'changed\n');
    const reader = new SelectorInputReader(new GitSelectorCommandRunner());

    const beforeCommit = await reader.readInputs(join(cwd, 'reports'), [], cwd, undefined);
    execFileSync('git', ['add', 'source.txt'], { cwd });
    execFileSync('git', ['commit', '--quiet', '-m', 'change'], { cwd });
    const afterCommit = await reader.readInputs(join(cwd, 'reports'), [], cwd, undefined);

    expect(beforeCommit.workingTreeDiff).toContain('changed');
    expect(afterCommit.workingTreeDiff).not.toContain('source.txt');
  });

  it('should reject a Git path outside the working directory before reading it', async () => {
    const cwd = createGitDirectory();
    const runner = new FakeGitCommandRunner(
      ['../outside.txt'],
      Buffer.byteLength('../outside.txt\0'),
      () => Buffer.from('must not be read'),
    );

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    )).rejects.toThrow();

    expect(runner.diffCalls).toBe(0);
  });

  it('should reject more than 1,024 changed paths before starting per-path Git commands', async () => {
    const cwd = createGitDirectory();
    const paths = Array.from({ length: 1_025 }, (_, index) => `src/${index}.ts`);
    const runner = new FakeGitCommandRunner(paths, Buffer.byteLength(`${paths.join('\0')}\0`), () => Buffer.alloc(0));

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    )).rejects.toThrow('changed path count exceeds 1024');

    expect(runner.diffCalls).toBe(0);
  });

  it('should reject a Git path list larger than 1 MiB', async () => {
    const cwd = createGitDirectory();
    const runner = new FakeGitCommandRunner(['src/a.ts'], 1024 * 1024 + 1, () => Buffer.alloc(0));

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    )).rejects.toThrow('Git path list exceeds 1048576 bytes');

    expect(runner.diffCalls).toBe(0);
  });

  it('should accept exactly 1 MiB of Git path-list output', async () => {
    const cwd = createGitDirectory();
    const pathList = Buffer.alloc(1024 * 1024);
    pathList.write('src/a.ts\0', pathList.length - Buffer.byteLength('src/a.ts\0'));
    const runner: SelectorGitCommandRunner = {
      run: async (_cwd, args, captureLimit) => {
        if (args.includes('--name-only')) {
          return { output: pathList.subarray(0, captureLimit), bytes: pathList.length };
        }
        if (args[0] === 'ls-files') {
          return { output: Buffer.alloc(0), bytes: 0 };
        }
        return { output: Buffer.from('diff'), bytes: 4 };
      },
    };

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain('src/a.ts');
  });

  it('should accept exactly 1,024 changed paths', async () => {
    const cwd = createGitDirectory();
    const paths = Array.from({ length: 1_024 }, (_, index) => `src/${index}.ts`);
    const runner = new FakeGitCommandRunner(
      paths,
      Buffer.byteLength(`${paths.join('\0')}\0`),
      () => Buffer.alloc(0),
    );

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain('src/1023.ts');
  });

  it('should accept a tracked path payload at exactly 64 KiB', async () => {
    const cwd = createGitDirectory();
    const payload = Buffer.alloc(64 * 1024, 'd');
    const runner = new FakeGitCommandRunner(
      ['src/a.ts'],
      Buffer.byteLength('src/a.ts\0'),
      () => payload,
    );

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain('d'.repeat(64 * 1024));
    expect(result.workingTreeDiff).toContain('Content status: complete');
  });

  it('should truncate a tracked path payload one byte above 64 KiB', async () => {
    const cwd = createGitDirectory();
    const runner = new FakeGitCommandRunner(
      ['src/a.ts'],
      Buffer.byteLength('src/a.ts\0'),
      () => Buffer.alloc(64 * 1024 + 1, 'd'),
    );

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain('Source bytes: 65537');
    expect(result.workingTreeDiff).toContain('Content status: truncated');
    expect(result.workingTreeDiff).toContain('d'.repeat(64 * 1024));
  });

  it('should preserve valid UTF-8 when a tracked payload ends mid-character', async () => {
    const cwd = createGitDirectory();
    const payload = Buffer.concat([
      Buffer.alloc(64 * 1024 - 1, 'a'),
      Buffer.from('界', 'utf-8'),
    ]);
    const runner = new FakeGitCommandRunner(
      ['src/a.ts'],
      Buffer.byteLength('src/a.ts\0'),
      () => payload,
    );

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain('Source bytes: 65538');
    expect(result.workingTreeDiff).toContain('Content status: truncated');
    expect(result.workingTreeDiff).toContain('a'.repeat(64 * 1024 - 1));
    expect(result.workingTreeDiff).not.toContain('\uFFFD');
  });

  it('should reject invalid UTF-8 inside an oversized tracked payload', async () => {
    const cwd = createGitDirectory();
    const payload = Buffer.concat([
      Buffer.from([0xc3, 0x28]),
      Buffer.alloc(64 * 1024, 'd'),
    ]);
    const runner = new FakeGitCommandRunner(
      ['src/a.ts'],
      Buffer.byteLength('src/a.ts\0'),
      () => payload,
    );

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    )).rejects.toThrow('is not valid UTF-8');
  });

  it('should truncate an oversized tracked diff from Git while preserving source bytes', async () => {
    const cwd = createRepository();
    const path = 'src/large.ts';
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, path), 'const value = "before";\n');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd });
    writeFileSync(join(cwd, path), `const value = "${'x'.repeat(80_000)}";\n`);
    const gitDiff = execFileSync(
      'git',
      ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--end-of-options', '--', path],
      { cwd },
    );

    const result = await new SelectorInputReader(new GitSelectorCommandRunner()).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(gitDiff.length).toBeGreaterThan(64 * 1024);
    expect(result.workingTreeDiff).toContain(`Source bytes: ${gitDiff.length}`);
    expect(result.workingTreeDiff).toContain('Content status: truncated');
    expect(result.workingTreeDiff).toContain(
      gitDiff.subarray(0, 64 * 1024).toString('utf-8'),
    );
    expect(result.workingTreeDiff).not.toContain('Dynamic selector path payload');
  });

  it('should truncate an oversized untracked regular file without rejecting the selector', async () => {
    const cwd = createGitDirectory();
    const path = 'src/untracked.ts';
    const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
    const content = 'u'.repeat(64 * 1024);
    const available = 64 * 1024 - Buffer.byteLength(header, 'utf-8');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, path), content);
    const runner = new FakeGitCommandRunner([], 0, () => Buffer.alloc(0), [path]);

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain(
      `Source bytes: ${Buffer.byteLength(header, 'utf-8') + Buffer.byteLength(content, 'utf-8')}`,
    );
    expect(result.workingTreeDiff).toContain('Content status: truncated');
    expect(result.workingTreeDiff).toContain('u'.repeat(available));
    expect(result.workingTreeDiff).not.toContain(content);
  });

  it('should distinguish complete and truncated untracked files at the entry boundary', async () => {
    const cwd = createGitDirectory();
    const path = 'src/untracked.ts';
    const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
    const available = 64 * 1024 - Buffer.byteLength(header, 'utf-8');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, path), 'u'.repeat(available));
    const runner = new FakeGitCommandRunner([], 0, () => Buffer.alloc(0), [path]);
    const reader = new SelectorInputReader(runner);

    const complete = await reader.readInputs(join(cwd, 'reports'), [], cwd, undefined);
    expect(complete.workingTreeDiff).toContain('Source bytes: 65536');
    expect(complete.workingTreeDiff).toContain('Content status: complete');

    writeFileSync(join(cwd, path), 'u'.repeat(available + 1));
    const truncated = await reader.readInputs(join(cwd, 'reports'), [], cwd, undefined);
    expect(truncated.workingTreeDiff).toContain('Source bytes: 65537');
    expect(truncated.workingTreeDiff).toContain('Content status: truncated');
  });

  it('should enforce the 64 KiB report limit using UTF-8 bytes', async () => {
    const cwd = createGitDirectory();
    const reportDirectory = join(cwd, 'reports');
    mkdirSync(reportDirectory);
    const exact = `${'界'.repeat(21_845)}x`;
    expect(Buffer.byteLength(exact, 'utf-8')).toBe(64 * 1024);
    writeFileSync(join(reportDirectory, 'review.md'), exact);
    const reader = new SelectorInputReader(new FakeGitCommandRunner([], 0, () => Buffer.alloc(0)));

    const result = await reader.readInputs(
      reportDirectory,
      ['review.md'],
      cwd,
      undefined,
    );
    expect(result.reports).toContain(exact);
    expect(result.reports).toContain('Source bytes: 65536');
    expect(result.reports).toContain('Content status: complete');

    writeFileSync(join(reportDirectory, 'review.md'), `${exact}x`);
    await expect(reader.readInputs(
      reportDirectory,
      ['review.md'],
      cwd,
      undefined,
    )).rejects.toThrow('Selector report "review.md" exceeds 65536 bytes');
  });

  it('should limit per-path Git commands to eight while preserving path order', async () => {
    const cwd = createGitDirectory();
    const paths = Array.from({ length: 20 }, (_, index) => `src/${index.toString().padStart(2, '0')}.ts`);
    const runner = new FakeGitCommandRunner(
      paths,
      Buffer.byteLength(`${paths.join('\0')}\0`),
      (path) => Buffer.from(`diff for ${path}`),
    );

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(runner.maxActive).toBe(8);
    expect(result.workingTreeDiff.indexOf('src/00.ts')).toBeLessThan(
      result.workingTreeDiff.indexOf('src/19.ts'),
    );
  });

  it('should stop starting Git commands after input collection is aborted', async () => {
    const cwd = createGitDirectory();
    const controller = new AbortController();
    const calls: Array<{ args: readonly string[]; signal: AbortSignal | undefined }> = [];
    const runner: SelectorGitCommandRunner = {
      run: async (_cwd, args, _captureLimit, signal) => {
        calls.push({ args, signal });
        controller.abort(new Error('selector input aborted'));
        return { output: Buffer.from('src/a.ts\0'), bytes: 9 };
      },
    };

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      controller.signal,
    )).rejects.toThrow('selector input aborted');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('--name-only');
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it('should enforce one 1 MiB budget across reports and the current diff', async () => {
    const cwd = createGitDirectory();
    const reportDirectory = join(cwd, 'reports');
    mkdirSync(reportDirectory);
    const requestedNames = Array.from({ length: 15 }, (_, index) => `report-${index}.md`);
    for (const name of requestedNames) {
      writeFileSync(join(reportDirectory, name), 'r'.repeat(64 * 1024));
    }
    const paths = ['src/a.ts', 'src/b.ts'];
    const runner = new FakeGitCommandRunner(
      paths,
      Buffer.byteLength(`${paths.join('\0')}\0`),
      () => Buffer.alloc(64 * 1024, 'd'),
    );

    await expect(new SelectorInputReader(runner).readInputs(
      reportDirectory,
      requestedNames,
      cwd,
      undefined,
    )).rejects.toThrow('Dynamic selector input exceeds 1048576 bytes');
  });

  it('should include the target agent prompt in the shared budget and mark existing entry-limit truncation', async () => {
    const cwd = createGitDirectory();
    const targetAgentPrompt = 'p'.repeat(64 * 1024 + 1);

    const result = await new SelectorInputReader(
      new FakeGitCommandRunner([], 0, () => Buffer.alloc(0)),
    ).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
      targetAgentPrompt,
    );

    expect(result.targetAgentPrompt).toContain(`Source bytes: ${64 * 1024 + 1}`);
    expect(result.targetAgentPrompt).toContain('Content status: truncated');
    expect(result.targetAgentPrompt).toContain('p'.repeat(64 * 1024));
    expect(
      Buffer.byteLength(result.targetAgentPrompt ?? '')
      + Buffer.byteLength(result.reports)
      + Buffer.byteLength(result.workingTreeDiff),
    ).toBeLessThanOrEqual(1024 * 1024);
  });

  it('should reject when inputs without the target prompt fit under 1 MiB but the prompt exceeds the shared budget', async () => {
    const cwd = createGitDirectory();
    const reportDirectory = join(cwd, 'reports');
    mkdirSync(reportDirectory);
    const requestedNames = Array.from({ length: 15 }, (_, index) => `report-${index}.md`);
    for (const name of requestedNames) {
      writeFileSync(join(reportDirectory, name), 'r'.repeat(64 * 1024));
    }
    const reader = new SelectorInputReader(
      new FakeGitCommandRunner([], 0, () => Buffer.alloc(0)),
    );

    const withoutPrompt = await reader.readInputs(
      reportDirectory,
      requestedNames,
      cwd,
      undefined,
    );
    expect(
      Buffer.byteLength(withoutPrompt.reports)
      + Buffer.byteLength(withoutPrompt.workingTreeDiff),
    ).toBeLessThan(1024 * 1024);

    await expect(reader.readInputs(
      reportDirectory,
      requestedNames,
      cwd,
      undefined,
      'p'.repeat(64 * 1024),
    )).rejects.toThrow('Dynamic selector input exceeds 1048576 bytes');
  });

  it('should accept an aggregate evidence payload at exactly 1 MiB', async () => {
    const cwd = createGitDirectory();
    const reportDirectory = join(cwd, 'reports');
    mkdirSync(reportDirectory);
    const requestedNames = Array.from({ length: 16 }, (_, index) => `report-${index}.md`);
    const emptyDiffBytes = Buffer.byteLength('(no working tree changes)');
    const separatorBytes = Buffer.byteLength('\n\n');
    const renderBytes = (name: string, contentBytes: number) =>
      Buffer.byteLength(
        `## ${name}\nSource bytes: ${contentBytes}\nContent status: complete\n\n`,
      ) + contentBytes;
    let consumed = emptyDiffBytes;
    for (const [index, name] of requestedNames.entries()) {
      const isLast = index === requestedNames.length - 1;
      const separator = index === 0 ? 0 : separatorBytes;
      const contentBytes = isLast
        ? (() => {
            for (let candidate = 0; candidate <= 64 * 1024; candidate += 1) {
              if (consumed + separator + renderBytes(name, candidate) === 1024 * 1024) {
                return candidate;
              }
            }
            throw new Error('Unable to construct exact selector input boundary');
          })()
        : 64 * 1024;
      writeFileSync(join(reportDirectory, name), 'x'.repeat(contentBytes));
      consumed += separator + renderBytes(name, contentBytes);
    }
    expect(consumed).toBe(1024 * 1024);

    const result = await new SelectorInputReader(
      new FakeGitCommandRunner([], 0, () => Buffer.alloc(0)),
    ).readInputs(reportDirectory, requestedNames, cwd, undefined);

    expect(Buffer.byteLength(result.reports) + Buffer.byteLength(result.workingTreeDiff))
      .toBe(1024 * 1024);
  });

  it('should represent an untracked symlink target without reading the external target', async () => {
    const cwd = createGitDirectory();
    const externalFile = join(tmpdir(), `takt-selector-external-${process.pid}.txt`);
    writeFileSync(externalFile, 'external secret');
    temporaryDirectories.push(externalFile);
    symlinkSync(externalFile, join(cwd, 'link.txt'));
    const runner = new FakeGitCommandRunner([], 0, () => Buffer.alloc(0), ['link.txt']);

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain(`Symbolic link target: ${externalFile}`);
    expect(result.workingTreeDiff).toContain('new file mode 120000');
    expect(result.workingTreeDiff).not.toContain('external secret');
  });

  itWithUnixFileModes('should represent regular and executable untracked file modes', async () => {
    const cwd = createGitDirectory();
    writeFileSync(join(cwd, 'regular.txt'), 'regular', { mode: 0o644 });
    writeFileSync(join(cwd, 'executable.txt'), 'executable', { mode: 0o755 });
    const runner = new FakeGitCommandRunner(
      [],
      0,
      () => Buffer.alloc(0),
      ['regular.txt', 'executable.txt'],
    );

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain(
      'new file mode 100644\n--- /dev/null\n+++ b/regular.txt',
    );
    expect(result.workingTreeDiff).toContain(
      'new file mode 100755\n--- /dev/null\n+++ b/executable.txt',
    );
  });

  itWithUnixFileModes('should use only the owner execute bit when determining untracked file modes', async () => {
    const cwd = createGitDirectory();
    const ownerExecutablePath = join(cwd, 'owner-executable.txt');
    const groupExecutablePath = join(cwd, 'group-executable.txt');
    writeFileSync(ownerExecutablePath, 'owner executable');
    writeFileSync(groupExecutablePath, 'group executable');
    chmodSync(ownerExecutablePath, 0o700);
    chmodSync(groupExecutablePath, 0o610);
    const runner = new FakeGitCommandRunner(
      [],
      0,
      () => Buffer.alloc(0),
      ['owner-executable.txt', 'group-executable.txt'],
    );

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain(
      'new file mode 100755\n--- /dev/null\n+++ b/owner-executable.txt',
    );
    expect(result.workingTreeDiff).toContain(
      'new file mode 100644\n--- /dev/null\n+++ b/group-executable.txt',
    );
  });

  it('should represent a dangling untracked symlink without dereferencing it', async () => {
    const cwd = createGitDirectory();
    const missingTarget = join(cwd, 'missing-target.txt');
    symlinkSync(missingTarget, join(cwd, 'dangling.txt'));
    const runner = new FakeGitCommandRunner([], 0, () => Buffer.alloc(0), ['dangling.txt']);

    const result = await new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    );

    expect(result.workingTreeDiff).toContain(`Symbolic link target: ${missingTarget}`);
  });

  it('should reject invalid UTF-8 in an untracked selector input', async () => {
    const cwd = createGitDirectory();
    writeFileSync(join(cwd, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
    const runner = new FakeGitCommandRunner([], 0, () => Buffer.alloc(0), ['invalid.txt']);

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    )).rejects.toThrow('is not valid UTF-8');
  });

  it('should reject an unreadable untracked selector input when permissions are enforced', async (context) => {
    const cwd = createGitDirectory();
    const inputPath = join(cwd, 'unreadable.txt');
    writeFileSync(inputPath, 'secret');
    chmodSync(inputPath, 0o000);
    const runner = new FakeGitCommandRunner([], 0, () => Buffer.alloc(0), ['unreadable.txt']);

    try {
      try {
        readFileSync(inputPath);
        context.skip();
        return;
      } catch {
        await expect(new SelectorInputReader(runner).readInputs(
          join(cwd, 'reports'),
          [],
          cwd,
          undefined,
        )).rejects.toThrow();
      }
    } finally {
      chmodSync(inputPath, 0o600);
    }
  });

  it('should reject an untracked non-regular file', async () => {
    const cwd = createGitDirectory();
    mkdirSync(join(cwd, 'directory'));
    const runner = new FakeGitCommandRunner([], 0, () => Buffer.alloc(0), ['directory']);

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    )).rejects.toThrow('Selector input is not a regular file: directory');
  });

  it('should abort in-flight commands and stop allocating paths after the first candidate failure', async () => {
    const cwd = createGitDirectory();
    const paths = Array.from({ length: 20 }, (_, index) => `src/${index.toString().padStart(2, '0')}.ts`);
    const diffCalls: string[] = [];
    const runner: SelectorGitCommandRunner = {
      run: async (_cwd, args, captureLimit, signal) => {
        if (args.includes('--name-only')) {
          const output = Buffer.from(`${paths.join('\0')}\0`);
          return { output: output.subarray(0, captureLimit), bytes: output.length };
        }
        if (args[0] === 'ls-files') {
          return { output: Buffer.alloc(0), bytes: 0 };
        }
        const path = args.at(-1)!;
        diffCalls.push(path);
        if (path === 'src/00.ts') {
          throw new Error('first candidate failed');
        }
        return new Promise<SelectorGitOutput>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };

    await expect(new SelectorInputReader(runner).readInputs(
      join(cwd, 'reports'),
      [],
      cwd,
      undefined,
    )).rejects.toThrow('first candidate failed');
    const callsAtFailure = diffCalls.length;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(callsAtFailure).toBeLessThanOrEqual(8);
    expect(diffCalls).toHaveLength(callsAtFailure);
    expect(diffCalls).not.toContain('src/08.ts');
  });

  it('should include only the explicitly requested workflow-call report instance', async () => {
    const cwd = createGitDirectory();
    const reportDirectory = join(cwd, 'reports');
    const firstNamespace = join(
      reportDirectory,
      'subworkflows',
      'iteration-3--step-delegate--workflow-child',
    );
    const currentNamespace = join(
      reportDirectory,
      'subworkflows',
      'iteration-9--step-delegate--workflow-child',
    );
    mkdirSync(firstNamespace, { recursive: true });
    mkdirSync(currentNamespace, { recursive: true });
    writeFileSync(join(firstNamespace, 'review.md'), 'stale report');
    writeFileSync(join(currentNamespace, 'review.md'), 'current report');
    const runner = new FakeGitCommandRunner([], 0, () => Buffer.alloc(0));

    const result = await new SelectorInputReader(runner).readInputs(
      reportDirectory,
      ['subworkflows/iteration-9--step-delegate--workflow-child/review.md'],
      cwd,
      undefined,
    );

    expect(result.reports).toContain('current report');
    expect(result.reports).not.toContain('stale report');
  });

  it('should choose one deterministic latest report for a legacy wildcard namespace', async () => {
    const cwd = createGitDirectory();
    const reportDirectory = join(cwd, 'reports');
    const firstNamespace = join(
      reportDirectory,
      'subworkflows',
      'iteration-3--step-delegate--workflow-child',
    );
    const latestNamespace = join(
      reportDirectory,
      'subworkflows',
      'iteration-9--step-delegate--workflow-child',
    );
    mkdirSync(firstNamespace, { recursive: true });
    mkdirSync(latestNamespace, { recursive: true });
    const firstReport = join(firstNamespace, 'review.md');
    const latestReport = join(latestNamespace, 'review.md');
    writeFileSync(firstReport, 'older report');
    writeFileSync(latestReport, 'latest report');
    utimesSync(firstReport, new Date(1_000), new Date(1_000));
    utimesSync(latestReport, new Date(2_000), new Date(2_000));

    const result = await new SelectorInputReader(
      new FakeGitCommandRunner([], 0, () => Buffer.alloc(0)),
    ).readInputs(
      reportDirectory,
      ['subworkflows/iteration-*--step-delegate--workflow-child/review.md'],
      cwd,
      undefined,
    );

    expect(result.reports).toContain('latest report');
    expect(result.reports).not.toContain('older report');
  });
});
