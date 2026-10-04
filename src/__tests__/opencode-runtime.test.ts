import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCodeRuntimeSelection, resolveOpenCodeRuntime } from '../infra/opencode/runtime.js';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function version(stdout: string, error: Error | null = null): void {
  execFile.mockImplementation((_command, _args, _options, callback) => callback(error, stdout));
}

describe('OpenCode runtime compatibility', () => {
  it('keeps v1 as the default and checks its CLI before starting a server', async () => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', undefined);
    vi.stubEnv('TAKT_OPENCODE_PATH', undefined);
    version('1.18.2\n');
    await expect(resolveOpenCodeRuntime()).resolves.toEqual({ generation: 'v1', command: 'opencode', version: '1.18.2' });
  });

  it('accepts the official v2 version prefix and selected binary', async () => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', 'v2');
    vi.stubEnv('TAKT_OPENCODE_PATH', '/isolated/opencode');
    version('opencode v2.0.18\n');
    await expect(resolveOpenCodeRuntime()).resolves.toEqual({ generation: 'v2', command: '/isolated/opencode', version: 'opencode v2.0.18' });
    expect(execFile).toHaveBeenCalledWith('/isolated/opencode', ['--version'], expect.objectContaining({ timeout: 10_000 }), expect.any(Function));
  });

  it.each([['v1', 'opencode v2.0.18'], ['v2', '1.18.2'], ['v2', 'unrecognized']])('rejects %s transport with CLI %s', async (generation, cli) => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', generation);
    version(cli);
    await expect(resolveOpenCodeRuntime()).rejects.toThrow('incompatible');
  });

  it('reports a missing or unresponsive executable', async () => {
    version('', new Error('ENOENT'));
    await expect(resolveOpenCodeRuntime()).rejects.toThrow('TAKT_OPENCODE_PATH');
  });

  it('rejects invalid selection before invoking the CLI', () => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', 'v3');
    expect(openCodeRuntimeSelection).toThrow('v1 or v2');
    vi.stubEnv('TAKT_OPENCODE_VERSION', 'v2');
    vi.stubEnv('TAKT_OPENCODE_PATH', ' ');
    expect(openCodeRuntimeSelection).toThrow('must not be empty');
    expect(execFile).not.toHaveBeenCalled();
  });
});
