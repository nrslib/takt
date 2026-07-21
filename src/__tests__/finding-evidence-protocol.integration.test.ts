/**
 * review scope snapshot の Git/ファイルシステム境界を実リポジトリで検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const snapshotFsHook = vi.hoisted(() => ({
  beforeRead: undefined as ((fd: number) => void) | undefined,
  beforeOpen: undefined as ((path: string | Buffer | URL) => void) | undefined,
  beforeLstat: undefined as ((path: string | Buffer | URL) => import('node:fs').Stats | undefined) | undefined,
  replaceLstat: undefined as ((path: string | Buffer | URL, stat: import('node:fs').Stats) => import('node:fs').Stats | undefined) | undefined,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readSync(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null): number {
      snapshotFsHook.beforeRead?.(fd);
      return actual.readSync(fd, buffer, offset, length, position);
    },
    openSync(...args: Parameters<typeof actual.openSync>): number {
      snapshotFsHook.beforeOpen?.(args[0]);
      return actual.openSync(...args);
    },
    lstatSync(...args: Parameters<typeof actual.lstatSync>): import('node:fs').Stats {
      const intercepted = snapshotFsHook.beforeLstat?.(args[0]);
      if (intercepted !== undefined) {
        return intercepted;
      }
      const stat = actual.lstatSync(...args);
      return snapshotFsHook.replaceLstat?.(args[0], stat) ?? stat;
    },
  };
});

import { execFileSync } from 'node:child_process';
import { chmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  captureReviewScopeSnapshot,
  computeReviewScopeSnapshotId,
} from '../core/workflow/findings/snapshot.js';

describe('computeReviewScopeSnapshotId (snapshot.ts)', () => {
  let dir: string;
  let previousGitCeilingDirectories: string | undefined;

  beforeEach(() => {
    previousGitCeilingDirectories = process.env.GIT_CEILING_DIRECTORIES;
    dir = mkdtempSync(join(tmpdir(), 'takt-snapshot-id-'));
    process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
  });

  afterEach(() => {
    snapshotFsHook.beforeRead = undefined;
    snapshotFsHook.beforeOpen = undefined;
    snapshotFsHook.beforeLstat = undefined;
    snapshotFsHook.replaceLstat = undefined;
    if (previousGitCeilingDirectories === undefined) {
      delete process.env.GIT_CEILING_DIRECTORIES;
    } else {
      process.env.GIT_CEILING_DIRECTORIES = previousGitCeilingDirectories;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('non-git な cwd は git 収集エラーを黙殺せず fail-loud する', () => {
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      stdio: 'pipe',
    })).toThrow();
    expect(() => computeReviewScopeSnapshotId(dir)).toThrow(/ReviewScopeSnapshotError: git .* failed/);
  });

  it('壊れた git metadata は git 収集エラーを fail-loud する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    writeFileSync(join(dir, '.git'), 'gitdir: missing-git-dir\n');

    expect(() => computeReviewScopeSnapshotId(dir)).toThrow(/ReviewScopeSnapshotError: git .* failed/);
  });

  it('同じ working tree の状態に対しては決定的に同じ値を返す', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

    const first = computeReviewScopeSnapshotId(dir);
    const second = computeReviewScopeSnapshotId(dir);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it('tracked ファイルの内容が変わる（未コミットの dirty diff）と値が変わる', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

    const beforeEdit = computeReviewScopeSnapshotId(dir);
    writeFileSync(join(dir, 'a.txt'), 'hello, edited\n');
    const afterEdit = computeReviewScopeSnapshotId(dir);
    expect(afterEdit).not.toBe(beforeEdit);
  });

  it('tracked diff の上限では UTF-8 文字の途中を切断しない', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    const path = join(dir, 'multibyte.txt');
    writeFileSync(path, 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

    let selectedContent: string | undefined;
    for (let padding = 19_800; padding < 20_100; padding += 1) {
      const content = `${'x'.repeat(padding)}${'界'.repeat(200)}\n`;
      writeFileSync(path, content);
      const diff = execFileSync('git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], { cwd: dir });
      if (diff.subarray(0, 20_000).toString('utf8').includes('\uFFFD')) {
        selectedContent = content;
        break;
      }
    }
    expect(selectedContent).toBeDefined();
    writeFileSync(path, selectedContent!);

    const evidence = captureReviewScopeSnapshot(dir);

    expect(evidence.trackedDiff).toContain('truncated');
    expect(evidence.trackedDiff).not.toContain('\uFFFD');
  });

  it('新しいコミットを積む（HEAD が動く）と値が変わる', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const beforeSecondCommit = computeReviewScopeSnapshotId(dir);

    writeFileSync(join(dir, 'b.txt'), 'second file\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'second'], { cwd: dir });
    const afterSecondCommit = computeReviewScopeSnapshotId(dir);

    expect(afterSecondCommit).not.toBe(beforeSecondCommit);
  });

  it('untracked（未追跡）ファイルの内容変化を捉える（codex 検証ブロッカー#4: coder の新規ファイルは未追跡で HEAD/diff の外）', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

    // coder が新規作成した src ファイル（git に add されていない = untracked）。
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'new-file.ts'), 'export const quoted = 1;\nconst surrounding = 2;\n');
    const beforeChange = computeReviewScopeSnapshotId(dir);

    // 引用対象行（1行目）はそのままで、周辺行（2行目）だけを書き換える。旧実装
    // （HEAD + diff HEAD のみ）は untracked ファイルを見ないため snapshot は
    // 一致したまま = stale 判定を迂回できた。untracked 内容を畳み込む新実装では
    // 周辺行の改変でも snapshot 値が変わる。
    writeFileSync(join(dir, 'src', 'new-file.ts'), 'export const quoted = 1;\nconst surrounding = 999;\n');
    const afterSurroundingChange = computeReviewScopeSnapshotId(dir);
    expect(afterSurroundingChange).not.toBe(beforeChange);
  });

  it('untracked ファイルの新規追加でも値が変わる', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const beforeAdd = computeReviewScopeSnapshotId(dir);

    writeFileSync(join(dir, 'untracked-new.ts'), 'brand new content\n');
    const afterAdd = computeReviewScopeSnapshotId(dir);
    expect(afterAdd).not.toBe(beforeAdd);
  });

  it('未追跡の埋め込み repository 内の同サイズ内容変更を検出する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

    const embedded = join(dir, 'embedded');
    mkdirSync(embedded);
    execFileSync('git', ['init'], { cwd: embedded });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: embedded });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: embedded });
    const child = join(embedded, 'child.txt');
    writeFileSync(child, 'AAAA\n');
    execFileSync('git', ['add', '.'], { cwd: embedded });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: embedded });
    const before = computeReviewScopeSnapshotId(dir);

    writeFileSync(child, 'BBBB\n');

    expect(computeReviewScopeSnapshotId(dir)).not.toBe(before);
  }, 120_000);

  it('.gitignore 済みファイル（node_modules 等）は snapshot に含めない（--exclude-standard）', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const beforeIgnored = computeReviewScopeSnapshotId(dir);

    mkdirSync(join(dir, 'ignored'), { recursive: true });
    writeFileSync(join(dir, 'ignored', 'huge.bin'), 'x'.repeat(1000));
    const afterIgnored = computeReviewScopeSnapshotId(dir);
    // .gitignore 済みの変化は snapshot に影響しない。
    expect(afterIgnored).toBe(beforeIgnored);
  });

  it('65 MiB超の tracked ファイルを固定バッファで全量ハッシュし、同サイズのバイナリ改変を検出する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    const big = Buffer.alloc(65 * 1024 * 1024 + 1, 0x41);
    writeFileSync(join(dir, 'big-tracked.bin'), big);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const before = computeReviewScopeSnapshotId(dir);

    big[big.length - 3] = 0x42;
    writeFileSync(join(dir, 'big-tracked.bin'), big);
    const after = computeReviewScopeSnapshotId(dir);
    const evidence = captureReviewScopeSnapshot(dir);

    expect(after).not.toBe(before);
    expect(evidence.reviewScopeSnapshotId).toBe(after);
    expect(evidence.trackedDiff).toContain('capture limit');
    expect(evidence.trackedDiff).toContain('big-tracked.bin');
  });

  it('untracked symlink は追従せず、参照先のすり替え（repoint）を検出する（codex 検証2巡目#3b）', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

    writeFileSync(join(dir, 'target-a.txt'), 'AAAA\n');
    writeFileSync(join(dir, 'target-b.txt'), 'AAAA\n'); // target-a と同一内容
    symlinkSync('target-a.txt', join(dir, 'link.ts'));
    const beforeRepoint = computeReviewScopeSnapshotId(dir);

    // symlink を同一内容の別ファイルへ張り替える。追従して target 内容だけを
    // 読む実装だと（両 target が同一内容のため）検出できないが、readlink 値を
    // ハッシュする実装は向き先文字列の変化として検出する。
    unlinkSync(join(dir, 'link.ts'));
    symlinkSync('target-b.txt', join(dir, 'link.ts'));
    const afterRepoint = computeReviewScopeSnapshotId(dir);

    expect(afterRepoint).not.toBe(beforeRepoint);
  });

  it('broken symlink でも throw せず、参照先文字列の変化を検出する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

    symlinkSync('does-not-exist-a', join(dir, 'broken.ts'));
    const before = computeReviewScopeSnapshotId(dir); // throw しない
    expect(before.length).toBe(64);

    unlinkSync(join(dir, 'broken.ts'));
    symlinkSync('does-not-exist-b', join(dir, 'broken.ts'));
    const after = computeReviewScopeSnapshotId(dir);
    expect(after).not.toBe(before);
  });

  it('tracked ファイルの実行権限変更を検出する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    const path = join(dir, 'script.sh');
    writeFileSync(path, '#!/bin/sh\necho ok\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const before = computeReviewScopeSnapshotId(dir);

    chmodSync(path, 0o755);

    expect(computeReviewScopeSnapshotId(dir)).not.toBe(before);
  });

  it('tracked ファイルの削除を index path と mode を含む削除状態として検出する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    const path = join(dir, 'deleted.txt');
    writeFileSync(path, 'present\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const before = computeReviewScopeSnapshotId(dir);

    unlinkSync(path);

    expect(computeReviewScopeSnapshotId(dir)).not.toBe(before);
  });

  it('tracked symlink は追従せず、リンク先文字列の変更を検出する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'target-a.txt'), 'same\n');
    writeFileSync(join(dir, 'target-b.txt'), 'same\n');
    symlinkSync('target-a.txt', join(dir, 'link.ts'));
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const before = computeReviewScopeSnapshotId(dir);

    unlinkSync(join(dir, 'link.ts'));
    symlinkSync('target-b.txt', join(dir, 'link.ts'));

    expect(computeReviewScopeSnapshotId(dir)).not.toBe(before);
  });

  it('同一 tree の別 commit を HEAD inventory として検出する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'same-tree.txt'), 'content\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const before = computeReviewScopeSnapshotId(dir);

    const nextHead = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'same tree'], { cwd: dir })
      .toString('ascii')
      .trim();
    execFileSync('git', ['update-ref', 'HEAD', nextHead], { cwd: dir });

    expect(computeReviewScopeSnapshotId(dir)).not.toBe(before);
  }, 120000);

  it('gitlink の symlink working tree を拒否する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir }).toString('ascii').trim();
    symlinkSync('.', join(dir, 'submodule'), 'dir');
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},submodule`], { cwd: dir });

    expect(() => computeReviewScopeSnapshotId(dir)).toThrow(/ReviewScopeSnapshotError: submodule path failed/);
  }, 120000);

  it('gitlink の非 directory working tree を拒否する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir }).toString('ascii').trim();
    writeFileSync(join(dir, 'submodule'), 'not a directory\n');
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},submodule`], { cwd: dir });

    expect(() => computeReviewScopeSnapshotId(dir)).toThrow(/ReviewScopeSnapshotError: submodule path failed/);
  }, 120000);

  it('不正 UTF-8 の gitlink path を置換文字名の別 repository に解決せず拒否する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

    const rawGitlinkName = Buffer.concat([Buffer.from('gitlink-'), Buffer.from([0xff])]);
    const rawGitlinkPath = Buffer.concat([Buffer.from(dir), Buffer.from('/'), rawGitlinkName]);
    const replacementRepository = join(dir, rawGitlinkName.toString('utf8'));
    mkdirSync(replacementRepository);
    execFileSync('git', ['init'], { cwd: replacementRepository });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: replacementRepository });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: replacementRepository });
    writeFileSync(join(replacementRepository, 'child.txt'), 'child\n');
    execFileSync('git', ['add', '.'], { cwd: replacementRepository });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: replacementRepository });
    const replacementHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: replacementRepository }).toString('ascii').trim();
    const indexRecord = Buffer.concat([Buffer.from(`160000 ${replacementHead}\t`), rawGitlinkName, Buffer.from([0])]);
    execFileSync('git', ['update-index', '-z', '--index-info'], { cwd: dir, input: indexRecord });
    const replacementStat = lstatSync(replacementRepository);
    snapshotFsHook.beforeLstat = (path) => Buffer.isBuffer(path) && path.equals(rawGitlinkPath) ? replacementStat : undefined;

    expect(() => computeReviewScopeSnapshotId(dir)).toThrow(/ReviewScopeSnapshotError: submodule digest failed.*path encoding failed/);
  }, 120_000);

  it('gitlink が親と同じ dev/ino へ再帰すると fail-loud する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

    const submodule = join(dir, 'submodule');
    mkdirSync(submodule);
    execFileSync('git', ['init'], { cwd: submodule });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: submodule });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: submodule });
    writeFileSync(join(submodule, 'child.txt'), 'child\n');
    execFileSync('git', ['add', '.'], { cwd: submodule });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: submodule });
    const submoduleHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: submodule }).toString('ascii').trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${submoduleHead},submodule`], { cwd: dir });

    const parentStat = lstatSync(dir);
    snapshotFsHook.replaceLstat = (path) => Buffer.from(path).toString() === submodule ? parentStat : undefined;

    expect(() => computeReviewScopeSnapshotId(dir)).toThrow(/ReviewScopeSnapshotError: submodule digest failed.*capture recursion failed/);
  }, 120000);

  it('lstat 後に外部 target への symlink へ差し替えられても target 内容を読まず fail-loud する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    const victim = join(dir, 'victim.txt');
    const external = mkdtempSync(join(tmpdir(), 'takt-snapshot-external-target-'));
    writeFileSync(victim, 'original\n');
    const externalTarget = join(external, 'replacement.txt');
    writeFileSync(externalTarget, 'external replacement\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const externalStat = statSync(externalTarget);
    let readExternalTarget = false;
    snapshotFsHook.beforeRead = (fd) => {
      const opened = fstatSync(fd);
      readExternalTarget ||= opened.dev === externalStat.dev && opened.ino === externalStat.ino;
    };
    snapshotFsHook.beforeOpen = (openedPath) => {
      if (Buffer.from(openedPath).toString() !== victim) {
        return;
      }
      snapshotFsHook.beforeOpen = undefined;
      unlinkSync(victim);
      symlinkSync(externalTarget, victim);
    };

    try {
      expect(() => computeReviewScopeSnapshotId(dir)).toThrow(/ReviewScopeSnapshotError: open failed/);
      expect(readExternalTarget).toBe(false);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('lstat 後に別の regular file を rename で差し替えても fstat identity 照合で fail-loud する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'original\n');
    writeFileSync(join(dir, 'replacement.txt'), 'replacement\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    snapshotFsHook.beforeOpen = (openedPath) => {
      if (Buffer.from(openedPath).toString() !== victim) {
        return;
      }
      snapshotFsHook.beforeOpen = undefined;
      renameSync(join(dir, 'replacement.txt'), victim);
    };

    expect(() => computeReviewScopeSnapshotId(dir)).toThrow(/ReviewScopeSnapshotError: verify opened file failed/);
  }, 120000);

  it('submodule の gitlink と再帰 working tree digest を含める', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const submodule = join(dir, 'submodule');
    mkdirSync(submodule);
    execFileSync('git', ['init'], { cwd: submodule });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: submodule });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: submodule });
    writeFileSync(join(submodule, 'child.txt'), 'initial\n');
    execFileSync('git', ['add', '.'], { cwd: submodule });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: submodule });
    const submoduleHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: submodule }).toString('ascii').trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${submoduleHead},submodule`], { cwd: dir });
    const before = computeReviewScopeSnapshotId(dir);

    writeFileSync(join(submodule, 'child.txt'), 'changed without commit\n');

    expect(computeReviewScopeSnapshotId(dir)).not.toBe(before);
  }, 120_000);

  it('submodule が同一 tree の別 commit へ進むと、親の gitlink が同じでも値が変わる', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    const submodule = join(dir, 'submodule');
    mkdirSync(submodule);
    execFileSync('git', ['init'], { cwd: submodule });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: submodule });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: submodule });
    writeFileSync(join(submodule, 'child.txt'), 'initial\n');
    execFileSync('git', ['add', '.'], { cwd: submodule });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: submodule });
    const submoduleHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: submodule }).toString('ascii').trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${submoduleHead},submodule`], { cwd: dir });
    const before = computeReviewScopeSnapshotId(dir);

    execFileSync('git', ['commit', '--allow-empty', '-m', 'same tree, different commit'], { cwd: submodule });

    expect(computeReviewScopeSnapshotId(dir)).not.toBe(before);
  }, 120_000);

  it('収集中の変更を検出すると、次の安定した連続 capture で再試行に成功する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    const path = join(dir, 'tracked.txt');
    writeFileSync(path, 'before\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    let reads = 0;
    snapshotFsHook.beforeRead = () => {
      reads += 1;
      if (reads === 2) {
        writeFileSync(path, 'after\n');
      }
    };

    const snapshot = computeReviewScopeSnapshotId(dir);
    snapshotFsHook.beforeRead = undefined;

    expect(snapshot).toBe(computeReviewScopeSnapshotId(dir));
    expect(reads).toBe(8);
  });

  it('収集中の変更が3試行続くと ReviewScopeSnapshotError を送出する', () => {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    const path = join(dir, 'tracked.txt');
    writeFileSync(path, 'value-0\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
    let reads = 0;
    snapshotFsHook.beforeRead = () => {
      reads += 1;
      writeFileSync(path, `value-${reads}\n`);
    };

    expect(() => computeReviewScopeSnapshotId(dir)).toThrow(/ReviewScopeSnapshotError: capture failed/);
    expect(reads).toBeGreaterThanOrEqual(12);
  });
});
