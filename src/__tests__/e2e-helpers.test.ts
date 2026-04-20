import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { injectProviderArgs } from '../../e2e/helpers/takt-runner.js';
import { cleanupChildProcess, cleanupTestResource, waitForClose } from '../../e2e/helpers/wait.js';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
} from '../../e2e/helpers/isolated-env.js';

describe('injectProviderArgs', () => {
  it('should prepend --provider when provider is specified', () => {
    const result = injectProviderArgs(['run', '--pipeline'], 'codex');
    expect(result).toEqual(['--provider', 'codex', 'run', '--pipeline']);
  });

  it('should not prepend --provider when args already contain --provider', () => {
    const result = injectProviderArgs(
      ['--provider', 'claude', 'run', '--pipeline'],
      'codex',
    );
    expect(result).toEqual(['--provider', 'claude', 'run', '--pipeline']);
  });

  it('should return a copy of args when provider is undefined', () => {
    const result = injectProviderArgs(['run', '--pipeline'], undefined);
    expect(result).toEqual(['run', '--pipeline']);
  });

  it('should return a copy of args when provider is empty string', () => {
    const result = injectProviderArgs(['run', '--pipeline'], '');
    expect(result).toEqual(['run', '--pipeline']);
  });
});

describe('createIsolatedEnv', () => {
  const originalEnv = process.env;
  let cleanups: Array<() => void> = [];

  afterEach(() => {
    process.env = originalEnv;
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups = [];
  });

  it('should inherit TAKT_OPENAI_API_KEY from process.env', () => {
    process.env = { ...originalEnv, TAKT_OPENAI_API_KEY: 'test-key-123' };
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    expect(isolated.env.TAKT_OPENAI_API_KEY).toBe('test-key-123');
  });

  it('should not include TAKT_OPENAI_API_KEY when not in process.env', () => {
    process.env = { ...originalEnv };
    delete process.env.TAKT_OPENAI_API_KEY;
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    expect(isolated.env.TAKT_OPENAI_API_KEY).toBeUndefined();
  });

  it('should override TAKT_CONFIG_DIR with isolated directory', () => {
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    expect(isolated.env.TAKT_CONFIG_DIR).toBe(isolated.taktDir);
  });

  it('should set GIT_CONFIG_GLOBAL to isolated path', () => {
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    expect(isolated.env.GIT_CONFIG_GLOBAL).toBeDefined();
    expect(isolated.env.GIT_CONFIG_GLOBAL).toContain('takt-e2e-');
  });

  it('should create config.yaml from E2E fixture with notification_sound disabled', () => {
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    const configRaw = readFileSync(`${isolated.taktDir}/config.yaml`, 'utf-8');
    const config = parseYaml(configRaw) as Record<string, unknown>;

    expect(config.language).toBe('en');
    expect((config.logging as Record<string, unknown>)?.level).toBe('info');
    expect(config.notification_sound).toBe(false);
    expect(config.notification_sound_events).toEqual({
      iteration_limit: false,
      workflow_complete: false,
      workflow_abort: false,
      run_complete: true,
      run_abort: false,
    });
    expect(config.provider_options).toEqual({
      codex: { network_access: true },
      opencode: { network_access: true },
    });
  });

  it('should override provider in config.yaml when TAKT_E2E_PROVIDER is set', () => {
    process.env = { ...originalEnv, TAKT_E2E_PROVIDER: 'mock' };
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    const configRaw = readFileSync(`${isolated.taktDir}/config.yaml`, 'utf-8');
    const config = parseYaml(configRaw) as Record<string, unknown>;
    expect(config.provider).toBe('mock');
  });

  it('should preserve base settings when updateIsolatedConfig applies patch', () => {
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    updateIsolatedConfig(isolated.taktDir, {
      provider: 'mock',
      concurrency: 2,
    });

    const configRaw = readFileSync(`${isolated.taktDir}/config.yaml`, 'utf-8');
    const config = parseYaml(configRaw) as Record<string, unknown>;

    expect(config.provider).toBe('mock');
    expect(config.concurrency).toBe(2);
    expect(config.notification_sound).toBe(false);
    expect(config.notification_sound_events).toEqual({
      iteration_limit: false,
      workflow_complete: false,
      workflow_abort: false,
      run_complete: true,
      run_abort: false,
    });
    expect(config.language).toBe('en');
  });

  it('should deep-merge notification_sound_events patch and preserve unspecified keys', () => {
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    updateIsolatedConfig(isolated.taktDir, {
      notification_sound_events: {
        run_complete: false,
      },
    });

    const configRaw = readFileSync(`${isolated.taktDir}/config.yaml`, 'utf-8');
    const config = parseYaml(configRaw) as Record<string, unknown>;

    expect(config.notification_sound_events).toEqual({
      iteration_limit: false,
      workflow_complete: false,
      workflow_abort: false,
      run_complete: false,
      run_abort: false,
    });
  });

  it('should throw when patch.notification_sound_events is not an object', () => {
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    expect(() => {
      updateIsolatedConfig(isolated.taktDir, {
        notification_sound_events: true,
      });
    }).toThrow('Invalid notification_sound_events in patch: expected object');
  });

  it('should throw when current config notification_sound_events is invalid', () => {
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    writeFileSync(
      `${isolated.taktDir}/config.yaml`,
      [
        'language: en',
        'logging:',
        '  level: info',
        'notification_sound: true',
        'notification_sound_events: true',
      ].join('\n'),
    );

    expect(() => {
      updateIsolatedConfig(isolated.taktDir, { provider: 'mock' });
    }).toThrow('Invalid notification_sound_events in current config: expected object');
  });
});

describe('wait helper child process cleanup', () => {
  it('should resolve immediately when waitForClose is called after the child already exited', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });

    await new Promise<void>((resolvePromise) => {
      child.once('close', () => resolvePromise());
    });

    const startedAt = Date.now();
    const result = await waitForClose(child, 1_000);

    expect(result).toEqual({ code: 0, signal: null });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('should terminate a running child in cleanupChildProcess', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1_000);'], {
      stdio: 'ignore',
    });

    await cleanupChildProcess(child, 1_000);

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('should reject when cleanupChildProcess cannot signal a running child', async () => {
    const child = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        throw new Error('kill failed');
      }),
    } as unknown as ReturnType<typeof spawn>;

    await expect(cleanupChildProcess(child, 1_000)).rejects.toThrow('kill failed');
  });

  it('should rethrow cleanup errors with the resource label', () => {
    expect(() => {
      cleanupTestResource('testRepo', () => {
        throw new Error('boom');
      });
    }).toThrow('testRepo cleanup failed: boom');
  });
});
