import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const provider = process.env.TAKT_E2E_PROVIDER;
const providerEnabled = provider != null && provider !== 'mock';
const providerIt = providerEnabled ? it : it.skip;

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: runtime.prepare with provider', () => {
  let isolatedEnv: IsolatedEnv | undefined;
  let repo: LocalRepo | undefined;
  const runtimeTmpDirs = new Set<string>();
  const runtimeTmpDirectoryNamePattern = /^[a-f0-9]{32}$/;
  const userId = process.getuid?.();
  const runtimeTempRoot = join(
    realpathSync(process.platform === 'win32' ? tmpdir() : '/tmp'),
    userId === undefined ? 'takt' : `takt-${userId}`,
  );

  function getExpectedRuntimeTemporaryDirectory(repoPath: string, tempRoot: string): string {
    const worktreeHash = createHash('sha256')
      .update(resolve(repoPath, '.takt', '.runtime'))
      .digest('hex')
      .slice(0, 32);
    return join(resolve(tempRoot), worktreeHash);
  }

  function validateRuntimeTemporaryDirectory(
    candidate: string,
    repoPath: string,
    tempRoot: string,
  ): string | undefined {
    if (!isAbsolute(candidate) || candidate !== resolve(candidate)) return undefined;
    if (dirname(candidate) !== resolve(tempRoot) || !runtimeTmpDirectoryNamePattern.test(basename(candidate))) {
      return undefined;
    }
    return candidate === getExpectedRuntimeTemporaryDirectory(repoPath, tempRoot)
      ? candidate
      : undefined;
  }

  function registerRuntimeTmpDirectory(repoPath: string, envFile: string, tempRoot: string): void {
    if (!existsSync(envFile)) return;

    const envContent = readFileSync(envFile, 'utf-8');
    const runtimeTmpMatch = /^export TMPDIR='([^']+)'$/m.exec(envContent);
    if (runtimeTmpMatch !== null) {
      const runtimeTmpDirectory = validateRuntimeTemporaryDirectory(runtimeTmpMatch[1], repoPath, tempRoot);
      if (runtimeTmpDirectory !== undefined) {
        runtimeTmpDirs.add(runtimeTmpDirectory);
      }
    }
  }

  function cleanupRuntimeTmpDirectories(repoPath: string, tempRoot: string): void {
    let firstError: unknown;
    try {
      registerRuntimeTmpDirectory(repoPath, join(repoPath, '.takt', '.runtime', 'env.sh'), tempRoot);
    } catch (error) {
      firstError = error;
    }

    try {
      for (const runtimeTmpDir of runtimeTmpDirs) {
        try {
          rmSync(runtimeTmpDir, { recursive: true, force: true });
        } catch (error) {
          firstError ??= error;
        }
      }
    } finally {
      runtimeTmpDirs.clear();
    }
    if (firstError !== undefined) throw firstError;
  }

  function cleanupTestResources(
    runtimeTmpCleanup: (() => void) | undefined,
    localRepo: Pick<LocalRepo, 'cleanup'> | undefined,
    environment: Pick<IsolatedEnv, 'cleanup'> | undefined,
  ): void {
    let firstError: unknown;
    for (const cleanup of [runtimeTmpCleanup, localRepo?.cleanup.bind(localRepo), environment?.cleanup.bind(environment)]) {
      if (cleanup === undefined) continue;
      try {
        cleanup();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  beforeEach(() => {
    isolatedEnv = undefined;
    repo = undefined;
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    mkdirSync(join(repo.path, 'scripts'), { recursive: true });

    writeFileSync(
      join(repo.path, 'gradlew'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'mkdir -p .takt-e2e-markers',
        'touch .takt-e2e-markers/gradle-invoked',
        'if [ -z "${GRADLE_USER_HOME:-}" ]; then printf "%s\\n" "GRADLE_USER_HOME is required" > .takt-e2e-markers/gradle-env-error; exit 2; fi',
        'if [ -z "${TMPDIR:-}" ]; then printf "%s\\n" "TMPDIR is required" > .takt-e2e-markers/gradle-env-error; exit 3; fi',
        'mkdir -p "$GRADLE_USER_HOME"',
        'mkdir -p "$TMPDIR"',
        'echo "ok" > "$GRADLE_USER_HOME/gradle-ok.txt"',
        'printf "%s" "$TMPDIR" > "$GRADLE_USER_HOME/gradle-tmpdir.txt"',
        'echo "ok" > "$TMPDIR/gradle-tmp-ok.txt"',
        'echo "BUILD SUCCESSFUL"',
      ].join('\n'),
      'utf-8',
    );
    chmodSync(join(repo.path, 'gradlew'), 0o755);

    writeFileSync(
      join(repo.path, 'scripts/check-node-env.js'),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "fs.mkdirSync('.takt-e2e-markers', { recursive: true });",
        "fs.writeFileSync('.takt-e2e-markers/npm-invoked', '');",
        "const cache = process.env.npm_config_cache;",
        "const expectedCache = path.join(process.cwd(), '.takt', '.runtime', 'npm');",
        "if (cache !== expectedCache) { fs.writeFileSync('.takt-e2e-markers/npm-env-error', 'runtime npm cache is required\\n'); process.exit(2); }",
        "fs.mkdirSync(cache, { recursive: true });",
        "fs.writeFileSync(path.join(cache, 'npm-ok.txt'), 'ok');",
        "fs.writeFileSync(path.join(cache, 'node-tmpdir.txt'), process.env.TMPDIR ?? '');",
        "console.log('node-env-ok');",
      ].join('\n'),
      'utf-8',
    );

    writeFileSync(
      join(repo.path, 'package.json'),
      JSON.stringify({
        name: 'runtime-e2e',
        private: true,
        version: '1.0.0',
        scripts: {
          test: 'node scripts/check-node-env.js',
        },
      }, null, 2),
      'utf-8',
    );

    writeFileSync(
      join(repo.path, 'runtime-e2e-workflow.yaml'),
      [
        'name: runtime-e2e',
        'description: Runtime env injection verification workflow',
        'max_steps: 3',
        'initial_step: execute',
        'steps:',
        '  - name: execute',
        '    edit: false',
        '    persona: ../fixtures/agents/test-coder.md',
        '    provider_options:',
        '      claude:',
        '        allowed_tools:',
        '          - Read',
        '          - Bash',
        '    required_permission_mode: full',
        '    instruction: |',
        '      {task}',
        '    rules:',
        '      - condition: Task completed',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(() => {
    cleanupTestResources(
      repo === undefined ? undefined : () => cleanupRuntimeTmpDirectories(repo.path, runtimeTempRoot),
      repo,
      isolatedEnv,
    );
  });

  it('should remove a runtime temporary directory discovered from env.sh during cleanup', () => {
    mkdirSync(runtimeTempRoot, { recursive: true, mode: 0o700 });
    const runtimeTmpDir = getExpectedRuntimeTemporaryDirectory(repo.path, runtimeTempRoot);
    mkdirSync(runtimeTmpDir, { mode: 0o700 });
    const envFile = join(repo.path, '.takt', '.runtime', 'env.sh');
    mkdirSync(dirname(envFile), { recursive: true });
    writeFileSync(envFile, `export TMPDIR='${runtimeTmpDir}'\n`, 'utf-8');

    cleanupRuntimeTmpDirectories(repo.path, runtimeTempRoot);

    expect(existsSync(runtimeTmpDir)).toBe(false);
  });

  it('should remove registered runtime temporary directories before reporting an env read failure', () => {
    const envFile = join(repo.path, '.takt', '.runtime', 'env.sh');
    mkdirSync(runtimeTempRoot, { recursive: true, mode: 0o700 });
    const runtimeTmpDir = getExpectedRuntimeTemporaryDirectory(repo.path, runtimeTempRoot);
    mkdirSync(runtimeTmpDir, { mode: 0o700 });
    runtimeTmpDirs.add(runtimeTmpDir);
    mkdirSync(envFile, { recursive: true });

    try {
      expect(() => cleanupRuntimeTmpDirectories(repo.path, runtimeTempRoot)).toThrow();
      expect(existsSync(runtimeTmpDir)).toBe(false);
      rmSync(envFile, { recursive: true, force: true });
      mkdirSync(runtimeTmpDir, { mode: 0o700 });

      cleanupRuntimeTmpDirectories(repo.path, runtimeTempRoot);

      expect(existsSync(runtimeTmpDir)).toBe(true);
    } finally {
      rmSync(envFile, { recursive: true, force: true });
      rmSync(runtimeTmpDir, { recursive: true, force: true });
    }
  });

  it('should reject a non-hash runtime temporary directory component during cleanup', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'takt-runtime-cleanup-'));
    const isolatedTempRoot = join(sandbox, 'runtime-root');

    try {
      const envFile = join(repo.path, '.takt', '.runtime', 'env.sh');
      mkdirSync(isolatedTempRoot, { recursive: true });
      mkdirSync(dirname(envFile), { recursive: true });
      writeFileSync(envFile, `export TMPDIR='${join(isolatedTempRoot, '.')}'\n`, 'utf-8');

      cleanupRuntimeTmpDirectories(repo.path, isolatedTempRoot);

      expect(existsSync(isolatedTempRoot)).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('should reject a parent-directory runtime temporary path during cleanup', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'takt-runtime-cleanup-'));
    const isolatedTempRoot = join(sandbox, 'runtime-root');
    const sentinel = join(sandbox, 'sentinel');

    try {
      const envFile = join(repo.path, '.takt', '.runtime', 'env.sh');
      mkdirSync(isolatedTempRoot, { recursive: true });
      writeFileSync(sentinel, 'keep', 'utf-8');
      mkdirSync(dirname(envFile), { recursive: true });
      writeFileSync(envFile, `export TMPDIR='${isolatedTempRoot}/..'\n`, 'utf-8');

      cleanupRuntimeTmpDirectories(repo.path, isolatedTempRoot);

      expect(existsSync(isolatedTempRoot)).toBe(true);
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('should reject a symlink and parent traversal runtime temporary path during cleanup', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'takt-runtime-cleanup-'));
    const isolatedTempRoot = join(sandbox, 'runtime-root');
    const outsideRoot = join(sandbox, 'outside');
    const expectedDirectoryName = basename(getExpectedRuntimeTemporaryDirectory(repo.path, isolatedTempRoot));
    const outsideRuntimeTmp = join(outsideRoot, expectedDirectoryName);

    try {
      const envFile = join(repo.path, '.takt', '.runtime', 'env.sh');
      const linkedDirectory = join(outsideRoot, 'linked-directory');
      mkdirSync(isolatedTempRoot, { recursive: true });
      mkdirSync(linkedDirectory, { recursive: true });
      mkdirSync(outsideRuntimeTmp, { recursive: true });
      writeFileSync(join(outsideRuntimeTmp, 'sentinel'), 'keep', 'utf-8');
      symlinkSync(linkedDirectory, join(isolatedTempRoot, 'link'), 'dir');
      mkdirSync(dirname(envFile), { recursive: true });
      writeFileSync(envFile, `export TMPDIR='${isolatedTempRoot}/link/../${expectedDirectoryName}'\n`, 'utf-8');

      cleanupRuntimeTmpDirectories(repo.path, isolatedTempRoot);

      expect(existsSync(outsideRuntimeTmp)).toBe(true);
      expect(existsSync(join(outsideRuntimeTmp, 'sentinel'))).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('should reject a different worktree runtime temporary directory during cleanup', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'takt-runtime-cleanup-'));
    const isolatedTempRoot = join(sandbox, 'runtime-root');
    const expectedDirectoryName = basename(getExpectedRuntimeTemporaryDirectory(repo.path, isolatedTempRoot));
    const differentDirectoryName = `${expectedDirectoryName[0] === 'a' ? 'b' : 'a'}${expectedDirectoryName.slice(1)}`;
    const differentRuntimeTmp = join(isolatedTempRoot, differentDirectoryName);

    try {
      const envFile = join(repo.path, '.takt', '.runtime', 'env.sh');
      mkdirSync(differentRuntimeTmp, { recursive: true });
      writeFileSync(join(differentRuntimeTmp, 'sentinel'), 'keep', 'utf-8');
      mkdirSync(dirname(envFile), { recursive: true });
      writeFileSync(envFile, `export TMPDIR='${differentRuntimeTmp}'\n`, 'utf-8');

      cleanupRuntimeTmpDirectories(repo.path, isolatedTempRoot);

      expect(existsSync(differentRuntimeTmp)).toBe(true);
      expect(existsSync(join(differentRuntimeTmp, 'sentinel'))).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('should attempt every teardown cleanup after a runtime cleanup failure', () => {
    const cleanupCalls: string[] = [];

    expect(() => cleanupTestResources(
      () => {
        cleanupCalls.push('runtime');
        throw new Error('runtime cleanup failed');
      },
      { cleanup: () => cleanupCalls.push('repo') },
      { cleanup: () => cleanupCalls.push('environment') },
    )).toThrow('runtime cleanup failed');

    expect(cleanupCalls).toEqual(['runtime', 'repo', 'environment']);
  });

  it('should clean an isolated environment when repository setup did not complete', () => {
    let environmentCleaned = false;

    cleanupTestResources(undefined, undefined, {
      cleanup: () => {
        environmentCleaned = true;
      },
    });

    expect(environmentCleaned).toBe(true);
  });

  it('should save the Gradle TMPDIR failure proof when GRADLE_USER_HOME is set', () => {
    const markerPath = join(repo.path, '.takt-e2e-markers', 'gradle-env-error');
    const result = spawnSync('./gradlew', ['test'], {
      cwd: repo.path,
      env: {
        ...process.env,
        GRADLE_USER_HOME: join(repo.path, 'gradle-home'),
        TMPDIR: undefined,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(3);
    expect(readFileSync(markerPath, 'utf-8')).toBe('TMPDIR is required\n');
  });

  providerIt('should apply runtime.prepare from config.yaml during provider execution', () => {
    updateIsolatedConfig(isolatedEnv.taktDir, {
      runtime: {
        prepare: ['gradle', 'node'],
      },
    });

    const workflowPath = join(repo.path, 'runtime-e2e-workflow.yaml');
    const runtimeRoot = join(repo.path, '.takt', '.runtime');
    const envFile = join(runtimeRoot, 'env.sh');
    const expectedRuntimeTmpDir = getExpectedRuntimeTemporaryDirectory(repo.path, runtimeTempRoot);
    runtimeTmpDirs.add(expectedRuntimeTmpDir);
    const result = runTakt({
      args: [
        '--task',
        [
          'Run `./gradlew test` and `npm test` in the repository root.',
          'If both commands succeed, respond exactly with: Task completed',
        ].join(' '),
        '--workflow', workflowPath,
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    registerRuntimeTmpDirectory(repo.path, envFile, runtimeTempRoot);

    expect(result.exitCode).toBe(0);

    expect(existsSync(runtimeRoot)).toBe(true);
    expect(existsSync(join(runtimeRoot, 'cache'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'config'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'state'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'gradle'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'npm'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'gradle', 'gradle-ok.txt'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'npm', 'npm-ok.txt'))).toBe(true);
    expect(existsSync(envFile)).toBe(true);

    const envContent = readFileSync(envFile, 'utf-8');
    const runtimeTmpMatch = /^export TMPDIR='([^']+)'$/m.exec(envContent);
    expect(runtimeTmpMatch).not.toBeNull();
    expect(runtimeTmpMatch![1]).toBe(expectedRuntimeTmpDir);

    const gradleTmpDir = readFileSync(join(runtimeRoot, 'gradle', 'gradle-tmpdir.txt'), 'utf-8');
    const nodeTmpDir = readFileSync(join(runtimeRoot, 'npm', 'node-tmpdir.txt'), 'utf-8');
    expect(nodeTmpDir).toBe(runtimeTmpMatch![1]);
    expect(nodeTmpDir).toBe(gradleTmpDir);
    expect(nodeTmpDir.startsWith(runtimeRoot)).toBe(false);
    expect(existsSync(join(nodeTmpDir, 'gradle-tmp-ok.txt'))).toBe(true);

    expect(envContent).toContain('export TMPDIR=');
    expect(envContent).toContain('export GRADLE_USER_HOME=');
    expect(envContent).toContain('export npm_config_cache=');
  }, 240_000);

  providerIt('should not prepare the runtime environment when runtime.prepare is unset', () => {
    const workflowPath = join(repo.path, 'runtime-e2e-workflow.yaml');
    const unpreparedEnv = {
      ...isolatedEnv.env,
      GRADLE_USER_HOME: undefined,
      npm_config_cache: undefined,
    };
    const result = runTakt({
      args: [
        '--task',
        [
          'Run `./gradlew test` and `npm test` separately in the repository root without setting or overriding environment variables, even if either command fails.',
          'If both commands succeed, respond exactly with: Task completed',
        ].join(' '),
        '--workflow', workflowPath,
      ],
      cwd: repo.path,
      env: unpreparedEnv,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(repo.path, '.takt-e2e-markers', 'gradle-invoked'))).toBe(true);
    expect(existsSync(join(repo.path, '.takt-e2e-markers', 'npm-invoked'))).toBe(true);
    expect(readFileSync(join(repo.path, '.takt-e2e-markers', 'gradle-env-error'), 'utf-8')).toBe('GRADLE_USER_HOME is required\n');
    expect(readFileSync(join(repo.path, '.takt-e2e-markers', 'npm-env-error'), 'utf-8')).toBe('runtime npm cache is required\n');

    const runtimeRoot = join(repo.path, '.takt', '.runtime');
    expect(existsSync(join(runtimeRoot, 'env.sh'))).toBe(false);
  }, 240_000);
});
