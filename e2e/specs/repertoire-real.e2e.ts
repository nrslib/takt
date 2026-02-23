// E2E更新時は docs/testing/e2e.md も更新すること

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

function fixtureHasManifest(repo: string, ref: string, filename: string): boolean {
  try {
    const out = execFileSync(
      'gh',
      ['api', `/repos/${repo}/git/trees/${ref}`, '--recursive'],
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    const tree = JSON.parse(out) as { tree: { path: string }[] };
    return tree.tree.some((f) => f.path === filename);
  } catch {
    return false;
  }
}

function readYamlFile<T>(path: string): T {
  const raw = readFileSync(path, 'utf-8');
  return parseYaml(raw) as T;
}

const FIXTURE_REPO = 'nrslib/takt-repertoire-fixture';
const FIXTURE_REPO_SUBDIR = 'nrslib/takt-repertoire-fixture-subdir';
const FIXTURE_REPO_FACETS_ONLY = 'nrslib/takt-repertoire-fixture-facets-only';
const MISSING_MANIFEST_REPO = 'nrslib/takt';
const FIXTURE_REF = 'v1.0.0';

const canUseFixtureRepo =
  canAccessRepo(FIXTURE_REPO) &&
  canAccessRepoRef(FIXTURE_REPO, FIXTURE_REF) &&
  fixtureHasManifest(FIXTURE_REPO, FIXTURE_REF, 'takt-repertoire.yaml');
const canUseSubdirRepo =
  canAccessRepo(FIXTURE_REPO_SUBDIR) &&
  canAccessRepoRef(FIXTURE_REPO_SUBDIR, FIXTURE_REF) &&
  fixtureHasManifest(FIXTURE_REPO_SUBDIR, FIXTURE_REF, 'takt-repertoire.yaml');
const canUseFacetsOnlyRepo =
  canAccessRepo(FIXTURE_REPO_FACETS_ONLY) &&
  canAccessRepoRef(FIXTURE_REPO_FACETS_ONLY, FIXTURE_REF) &&
  fixtureHasManifest(FIXTURE_REPO_FACETS_ONLY, FIXTURE_REF, 'takt-repertoire.yaml');
const canUseMissingManifestRepo = canAccessRepo(MISSING_MANIFEST_REPO);

describe('E2E: takt repertoire (real GitHub fixtures)', () => {
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

  it.skipIf(!canUseFixtureRepo)('should install fixture package from GitHub and create lock file', () => {
    const result = runTakt({
      args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`📦 ${FIXTURE_REPO} @${FIXTURE_REF}`);
    expect(result.stdout).toContain('インストールしました');

    const packageDir = join(isolatedEnv.taktDir, 'repertoire', '@nrslib', 'takt-repertoire-fixture');
    expect(existsSync(join(packageDir, 'takt-repertoire.yaml'))).toBe(true);
    expect(existsSync(join(packageDir, '.takt-repertoire-lock.yaml'))).toBe(true);
    expect(existsSync(join(packageDir, 'facets'))).toBe(true);
    expect(existsSync(join(packageDir, 'pieces'))).toBe(true);

    const lock = readYamlFile<LockFile>(join(packageDir, '.takt-repertoire-lock.yaml'));
    expect(lock.source).toBe('github:nrslib/takt-repertoire-fixture');
    expect(lock.ref).toBe(FIXTURE_REF);
    expect(lock.commit).toBeTypeOf('string');
    expect(lock.commit!.length).toBeGreaterThanOrEqual(7);
    expect(lock.imported_at).toBeTypeOf('string');
  }, 240_000);

  it.skipIf(!canUseFixtureRepo)('should list installed package after add', () => {
    const addResult = runTakt({
      args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });
    expect(addResult.exitCode).toBe(0);

    const listResult = runTakt({
      args: ['repertoire', 'list'],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      timeout: 120_000,
    });

    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('@nrslib/takt-repertoire-fixture');
  }, 240_000);

  it.skipIf(!canUseFixtureRepo)('should remove installed package with confirmation', () => {
    const addResult = runTakt({
      args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });
    expect(addResult.exitCode).toBe(0);

    const removeResult = runTakt({
      args: ['repertoire', 'remove', '@nrslib/takt-repertoire-fixture'],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 120_000,
    });
    expect(removeResult.exitCode).toBe(0);

    const packageDir = join(isolatedEnv.taktDir, 'repertoire', '@nrslib', 'takt-repertoire-fixture');
    expect(existsSync(packageDir)).toBe(false);
  }, 240_000);

  it.skipIf(!canUseFixtureRepo)('should cancel installation when user answers N', () => {
    const result = runTakt({
      args: ['repertoire', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'n\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('キャンセルしました');

    const packageDir = join(isolatedEnv.taktDir, 'repertoire', '@nrslib', 'takt-repertoire-fixture');
    expect(existsSync(packageDir)).toBe(false);
  }, 240_000);

  it.skipIf(!canUseSubdirRepo)('should install subdir fixture package', () => {
    const result = runTakt({
      args: ['repertoire', 'add', `github:${FIXTURE_REPO_SUBDIR}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    const packageDir = join(isolatedEnv.taktDir, 'repertoire', '@nrslib', 'takt-repertoire-fixture-subdir');
    expect(existsSync(join(packageDir, 'takt-repertoire.yaml'))).toBe(true);
    expect(existsSync(join(packageDir, '.takt-repertoire-lock.yaml'))).toBe(true);
    expect(existsSync(join(packageDir, 'facets')) || existsSync(join(packageDir, 'pieces'))).toBe(true);
  }, 240_000);

  it.skipIf(!canUseFacetsOnlyRepo)('should install facets-only fixture package without requiring pieces directory', () => {
    const result = runTakt({
      args: ['repertoire', 'add', `github:${FIXTURE_REPO_FACETS_ONLY}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    const packageDir = join(isolatedEnv.taktDir, 'repertoire', '@nrslib', 'takt-repertoire-fixture-facets-only');
    expect(existsSync(join(packageDir, 'facets'))).toBe(true);
    expect(existsSync(join(packageDir, 'pieces'))).toBe(false);
  }, 240_000);

  it.skipIf(!canUseMissingManifestRepo)('should fail when repository has no takt-repertoire.yaml', () => {
    const result = runTakt({
      args: ['repertoire', 'add', `github:${MISSING_MANIFEST_REPO}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('takt-repertoire.yaml not found');
  }, 240_000);

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
      expect(result.stdout).toContain(`nrslib/takt-repertoire-fixture @${FIXTURE_REF}`);
      expect(result.stdout).toContain('facets:');
      expect(result.stdout).toContain('pieces:');
      expect(result.stdout).toContain('キャンセルしました');
    },
    240_000,
  );

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
        'takt-repertoire-fixture',
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
        'takt-repertoire-fixture',
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
        'takt-repertoire-fixture',
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
        'takt-repertoire-fixture',
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

  it.todo('should populate lock file commit field with the specified commit SHA when installing by SHA');

  it.todo('should display warning symbol when package contains piece with edit: true');

  it.todo('should reject takt-repertoire.yaml with absolute path in path field (/foo)');

  it.todo('should reject takt-repertoire.yaml with path traversal via ".." segments');

  it.todo('should reject package with neither facets/ nor pieces/ directory');

  it.todo('should reject takt-repertoire.yaml with min_version "1.0" (missing patch segment)');

  it.todo('should reject takt-repertoire.yaml with min_version "v1.0.0" (v prefix)');

  it.todo('should reject takt-repertoire.yaml with min_version "1.0.0-alpha" (pre-release suffix)');

  it.todo('should fail with version mismatch message when min_version exceeds current takt version');
});
