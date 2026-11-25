import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureSyncConflictFiles } from '../infra/service/syncConflictFiles.js';

const INDEX_CHANGED = 'AI changed the Git index before runtime validation';
const IGNORE_VALUES = ['all', 'dirty', 'untracked', 'none'] as const;
type Ignore = (typeof IGNORE_VALUES)[number];

describe('sync conflict index fingerprint and submodule ignore settings', () => {
  let root: string, cwd: string, subOld: string, subNew: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-index-fingerprint-')));
    cwd = join(root, 'clone');
    for (const name of ['global', 'system']) writeFileSync(join(root, name), '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'global'));
    vi.stubEnv('GIT_CONFIG_SYSTEM', join(root, 'system'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  const run = (dir: string, args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  const git = (args: string[]) => run(cwd, args);
  const sub = () => join(cwd, 'sub');
  const identity = (dir: string) => {
    run(dir, ['config', 'user.name', 'Fingerprint Test']);
    run(dir, ['config', 'user.email', 'test@example.test']);
  };

  // Merge that stages a submodule update (gitlink) and leaves code.txt conflicted.
  // The submodule worktree already sits at the new commit, so only the index differs from HEAD.
  function prepareMergeWithStagedSubmoduleUpdate(committedIgnore?: Ignore): void {
    const source = join(root, 'subsrc');
    mkdirSync(source); run(source, ['init', '-b', 'main']); identity(source);
    writeFileSync(join(source, 'lib.txt'), 'one\n');
    run(source, ['add', 'lib.txt']); run(source, ['commit', '-m', 'sub one']);
    subOld = run(source, ['rev-parse', 'HEAD']);

    mkdirSync(cwd); git(['init', '-b', 'main']); identity(cwd);
    writeFileSync(join(cwd, 'code.txt'), 'base\n');
    git(['add', 'code.txt']); git(['commit', '-m', 'root']);
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'sub']);
    if (committedIgnore) git(['config', '-f', '.gitmodules', 'submodule.sub.ignore', committedIgnore]);
    git(['add', '-A']); git(['commit', '-m', 'add submodule']);

    git(['checkout', '-b', 'feature/pr']);
    writeFileSync(join(cwd, 'code.txt'), 'HEAD\n'); git(['commit', '-am', 'head']);
    git(['checkout', 'main']);
    writeFileSync(join(cwd, 'code.txt'), 'BASE\n');
    identity(sub());
    writeFileSync(join(sub(), 'lib.txt'), 'two\n');
    run(sub(), ['commit', '-am', 'sub two']);
    subNew = run(sub(), ['rev-parse', 'HEAD']);
    // `commit -a` skips the gitlink while .gitmodules says ignore = all, so stage it explicitly.
    git(['add', 'code.txt']); git(['update-index', '--cacheinfo', `160000,${subNew},sub`]);
    git(['commit', '-m', 'base and submodule update']);
    git(['checkout', 'feature/pr']);
    expect(() => git(['merge', 'main'])).toThrow();
    expect(git(['ls-files', '-u'])).not.toBe('');
    expect(git(['ls-files', '-s', 'sub'])).toContain(subNew);
    expect(git(['diff', '--cached', '--ignore-submodules=none', '--name-only', 'HEAD'])).toContain('sub');
  }

  const setGitmodulesIgnore = (value: Ignore | undefined) => {
    if (value === undefined) {
      // Exit status 5 means the key was not set, which is already the state we want.
      try { git(['config', '-f', '.gitmodules', '--unset', 'submodule.sub.ignore']); } catch { /* not set */ }
    }
    else git(['config', '-f', '.gitmodules', 'submodule.sub.ignore', value]);
  };

  it.each(IGNORE_VALUES)('.gitmodules に ignore = %s を足してもサブモジュール更新入りの index を変更とみなさない', (value) => {
    prepareMergeWithStagedSubmoduleUpdate();
    const conflictFiles = captureSyncConflictFiles(cwd);
    setGitmodulesIgnore(value);
    writeFileSync(join(cwd, 'code.txt'), 'resolved\n');
    conflictFiles.validateAndStage();
    expect(git(['ls-files', '-u'])).toBe('');
    expect(git(['ls-files', '-s', 'sub'])).toContain(subNew);
  });

  it('.gitmodules の ignore = all を外してもサブモジュール更新入りの index を変更とみなさない', () => {
    prepareMergeWithStagedSubmoduleUpdate('all');
    const conflictFiles = captureSyncConflictFiles(cwd);
    setGitmodulesIgnore(undefined);
    writeFileSync(join(cwd, 'code.txt'), 'resolved\n');
    conflictFiles.validateAndStage();
    expect(git(['ls-files', '-u'])).toBe('');
  });

  it('ステージ済みのサブモジュール更新を AI が戻したら ignore = all でも index の変更として拒否する', () => {
    prepareMergeWithStagedSubmoduleUpdate();
    const conflictFiles = captureSyncConflictFiles(cwd);
    setGitmodulesIgnore('all');
    git(['update-index', '--cacheinfo', `160000,${subOld},sub`]);
    writeFileSync(join(cwd, 'code.txt'), 'resolved\n');
    expect(() => conflictFiles.validateAndStage()).toThrow(INDEX_CHANGED);
  });

  // Each case pairs settings that hide a staged gitlink (`ignore = all`) with the ways they can be reached.
  const settingEdits: Record<string, () => void> = {
    '.git/config の submodule.sub.ignore = all': () => git(['config', 'submodule.sub.ignore', 'all']),
    'diff.ignoreSubmodules = all': () => git(['config', 'diff.ignoreSubmodules', 'all']),
    'diff.ignoreSubmodules = dirty': () => git(['config', 'diff.ignoreSubmodules', 'dirty']),
    'サブモジュールの worktree が汚れている + ignore = all': () => {
      writeFileSync(join(sub(), 'scratch.txt'), 'untracked\n');
      setGitmodulesIgnore('all');
    },
    '.gitmodules と .git/config と diff.ignoreSubmodules を重ねて all': () => {
      setGitmodulesIgnore('all');
      git(['config', 'submodule.sub.ignore', 'all']);
      git(['config', 'diff.ignoreSubmodules', 'all']);
    },
  };

  it.each(Object.entries(settingEdits))('index を変えない操作（%s）では指紋が変わらない', (_name, edit) => {
    prepareMergeWithStagedSubmoduleUpdate();
    const conflictFiles = captureSyncConflictFiles(cwd);
    edit();
    writeFileSync(join(cwd, 'code.txt'), 'resolved\n');
    conflictFiles.validateAndStage();
    expect(git(['ls-files', '-u'])).toBe('');
    expect(git(['ls-files', '-s', 'sub'])).toContain(subNew);
  });

  it('既に ignore = all のリポジトリでも、設定を重ねて変えただけでは指紋が変わらない', () => {
    prepareMergeWithStagedSubmoduleUpdate('all');
    const conflictFiles = captureSyncConflictFiles(cwd);
    git(['config', 'diff.ignoreSubmodules', 'none']);
    git(['config', 'submodule.sub.ignore', 'none']);
    setGitmodulesIgnore(undefined);
    writeFileSync(join(cwd, 'code.txt'), 'resolved\n');
    conflictFiles.validateAndStage();
    expect(git(['ls-files', '-u'])).toBe('');
  });

  const indexChanges: Record<string, () => void> = {
    'gitlink を戻す': () => git(['update-index', '--cacheinfo', `160000,${subOld},sub`]),
    'エントリを足す': () => {
      writeFileSync(join(cwd, 'extra.txt'), 'extra\n');
      git(['add', 'extra.txt']);
    },
    'エントリを外す': () => git(['rm', '--cached', '-q', '--', '.gitmodules']),
  };

  it.each(Object.entries(indexChanges))('index を変える操作（%s）は ignore = all でも拒否する', (_name, change) => {
    prepareMergeWithStagedSubmoduleUpdate();
    const conflictFiles = captureSyncConflictFiles(cwd);
    setGitmodulesIgnore('all');
    git(['config', 'submodule.sub.ignore', 'all']);
    git(['config', 'diff.ignoreSubmodules', 'all']);
    change();
    writeFileSync(join(cwd, 'code.txt'), 'resolved\n');
    expect(() => conflictFiles.validateAndStage()).toThrow(INDEX_CHANGED);
  });
});
