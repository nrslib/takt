import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRuntimeEnvironment, resolveRuntimeConfig } from '../core/runtime/runtime-environment.js';

describe('prepareRuntimeEnvironment', () => {
  const tempDirs: string[] = [];
  const runtimeTmpDirs = new Set<string>();
  const systemTmpDir = tmpdir();
  const userId = process.getuid?.();
  const envKeys = [
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'CI',
    'JAVA_TOOL_OPTIONS',
    'GRADLE_USER_HOME',
    'npm_config_cache',
    'GH_CONFIG_DIR',
    'GLAB_CONFIG_DIR',
    'CURSOR_CONFIG_DIR',
    'HOME',
    'TAKT_RUNTIME_TMP',
    'CUSTOM_CACHE_DIR',
    'CUSTOM_PREPARE_VALUE',
    'TAKT_RUNTIME_CUSTOM',
    'OBSERVED_TMPDIR',
    'OBSERVED_RUNTIME_TMP',
    'tmpdir',
    'takt_runtime_tmp',
    '__proto__',
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  function getExpectedRuntimeTemporaryDirectory(cwd: string): string {
    const systemTmpRoot = realpathSync(process.platform === 'win32' ? tmpdir() : '/tmp');
    const userDirectory = userId === undefined
      ? join(systemTmpRoot, 'takt')
      : join(systemTmpRoot, `takt-${userId}`);
    const worktreeHash = createHash('sha256')
      .update(resolve(cwd, '.takt', '.runtime'))
      .digest('hex')
      .slice(0, 32);
    return join(userDirectory, worktreeHash);
  }

  function prepareRuntimeEnvironmentForTest(
    cwd: string,
    runtime: Parameters<typeof prepareRuntimeEnvironment>[1],
  ) {
    const expectedRuntimeTmpDir = getExpectedRuntimeTemporaryDirectory(cwd);
    runtimeTmpDirs.add(expectedRuntimeTmpDir);
    const result = prepareRuntimeEnvironment(cwd, runtime);
    if (result !== undefined) {
      expect(result.injectedEnv.TMPDIR).toBe(expectedRuntimeTmpDir);
    }
    return result;
  }

  function removeDirectory(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }

  function cleanupTestResources(remove: (path: string) => void): void {
    let firstError: unknown;
    try {
      for (const runtimeTmpDir of runtimeTmpDirs) {
        try {
          remove(runtimeTmpDir);
        } catch (error) {
          firstError ??= error;
        }
      }
    } finally {
      runtimeTmpDirs.clear();
    }

    for (const dir of tempDirs.splice(0)) {
      try {
        remove(dir);
      } catch (error) {
        firstError ??= error;
      }
    }

    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    if (firstError !== undefined) throw firstError;
  }

  afterEach(() => {
    cleanupTestResources(removeDirectory);
  });

  it('should return undefined when runtime.prepare is not set', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const result = prepareRuntimeEnvironmentForTest(cwd, undefined);
    expect(result).toBeUndefined();
  });

  it('should clean up the expected temporary directory when prepare fails', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    const expectedRuntimeTmpDir = getExpectedRuntimeTemporaryDirectory(cwd);
    tempDirs.push(cwd);

    expect(() => prepareRuntimeEnvironmentForTest(cwd, {
      prepare: [join(cwd, 'missing-prepare-script.sh')],
    })).toThrow();

    expect(existsSync(expectedRuntimeTmpDir)).toBe(true);
    cleanupTestResources(removeDirectory);
    expect(existsSync(expectedRuntimeTmpDir)).toBe(false);
  });

  it('should create .runtime files and inject tool-specific env', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const result = prepareRuntimeEnvironmentForTest(cwd, {
      prepare: ['gradle', 'node'],
    });

    expect(result).toBeDefined();
    expect(result?.prepare).toEqual(['gradle', 'node']);

    const runtimeRoot = join(cwd, '.takt', '.runtime');
    expect(existsSync(runtimeRoot)).toBe(true);
    expect(existsSync(result!.injectedEnv.TMPDIR)).toBe(true);
    expect(existsSync(join(runtimeRoot, 'cache'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'config'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'state'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'gradle'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'npm'))).toBe(true);

    const envFile = join(runtimeRoot, 'env.sh');
    expect(existsSync(envFile)).toBe(true);
    const envContent = readFileSync(envFile, 'utf-8');
    expect(envContent).toContain('export TMPDIR=');
    expect(envContent).toContain('export GRADLE_USER_HOME=');
    expect(envContent).toContain('export npm_config_cache=');
  });

  it('should use one short temporary directory for Node and Gradle while retaining runtime caches', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const result = prepareRuntimeEnvironmentForTest(cwd, {
      prepare: ['gradle', 'node'],
    });

    const runtimeRoot = join(cwd, '.takt', '.runtime');
    const tmpDir = result!.injectedEnv.TMPDIR;
    expect(tmpDir.startsWith(runtimeRoot)).toBe(false);
    expect(existsSync(tmpDir)).toBe(true);
    expect(result!.injectedEnv.JAVA_TOOL_OPTIONS).toContain(`-Djava.io.tmpdir=${tmpDir}`);
    expect(result!.injectedEnv.GRADLE_USER_HOME).toBe(join(runtimeRoot, 'gradle'));
    expect(result!.injectedEnv.npm_config_cache).toBe(join(runtimeRoot, 'npm'));
    expect(result!.injectedEnv.XDG_CACHE_HOME).toBe(join(runtimeRoot, 'cache'));
    expect(result!.injectedEnv.XDG_CONFIG_HOME).toBe(join(runtimeRoot, 'config'));
    expect(result!.injectedEnv.XDG_STATE_HOME).toBe(join(runtimeRoot, 'state'));
  });

  it('should derive a stable temporary directory per worktree', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    const otherCwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd, otherCwd);

    const first = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });
    const second = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });
    const other = prepareRuntimeEnvironmentForTest(otherCwd, { prepare: ['node'] });

    expect(second!.injectedEnv.TMPDIR).toBe(first!.injectedEnv.TMPDIR);
    expect(other!.injectedEnv.TMPDIR).not.toBe(first!.injectedEnv.TMPDIR);
  });

  it('should use a 128-bit runtime temporary directory identifier', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result!.injectedEnv.TMPDIR).toBe(getExpectedRuntimeTemporaryDirectory(cwd));
    expect(basename(result!.injectedEnv.TMPDIR)).toHaveLength(32);
  });

  it('should restore all test resources after a runtime temporary directory cleanup failure', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    const otherCwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    const temporaryDir = mkdtempSync(join(systemTmpDir, 'takt-runtime-cleanup-'));
    tempDirs.push(cwd, otherCwd, temporaryDir);
    const expectedError = new Error('runtime temporary directory cleanup failed');
    const expectedFirstRuntimeTmpDir = getExpectedRuntimeTemporaryDirectory(cwd);
    const expectedSecondRuntimeTmpDir = getExpectedRuntimeTemporaryDirectory(otherCwd);

    try {
      const first = prepareRuntimeEnvironment(cwd, { prepare: ['node'] });
      const second = prepareRuntimeEnvironment(otherCwd, { prepare: ['node'] });

      expect(first!.injectedEnv.TMPDIR).toBe(expectedFirstRuntimeTmpDir);
      expect(second!.injectedEnv.TMPDIR).toBe(expectedSecondRuntimeTmpDir);
      runtimeTmpDirs.add(expectedFirstRuntimeTmpDir);
      runtimeTmpDirs.add(expectedSecondRuntimeTmpDir);
      process.env.TMPDIR = '/changed/by/test';

      expect(() => cleanupTestResources((path) => {
        if (path === expectedFirstRuntimeTmpDir) throw expectedError;
        removeDirectory(path);
      })).toThrow(expectedError);

      expect(existsSync(expectedSecondRuntimeTmpDir)).toBe(false);
      expect(existsSync(temporaryDir)).toBe(false);
      expect(runtimeTmpDirs).toHaveLength(0);
      expect(process.env.TMPDIR).toBe(originalEnv.TMPDIR);
    } finally {
      removeDirectory(expectedFirstRuntimeTmpDir);
      removeDirectory(expectedSecondRuntimeTmpDir);
    }

    expect(existsSync(expectedFirstRuntimeTmpDir)).toBe(false);
    expect(existsSync(expectedSecondRuntimeTmpDir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'should keep runtime temporary directories private',
    () => {
      const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
      tempDirs.push(cwd);

      const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });
      const tmpDir = result!.injectedEnv.TMPDIR;

      expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(tmpDir, '..')).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should support a tsx socket within the macOS Unix socket path limit for a long worktree path',
    async () => {
      const root = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
      const cwd = join(root, 'worktree-with-a-name-long-enough-to-exceed-the-unix-domain-socket-path-limit-when-runtime-isolation-is-used');
      mkdirSync(cwd, { recursive: true });
      tempDirs.push(root);

      const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });
      if (process.getuid === undefined) {
        throw new Error('process.getuid is required for POSIX tsx socket path verification');
      }
      const socketDirectory = join(result!.injectedEnv.TMPDIR, `tsx-${process.getuid()}`);
      const socketPath = join(socketDirectory, '999999.pipe');
      mkdirSync(socketDirectory, { recursive: true });

      expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103);
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should reject a pre-existing temporary directory symlink before running prepare scripts',
    () => {
      const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
      tempDirs.push(cwd);
      const expectedRuntimeTmpDir = getExpectedRuntimeTemporaryDirectory(cwd);
      const first = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });
      expect(first!.injectedEnv.TMPDIR).toBe(expectedRuntimeTmpDir);
      const outsideDir = join(cwd, 'outside');
      const scriptPath = join(cwd, 'prepare-marker.sh');
      mkdirSync(outsideDir);
      writeFileSync(scriptPath, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'touch "$TAKT_RUNTIME_TMP/tsx-guard"',
      ].join('\n'), 'utf-8');
      chmodSync(scriptPath, 0o755);
      rmSync(expectedRuntimeTmpDir, { recursive: true });
      symlinkSync(outsideDir, expectedRuntimeTmpDir, 'dir');

      expect(() => prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node', scriptPath] })).toThrow(/symlink|unsafe/i);
      expect(existsSync(join(outsideDir, 'tsx-guard'))).toBe(false);
    },
  );

  it('should reject a regular file at the resolved temporary directory path', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    const expectedRuntimeTmpDir = getExpectedRuntimeTemporaryDirectory(cwd);
    const first = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });
    expect(first!.injectedEnv.TMPDIR).toBe(expectedRuntimeTmpDir);
    rmSync(expectedRuntimeTmpDir, { recursive: true });
    writeFileSync(expectedRuntimeTmpDir, 'not a directory\n', 'utf-8');

    expect(() => prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] })).toThrow();
  });

  it('should execute custom prepare script path and merge exported env', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const scriptPath = join(cwd, 'prepare-custom.sh');
    writeFileSync(scriptPath, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'runtime_root="${TAKT_RUNTIME_ROOT:?}"',
      'custom_dir="$runtime_root/custom-cache"',
      'mkdir -p "$custom_dir"',
      'echo "CUSTOM_CACHE_DIR=$custom_dir"',
      'echo "TAKT_RUNTIME_CUSTOM=visible"',
    ].join('\n'), 'utf-8');
    chmodSync(scriptPath, 0o755);

    const result = prepareRuntimeEnvironmentForTest(cwd, {
      prepare: [scriptPath],
    });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.CUSTOM_CACHE_DIR).toBe(join(cwd, '.takt', '.runtime', 'custom-cache'));
    expect(result?.injectedEnv.TAKT_RUNTIME_CUSTOM).toBe('visible');
    expect(process.env.TAKT_RUNTIME_CUSTOM).toBe('visible');
    expect(existsSync(join(cwd, '.takt', '.runtime', 'custom-cache'))).toBe(true);
  });

  it('should replace an existing java.io.tmpdir option with the resolved runtime directory', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    process.env['JAVA_TOOL_OPTIONS'] = '-Xmx1g -Djava.io.tmpdir=/unsafe/runtime-tmp-other';

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['gradle'] });

    expect(result!.injectedEnv.JAVA_TOOL_OPTIONS).toBe(
      `-Xmx1g -Djava.io.tmpdir=${result!.injectedEnv.TMPDIR}`,
    );
  });

  it('should replace a quoted java.io.tmpdir option with the resolved runtime directory', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    process.env['JAVA_TOOL_OPTIONS'] = '"-Djava.io.tmpdir=/unsafe/runtime tmp" -Xmx1g';

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['gradle'] });

    expect(result!.injectedEnv.JAVA_TOOL_OPTIONS).toBe(
      `-Xmx1g -Djava.io.tmpdir=${result!.injectedEnv.TMPDIR}`,
    );
  });

  it('should quote a runtime temporary directory containing spaces for Java', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    const windowsTmpDir = join(cwd, 'temporary directory');
    tempDirs.push(cwd);
    mkdirSync(windowsTmpDir);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    process.env['TMPDIR'] = windowsTmpDir;

    try {
      const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['gradle'] });

      expect(result!.injectedEnv.JAVA_TOOL_OPTIONS).toBe(
        `-Djava.io.tmpdir="${result!.injectedEnv.TMPDIR}"`,
      );
      const runtimeTmpDir = result!.injectedEnv.TMPDIR;
      cleanupTestResources(removeDirectory);
      expect(existsSync(runtimeTmpDir)).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('should preserve the runtime temporary directory across custom prepare scripts', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    process.env.TAKT_RUNTIME_TMP = '/unsafe/preexisting-path';
    const firstScriptPath = join(cwd, 'prepare-first.sh');
    const secondScriptPath = join(cwd, 'prepare-second.sh');
    writeFileSync(firstScriptPath, [
      '#!/usr/bin/env bash',
      'echo "TMPDIR=/unsafe/long-path"',
      'echo "TAKT_RUNTIME_TMP=/unsafe/other-path"',
      'echo "CUSTOM_PREPARE_VALUE=first"',
    ].join('\n'), 'utf-8');
    writeFileSync(secondScriptPath, [
      '#!/usr/bin/env bash',
      'echo "OBSERVED_TMPDIR=$TMPDIR"',
      'echo "OBSERVED_RUNTIME_TMP=$TAKT_RUNTIME_TMP"',
      'echo "TMPDIR=/unsafe/final-path"',
      'echo "TAKT_RUNTIME_TMP=/unsafe/final-runtime-path"',
    ].join('\n'), 'utf-8');
    chmodSync(firstScriptPath, 0o755);
    chmodSync(secondScriptPath, 0o755);

    const result = prepareRuntimeEnvironmentForTest(cwd, {
      prepare: [firstScriptPath, secondScriptPath],
    });

    expect(result!.injectedEnv.TMPDIR).toBe(result!.injectedEnv.OBSERVED_TMPDIR);
    expect(result!.injectedEnv.OBSERVED_RUNTIME_TMP).toBe(result!.injectedEnv.TMPDIR);
    expect(result!.injectedEnv.CUSTOM_PREPARE_VALUE).toBe('first');
    expect(result!.injectedEnv.TAKT_RUNTIME_TMP).toBe(result!.injectedEnv.TMPDIR);
    expect(process.env.TAKT_RUNTIME_TMP).toBe(result!.injectedEnv.TMPDIR);
  });

  it('should reject case-insensitive protected temporary keys from custom prepare output on Windows', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    const scriptPath = join(cwd, 'prepare-case-variant.sh');
    const originalPlatform = process.platform;
    tempDirs.push(cwd);
    writeFileSync(scriptPath, [
      '#!/usr/bin/env bash',
      'echo "tmpdir=/unsafe/tmpdir"',
      'echo "takt_runtime_tmp=/unsafe/runtime-tmp"',
    ].join('\n'), 'utf-8');
    chmodSync(scriptPath, 0o755);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });

    try {
      const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: [scriptPath] });

      expect(result!.injectedEnv.TMPDIR).not.toBe('/unsafe/tmpdir');
      expect(result!.injectedEnv.TAKT_RUNTIME_TMP).toBe(result!.injectedEnv.TMPDIR);
      expect(result!.injectedEnv.tmpdir).toBeUndefined();
      expect(result!.injectedEnv.takt_runtime_tmp).toBeUndefined();
      const runtimeTmpDir = result!.injectedEnv.TMPDIR;
      cleanupTestResources(removeDirectory);
      expect(existsSync(runtimeTmpDir)).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'should preserve case-sensitive custom temporary keys from custom prepare output on POSIX',
    () => {
      const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
      const scriptPath = join(cwd, 'prepare-case-variant.sh');
      tempDirs.push(cwd);
      writeFileSync(scriptPath, [
        '#!/usr/bin/env bash',
        'echo "tmpdir=/custom/tmpdir"',
        'echo "takt_runtime_tmp=/custom/runtime-tmp"',
      ].join('\n'), 'utf-8');
      chmodSync(scriptPath, 0o755);

      const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: [scriptPath] });

      expect(result!.injectedEnv.tmpdir).toBe('/custom/tmpdir');
      expect(result!.injectedEnv.takt_runtime_tmp).toBe('/custom/runtime-tmp');
      expect(result!.injectedEnv.TMPDIR).not.toBe('/custom/tmpdir');
      expect(result!.injectedEnv.TAKT_RUNTIME_TMP).toBe(result!.injectedEnv.TMPDIR);
    },
  );

  it('should preserve __proto__ from custom prepare output as an environment variable', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    const scriptPath = join(cwd, 'prepare-prototype-key.sh');
    writeFileSync(scriptPath, 'echo "__proto__=visible"\n', 'utf-8');
    chmodSync(scriptPath, 0o755);

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: [scriptPath] });

    expect(Object.hasOwn(result!.injectedEnv, '__proto__')).toBe(true);
    expect(result!.injectedEnv.__proto__).toBe('visible');
    expect(process.env.__proto__).toBe('visible');
  });

  it('should reject invalid environment variable names from custom prepare output', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    const initial = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });
    const scriptPath = join(cwd, 'prepare-invalid-env-key.sh');

    expect(initial).toBeDefined();
    for (const output of ['BAD KEY=value', '=value']) {
      writeFileSync(scriptPath, `echo "${output}"\n`, 'utf-8');
      chmodSync(scriptPath, 0o755);
      expect(() => prepareRuntimeEnvironmentForTest(cwd, { prepare: [scriptPath] }))
        .toThrow(/invalid environment variable name/i);
    }
  });

  it('should preserve custom JAVA_TOOL_OPTIONS before and after the Gradle preset', () => {
    const scriptPath = 'prepare-java-options.sh';

    for (const prepare of [[scriptPath, 'gradle'], ['gradle', scriptPath]]) {
      const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
      tempDirs.push(cwd);
      const resolvedScriptPath = join(cwd, scriptPath);
      writeFileSync(resolvedScriptPath, 'echo "JAVA_TOOL_OPTIONS=-Xmx2g"\n', 'utf-8');
      chmodSync(resolvedScriptPath, 0o755);

      const result = prepareRuntimeEnvironmentForTest(cwd, { prepare });

      expect(result!.injectedEnv.JAVA_TOOL_OPTIONS).toBe(
        `-Xmx2g -Djava.io.tmpdir=${result!.injectedEnv.TMPDIR}`,
      );
    }
  });

  it('should preserve GLAB_CONFIG_DIR when already set in environment', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const customGlabDir = '/custom/glab/config';
    process.env['GLAB_CONFIG_DIR'] = customGlabDir;

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.GLAB_CONFIG_DIR).toBe(customGlabDir);
  });

  it.skipIf(process.platform !== 'darwin')(
    'should use macOS Application Support path when it exists',
    () => {
      const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
      tempDirs.push(cwd);
      const fakeHome = mkdtempSync(join(systemTmpDir, 'takt-fake-home-'));
      tempDirs.push(fakeHome);

      delete process.env['GLAB_CONFIG_DIR'];
      process.env['HOME'] = fakeHome;
      delete process.env['XDG_CONFIG_HOME'];

      const macOsGlabDir = join(fakeHome, 'Library', 'Application Support', 'glab-cli');
      mkdirSync(macOsGlabDir, { recursive: true });

      const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

      expect(result).toBeDefined();
      expect(result?.injectedEnv.GLAB_CONFIG_DIR).toBe(macOsGlabDir);
    },
  );

  it('should use XDG_CONFIG_HOME/glab-cli when it exists', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    const fakeHome = mkdtempSync(join(systemTmpDir, 'takt-fake-home-'));
    tempDirs.push(fakeHome);
    const fakeXdgConfig = mkdtempSync(join(systemTmpDir, 'takt-xdg-config-'));
    tempDirs.push(fakeXdgConfig);

    delete process.env['GLAB_CONFIG_DIR'];
    process.env['HOME'] = fakeHome;
    process.env['XDG_CONFIG_HOME'] = fakeXdgConfig;

    const glabDir = join(fakeXdgConfig, 'glab-cli');
    mkdirSync(glabDir, { recursive: true });

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.GLAB_CONFIG_DIR).toBe(glabDir);
  });

  it('should fallback to ~/.config/glab-cli when no other glab config exists', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    const fakeHome = mkdtempSync(join(systemTmpDir, 'takt-fake-home-'));
    tempDirs.push(fakeHome);

    delete process.env['GLAB_CONFIG_DIR'];
    delete process.env['XDG_CONFIG_HOME'];
    process.env['HOME'] = fakeHome;

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.GLAB_CONFIG_DIR).toBe(join(fakeHome, '.config', 'glab-cli'));
  });

  it('should respect XDG_CONFIG_HOME in fallback when glab-cli dir does not exist', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    const fakeHome = mkdtempSync(join(systemTmpDir, 'takt-fake-home-'));
    tempDirs.push(fakeHome);
    const fakeXdgConfig = mkdtempSync(join(systemTmpDir, 'takt-xdg-config-'));
    tempDirs.push(fakeXdgConfig);

    delete process.env['GLAB_CONFIG_DIR'];
    process.env['HOME'] = fakeHome;
    process.env['XDG_CONFIG_HOME'] = fakeXdgConfig;

    // glab-cli dir does NOT exist under XDG_CONFIG_HOME — fallback should still use XDG_CONFIG_HOME
    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.GLAB_CONFIG_DIR).toBe(join(fakeXdgConfig, 'glab-cli'));
  });

  it('should include GLAB_CONFIG_DIR in env.sh output', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const customGlabDir = '/custom/glab/config';
    process.env['GLAB_CONFIG_DIR'] = customGlabDir;

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    const envContent = readFileSync(result!.envFile, 'utf-8');
    expect(envContent).toContain('export GLAB_CONFIG_DIR=');
    expect(envContent).toContain(customGlabDir);
  });

  it.skipIf(process.platform !== 'darwin')(
    'should prefer macOS Application Support over XDG_CONFIG_HOME for glab',
    () => {
      const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
      tempDirs.push(cwd);
      const fakeHome = mkdtempSync(join(systemTmpDir, 'takt-fake-home-'));
      tempDirs.push(fakeHome);
      const fakeXdgConfig = mkdtempSync(join(systemTmpDir, 'takt-xdg-config-'));
      tempDirs.push(fakeXdgConfig);

      delete process.env['GLAB_CONFIG_DIR'];
      process.env['HOME'] = fakeHome;
      process.env['XDG_CONFIG_HOME'] = fakeXdgConfig;

      // Both paths exist
      const macOsGlabDir = join(fakeHome, 'Library', 'Application Support', 'glab-cli');
      mkdirSync(macOsGlabDir, { recursive: true });
      const xdgGlabDir = join(fakeXdgConfig, 'glab-cli');
      mkdirSync(xdgGlabDir, { recursive: true });

      const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

      expect(result).toBeDefined();
      expect(result?.injectedEnv.GLAB_CONFIG_DIR).toBe(macOsGlabDir);
    },
  );

  it('should prefer GLAB_CONFIG_DIR env over all other glab config paths', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    const fakeXdgConfig = mkdtempSync(join(systemTmpDir, 'takt-xdg-config-'));
    tempDirs.push(fakeXdgConfig);

    const explicitDir = '/explicit/glab/config';
    process.env['GLAB_CONFIG_DIR'] = explicitDir;
    process.env['XDG_CONFIG_HOME'] = fakeXdgConfig;

    // XDG path also exists, but env var should take precedence
    const xdgGlabDir = join(fakeXdgConfig, 'glab-cli');
    mkdirSync(xdgGlabDir, { recursive: true });

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.GLAB_CONFIG_DIR).toBe(explicitDir);
  });

  it('should preserve CURSOR_CONFIG_DIR when already set in environment', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const customCursorDir = '/custom/cursor/config';
    process.env['CURSOR_CONFIG_DIR'] = customCursorDir;

    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.CURSOR_CONFIG_DIR).toBe(customCursorDir);
  });

  it('should use XDG_CONFIG_HOME/cursor when CURSOR_CONFIG_DIR is unset', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    const fakeHome = mkdtempSync(join(systemTmpDir, 'takt-fake-home-'));
    tempDirs.push(fakeHome);
    const fakeXdgConfig = mkdtempSync(join(systemTmpDir, 'takt-xdg-config-'));
    tempDirs.push(fakeXdgConfig);

    delete process.env['CURSOR_CONFIG_DIR'];
    process.env['HOME'] = fakeHome;
    process.env['XDG_CONFIG_HOME'] = fakeXdgConfig;

    const runtimeConfigDir = join(cwd, '.takt', '.runtime', 'config');
    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.XDG_CONFIG_HOME).toBe(runtimeConfigDir);
    expect(result?.injectedEnv.CURSOR_CONFIG_DIR).toBe(join(fakeXdgConfig, 'cursor'));
    expect(result?.injectedEnv.CURSOR_CONFIG_DIR).not.toBe(join(runtimeConfigDir, 'cursor'));
  });

  it('should fallback to ~/.cursor when CURSOR_CONFIG_DIR and XDG_CONFIG_HOME are unset', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);
    const fakeHome = mkdtempSync(join(systemTmpDir, 'takt-fake-home-'));
    tempDirs.push(fakeHome);

    delete process.env['CURSOR_CONFIG_DIR'];
    delete process.env['XDG_CONFIG_HOME'];
    process.env['HOME'] = fakeHome;

    const runtimeConfigDir = join(cwd, '.takt', '.runtime', 'config');
    const result = prepareRuntimeEnvironmentForTest(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.XDG_CONFIG_HOME).toBe(runtimeConfigDir);
    expect(result?.injectedEnv.CURSOR_CONFIG_DIR).toBe(join(fakeHome, '.cursor'));
    expect(result?.injectedEnv.CURSOR_CONFIG_DIR).not.toBe(join(fakeHome, '.config', 'cursor'));
    expect(result?.injectedEnv.CURSOR_CONFIG_DIR).not.toBe(join(runtimeConfigDir, 'cursor'));
  });

});

describe('resolveRuntimeConfig', () => {
  it('should use workflow runtime when both global and workflow values are defined', () => {
    const resolved = resolveRuntimeConfig(
      { prepare: ['gradle', 'node'] },
      { prepare: ['node', 'pnpm'] },
    );
    expect(resolved).toEqual({ prepare: ['node', 'pnpm'] });
  });

  it('should fall back to global runtime when workflow runtime is missing', () => {
    const resolved = resolveRuntimeConfig(
      { prepare: ['gradle', 'node', 'gradle'] },
      undefined,
    );
    expect(resolved).toEqual({ prepare: ['gradle', 'node'] });
  });
});
