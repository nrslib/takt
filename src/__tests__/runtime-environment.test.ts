import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRuntimeEnvironment, resolveRuntimeConfig } from '../core/runtime/runtime-environment.js';

describe('prepareRuntimeEnvironment', () => {
  const tempDirs: string[] = [];
  const systemTmpDir = tmpdir();
  const envKeys = [
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'CI',
    'JAVA_TOOL_OPTIONS',
    'GRADLE_USER_HOME',
    'npm_config_cache',
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('should return undefined when runtime.prepare is not set', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const result = prepareRuntimeEnvironment(cwd, undefined);
    expect(result).toBeUndefined();
  });

  it('should create .runtime files and inject tool-specific env', () => {
    const cwd = mkdtempSync(join(systemTmpDir, 'takt-runtime-env-'));
    tempDirs.push(cwd);

    const result = prepareRuntimeEnvironment(cwd, {
      prepare: ['gradle', 'node'],
    });

    expect(result).toBeDefined();
    expect(result?.prepare).toEqual(['gradle', 'node']);

    const runtimeRoot = join(cwd, '.takt', '.runtime');
    expect(existsSync(runtimeRoot)).toBe(true);
    expect(existsSync(join(runtimeRoot, 'tmp'))).toBe(true);
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
    ].join('\n'), 'utf-8');
    chmodSync(scriptPath, 0o755);

    const result = prepareRuntimeEnvironment(cwd, {
      prepare: [scriptPath],
    });

    expect(result).toBeDefined();
    expect(result?.injectedEnv.CUSTOM_CACHE_DIR).toBe(join(cwd, '.takt', '.runtime', 'custom-cache'));
    expect(existsSync(join(cwd, '.takt', '.runtime', 'custom-cache'))).toBe(true);
  });

});

describe('resolveRuntimeConfig', () => {
  it('should use piece runtime when both global and piece are defined', () => {
    const resolved = resolveRuntimeConfig(
      { prepare: ['gradle', 'node'] },
      { prepare: ['node', 'pnpm'] },
    );
    expect(resolved).toEqual({ prepare: ['node', 'pnpm'] });
  });

  it('should fallback to global runtime when piece runtime is missing', () => {
    const resolved = resolveRuntimeConfig(
      { prepare: ['gradle', 'node', 'gradle'] },
      undefined,
    );
    expect(resolved).toEqual({ prepare: ['gradle', 'node'] });
  });
});
