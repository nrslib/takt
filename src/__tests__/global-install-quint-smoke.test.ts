import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execute, resolveCli, installedRequire, writeFile, remove } = vi.hoisted(() => ({
  execute: vi.fn(), resolveCli: vi.fn(), installedRequire: vi.fn(), writeFile: vi.fn(), remove: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: execute }));
vi.mock('node:module', () => ({ createRequire: installedRequire }));
vi.mock('node:fs', () => ({
  realpathSync: (path: string) => path,
  mkdtempSync: () => '/isolated/quint-smoke',
  mkdirSync: vi.fn(),
  writeFileSync: writeFile,
  readFileSync: () => JSON.stringify({ name: 'takt', version: '0.72.0' }),
  existsSync: () => true,
  rmSync: remove,
}));

class ScriptExit extends Error {
  constructor(readonly status: number) { super(`exit ${status}`); }
}

describe('installed Quint smoke', () => {
  const packageRoot = '/isolated/global/lib/node_modules/takt';
  const cli = join(packageRoot, 'node_modules/@informalsystems/quint/dist/src/cli.js');
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  let failure: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    failure = undefined;
    process.argv = [process.execPath, fileURLToPath(new URL('../../scripts/global-install-quint-smoke.mjs', import.meta.url)), packageRoot];
    process.exitCode = undefined;
    installedRequire.mockReturnValue(Object.assign(vi.fn(), { resolve: resolveCli }));
    resolveCli.mockReturnValue(cli);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process, 'exit').mockImplementation((code) => { throw new ScriptExit(Number(code ?? 0)); });
    execute.mockImplementation((_command: string, args: string[]) => {
      if (failure && args.includes(failure)) {
        throw Object.assign(new Error('isFullwidthCodePoint is not a function'), { status: 1, stdout: '', stderr: 'isFullwidthCodePoint is not a function' });
      }
      return args.includes('--version') ? 'openjdk 17.0.1' : 'ok\n';
    });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  async function runSmoke(): Promise<unknown> {
    const modulePath = '../../scripts/global-install-quint-smoke.mjs';
    try {
      await import(modulePath);
      return process.exitCode;
    } catch (error) {
      if (error instanceof ScriptExit) return error.status;
      return error;
    }
  }

  it('should run a bounded specification using the Quint resolved from the installed CLI', async () => {
    const result = await runSmoke();

    expect(result === undefined || result === 0, String(result)).toBe(true);
    const base = installedRequire.mock.calls[0]?.[0];
    const basePath = String(base).startsWith('file:') ? fileURLToPath(base) : String(base);
    expect(relative(packageRoot, basePath).startsWith('..')).toBe(false);
    expect(isAbsolute(relative(packageRoot, basePath))).toBe(false);
    expect(resolveCli).toHaveBeenCalledWith('@informalsystems/quint/dist/src/cli.js');
    const call = execute.mock.calls.find((entry) => (entry[1] as string[]).includes('run'));
    expect(call).toBeDefined();
    expect(call?.[0]).toBe(process.execPath);
    expect(call?.[1]).toEqual(expect.arrayContaining([cli, '--backend', 'typescript', '--max-samples', '--max-steps']));
    const args = call?.[1] as string[];
    for (const option of ['--max-samples', '--max-steps']) {
      expect(Number(args[args.indexOf(option) + 1])).toBeGreaterThan(0);
      expect(Number(args[args.indexOf(option) + 1])).toBeLessThanOrEqual(20);
    }
    const specification = args.find((arg) => arg.endsWith('.qnt'));
    expect(writeFile.mock.calls.some((entry) => entry[0] === specification && /action init/.test(String(entry[1])) && /action step/.test(String(entry[1])))).toBe(true);
    expect(call?.[2]?.timeout).toBeGreaterThan(0);
    expect(Number.isFinite(call?.[2]?.timeout)).toBe(true);
  });

  it('should invoke model verification with the installed Quint CLI', async () => {
    await runSmoke();

    const call = execute.mock.calls.find((entry) => (entry[1] as string[]).includes('verify'));
    expect(call?.[0]).toBe(process.execPath);
    expect(call?.[1]).toEqual(expect.arrayContaining([cli, 'verify', '--max-steps']));
    expect(call?.[1]).not.toContain('--help');
    expect(call?.[2]?.timeout).toBeGreaterThan(0);
    expect(Number.isFinite(call?.[2]?.timeout)).toBe(true);
  });

  it.each(['run', 'verify'])('should fail the smoke when %s fails while observing both commands', async (command) => {
    failure = command;
    const result = await runSmoke();

    expect(result).not.toBeUndefined();
    expect(result).not.toBe(0);
    expect(execute.mock.calls.filter((entry) => (entry[1] as string[]).includes('run'))).toHaveLength(1);
    expect(execute.mock.calls.filter((entry) => (entry[1] as string[]).includes('verify'))).toHaveLength(1);
  });

  it('should fail instead of skipping verification when Java is unavailable', async () => {
    execute.mockImplementation((command: string, args: string[]) => {
      if (command === 'java') throw Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT' });
      if (args.includes('verify')) {
        throw Object.assign(new Error('Java was not found'), { status: 1, stdout: '', stderr: 'Java was not found' });
      }
      return 'ok\n';
    });

    const result = await runSmoke();

    expect(execute).toHaveBeenCalled();
    expect(result).not.toBeUndefined();
    expect(result).not.toBe(0);
  });

  it.each([
    '/outside/node_modules/@informalsystems/quint/dist/src/cli.js',
    `${packageRoot}-other/node_modules/@informalsystems/quint/dist/src/cli.js`,
  ])('should reject a Quint resolved outside the installed package: %s', async (outside) => {
    resolveCli.mockReturnValue(outside);
    const result = await runSmoke();

    expect(resolveCli).toHaveBeenCalled();
    expect(result).not.toBeUndefined();
    expect(result).not.toBe(0);
    expect(execute.mock.calls.some((entry) => (entry[1] as string[]).includes(outside))).toBe(false);
  });
});
