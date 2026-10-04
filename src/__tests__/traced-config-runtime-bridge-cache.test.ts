import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SchemaShape } from 'traced-config';
import {
  clearRuntimeTraceCache,
  loadTraceEntriesViaRuntime,
} from '../infra/config/traced/tracedConfigRuntimeBridge.js';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

const providerSchema: SchemaShape = {
  provider: {
    doc: 'provider',
    format: String,
    env: 'TAKT_PROVIDER',
    sources: { global: false, local: true, env: true, cli: false },
  },
};

let taktEnvSnapshot: TaktEnvSnapshot;

describe('tracedConfigRuntimeBridge memoization cache', () => {
  beforeEach(() => {
    taktEnvSnapshot = clearTaktEnv();
    clearRuntimeTraceCache();
  });

  afterEach(() => {
    restoreTaktEnv(taktEnvSnapshot);
    clearRuntimeTraceCache();
  });

  it('同一入力の再ロードは子プロセスを再起動せず、独立した TracedValue を返す', () => {
    const first = loadTraceEntriesViaRuntime(providerSchema, 'local', { provider: 'codex' });
    expect(first.get('provider')?.value).toBe('codex');

    const firstTraced = first.get('provider');
    if (firstTraced) {
      firstTraced.value = 'mutated';
    }

    const originalTmpDir = process.env.TMPDIR;
    const blockerFile = join(tmpdir(), `takt-traced-cache-blocker-${randomUUID()}`);
    writeFileSync(blockerFile, 'not a directory', 'utf-8');
    process.env.TMPDIR = join(blockerFile, 'nested');

    try {
      const second = loadTraceEntriesViaRuntime(providerSchema, 'local', { provider: 'codex' });
      expect(second.get('provider')?.value).toBe('codex');
      expect(second.get('provider')?.origin).toBe('local');

      clearRuntimeTraceCache();
      expect(() => loadTraceEntriesViaRuntime(providerSchema, 'local', { provider: 'codex' })).toThrow();
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
      rmSync(blockerFile, { force: true });
    }
  });

  it('スキーマが参照する env の変更で必ずキャッシュミスする', () => {
    const first = loadTraceEntriesViaRuntime(providerSchema, 'local', { provider: 'codex' });
    expect(first.get('provider')?.origin).toBe('local');

    process.env.TAKT_PROVIDER = 'claude';

    const second = loadTraceEntriesViaRuntime(providerSchema, 'local', { provider: 'codex' });
    expect(second.get('provider')?.origin).toBe('env');
    expect(second.get('provider')?.value).toBe('claude');

    delete process.env.TAKT_PROVIDER;

    const third = loadTraceEntriesViaRuntime(providerSchema, 'local', { provider: 'codex' });
    expect(third.get('provider')?.origin).toBe('local');
    expect(third.get('provider')?.value).toBe('codex');
  });

  it('config ファイル内容の変更で必ずキャッシュミスする', () => {
    const first = loadTraceEntriesViaRuntime(providerSchema, 'local', { provider: 'codex' });
    expect(first.get('provider')?.value).toBe('codex');

    const second = loadTraceEntriesViaRuntime(providerSchema, 'local', { provider: 'opencode' });
    expect(second.get('provider')?.value).toBe('opencode');

    const third = loadTraceEntriesViaRuntime(providerSchema, 'local', {});
    expect(third.get('provider')?.origin).toBe('default');
  });

  it('fileOrigin の変更で必ずキャッシュミスする', () => {
    const globalSchema: SchemaShape = {
      provider: {
        doc: 'provider',
        format: String,
        env: 'TAKT_PROVIDER',
        sources: { global: true, local: true, env: true, cli: false },
      },
    };

    const local = loadTraceEntriesViaRuntime(globalSchema, 'local', { provider: 'codex' });
    expect(local.get('provider')?.origin).toBe('local');

    const global = loadTraceEntriesViaRuntime(globalSchema, 'global', { provider: 'codex' });
    expect(global.get('provider')?.origin).toBe('global');
  });
});
