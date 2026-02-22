// E2E更新時は docs/testing/e2e.md も更新すること

/**
 * E2E tests for `takt repertoire add` subcommand — scenarios requiring real GitHub access.
 *
 * All tests are guarded with `it.skipIf` to be safely included in the mock test run.
 * Tests only execute when the fixture GitHub repositories are reachable AND have the
 * expected `takt-repertoire.yaml` manifest format (required since the rename from
 * takt-ensemble.yaml → takt-repertoire.yaml).
 *
 * GitHub fixture repos used:
 *   - github:nrslib/takt-ensemble-fixture  (standard: facets/ + pieces/)
 *
 * NOTE: These tests require fixture repos to be updated with takt-repertoire.yaml.
 * Until the fixture repos are updated, all it.skipIf tests will be skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';

type LockFile = {
  source?: string;
  ref?: string;
  commit?: string;
  imported_at?: string;
};

function canAccessRepo(repo: string): boolean {
  try {
    execFileSync('gh', ['repo', 'view', repo], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function canAccessRepoRef(repo: string, ref: string): boolean {
  try {
    const out = execFileSync('gh', ['api', `/repos/${repo}/git/ref/tags/${ref}`], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return out.includes('"ref"');
  } catch {
    return false;
  }
}

/**
 * Check that the fixture repo has takt-repertoire.yaml at the given ref.
 * Fixture repos predating the takt-ensemble → takt-repertoire rename use
 * takt-ensemble.yaml instead, which the current add command does not recognize.
 */
function fixtureHasRepertoireManifest(repo: string, ref: string): boolean {
  try {
    const out = execFileSync(
      'gh',
      ['api', `/repos/${repo}/contents/takt-repertoire.yaml`, '--field', `ref=${ref}`],
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    return out.includes('"name"');
  } catch {
    return false;
  }
}

function readYamlFile<T>(path: string): T {
  const raw = readFileSync(path, 'utf-8');
  return parseYaml(raw) as T;
}

const FIXTURE_REPO = 'nrslib/takt-ensemble-fixture';
const FIXTURE_REF = 'v1.0.0';

// Guard requires both GitHub access and compatible takt-repertoire.yaml manifest
const canUseFixtureRepo =
  canAccessRepo(FIXTURE_REPO) &&
  canAccessRepoRef(FIXTURE_REPO, FIXTURE_REF) &&
  fixtureHasRepertoireManifest(FIXTURE_REPO, FIXTURE_REF);

describe('E2E: takt ensemble add (real GitHub — basic scenarios)', () => {
  // E1: 標準インストール + lock ファイル検証
  it.todo('should install fixture package from GitHub and create lock file with source ref commit and imported_at');

  // E2: インストール後 list 確認
  it.todo('should list installed package after add');

  // E3: subdir インストール
  // requires nrslib/takt-ensemble-fixture-subdir with takt-repertoire.yaml
  it.todo('should install fixture package from GitHub subdirectory');

  // E4: facets-only インストール
  // requires nrslib/takt-ensemble-fixture-facets-only with takt-repertoire.yaml
  it.todo('should install facets-only fixture package without requiring pieces directory');

  // E7: N でキャンセル
  it.todo('should cancel installation when user answers N to pre-install prompt');

  // E13: manifest 不在エラー
  it.todo('should fail with error when repository has no takt-repertoire.yaml');
});

describe('E2E: takt ensemble add (real GitHub — overwrite scenarios)', () => {
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

  // E5: インストール前サマリー表示
  it.skipIf(!canUseFixtureRepo)(
    'should display pre-install summary with package name, faceted info, and pieces list',
    () => {
      const result = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'n\n',
        timeout: 240_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`nrslib/takt-ensemble-fixture @${FIXTURE_REF}`);
      expect(result.stdout).toContain('facets:');
      expect(result.stdout).toContain('pieces:');
      expect(result.stdout).toContain('キャンセルしました');
    },
    240_000,
  );

  // E8: 既存パッケージの上書き警告表示
  it.skipIf(!canUseFixtureRepo)(
    'should display already-installed warning when adding a package that is already installed',
    () => {
      const firstResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\n',
        timeout: 240_000,
      });
      expect(firstResult.exitCode).toBe(0);

      const secondResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\nn\n',
        timeout: 240_000,
      });

      expect(secondResult.exitCode).toBe(0);
      expect(secondResult.stdout).toContain('既にインストールされています');
    },
    240_000,
  );

  // E9: 上書き y で原子的更新（.tmp/, .bak/ が残っていない）
  it.skipIf(!canUseFixtureRepo)(
    'should atomically update package with no leftover tmp or bak directories when user answers y to overwrite',
    () => {
      const firstResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\n',
        timeout: 240_000,
      });
      expect(firstResult.exitCode).toBe(0);

      const packageDir = join(
        isolatedEnv.taktDir,
        'repertoire',
        '@nrslib',
        'takt-ensemble-fixture',
      );

      const secondResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\ny\n',
        timeout: 240_000,
      });

      expect(secondResult.exitCode).toBe(0);
      expect(existsSync(`${packageDir}.tmp`)).toBe(false);
      expect(existsSync(`${packageDir}.bak`)).toBe(false);
      expect(existsSync(join(packageDir, '.takt-repertoire-lock.yaml'))).toBe(true);
    },
    240_000,
  );

  // E10: 上書き N でキャンセル — 既存 lock ファイルが変わらない
  it.skipIf(!canUseFixtureRepo)(
    'should keep existing package unchanged when user answers N to overwrite prompt',
    () => {
      const firstResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\n',
        timeout: 240_000,
      });
      expect(firstResult.exitCode).toBe(0);

      const lockPath = join(
        isolatedEnv.taktDir,
        'repertoire',
        '@nrslib',
        'takt-ensemble-fixture',
        '.takt-repertoire-lock.yaml',
      );
      const originalLock = readYamlFile<LockFile>(lockPath);

      const secondResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\nn\n',
        timeout: 240_000,
      });

      expect(secondResult.exitCode).toBe(0);
      const afterLock = readYamlFile<LockFile>(lockPath);
      expect(afterLock.commit).toBe(originalLock.commit);
      expect(afterLock.imported_at).toBe(originalLock.imported_at);
    },
    240_000,
  );

  // E11: 前回異常終了残留物（.tmp/）クリーンアップ
  it.skipIf(!canUseFixtureRepo)(
    'should clean up leftover .tmp/ directory from previous failed installation and succeed',
    () => {
      const firstResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\n',
        timeout: 240_000,
      });
      expect(firstResult.exitCode).toBe(0);

      const packageDir = join(
        isolatedEnv.taktDir,
        'repertoire',
        '@nrslib',
        'takt-ensemble-fixture',
      );

      mkdirSync(`${packageDir}.tmp`, { recursive: true });

      const secondResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\ny\n',
        timeout: 240_000,
      });

      expect(secondResult.exitCode).toBe(0);
      expect(existsSync(`${packageDir}.tmp`)).toBe(false);
    },
    240_000,
  );

  // E12: 前回異常終了残留物（.bak/）クリーンアップ
  it.skipIf(!canUseFixtureRepo)(
    'should clean up leftover .bak/ directory from previous failed installation and succeed',
    () => {
      const firstResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\n',
        timeout: 240_000,
      });
      expect(firstResult.exitCode).toBe(0);

      const packageDir = join(
        isolatedEnv.taktDir,
        'repertoire',
        '@nrslib',
        'takt-ensemble-fixture',
      );

      mkdirSync(`${packageDir}.bak`, { recursive: true });

      const secondResult = runTakt({
        args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
        cwd: process.cwd(),
        env: isolatedEnv.env,
        input: 'y\ny\n',
        timeout: 240_000,
      });

      expect(secondResult.exitCode).toBe(0);
      expect(existsSync(`${packageDir}.bak`)).toBe(false);
    },
    240_000,
  );
});

describe('E2E: takt ensemble add (real GitHub — validation errors)', () => {
  // E4b: コミットSHA指定
  // requires a known commit SHA for the fixture repo
  it.todo('should populate lock file commit field with the specified commit SHA when installing by SHA');

  // E6: 権限警告表示（edit: true ピース）
  // requires a fixture repo that contains a piece with edit: true
  it.todo('should display warning symbol when package contains piece with edit: true');

  // E14: path に絶対パス（/foo）
  // requires a fixture repo with path: /foo in takt-repertoire.yaml
  it.todo('should reject takt-repertoire.yaml with absolute path in path field (/foo)');

  // E15: path に .. によるリポジトリ外参照
  // requires a fixture repo with path: ../outside in takt-repertoire.yaml
  it.todo('should reject takt-repertoire.yaml with path traversal via ".." segments');

  // E16: 空パッケージ（facets/ も pieces/ もない）
  // requires a fixture repo with neither facets/ nor pieces/ directory
  it.todo('should reject package with neither facets/ nor pieces/ directory');

  // E17: min_version 不正形式（1.0、セグメント不足）
  // requires a fixture repo with takt.min_version: "1.0"
  it.todo('should reject takt-repertoire.yaml with min_version "1.0" (missing patch segment)');

  // E18: min_version 不正形式（v1.0.0、v プレフィックス）
  // requires a fixture repo with takt.min_version: "v1.0.0"
  it.todo('should reject takt-repertoire.yaml with min_version "v1.0.0" (v prefix)');

  // E19: min_version 不正形式（1.0.0-alpha、pre-release）
  // requires a fixture repo with takt.min_version: "1.0.0-alpha"
  it.todo('should reject takt-repertoire.yaml with min_version "1.0.0-alpha" (pre-release suffix)');

  // E20: min_version が現在の TAKT より新しい
  // requires a fixture repo with takt.min_version: "999.0.0"
  it.todo('should fail with version mismatch message when min_version exceeds current takt version');
});
