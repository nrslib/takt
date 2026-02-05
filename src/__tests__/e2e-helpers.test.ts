import { describe, it, expect, afterEach } from 'vitest';
import { injectProviderArgs } from '../../e2e/helpers/takt-runner.js';
import { createIsolatedEnv } from '../../e2e/helpers/isolated-env.js';

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
});
