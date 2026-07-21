import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRuntimeEnvironment } from '../core/runtime/runtime-environment.js';

describe.runIf(process.platform === 'win32')('prepareRuntimeEnvironment on Windows', () => {
  const originalEnv = {
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  const cleanupPaths = new Set<string>();

  afterEach(() => {
    for (const path of cleanupPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    cleanupPaths.clear();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('should use one runtime temporary directory for Node and shell tools', () => {
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
