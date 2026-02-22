// E2E更新時は docs/testing/e2e.md も更新すること

/**
 * E2E tests for `takt repertoire remove` and `takt repertoire list` subcommands.
 *
 * All tests are mock tests that manually create fake package directories
 * instead of downloading from GitHub, so no external network access is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

interface FakePackageOptions {
  taktDir: string;
  owner: string;
  repo: string;
  description?: string;
  ref?: string;
  commit?: string;
}

function createFakePackage(opts: FakePackageOptions): string {
  const { taktDir, owner, repo } = opts;
  const ref = opts.ref ?? 'v1.0.0';
  const commit = opts.commit ?? 'abc1234def5678';
  const packageDir = join(taktDir, 'repertoire', `@${owner}`, repo);

  mkdirSync(packageDir, { recursive: true });

  const manifest: Record<string, unknown> = { path: '.' };
  if (opts.description) manifest.description = opts.description;
  writeFileSync(join(packageDir, 'takt-repertoire.yaml'), stringifyYaml(manifest));

  const lock = {
    source: `github:${owner}/${repo}`,
    ref,
    commit,
    imported_at: new Date().toISOString(),
  };
  writeFileSync(join(packageDir, '.takt-repertoire-lock.yaml'), stringifyYaml(lock));

  return packageDir;
}

// ---------------------------------------------------------------------------
// E2E: takt ensemble remove (mock)
// ---------------------------------------------------------------------------

describe('E2E: takt ensemble remove (mock)', () => {
  let isolatedEnv: IsolatedEnv;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
  });

  afterEach(() => {
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  // E21: 正常削除 y — ディレクトリ削除、@owner/ も空なら削除
  it('should remove installed package and delete empty owner directory when user answers y', () => {
    const scope = '@testowner/single-fixture';
    createFakePackage({ taktDir: isolatedEnv.taktDir, owner: 'testowner', repo: 'single-fixture' });

    const result = runTakt({
      args: ['repertoire', 'remove', scope],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    const packageDir = join(isolatedEnv.taktDir, 'repertoire', '@testowner', 'single-fixture');
    const ownerDir = join(isolatedEnv.taktDir, 'repertoire', '@testowner');
    expect(existsSync(packageDir)).toBe(false);
    expect(existsSync(ownerDir)).toBe(false);
  }, 240_000);

  // E22: owner dir 残存（他パッケージがある場合）
  it('should keep owner directory when other packages remain under same scope', () => {
    createFakePackage({ taktDir: isolatedEnv.taktDir, owner: 'testowner', repo: 'fixture-a' });
    createFakePackage({ taktDir: isolatedEnv.taktDir, owner: 'testowner', repo: 'fixture-b' });

    const result = runTakt({
      args: ['repertoire', 'remove', '@testowner/fixture-a'],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    const removedDir = join(isolatedEnv.taktDir, 'repertoire', '@testowner', 'fixture-a');
    const ownerDir = join(isolatedEnv.taktDir, 'repertoire', '@testowner');
    const remainingDir = join(isolatedEnv.taktDir, 'repertoire', '@testowner', 'fixture-b');
    expect(existsSync(removedDir)).toBe(false);
    expect(existsSync(ownerDir)).toBe(true);
    expect(existsSync(remainingDir)).toBe(true);
  }, 240_000);

  // E23: 参照ありでの警告付き削除
  it('should display reference warning before deletion but still proceed when user answers y', () => {
    const scope = '@testowner/ref-fixture';
    createFakePackage({ taktDir: isolatedEnv.taktDir, owner: 'testowner', repo: 'ref-fixture' });

    const piecesDir = join(isolatedEnv.taktDir, 'pieces');
    mkdirSync(piecesDir, { recursive: true });
    writeFileSync(join(piecesDir, 'ref-piece.yaml'), `from: ${scope}\nname: example\n`);

    const result = runTakt({
      args: ['repertoire', 'remove', scope],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('⚠ 以下のファイルが');
    expect(result.stdout).toContain('を参照しています');
    const packageDir = join(isolatedEnv.taktDir, 'repertoire', '@testowner', 'ref-fixture');
    expect(existsSync(packageDir)).toBe(false);
  }, 240_000);

  // E24: 参照ファイル自体は変更されない
  it('should not modify reference files during package removal', () => {
    const scope = '@testowner/ref-fixture2';
    createFakePackage({ taktDir: isolatedEnv.taktDir, owner: 'testowner', repo: 'ref-fixture2' });

    const piecesDir = join(isolatedEnv.taktDir, 'pieces');
    mkdirSync(piecesDir, { recursive: true });
    const refFilePath = join(piecesDir, 'ref-piece2.yaml');
    const originalContent = `from: ${scope}\nname: example\n`;
    writeFileSync(refFilePath, originalContent);

    runTakt({
      args: ['repertoire', 'remove', scope],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 30_000,
    });

    const afterContent = readFileSync(refFilePath, 'utf-8');
    expect(afterContent).toBe(originalContent);
  }, 240_000);

  // E25: 削除キャンセル N
  it('should keep package directory when user answers N to removal prompt', () => {
    const scope = '@testowner/keep-fixture';
    createFakePackage({ taktDir: isolatedEnv.taktDir, owner: 'testowner', repo: 'keep-fixture' });

    const result = runTakt({
      args: ['repertoire', 'remove', scope],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'n\n',
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('キャンセルしました');
    const packageDir = join(isolatedEnv.taktDir, 'repertoire', '@testowner', 'keep-fixture');
    expect(existsSync(packageDir)).toBe(true);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// E2E: takt ensemble list (mock)
// ---------------------------------------------------------------------------

describe('E2E: takt ensemble list (mock)', () => {
  let isolatedEnv: IsolatedEnv;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
  });

  afterEach(() => {
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  // E26: インストール済みパッケージ一覧表示（name/description/ref/commit 7文字）
  it('should list installed package with name, description, ref, and abbreviated commit', () => {
    createFakePackage({
      taktDir: isolatedEnv.taktDir,
      owner: 'testowner',
      repo: 'list-fixture',
      description: 'My test package',
      ref: 'v2.0.0',
      commit: 'abcdef1234567',
    });

    const result = runTakt({
      args: ['repertoire', 'list'],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('📦 インストール済みパッケージ:');
    expect(result.stdout).toContain('@testowner/list-fixture');
    expect(result.stdout).toContain('My test package');
    expect(result.stdout).toContain('v2.0.0');
    expect(result.stdout).toContain('abcdef1');
  }, 240_000);

  // E27: 空状態での表示
  it('should display empty-state message when no packages are installed', () => {
    const result = runTakt({
      args: ['repertoire', 'list'],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('インストール済みパッケージはありません');
  }, 240_000);

  // E28: 複数パッケージの一覧
  it('should list all installed packages when multiple packages exist', () => {
    createFakePackage({
      taktDir: isolatedEnv.taktDir,
      owner: 'ownerA',
      repo: 'pkg-alpha',
      description: 'Alpha package',
    });
    createFakePackage({
      taktDir: isolatedEnv.taktDir,
      owner: 'ownerB',
      repo: 'pkg-beta',
      description: 'Beta package',
    });

    const result = runTakt({
      args: ['repertoire', 'list'],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('@ownerA/pkg-alpha');
    expect(result.stdout).toContain('@ownerB/pkg-beta');
  }, 240_000);
});
