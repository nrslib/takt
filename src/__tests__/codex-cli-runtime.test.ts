import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCodexSdkCli } from '../infra/codex/cli-runtime.js';

const doubles = vi.hoisted(() => ({ createRequire: vi.fn(), findPackageJSON: vi.fn(), resolve: vi.fn(), stat: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: doubles.createRequire, findPackageJSON: doubles.findPackageJSON }));
vi.mock('node:fs', () => ({ statSync: doubles.stat }));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.createRequire.mockReturnValue({ resolve: doubles.resolve });
  doubles.findPackageJSON.mockImplementation((_specifier: string, base: string | URL) => base instanceof URL
    ? '/loaded/sdk/package.json' : '/local/sdk/package.json');
  doubles.resolve.mockImplementation((specifier: string) => specifier === '@openai/codex/package.json'
    ? '/loaded/codex/package.json' : '/loaded/native/package.json');
  doubles.stat.mockReturnValue({ isFile: () => true, isDirectory: () => true });
});

describe('Codex CLI resolution', () => {
  it('prioritizes an explicit CLI over the managed installation', () => {
    expect(resolveCodexSdkCli('/explicit/codex', '/loaded')).toEqual({ executablePath: '/explicit/codex', pathDirs: [] });
    expect(doubles.createRequire).not.toHaveBeenCalled();
    expect(doubles.stat).not.toHaveBeenCalled();
  });

  it('resolves the CLI from the installation returned by the managed loader', () => {
    const runtime = resolveCodexSdkCli(undefined, '/loaded');
    expect(doubles.createRequire.mock.calls.map(([path]) => path)).toEqual([
      join('/loaded/sdk', 'dist', 'index.js'), '/loaded/codex/package.json',
    ]);
    expect(runtime.executablePath).toContain(join('/loaded/native', 'vendor'));
    expect(runtime.pathDirs).toHaveLength(1);
    expect(doubles.findPackageJSON).toHaveBeenCalledWith('@openai/codex-sdk', pathToFileURL(join('/loaded', 'package.json')));
  });

  it('preserves the existing SDK lookup for callers without a managed directory', () => {
    resolveCodexSdkCli(undefined);
    expect(doubles.findPackageJSON).toHaveBeenCalledWith('@openai/codex-sdk', expect.any(String));
    expect(doubles.createRequire.mock.calls[0]![0]).toBe(join('/local/sdk', 'dist', 'index.js'));
  });
});
