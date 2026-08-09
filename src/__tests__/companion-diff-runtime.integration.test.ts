import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalAgentWorkflowStep } from '../core/models/index.js';
import { CompanionStepRuntime } from '../core/workflow/companion/step-runtime.js';
import { GitCompanionDiffReader } from '../infra/task/companion-git-diff-reader.js';
import { CompanionReviewStateStore } from '../core/workflow/companion/review-state-store.js';
import type { CompanionDiff } from '../core/workflow/companion/diff-reader.js';

const roots: string[] = [];
const itWithGitMagicFileNames = process.platform === 'win32' ? it.skip : it;
const itWithUnixFileModes = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function readSnapshot(
  reader: GitCompanionDiffReader,
  root: string,
  baseline: string,
): Promise<CompanionDiff> {
  const result = await reader.readDiff(root, baseline);
  if (result.status === 'error') throw new Error(result.failure.message);
  return result.snapshot;
}

describe('CT-COMP-05 companion cumulative diff reader', () => {
  it('should fix HEAD as the baseline and report changed lines, files, content, and digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-diff-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'before\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });

    const reader = new GitCompanionDiffReader();
    const baseline = await reader.readBaselineSha(root);
    writeFileSync(join(root, 'tracked.txt'), 'after\nsecond\n', 'utf8');
    const diff = await readSnapshot(reader, root, baseline);

    expect(baseline).toMatch(/^[0-9a-f]{40}$/u);
    expect(diff.changedFiles).toEqual(['tracked.txt']);
    expect(diff.changedLines).toBe(3);
    expect(diff.content).toContain('+second');
    expect(diff.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(diff.hunkFingerprints)).toContainEqual(
      expect.stringMatching(/^tracked\.txt:\d+-\d+$/u),
    );

    writeFileSync(join(root, 'untracked.txt'), 'new file\n', 'utf8');
    const withUntracked = await readSnapshot(reader, root, baseline);
    expect(withUntracked.changedFiles).toEqual(['tracked.txt', 'untracked.txt']);
    expect(withUntracked.content).toContain('+++ b/untracked.txt');
    expect(withUntracked.content).toContain('+new file');
    expect(withUntracked.fileFingerprints['tracked.txt']).toBe(
      diff.fileFingerprints['tracked.txt'],
    );
  });

  it('should project added text with a real hunk and matching line and fingerprint metadata', async () => {
    const { root, baseline } = createRepositoryFixture('added-text');
    writeFileSync(join(root, 'added.txt'), 'first\nsecond\n', 'utf8');
    const reader = new GitCompanionDiffReader();

    const first = await readSnapshot(reader, root, baseline);
    writeFileSync(join(root, 'added.txt'), 'first\nchanged\n', 'utf8');
    const changed = await readSnapshot(reader, root, baseline);

    expect(first.content).toContain('@@ -0,0 +1,2 @@');
    expect(first.changedLines).toBe(2);
    expect(first.hunkFingerprints['added.txt:1-2']).toMatch(/^[0-9a-f]{64}$/u);
    expect(changed.fileFingerprints['added.txt']).not.toBe(first.fileFingerprints['added.txt']);
    expect(changed.hunkFingerprints['added.txt:1-2']).not.toBe(
      first.hunkFingerprints['added.txt:1-2'],
    );
  });

  it('should project an added binary as a Git binary patch without prefixing raw bytes', async () => {
    const { root, baseline } = createRepositoryFixture('added-binary');
    writeFileSync(join(root, 'added.bin'), Buffer.from([0, 1, 2, 3, 255]));

    const snapshot = await readSnapshot(new GitCompanionDiffReader(), root, baseline);

    expect(snapshot.changedFiles).toEqual(['added.bin']);
    expect(snapshot.content).toContain('GIT binary patch');
    expect(snapshot.content).toContain('literal 5');
    expect(snapshot.content).not.toContain('\0');
    expect(snapshot.changedLines).toBe(0);
    expect(snapshot.hunkFingerprints).toEqual({});
  });

  it('should omit a changed gitlink while preserving ordinary file changes', async () => {
    const { root, baseline } = createRepositoryFixture('gitlink');
    const modulePath = join(root, 'module');
    mkdirSync(modulePath);
    execFileSync('git', ['init'], { cwd: modulePath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: modulePath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: modulePath });
    writeFileSync(join(modulePath, 'module.txt'), 'module\n', 'utf8');
    execFileSync('git', ['add', 'module.txt'], { cwd: modulePath });
    execFileSync('git', ['commit', '-m', 'module'], { cwd: modulePath });
    writeFileSync(join(root, 'ordinary.txt'), 'ordinary\n', 'utf8');
    execFileSync('git', ['add', 'module', 'ordinary.txt'], { cwd: root });

    const snapshot = await readSnapshot(
      new GitCompanionDiffReader({ maxChangedFiles: 1 }),
      root,
      baseline,
    );

    expect(snapshot.changedFiles).toEqual(['ordinary.txt']);
    expect(snapshot.content).toContain('+ordinary');
    expect(snapshot.content).not.toContain('module');
  });

  itWithGitMagicFileNames('should preserve literal tracked and untracked Git path names in every snapshot projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-literal-paths-'));
    roots.push(root);
    const normalPath = 'normal.txt';
    const specialTrackedPath = ':(glob)tracked-*.txt';
    const specialUntrackedPath = ':(exclude)untracked.txt';
    const indexSelectorLikePath = '0:normal.txt';
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, normalPath), 'normal before\n', 'utf8');
    writeFileSync(join(root, specialTrackedPath), 'special before\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
    const reader = new GitCompanionDiffReader();
    const baseline = await reader.readBaselineSha(root);
    writeFileSync(join(root, normalPath), 'normal after\n', 'utf8');
    writeFileSync(join(root, specialTrackedPath), 'special tracked after\n', 'utf8');
    writeFileSync(join(root, specialUntrackedPath), 'special untracked content\n', 'utf8');
    writeFileSync(join(root, indexSelectorLikePath), 'index selector filename content\n', 'utf8');

    const first = await readSnapshot(reader, root, baseline);
    writeFileSync(join(root, specialTrackedPath), 'special tracked second\n', 'utf8');
    const second = await readSnapshot(reader, root, baseline);
    writeFileSync(join(root, indexSelectorLikePath), 'index selector filename second\n', 'utf8');
    const third = await readSnapshot(reader, root, baseline);

    expect(first.changedFiles).toHaveLength(4);
    expect(first.changedFiles).toEqual(expect.arrayContaining([
      normalPath,
      specialTrackedPath,
      specialUntrackedPath,
      indexSelectorLikePath,
    ]));
    expect(first.content).toContain('normal after');
    expect(first.content).toContain('special tracked after');
    expect(first.content).toContain('special untracked content');
    expect(first.content).toContain('index selector filename content');
    expect(first.fileFingerprints[specialTrackedPath]).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.fileFingerprints[specialUntrackedPath]).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.fileFingerprints[indexSelectorLikePath]).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.hunkFingerprints[`${indexSelectorLikePath}:1-1`]).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(first.hunkFingerprints)).toContainEqual(
      expect.stringMatching(/^:\(glob\)tracked-\*\.txt:\d+-\d+$/u),
    );
    expect(second.digest).not.toBe(first.digest);
    expect(second.fileFingerprints[specialTrackedPath]).not.toBe(
      first.fileFingerprints[specialTrackedPath],
    );
    expect(third.content).toContain('index selector filename second');
    expect(third.digest).not.toBe(second.digest);
    expect(third.fileFingerprints[indexSelectorLikePath]).not.toBe(
      second.fileFingerprints[indexSelectorLikePath],
    );
  });

  itWithUnixFileModes('should bind added file modes to snapshot digests and fingerprints', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-file-modes-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'baseline.txt'), 'baseline\n', 'utf8');
    execFileSync('git', ['add', 'baseline.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
    writeFileSync(join(root, 'regular.txt'), 'same content\n', { mode: 0o644 });
    writeFileSync(join(root, 'executable.txt'), 'same content\n', { mode: 0o755 });
    symlinkSync('regular.txt', join(root, 'link.txt'));
    const reader = new GitCompanionDiffReader();
    const baseline = await reader.readBaselineSha(root);

    const first = await readSnapshot(reader, root, baseline);
    const stable = await readSnapshot(reader, root, baseline);
    chmodSync(join(root, 'executable.txt'), 0o644);
    const modeChanged = await readSnapshot(reader, root, baseline);

    expect(first.content).toMatch(/new file mode 100644[\s\S]*?\+\+\+ b\/regular\.txt/u);
    expect(first.content).toMatch(/new file mode 100755[\s\S]*?\+\+\+ b\/executable\.txt/u);
    expect(first.content).toMatch(/new file mode 120000[\s\S]*?\+\+\+ b\/link\.txt/u);
    expect(stable.digest).toBe(first.digest);
    expect(stable.fileFingerprints).toEqual(first.fileFingerprints);
    expect(modeChanged.content).toMatch(/new file mode 100644[\s\S]*?\+\+\+ b\/executable\.txt/u);
    expect(modeChanged.digest).not.toBe(first.digest);
    expect(modeChanged.fileFingerprints['executable.txt']).not.toBe(
      first.fileFingerprints['executable.txt'],
    );
    expect(modeChanged.fileFingerprints['regular.txt']).toBe(first.fileFingerprints['regular.txt']);
    expect(modeChanged.fileFingerprints['link.txt']).toBe(first.fileFingerprints['link.txt']);
  });

  it('should initialize fixed companions once and compose the existing stream callback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
    const emitEvent = vi.fn();
    const existingStream = vi.fn();
    const step = {
      name: 'implement',
      instruction: 'Implement',
      companion: { fixed: ['security-reviewer'], pool: [] },
      rules: [],
    } as unknown as NormalAgentWorkflowStep;
    const stateStore = new CompanionReviewStateStore();
    const loadState = vi.spyOn(stateStore, 'get');
    const runtime = await CompanionStepRuntime.create({
      cwd: root,
      projectCwd: root,
      runSlug: 'run',
      runPathNamespace: [],
      language: 'en',
      task: 'task',
      step,
      definitions: {
        'security-reviewer': {
          name: 'security-reviewer',
          description: 'security',
          instruction: 'review',
          intervalMs: 60_000,
        },
      },
      providers: { 'security-reviewer': { provider: 'mock' } },
      diffReader: new GitCompanionDiffReader(),
      stateStore,
      emitEvent,
      recordUsage: vi.fn(),
    });
    const options = runtime.composeOptions({ cwd: root, onStream: existingStream });
    options.onStream?.({
      type: 'tool_use',
      data: { tool: 'Edit', input: { path: 'tracked.txt' }, id: 'tool-1' },
    });
    runtime.stop();

    expect(existingStream).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledWith('companion:start', {
      step: 'implement',
      companion: 'security-reviewer',
    });
    expect(loadState).toHaveBeenCalledWith(
      expect.stringContaining('security-reviewer.jsonl'),
      'security-reviewer',
    );
  });

  it('should return a bounded snapshot and stable full-content digest for an oversized untracked file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-large-diff-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(600_000), 'utf8');
    const reader = new GitCompanionDiffReader();
    const baseline = await reader.readBaselineSha(root);

    const first = await readSnapshot(reader, root, baseline);
    const second = await readSnapshot(reader, root, baseline);

    expect(Buffer.byteLength(first.content, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(first.truncated).toBe(true);
    expect(first.omittedBytes).toBeGreaterThan(0);
    expect(first.content).toContain('companion diff omitted');
    expect(first.changedFiles).toEqual(['large.txt']);
    expect(first.fileFingerprints['large.txt']).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.digest).toBe(first.digest);
  });

  it.each([200_000, 600_000])(
    'should return a bounded binary-safe snapshot for %i invalid UTF-8 bytes',
    async (size) => {
      const root = mkdtempSync(join(tmpdir(), 'takt-companion-binary-diff-'));
      roots.push(root);
      execFileSync('git', ['init'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      writeFileSync(join(root, 'tracked.txt'), 'baseline\n', 'utf8');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
      writeFileSync(join(root, 'binary.dat'), Buffer.alloc(size, 0xff));
      const reader = new GitCompanionDiffReader();
      const baseline = await reader.readBaselineSha(root);

      const diff = await readSnapshot(reader, root, baseline);

      expect(Buffer.byteLength(diff.content, 'utf8')).toBeLessThanOrEqual(512 * 1024);
      expect(diff.truncated).toBe(true);
      expect(diff.omittedBytes).toBeGreaterThan(0);
      expect(diff.content).toContain('companion diff omitted');
      expect(diff.changedFiles).toEqual(['binary.dat']);
      expect(diff.fileFingerprints['binary.dat']).toMatch(/^[0-9a-f]{64}$/u);
    },
  );

  it('should derive content and fingerprints from the same frozen index while the worktree changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-frozen-diff-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'first\n', 'utf8');
    writeFileSync(join(root, 'large.dat'), Buffer.alloc(2 * 1024 * 1024, 0x5a));
    const baselineReader = new GitCompanionDiffReader();
    const baseline = await baselineReader.readBaselineSha(root);
    const first = await readSnapshot(baselineReader, root, baseline);
    let releaseFrozenIndex: (() => void) | undefined;
    let reportFrozenIndex: (() => void) | undefined;
    const frozenIndexReached = new Promise<void>((resolve) => {
      reportFrozenIndex = resolve;
    });
    const frozenIndexRelease = new Promise<void>((resolve) => {
      releaseFrozenIndex = resolve;
    });
    const reader = new GitCompanionDiffReader({}, {
      afterFrozenIndex: async () => {
        reportFrozenIndex?.();
        await frozenIndexRelease;
      },
    });

    const changing = readSnapshot(reader, root, baseline);
    await frozenIndexReached;
    writeFileSync(join(root, 'tracked.txt'), 'second\n', 'utf8');
    releaseFrozenIndex?.();
    const captured = await changing;
    const second = await readSnapshot(baselineReader, root, baseline);

    expect(captured.content).toBe(first.content);
    expect(captured.digest).toBe(first.digest);
    expect(captured.fileFingerprints).toEqual(first.fileFingerprints);
    expect(captured.hunkFingerprints).toEqual(first.hunkFingerprints);
    expect(captured.content).not.toBe(second.content);
    expect(captured.fileFingerprints).not.toEqual(second.fileFingerprints);
    expect(captured.hunkFingerprints).not.toEqual(second.hunkFingerprints);
  });

  it('should disable repository filters while freezing the companion snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-safe-git-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
    const markerPath = join(root, 'filter-marker');
    const filterPath = join(root, 'filter.sh');
    writeFileSync(filterPath, `#!/bin/sh\ntouch "${markerPath}"\ncat\n`, { mode: 0o700 });
    execFileSync('git', ['config', 'filter.observer.clean', filterPath], { cwd: root });
    execFileSync('git', ['config', 'filter.observer.required', 'true'], { cwd: root });
    writeFileSync(join(root, '.gitattributes'), 'tracked.txt filter=observer\n', 'utf8');
    writeFileSync(join(root, 'tracked.txt'), 'after\n', 'utf8');
    const reader = new GitCompanionDiffReader();
    const baseline = await reader.readBaselineSha(root);

    const snapshot = await readSnapshot(reader, root, baseline);

    expect(snapshot.content).toContain('+after');
    expect(existsSync(markerPath)).toBe(false);
  });

  it('should disable effective global and duplicate local filters while freezing the snapshot', async () => {
    const { root, baseline } = createRepositoryFixture('global-filter');
    const globalConfig = join(root, 'isolated-global-config');
    const markerPath = join(root, 'global-filter-marker');
    const filterPath = join(root, 'global-filter.sh');
    writeFileSync(filterPath, `#!/bin/sh\ntouch "${markerPath}"\ncat\n`, { mode: 0o700 });
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
    for (const key of ['clean', 'smudge', 'process']) {
      execFileSync('git', ['config', '--global', `filter.observer.${key}`, filterPath], {
        cwd: root,
        env: gitEnvironment,
      });
    }
    execFileSync('git', ['config', '--global', 'filter.observer.required', 'true'], {
      cwd: root,
      env: gitEnvironment,
    });
    execFileSync('git', ['config', '--local', 'filter.observer.clean', filterPath], { cwd: root });
    writeFileSync(join(root, '.gitattributes'), 'tracked.txt filter=observer\n', 'utf8');
    writeFileSync(join(root, 'tracked.txt'), 'after\n', 'utf8');

    const snapshot = await readSnapshot(new GitCompanionDiffReader(), root, baseline);

    expect(snapshot.content).toContain('+after');
    expect(existsSync(markerPath)).toBe(false);
  });

  it('should ignore inherited GIT_CONFIG_PARAMETERS when enumerating and overriding filters', async () => {
    const { root, baseline } = createRepositoryFixture('inherited-filter-parameters');
    const markerPath = join(root, 'inherited-filter-marker');
    const filterPath = join(root, 'inherited-filter.sh');
    writeFileSync(filterPath, `#!/bin/sh\ntouch "${markerPath}"\ncat\n`, { mode: 0o700 });
    execFileSync('git', ['config', '--local', 'filter.observer.clean', 'cat'], { cwd: root });
    writeFileSync(join(root, '.gitattributes'), 'tracked.txt filter=observer\n', 'utf8');
    writeFileSync(join(root, 'tracked.txt'), 'after\n', 'utf8');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', `'filter.observer.clean=${filterPath}'`);

    const snapshot = await readSnapshot(new GitCompanionDiffReader(), root, baseline);

    expect(snapshot.content).toContain('+after');
    expect(existsSync(markerPath)).toBe(false);
  });

  it('should use cwd filter isolation when inherited GIT_CONFIG points to an alternate config', async () => {
    const { root, baseline } = createRepositoryFixture('inherited-alternate-config');
    const alternateConfig = join(root, 'alternate-git-config');
    const markerPath = join(root, 'alternate-config-filter-marker');
    const filterPath = join(root, 'alternate-config-filter.sh');
    writeFileSync(alternateConfig, '[core]\n\tbare = true\n', 'utf8');
    writeFileSync(filterPath, `#!/bin/sh\ntouch "${markerPath}"\ncat\n`, { mode: 0o700 });
    execFileSync('git', ['config', '--local', 'filter.observer.clean', filterPath], { cwd: root });
    execFileSync('git', ['config', '--local', 'filter.observer.required', 'true'], { cwd: root });
    writeFileSync(join(root, '.gitattributes'), 'tracked.txt filter=observer\n', 'utf8');
    writeFileSync(join(root, 'tracked.txt'), 'after\n', 'utf8');
    vi.stubEnv('GIT_CONFIG', alternateConfig);

    const snapshot = await readSnapshot(new GitCompanionDiffReader(), root, baseline);

    expect(snapshot.content).toContain('+after');
    expect(existsSync(markerPath)).toBe(false);
  });

  it('should preserve content at the byte limit and truncate only above it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-boundary-diff-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
    const path = 'boundary.txt';
    const reader = new GitCompanionDiffReader();
    const baseline = await reader.readBaselineSha(root);
    writeFileSync(join(root, path), 'x', 'utf8');
    const probe = await readSnapshot(reader, root, baseline);
    const overhead = Buffer.byteLength(probe.content) - 2;
    const exactFileBytes = 512 * 1024 - overhead - 1;

    writeFileSync(join(root, path), 'x'.repeat(exactFileBytes - 1), 'utf8');
    const below = await readSnapshot(reader, root, baseline);
    writeFileSync(join(root, path), 'x'.repeat(exactFileBytes), 'utf8');
    const exact = await readSnapshot(reader, root, baseline);
    writeFileSync(join(root, path), 'x'.repeat(exactFileBytes + 1), 'utf8');
    const above = await readSnapshot(reader, root, baseline);

    expect(below.truncated).toBe(false);
    expect(exact.truncated).toBe(false);
    expect(Buffer.byteLength(exact.content)).toBe(512 * 1024);
    expect(above.truncated).toBe(true);
    expect(Buffer.byteLength(above.content)).toBeLessThanOrEqual(512 * 1024);
  });

  it('should accept the changed-file limit and reject one file above it', async () => {
    const { root, baseline } = createRepositoryFixture('file-count');
    writeFileSync(join(root, 'one.txt'), 'one', 'utf8');
    const reader = new GitCompanionDiffReader({ maxChangedFiles: 1 });

    expect((await reader.readDiff(root, baseline)).status).toBe('ok');
    writeFileSync(join(root, 'two.txt'), 'two', 'utf8');
    const result = await reader.readDiff(root, baseline);

    expect(result).toMatchObject({ status: 'error', failure: { code: 'file_count_limit' } });
  });

  it('should reject by file count without an unbounded argv when many long paths exceed the limit', async () => {
    const { root, baseline } = createRepositoryFixture('many-long-paths');
    for (let index = 0; index < 1_025; index += 1) {
      const suffix = index.toString().padStart(4, '0');
      writeFileSync(join(root, `${'long-'.repeat(38)}${suffix}.txt`), suffix, 'utf8');
    }

    const result = await new GitCompanionDiffReader().readDiff(root, baseline);

    expect(result).toMatchObject({ status: 'error', failure: { code: 'file_count_limit' } });
  });

  itWithUnixFileModes('should accept a single gitlink path when its argv cost is exactly 16 KiB', async () => {
    const { root, baseline } = createRepositoryFixture('exact-gitlink-path-budget');
    const markerPath = join(root, 'gitlink-command-marker');
    installPathListGit(root, 'p'.repeat(16 * 1024 - 1), markerPath);

    const result = await new GitCompanionDiffReader().readDiff(root, baseline);

    expect(result.status).toBe('ok');
    expect(existsSync(markerPath)).toBe(true);
  });

  itWithUnixFileModes('should reject a single path when its argv cost exceeds 16 KiB by one byte', async () => {
    const { root, baseline } = createRepositoryFixture('oversized-gitlink-path-budget');
    const markerPath = join(root, 'gitlink-command-marker');
    installPathListGit(root, 'p'.repeat(16 * 1024), markerPath);

    const result = await new GitCompanionDiffReader().readDiff(root, baseline);

    expect(result).toMatchObject({
      status: 'error',
      failure: {
        code: 'input_limit',
        message: 'Companion Git path exceeds 16384 bytes',
      },
    });
    expect(existsSync(markerPath)).toBe(false);
  });

  it('should accept a blob at the byte limit and reject one byte above it', async () => {
    const { root, baseline } = createRepositoryFixture('blob-limit');
    const reader = new GitCompanionDiffReader({ maxBlobBytes: 8 });
    writeFileSync(join(root, 'bounded.txt'), '12345678', 'utf8');

    expect((await reader.readDiff(root, baseline)).status).toBe('ok');
    writeFileSync(join(root, 'bounded.txt'), '123456789', 'utf8');
    expect(await reader.readDiff(root, baseline)).toMatchObject({
      status: 'error',
      failure: { code: 'blob_limit' },
    });
  });

  it('should reject a changed baseline blob one byte above the configured blob limit', async () => {
    const { root, baseline } = createRepositoryFixture('baseline-blob-limit');
    writeFileSync(join(root, 'tracked.txt'), 'x', 'utf8');

    const result = await new GitCompanionDiffReader({ maxBlobBytes: 8 })
      .readDiff(root, baseline);

    expect(result).toMatchObject({ status: 'error', failure: { code: 'blob_limit' } });
  });

  it('should count baseline and working blobs toward the aggregate input limit', async () => {
    const { root, baseline } = createRepositoryFixture('baseline-total-input');
    writeFileSync(join(root, 'tracked.txt'), 'x', 'utf8');

    const result = await new GitCompanionDiffReader({ maxTotalInputBytes: 9 })
      .readDiff(root, baseline);

    expect(result).toMatchObject({ status: 'error', failure: { code: 'input_limit' } });
  });

  it('should accept the aggregate input limit and reject one byte above it', async () => {
    const { root, baseline } = createRepositoryFixture('total-input');
    writeFileSync(join(root, 'one.txt'), '1234', 'utf8');
    writeFileSync(join(root, 'two.txt'), '5678', 'utf8');
    const reader = new GitCompanionDiffReader({ maxTotalInputBytes: 8 });

    expect((await reader.readDiff(root, baseline)).status).toBe('ok');
    writeFileSync(join(root, 'two.txt'), '56789', 'utf8');
    const result = await reader.readDiff(root, baseline);

    expect(result).toMatchObject({ status: 'error', failure: { code: 'input_limit' } });
  });

  it('should reject a frozen index above the temporary-storage limit and clean it up', async () => {
    const { root, baseline } = createRepositoryFixture('temporary-storage');
    writeFileSync(join(root, 'value.txt'), 'changed', 'utf8');
    let ownedRoot: string | undefined;

    const result = await new GitCompanionDiffReader({ maxTemporaryBytes: 1 }, {
      afterFrozenIndex: async (root) => {
        ownedRoot = root;
        expect(existsSync(root)).toBe(true);
      },
    })
      .readDiff(root, baseline);

    expect(result).toMatchObject({
      status: 'error',
      failure: { code: 'temporary_storage_limit' },
    });
    if (ownedRoot === undefined) throw new Error('Frozen index root was not observed');
    expect(existsSync(ownedRoot)).toBe(false);
  });

  it('should isolate and clean the frozen roots owned by concurrent readers', async () => {
    const { root, baseline } = createRepositoryFixture('concurrent-roots');
    writeFileSync(join(root, 'value.txt'), 'changed', 'utf8');
    const ownedRoots: string[] = [];
    let reportBothReached: (() => void) | undefined;
    let releaseReaders: (() => void) | undefined;
    const bothReached = new Promise<void>((resolve) => {
      reportBothReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    const observeOwnedRoot = async (ownedRoot: string): Promise<void> => {
      ownedRoots.push(ownedRoot);
      if (ownedRoots.length === 2) reportBothReached?.();
      await release;
    };
    const first = new GitCompanionDiffReader({}, { afterFrozenIndex: observeOwnedRoot })
      .readDiff(root, baseline);
    const second = new GitCompanionDiffReader({}, { afterFrozenIndex: observeOwnedRoot })
      .readDiff(root, baseline);

    await bothReached;
    expect(new Set(ownedRoots).size).toBe(2);
    expect(ownedRoots.every((ownedRoot) => existsSync(ownedRoot))).toBe(true);
    releaseReaders?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'ok' }),
      expect.objectContaining({ status: 'ok' }),
    ]);
    expect(ownedRoots.every((ownedRoot) => !existsSync(ownedRoot))).toBe(true);
  });

  it('should reject Git stdout above its configured capacity', async () => {
    const { root, baseline } = createRepositoryFixture('stdout');
    writeFileSync(join(root, 'value.txt'), 'changed', 'utf8');

    const result = await new GitCompanionDiffReader({ maxStdoutBytes: 1 })
      .readDiff(root, baseline);

    expect(result).toMatchObject({ status: 'error', failure: { code: 'stdout_limit' } });
  });

  it('should reject Git stderr above its configured capacity', async () => {
    const { root } = createRepositoryFixture('stderr');

    const result = await new GitCompanionDiffReader({ maxStderrBytes: 0 })
      .readDiff(root, 'not-a-valid-baseline');

    expect(result).toMatchObject({ status: 'error', failure: { code: 'stderr_limit' } });
  });

  it('should reject work above its configured subprocess count', async () => {
    const { root, baseline } = createRepositoryFixture('process-count');

    const result = await new GitCompanionDiffReader({ maxSubprocesses: 1 })
      .readDiff(root, baseline);

    expect(result).toMatchObject({ status: 'error', failure: { code: 'process_limit' } });
  });

  it('should reject work when the total collection deadline is exhausted', async () => {
    const { root, baseline } = createRepositoryFixture('timeout');

    const result = await new GitCompanionDiffReader({ timeoutMs: 0 })
      .readDiff(root, baseline);

    expect(result).toMatchObject({ status: 'error', failure: { code: 'timeout' } });
  });

  it('should stop Git collection when the caller signal is aborted', async () => {
    const { root, baseline } = createRepositoryFixture('abort');
    const controller = new AbortController();
    controller.abort();

    const result = await new GitCompanionDiffReader().readDiff(root, baseline, controller.signal);

    expect(result).toMatchObject({ status: 'error', failure: { code: 'aborted' } });
  });
});

function createRepositoryFixture(name: string): { root: string; baseline: string } {
  const root = mkdtempSync(join(tmpdir(), `takt-companion-${name}-`));
  roots.push(root);
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'baseline\n', 'utf8');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
  return {
    root,
    baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  };
}

function installPathListGit(root: string, path: string, markerPath: string): void {
  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin);
  const gitPath = join(fakeBin, 'git');
  const objectId = '0'.repeat(40);
  writeFileSync(gitPath, `#!/bin/sh
if [ "$1" = "config" ]; then
  exit 1
fi
if [ "$1" = "diff" ] && [ "$2" = "--no-renames" ] && [ "$3" = "--name-only" ]; then
  printf '${path}\\0'
  exit 0
fi
if [ "$1" = "ls-tree" ] && [ "$2" = "-z" ]; then
  : > '${markerPath}'
  printf '160000 commit ${objectId}\\t${path}\\0'
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-path" ]; then
  printf '.git/objects\\n'
fi
`, { mode: 0o700 });
  const currentPath = process.env.PATH;
  if (currentPath === undefined) throw new Error('PATH is required for the Git boundary test');
  vi.stubEnv('PATH', `${fakeBin}${delimiter}${currentPath}`);
}
