import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { injectProviderArgs } from '../../e2e/helpers/takt-runner.js';
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

  it('should create config.yaml from E2E fixture with notification_sound timing controls', () => {
    const isolated = createIsolatedEnv();
    cleanups.push(isolated.cleanup);

    const configRaw = readFileSync(`${isolated.taktDir}/config.yaml`, 'utf-8');
    const config = parseYaml(configRaw) as Record<string, unknown>;

    expect(config.language).toBe('en');
    expect(config.log_level).toBe('info');
    expect(config.default_piece).toBe('default');
    expect(config.notification_sound).toBe(true);
    expect(config.notification_sound_events).toEqual({
      iteration_limit: false,
      piece_complete: false,
      piece_abort: false,
      run_complete: true,
      run_abort: true,
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
    expect(config.notification_sound).toBe(true);
    expect(config.notification_sound_events).toEqual({
      iteration_limit: false,
      piece_complete: false,
      piece_abort: false,
      run_complete: true,
      run_abort: true,
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
      piece_complete: false,
      piece_abort: false,
      run_complete: false,
      run_abort: true,
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
        'log_level: info',
        'default_piece: default',
        'notification_sound: true',
        'notification_sound_events: true',
      ].join('\n'),
    );

    expect(() => {
      updateIsolatedConfig(isolated.taktDir, { provider: 'mock' });
    }).toThrow('Invalid notification_sound_events in current config: expected object');
  });
});
