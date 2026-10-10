import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ execFile: vi.fn(), resolve: vi.fn(), exists: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: doubles.execFile,
}));
vi.mock('node:module', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:module')>(), createRequire: () => ({ resolve: doubles.resolve }),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(), existsSync: doubles.exists,
}));

import { assertClaudeSdkRuntime } from '../infra/claude/sdk-runtime.js';

describe('Claude SDK runtime preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.resolve.mockReset().mockImplementation((name: string) => name === '@anthropic-ai/claude-agent-sdk' ? '/sdk/sdk.mjs' : '/sdk/claude');
    doubles.exists.mockReset().mockReturnValue(true);
    doubles.execFile.mockReset().mockImplementation((_command, _args, _options, callback) => {
      callback(null, '--tools --strict-mcp-config --json-schema', '');
    });
  });

  it('inspects the SDK bundled native executable when no CLI override is configured', async () => {
    await assertClaudeSdkRuntime({ cwd: '/repo', tools: ['Read'], strictMcpConfig: true });
    expect(doubles.resolve).toHaveBeenCalledWith(expect.stringContaining('@anthropic-ai/claude-agent-sdk-'));
    expect(doubles.execFile).toHaveBeenCalledWith('/sdk/claude', ['--help'], expect.objectContaining({ cwd: '/repo' }), expect.any(Function));
  });

  it('rejects missing optional native packages before launching a process', async () => {
    doubles.resolve.mockImplementation((name: string) => {
      if (name === '@anthropic-ai/claude-agent-sdk') return '/sdk/sdk.mjs';
      throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
    });
    await expect(assertClaudeSdkRuntime({})).rejects.toThrow();
    expect(doubles.execFile).not.toHaveBeenCalled();
  });

  it('runs a configured JavaScript CLI with Node and the resolved environment', async () => {
    await assertClaudeSdkRuntime({ pathToClaudeCodeExecutable: '/custom/cli.mjs', cwd: '/repo', env: { PATH: '/custom/bin' } });
    expect(doubles.resolve).not.toHaveBeenCalled();
    expect(doubles.execFile).toHaveBeenCalledWith(process.execPath, ['/custom/cli.mjs', '--help'], expect.objectContaining({ cwd: '/repo', env: { PATH: '/custom/bin' } }), expect.any(Function));
  });

  it.each(['--tools', '--strict-mcp-config', '--json-schema'])('rejects a CLI missing the required %s option', async (flag) => {
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, ['--tools', '--strict-mcp-config', '--json-schema'].filter((option) => option !== flag).join(' '), '');
    });
    await expect(assertClaudeSdkRuntime({
      pathToClaudeCodeExecutable: '/custom/claude', tools: ['Read'], strictMcpConfig: true,
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    })).rejects.toThrow(flag);
  });

  it('does not require restriction flags for an unrestricted call', async () => {
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => callback(null, 'help', ''));
    await expect(assertClaudeSdkRuntime({ pathToClaudeCodeExecutable: '/custom/claude' })).resolves.toBeUndefined();
  });

  it('propagates a failed help probe', async () => {
    const failure = new Error('cannot execute');
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => callback(failure, '', ''));
    await expect(assertClaudeSdkRuntime({ pathToClaudeCodeExecutable: '/custom/claude' })).rejects.toMatchObject({ cause: failure });
  });

  it('does not launch a help probe when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(assertClaudeSdkRuntime({}, controller.signal)).rejects.toBe(controller.signal.reason);

    expect(doubles.execFile).not.toHaveBeenCalled();
    expect(doubles.resolve).not.toHaveBeenCalled();
  });
});
