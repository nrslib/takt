import { afterEach, describe, expect, it, vi } from 'vitest';

describe('tracedConfigRuntimeBridge mock regression', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('caller が node:child_process を mock しても runtime bridge は実ランタイム経路で trace を読める', async () => {
    vi.resetModules();

    const mockedExecFileSync = vi.fn(() => '');
    vi.doMock('node:child_process', () => ({
      execFileSync: mockedExecFileSync,
    }));

    const { loadTraceEntriesViaRuntime } = await import('../infra/config/traced/tracedConfigRuntimeBridge.js');

    const traceEntries = loadTraceEntriesViaRuntime({
      provider: {
        doc: 'provider',
        format: String,
        env: 'TAKT_PROVIDER',
        sources: { global: false, local: true, env: true, cli: false },
      },
    }, 'local', {
      provider: 'codex',
    });

    expect(traceEntries.get('provider')?.origin).toBe('local');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
