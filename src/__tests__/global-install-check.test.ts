import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execute, listDirectory, readFile, writeFile, remove } = vi.hoisted(() => ({
  execute: vi.fn(), listDirectory: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), remove: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFileSync: execute,
  spawnSync: (...args: unknown[]) => {
    try {
      return { status: 0, stdout: execute(...args), stderr: '' };
    } catch (error) {
      const failure = error as Error & { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', error: failure.status === undefined ? failure : undefined };
    }
  },
}));
vi.mock('node:fs', () => ({
  mkdtempSync: () => '/isolated/global-check',
  readdirSync: listDirectory,
  readFileSync: readFile,
  writeFileSync: writeFile,
  appendFileSync: writeFile,
  mkdirSync: vi.fn(),
  existsSync: () => true,
  realpathSync: (path: string) => path,
  cpSync: vi.fn(),
  rmSync: remove,
}));

interface Installation { npm: string; prefix: string; target: string }
class ScriptExit extends Error {
  constructor(readonly status: number) { super(`exit ${status}`); }
}

describe('global installation gate', () => {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const script = fileURLToPath(new URL('../../scripts/global-install-check.mjs', import.meta.url));
  let installations: Installation[];
  let diagnostics: string;
  let dependencyFailure: boolean;
  let quintFailure: boolean;
  let emptyDirectories: boolean;
  let resetPrefixes: string[];
  let failedTarget: string | undefined;
  let manifestFailure: 'missing' | 'mismatch' | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    process.argv = [process.execPath, script];
    process.exitCode = undefined;
    installations = [];
    diagnostics = '';
    dependencyFailure = false;
    quintFailure = false;
    emptyDirectories = false;
    resetPrefixes = [];
    failedTarget = undefined;
    manifestFailure = undefined;
    remove.mockImplementation((path: string) => {
      for (const entry of installations.filter((install) => install.target.startsWith('takt@'))) {
        if (entry.prefix.startsWith(`${path}/`) || entry.prefix === path) {
          const overwritten = installations.some((install) => install.prefix === entry.prefix && install.target.endsWith('.tgz'));
          if (!overwritten) resetPrefixes.push(entry.prefix);
        }
      }
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { diagnostics += String(chunk); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { diagnostics += String(chunk); return true; });
    vi.spyOn(process, 'exit').mockImplementation((code) => { throw new ScriptExit(Number(code ?? 0)); });
    listDirectory.mockImplementation((path: string, options?: { withFileTypes?: boolean }) => {
      if (!options?.withFileTypes) return ['takt-fixed.tgz'];
      if (emptyDirectories) {
        const directory = (name: string) => ({ name, isDirectory: () => true });
        if (/\/(?:string-width|emoji-regex)$/.test(path)) return [];
        if (/\/(?:wrap-ansi|widest-line)\/node_modules$/.test(path)) return ['string-width', 'emoji-regex'].map(directory);
        if (/\/(?:wrap-ansi|widest-line)$/.test(path)) return [directory('node_modules')];
        return ['wrap-ansi', 'widest-line'].map(directory);
      }
      return [{ name: 'package.json', isDirectory: () => false }];
    });
    readFile.mockImplementation((path: string) => {
      const target = [...installations].reverse().find((entry) => String(path).startsWith(entry.prefix))?.target;
      if (manifestFailure === 'missing' && target?.startsWith('takt@')) throw new Error('ENOENT: package.json');
      const version = manifestFailure === 'mismatch' && target?.startsWith('takt@')
        ? '0.70.0'
        : target?.startsWith('takt@') ? target.slice('takt@'.length) : '0.72.0';
      return JSON.stringify({ name: 'takt', version });
    });
    execute.mockImplementation((command: string, args: string[]) => {
      if (args.includes('view')) return '0.71.0\n';
      if (args.includes('uninstall') || args.includes('dedupe')) throw new Error('Unexpected package repair');
      if (args.includes('install')) {
        const prefix = args[args.indexOf('--prefix') + 1];
        const npm = args.find((arg) => /^npm@/.test(arg));
        const target = args.find((arg) => arg.endsWith('.tgz') || arg.startsWith('takt@'));
        if (!prefix || !npm || !target) throw new Error('Installation must identify npm, prefix and target');
        installations.push({ npm, prefix, target });
        if (target === failedTarget) throw Object.assign(new Error('Installation failed'), { status: 1 });
      }
      if (args.includes('ls') && dependencyFailure) {
        throw Object.assign(new Error('ELSPROBLEMS'), { status: 1, stdout: '{"problems":["invalid"]}', stderr: 'ELSPROBLEMS' });
      }
      if (args.some((arg) => arg.endsWith('global-install-quint-smoke.mjs')) && quintFailure) {
        throw Object.assign(new Error('Quint execution failed'), { status: 1, stdout: '', stderr: 'isFullwidthCodePoint is not a function' });
      }
      return command === 'npm' && args.includes('pack') ? 'takt-fixed.tgz\n' : '{}\n';
    });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  async function runGate(): Promise<unknown> {
    const modulePath = '../../scripts/global-install-check.mjs';
    try {
      await import(modulePath);
      return process.exitCode;
    } catch (error) {
      if (error instanceof ScriptExit) return error.status;
      diagnostics += String(error);
      return error;
    }
  }

  function callsWith(argument: string): string[][] {
    return execute.mock.calls.map((call) => call[1] as string[]).filter((args) => args.includes(argument));
  }

  it('should test fresh and continuous overwrite installations with npm 10, 11 and 12', async () => {
    const result = await runGate();

    expect(result === undefined || result === 0, String(result)).toBe(true);
    expect(resetPrefixes).toEqual([]);
    for (const npm of ['npm@10.9.4', 'npm@11.16.0', 'npm@12.2.0']) {
      const installs = installations.filter((entry) => entry.npm === npm);
      const prefixes = [...new Set(installs.map((entry) => entry.prefix))];
      expect(prefixes).toHaveLength(2);
      const routes = prefixes.map((prefix) => installs.filter((entry) => entry.prefix === prefix).map((entry) => entry.target));
      expect(routes).toEqual(expect.arrayContaining([
        [expect.stringMatching(/\.tgz$/)],
        ['takt@0.71.0', expect.stringMatching(/\.tgz$/)],
      ]));
    }
    expect(callsWith('view')).toHaveLength(1);
    const smokeCalls = execute.mock.calls.filter((call) => (call[1] as string[]).some((arg) => arg.endsWith('global-install-smoke.mjs')));
    expect(smokeCalls).toHaveLength(6);
    for (const entry of installations.filter((install) => install.target.endsWith('.tgz'))) {
      expect(smokeCalls.some((call) => (call[1] as string[]).includes(join(entry.prefix, 'lib/node_modules/takt')))).toBe(true);
    }
  });

  it('should inspect every installed dependency with the installing npm and prefix', async () => {
    await runGate();

    const inspections = callsWith('ls');
    expect(inspections).toHaveLength(6);
    for (const { npm, prefix } of installations.filter((entry) => entry.target.endsWith('.tgz'))) {
      const inspection = inspections.find((args) => args.includes(npm) && args.includes(prefix));
      expect(inspection).toEqual(expect.arrayContaining(['--global', '--prefix', prefix, '--all', '--json']));
      expect(inspection).not.toContain('--package-lock-only');
      expect(inspection?.some((arg) => arg.startsWith('--depth'))).toBe(false);
      const argumentsAfterLs = inspection!.slice(inspection!.indexOf('ls') + 1);
      const positionalArguments = argumentsAfterLs.filter((arg, index) => !arg.startsWith('-')
        && !['--prefix', '--cache'].includes(argumentsAfterLs[index - 1] ?? ''));
      expect(positionalArguments).toEqual([]);
    }
  });

  it('should prepare the requested history on the same overwrite prefix before the latest version and tarball', async () => {
    process.argv.push('--history-version', '0.69.1', '--npm-versions', '12.2.0');
    const result = await runGate();

    expect(result === undefined || result === 0, String(result)).toBe(true);
    const overwrite = installations.filter((entry) => entry.prefix.endsWith('-overwrite'));
    expect(overwrite.map((entry) => entry.target)).toEqual(['takt@0.69.1', 'takt@0.71.0', expect.stringMatching(/\.tgz$/)]);
    expect(new Set(overwrite.map((entry) => entry.prefix)).size).toBe(1);
    expect(installations.filter((entry) => entry.prefix.endsWith('-fresh')).map((entry) => entry.target))
      .toEqual([expect.stringMatching(/\.tgz$/)]);
    expect(resetPrefixes).toEqual([]);
    for (const [stage, version] of [['history', '0.69.1'], ['initial', '0.71.0']]) {
      const manifest = writeFile.mock.calls.find(([path]) => String(path).endsWith(`overwrite-${stage}-manifest.json`));
      expect(JSON.parse(manifest![1] as string).version).toBe(version);
    }
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('/isolated/global-check', { recursive: true, force: true });
  });

  it.each(['takt@0.69.1', 'takt@0.71.0'])('should stop the overwrite preparation when %s fails', async (target) => {
    process.argv.push('--history-version', '0.69.1', '--npm-versions', '12.2.0', '--route', 'overwrite');
    failedTarget = target;
    const result = await runGate();

    expect(result).toBe(1);
    expect(installations.map((entry) => entry.target)).toEqual(target === 'takt@0.69.1'
      ? ['takt@0.69.1'] : ['takt@0.69.1', 'takt@0.71.0']);
    expect(callsWith('ls')).toEqual([]);
    expect(remove).toHaveBeenCalledWith('/isolated/global-check', { recursive: true, force: true });
  });

  it('should stop a default overwrite after its starting installation fails', async () => {
    process.argv.push('--npm-versions', '12.2.0', '--route', 'overwrite');
    failedTarget = 'takt@0.71.0';
    expect(await runGate()).toBe(1);
    expect(installations.map((entry) => entry.target)).toEqual(['takt@0.71.0']);
  });

  it.each([
    { failure: 'missing', detail: 'ENOENT: package.json' },
    { failure: 'mismatch', detail: 'installed 0.70.0, expected 0.71.0' },
  ] as const)('should record a published manifest $failure and continue with the next npm version', async ({ failure, detail }) => {
    manifestFailure = failure;
    process.argv.push('--npm-versions', '10.9.4,11.16.0', '--route', 'overwrite');

    expect(await runGate()).toBe(1);
    expect(installations.map((entry) => entry.npm)).toEqual(['npm@10.9.4', 'npm@11.16.0']);
    expect(diagnostics).toContain('npm-10.9.4-overwrite-initial (takt@0.71.0)');
    expect(diagnostics).toContain(detail);
  });

  it('should report the requested history version and overwrite stage when its manifest mismatches', async () => {
    manifestFailure = 'mismatch';
    process.argv.push('--history-version', '0.69.1', '--npm-versions', '12.2.0', '--route', 'overwrite');

    expect(await runGate()).toBe(1);
    expect(installations.map((entry) => entry.target)).toEqual(['takt@0.69.1']);
    expect(diagnostics).toContain('npm-12.2.0-overwrite-history (takt@0.69.1)');
    expect(diagnostics).toContain('installed 0.70.0, expected 0.69.1');
  });

  it('should validate the history version before installing packages', async () => {
    process.argv.push('--history-version', 'latest');
    expect(await runGate()).toBeInstanceOf(Error);
    expect(installations).toEqual([]);
  });

  it('should install the supplied published tarball without packing the checkout', async () => {
    process.argv.push('--tarball', '/release/takt-requested.tgz', '--npm-versions', '11.16.0');
    const result = await runGate();
    expect(result === undefined || result === 0, String(result)).toBe(true);
    expect(callsWith('pack')).toEqual([]);
    expect(installations.filter((entry) => entry.target.endsWith('.tgz')).map((entry) => entry.target))
      .toEqual(['/release/takt-requested.tgz', '/release/takt-requested.tgz']);
  });

  it.each([
    { ls: false, quint: false },
    { ls: true, quint: false },
    { ls: false, quint: true },
    { ls: true, quint: true },
  ])('should retain independent check results when dependency failure=$ls and Quint failure=$quint', async ({ ls, quint }) => {
    dependencyFailure = ls;
    quintFailure = quint;
    const result = await runGate();

    const completed = installations.filter((entry) => entry.target.endsWith('.tgz'));
    expect(completed.length).toBeGreaterThan(0);
    const inspections = callsWith('ls');
    expect(inspections).toHaveLength(completed.length);
    const quintCalls = execute.mock.calls.filter((call) => (call[1] as string[]).some((arg) => arg.endsWith('global-install-quint-smoke.mjs')));
    expect(quintCalls).toHaveLength(completed.length);
    for (const entry of completed) {
      expect(inspections.some((args) => args.includes(entry.prefix))).toBe(true);
      expect(quintCalls.some((call) => (call[1] as string[]).includes(join(entry.prefix, 'lib/node_modules/takt')))).toBe(true);
    }
    if (ls || quint) {
      expect(result).not.toBeUndefined();
      expect(result).not.toBe(0);
      if (ls) expect(diagnostics + JSON.stringify(writeFile.mock.calls)).toContain('ELSPROBLEMS');
      if (quint) expect(diagnostics + JSON.stringify(writeFile.mock.calls)).toContain('isFullwidthCodePoint');
    } else {
      expect(result === undefined || result === 0).toBe(true);
    }
  });

  it('should fail for empty dependency directories while still running the independent inspections', async () => {
    emptyDirectories = true;
    const result = await runGate();

    expect(result).not.toBeUndefined();
    expect(result).not.toBe(0);
    expect(diagnostics).toMatch(/empty director/i);
    for (const parent of ['wrap-ansi', 'widest-line']) {
      for (const dependency of ['string-width', 'emoji-regex']) {
        expect(diagnostics).toContain(`${parent}/node_modules/${dependency}`);
      }
    }
    const completed = installations.filter((entry) => entry.target.endsWith('.tgz'));
    expect(completed.length).toBeGreaterThan(0);
    expect(callsWith('ls')).toHaveLength(completed.length);
    expect(execute.mock.calls.some((call) => (call[1] as string[]).some((arg) => arg.endsWith('global-install-smoke.mjs')))).toBe(false);
    expect(writeFile.mock.calls.some(([path]) => String(path).endsWith('-empty-directories.json'))).toBe(true);
    expect(remove).toHaveBeenCalledWith('/isolated/global-check', { recursive: true, force: true });
  });
});
