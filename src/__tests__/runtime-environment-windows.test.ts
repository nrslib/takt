import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRuntimeEnvironment } from '../core/runtime/runtime-environment.js';

describe.runIf(process.platform === 'win32')('prepareRuntimeEnvironment on Windows', () => {
  const originalEnv = { ...process.env };
  const cleanupPaths = new Set<string>();

  afterEach(() => {
    let firstError: unknown;
    for (const path of cleanupPaths) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        firstError ??= error;
      }
    }
    cleanupPaths.clear();

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }

    if (firstError !== undefined) throw firstError;
  });

  it('should use one runtime temporary directory for Node and shell tools when preparing a Node runtime', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-runtime-windows-'));
    cleanupPaths.add(cwd);

    const result = prepareRuntimeEnvironment(cwd, { prepare: ['node'] });

    expect(result).toBeDefined();
    const runtimeTmp = result!.injectedEnv.TMPDIR;
    cleanupPaths.add(runtimeTmp);
    expect(result!.injectedEnv.TEMP).toBe(runtimeTmp);
    expect(result!.injectedEnv.TMP).toBe(runtimeTmp);
    expect(process.env.TMPDIR).toBe(runtimeTmp);
    expect(process.env.TEMP).toBe(runtimeTmp);
    expect(process.env.TMP).toBe(runtimeTmp);
    expect(tmpdir()).toBe(runtimeTmp);
    expect(existsSync(runtimeTmp)).toBe(true);

    const envContent = readFileSync(result!.envFile, 'utf-8');
    expect(envContent).toContain(`export TMPDIR='${runtimeTmp}'`);
    expect(envContent).toContain(`export TEMP='${runtimeTmp}'`);
    expect(envContent).toContain(`export TMP='${runtimeTmp}'`);
  });
});
