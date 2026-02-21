import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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

function readYamlFile<T>(path: string): T {
  const raw = readFileSync(path, 'utf-8');
  return parseYaml(raw) as T;
}

const FIXTURE_REPO = 'nrslib/takt-pack-fixture';
const FIXTURE_REPO_SUBDIR = 'nrslib/takt-pack-fixture-subdir';
const FIXTURE_REPO_FACETS_ONLY = 'nrslib/takt-pack-fixture-facets-only';
const MISSING_MANIFEST_REPO = 'nrslib/takt';
const FIXTURE_REF = 'v1.0.0';

const canUseFixtureRepo = canAccessRepo(FIXTURE_REPO) && canAccessRepoRef(FIXTURE_REPO, FIXTURE_REF);
const canUseSubdirRepo = canAccessRepo(FIXTURE_REPO_SUBDIR) && canAccessRepoRef(FIXTURE_REPO_SUBDIR, FIXTURE_REF);
const canUseFacetsOnlyRepo = canAccessRepo(FIXTURE_REPO_FACETS_ONLY) && canAccessRepoRef(FIXTURE_REPO_FACETS_ONLY, FIXTURE_REF);
const canUseMissingManifestRepo = canAccessRepo(MISSING_MANIFEST_REPO);

describe('E2E: takt ensemble (real GitHub fixtures)', () => {
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
      args: ['ensemble', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`📦 ${FIXTURE_REPO} @${FIXTURE_REF}`);
    expect(result.stdout).toContain('インストールしました');

    const packageDir = join(isolatedEnv.taktDir, 'ensemble', '@nrslib', 'takt-pack-fixture');
    expect(existsSync(join(packageDir, 'takt-package.yaml'))).toBe(true);
    expect(existsSync(join(packageDir, '.takt-pack-lock.yaml'))).toBe(true);
    expect(existsSync(join(packageDir, 'facets'))).toBe(true);
    expect(existsSync(join(packageDir, 'pieces'))).toBe(true);

    const lock = readYamlFile<LockFile>(join(packageDir, '.takt-pack-lock.yaml'));
    expect(lock.source).toBe('github:nrslib/takt-pack-fixture');
    expect(lock.ref).toBe(FIXTURE_REF);
    expect(lock.commit).toBeTypeOf('string');
    expect(lock.commit!.length).toBeGreaterThanOrEqual(7);
    expect(lock.imported_at).toBeTypeOf('string');
  }, 240_000);

  it.skipIf(!canUseFixtureRepo)('should list installed package after add', () => {
    const addResult = runTakt({
      args: ['ensemble', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });
    expect(addResult.exitCode).toBe(0);

    const listResult = runTakt({
      args: ['ensemble', 'list'],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      timeout: 120_000,
    });

    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('@nrslib/takt-pack-fixture');
  }, 240_000);

  it.skipIf(!canUseFixtureRepo)('should remove installed package with confirmation', () => {
    const addResult = runTakt({
      args: ['ensemble', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });
    expect(addResult.exitCode).toBe(0);

    const removeResult = runTakt({
      args: ['ensemble', 'remove', '@nrslib/takt-pack-fixture'],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 120_000,
    });
    expect(removeResult.exitCode).toBe(0);

    const packageDir = join(isolatedEnv.taktDir, 'ensemble', '@nrslib', 'takt-pack-fixture');
    expect(existsSync(packageDir)).toBe(false);
  }, 240_000);

  it.skipIf(!canUseFixtureRepo)('should cancel installation when user answers N', () => {
    const result = runTakt({
      args: ['ensemble', 'add', `github:${FIXTURE_REPO}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'n\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('キャンセルしました');

    const packageDir = join(isolatedEnv.taktDir, 'ensemble', '@nrslib', 'takt-pack-fixture');
    expect(existsSync(packageDir)).toBe(false);
  }, 240_000);

  it.skipIf(!canUseSubdirRepo)('should install subdir fixture package', () => {
    const result = runTakt({
      args: ['ensemble', 'add', `github:${FIXTURE_REPO_SUBDIR}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    const packageDir = join(isolatedEnv.taktDir, 'ensemble', '@nrslib', 'takt-pack-fixture-subdir');
    expect(existsSync(join(packageDir, 'takt-package.yaml'))).toBe(true);
    expect(existsSync(join(packageDir, '.takt-pack-lock.yaml'))).toBe(true);
    expect(existsSync(join(packageDir, 'facets')) || existsSync(join(packageDir, 'pieces'))).toBe(true);
  }, 240_000);

  it.skipIf(!canUseFacetsOnlyRepo)('should install facets-only fixture package without requiring pieces directory', () => {
    const result = runTakt({
      args: ['ensemble', 'add', `github:${FIXTURE_REPO_FACETS_ONLY}@${FIXTURE_REF}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    const packageDir = join(isolatedEnv.taktDir, 'ensemble', '@nrslib', 'takt-pack-fixture-facets-only');
    expect(existsSync(join(packageDir, 'facets'))).toBe(true);
    expect(existsSync(join(packageDir, 'pieces'))).toBe(false);
  }, 240_000);

  it.skipIf(!canUseMissingManifestRepo)('should fail when repository has no takt-package.yaml', () => {
    const result = runTakt({
      args: ['ensemble', 'add', `github:${MISSING_MANIFEST_REPO}`],
      cwd: process.cwd(),
      env: isolatedEnv.env,
      input: 'y\n',
      timeout: 240_000,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('takt-package.yaml not found');
  }, 240_000);
});
