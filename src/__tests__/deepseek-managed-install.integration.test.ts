import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeepSeekHarnessInstallRequiredError,
  getDeepSeekHarnessManagedPackagePaths,
  getReadyDeepSeekHarnessPackageDirectory,
  installDeepSeekHarness,
  loadManagedDeepSeekHarnessModules,
} from '../infra/deepseek-harness/managed-package.js';
import { callDeepSeekHarness } from '../infra/deepseek-harness/index.js';
import { isSupportedDeepSeekHarnessPlatform } from '../infra/deepseek-harness/platform.js';

const supported = isSupportedDeepSeekHarnessPlatform(process.platform, process.arch);
const manifestSource = new URL('../../managed/deepseek-harness/package.json', import.meta.url);
const lockSource = new URL('../../managed/deepseek-harness/package-lock.json', import.meta.url);
const cliSource = fileURLToPath(new URL('../app/cli/index.ts', import.meta.url));
const installerSource = new URL('../infra/deepseek-harness/managed-package.ts', import.meta.url);

let temporaryRoot: string;
let fakeNpmPath: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(process.cwd(), '.deepseek-managed-test-'));
  vi.stubEnv('TAKT_CONFIG_DIR', join(temporaryRoot, 'config'));
  fakeNpmPath = join(temporaryRoot, 'fake-npm.cjs');
  await writeFile(fakeNpmPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.env.TAKT_TEST_NPM_FAIL === '1') process.exit(9);
if (process.env.TAKT_TEST_NPM_SIGNAL_FILE) {
  process.on('SIGTERM', () => fs.writeFileSync(process.env.TAKT_TEST_NPM_SIGNAL_FILE, 'received'));
}
if (process.env.TAKT_TEST_NPM_PID_FILE) fs.writeFileSync(process.env.TAKT_TEST_NPM_PID_FILE, String(process.pid));
if (process.env.TAKT_TEST_NPM_HANG === '1') setInterval(() => {}, 1000);
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const [name, version] of Object.entries(manifest.dependencies)) {
  const directory = path.join('node_modules', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name, version, type: 'module',
    exports: { '.': './index.js', './package.json': './package.json', './lib/*': './lib/*' },
    ...(name === '@deepseek-ai/dsh' ? { bin: { dsh: 'lib/bin.js' } } : {}),
  }));
  fs.writeFileSync(path.join(directory, 'index.js'),
    name === '@deepseek-ai/dsh-sdk-client' ? (process.env.TAKT_TEST_NPM_MISSING_EXPORT === '1'
      ? 'export const ready = true;\\n' : 'export class DeepSeekHarness {}\\n')
      : name === '@deepseek-ai/dsh-llm' ? 'export const ReasoningEffortId = (value) => value;\\n'
        : 'export const ready = true;\\n');
  if (name === '@deepseek-ai/dsh') {
    fs.mkdirSync(path.join(directory, 'lib'));
    fs.writeFileSync(path.join(directory, 'lib', 'bin.js'), 'export const ready = true;\\n');
  }
}
const fflate = path.join('node_modules', 'fflate');
fs.mkdirSync(fflate, { recursive: true });
fs.writeFileSync(path.join(fflate, 'package.json'), JSON.stringify({name: 'fflate', version: '0.8.3', exports: { './package.json': './package.json' }}));
const koffi = path.join('node_modules', 'koffi');
fs.mkdirSync(koffi, { recursive: true });
fs.writeFileSync(path.join(koffi, 'package.json'), JSON.stringify({name: 'koffi', version: '3.1.1', main: 'index.cjs'}));
fs.writeFileSync(path.join(koffi, 'index.cjs'), 'module.exports = { load() { return { func() { return () => process.pid; } }; } };\\n');
const protobuf = path.join('node_modules', 'protobufjs');
fs.mkdirSync(protobuf, { recursive: true });
fs.writeFileSync(path.join(protobuf, 'package.json'), JSON.stringify({ name: 'protobufjs', version: '1.0.0', main: 'index.cjs' }));
fs.writeFileSync(path.join(protobuf, 'index.cjs'), 'module.exports = {};\\n');
const pty = path.join('node_modules', 'node-pty');
const nativeDir = path.join(pty, 'prebuilds', process.platform + '-' + process.arch);
fs.mkdirSync(path.join(pty, 'lib'), { recursive: true });
fs.mkdirSync(nativeDir, { recursive: true });
fs.writeFileSync(path.join(pty, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.0.0', main: 'lib/index.js' }));
fs.writeFileSync(path.join(pty, 'lib', 'index.js'), 'exports.spawn = () => {};\\n');
fs.writeFileSync(path.join(pty, 'lib', 'utils.js'),
  'const fs = require("node:fs"); const path = require("node:path");\\n' +
  'exports.loadNativeModule = () => {\\n' +
  '  const dir = "../prebuilds/" + process.platform + "-" + process.arch;\\n' +
  '  if (!fs.existsSync(path.resolve(__dirname, dir, "pty.node"))) throw new Error("pty.node missing");\\n' +
  '  return { dir };\\n' +
  '};\\n');
fs.writeFileSync(path.join(nativeDir, 'pty.node'), 'native fixture');
if (process.platform === 'darwin') {
  fs.writeFileSync(path.join(nativeDir, 'spawn-helper'), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
}
`);
  await chmod(fakeNpmPath, 0o755);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function waitForFile(path: string, child?: ReturnType<typeof spawn>, getError?: () => string): Promise<string> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Child exited before writing ${path}: ${getError?.() ?? ''}`);
      }
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe.skipIf(!supported)('managed DeepSeek installation', () => {
  it('requires installation and leaves a ready install unchanged on repeated invocation', async () => {
    await expect(getReadyDeepSeekHarnessPackageDirectory()).rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    const missing = await callDeepSeekHarness('worker', 'missing install', { cwd: temporaryRoot });
    expect(missing).toMatchObject({ status: 'error', content: expect.stringContaining('takt install deepseek-harness') });

    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const first = await getReadyDeepSeekHarnessPackageDirectory();
    expect((await loadManagedDeepSeekHarnessModules()).directory).toBe(first);
    expect((await readFile(join(first, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))).toContain('0.2.0-rc.2');

    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toBe(first);
  });

  it('replaces a ready generation through the CLI --force option', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const npmExecutable = join(temporaryRoot, 'npm');
    await writeFile(npmExecutable, '#!/bin/sh\nexec node "$TAKT_TEST_FAKE_NPM_SCRIPT" "$@"\n');
    await chmod(npmExecutable, 0o755);
    const child = spawn(process.execPath, ['--import', 'tsx', cliSource, 'install', 'deepseek-harness', '--force'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${temporaryRoot}${delimiter}${process.env.PATH ?? ''}`,
        TAKT_TEST_FAKE_NPM_SCRIPT: fakeNpmPath,
      },
      stdio: 'ignore',
    });
    const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it('keeps a ready generation when --force fails to validate its replacement', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    vi.stubEnv('TAKT_TEST_NPM_MISSING_EXPORT', '1');
    await expect(installDeepSeekHarness({ npmPath: fakeNpmPath, force: true }))
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toBe(previous);
  });

  it.skipIf(process.platform !== 'darwin')('accepts the macOS /var filesystem alias', async () => {
    const aliasRoot = await mkdtemp(join(tmpdir(), 'takt-deepseek-alias-'));
    try {
      vi.stubEnv('TAKT_CONFIG_DIR', join(aliasRoot, 'config'));
      await installDeepSeekHarness({ npmPath: fakeNpmPath });
      await getReadyDeepSeekHarnessPackageDirectory();
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('keeps the previous ready install when a replacement npm ci fails', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const manifestPath = join(temporaryRoot, 'changed-package.json');
    const lockPath = join(temporaryRoot, 'changed-package-lock.json');
    const manifest = JSON.parse(await readFile(manifestSource, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, description: 'new release' })}\n`);
    await copyFile(lockSource, lockPath);
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');

    await expect(installDeepSeekHarness({
      npmPath: fakeNpmPath,
      assetPaths: { manifestPath, lockPath },
    })).rejects.toThrow(/npm ci failed/u);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toBe(previous);
    expect((await readdir(getDeepSeekHarnessManagedPackagePaths().root))
      .filter((name) => name.startsWith('.sdk-stage-') || name.startsWith('.sdk-link-'))).toEqual([]);
  });

  it('replaces a damaged install with a validated one', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    await rm(join(previous, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'index.js'));
    await expect(getReadyDeepSeekHarnessPackageDirectory()).rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);

    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const repaired = await getReadyDeepSeekHarnessPackageDirectory();
    expect(repaired).not.toBe(previous);
  });

  it('repairs a broken SDK entry even after the module was imported', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    await loadManagedDeepSeekHarnessModules();
    await writeFile(join(previous, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'index.js'), 'invalid JavaScript !');
    await expect(getReadyDeepSeekHarnessPackageDirectory()).rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it('does not publish an SDK without its required export', async () => {
    vi.stubEnv('TAKT_TEST_NPM_MISSING_EXPORT', '1');
    await expect(installDeepSeekHarness({ npmPath: fakeNpmPath }))
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
  });

  it('repairs a damaged runtime executable', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const first = await getReadyDeepSeekHarnessPackageDirectory();
    await writeFile(join(first, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'damaged');
    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const second = await getReadyDeepSeekHarnessPackageDirectory();
    expect(second).not.toBe(first);
  });

  const ptyFiles: Array<[string, string]> = [
    ['entry', 'lib/index.js'],
    ['native binary', `prebuilds/${process.platform}-${process.arch}/pty.node`],
    ...(process.platform === 'darwin'
      ? [['spawn-helper', `prebuilds/${process.platform}-${process.arch}/spawn-helper`] as [string, string]]
      : []),
  ];
  it.each(ptyFiles.flatMap(([label, file]) => [
    [label, file, 'changes'] as const,
    [label, file, 'disappears'] as const,
  ]))('repairs node-pty %s (%s) when it %s', async (_label, file, change) => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const target = join(previous, 'node_modules', 'node-pty', file);
    if (change === 'changes') await writeFile(target, 'damaged');
    else await rm(target);
    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it.skipIf(process.platform !== 'darwin')('repairs a spawn-helper without owner execute permission', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    await chmod(join(previous, 'node_modules', 'node-pty', 'prebuilds',
      `${process.platform}-${process.arch}`, 'spawn-helper'), 0o644);
    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it('preserves a damaged generation until its replacement passes validation', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const previousLink = await readlink(getDeepSeekHarnessManagedPackagePaths().current);
    await writeFile(join(previous, 'node_modules', 'node-pty', 'lib', 'index.js'), 'damaged');
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    await expect(installDeepSeekHarness({ npmPath: fakeNpmPath })).rejects.toThrow(/npm ci failed/u);
    expect(await readlink(getDeepSeekHarnessManagedPackagePaths().current)).toBe(previousLink);
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '0');
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it('rejects an unsupported platform before inspecting a managed install', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await expect(getReadyDeepSeekHarnessPackageDirectory())
        .rejects.toThrow(/Windows, macOS x64, and other platforms are not supported/u);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('recovers an old real SDK directory without removing unrelated state', async () => {
    const paths = getDeepSeekHarnessManagedPackagePaths();
    await mkdir(paths.current, { recursive: true });
    await copyFile(manifestSource, join(paths.current, 'package.json'));
    for (const name of ['dsh-home', 'state', 'credentials']) {
      await mkdir(join(paths.root, name));
      await writeFile(join(paths.root, name, 'sentinel'), 'preserve');
    }
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await readlink(paths.current)).toMatch(/^sdk-[a-f0-9-]+$/u);
    for (const name of ['dsh-home', 'state', 'credentials']) {
      expect(await readFile(join(paths.root, name, 'sentinel'), 'utf8')).toBe('preserve');
    }
    expect((await readdir(paths.root)).some((name) => name.startsWith('sdk-recovered-'))).toBe(true);
  });

  it('restores a displaced directory when publication fails normally', async () => {
    const paths = getDeepSeekHarnessManagedPackagePaths();
    await mkdir(paths.current, { recursive: true });
    await copyFile(manifestSource, join(paths.current, 'package.json'));
    await writeFile(join(paths.current, 'sentinel'), 'original SDK');

    await expect(installDeepSeekHarness({
      npmPath: fakeNpmPath,
      onDisplaced: () => { throw new Error('publication failed'); },
    })).rejects.toThrow('publication failed');
    expect(await readFile(join(paths.current, 'sentinel'), 'utf8')).toBe('original SDK');
    expect((await readdir(paths.root)).filter((name) => name.startsWith('.sdk-stage-')
      || name.startsWith('.sdk-link-') || name === 'sdk-recovered-pending'
      || name === '.sdk-recovery.json')).toEqual([]);
  });

  it('does not move an unrecorded recovery candidate with the same package name', async () => {
    const paths = getDeepSeekHarnessManagedPackagePaths();
    const candidate = join(paths.root, 'sdk-recovered-pending');
    await mkdir(candidate, { recursive: true });
    await copyFile(manifestSource, join(candidate, 'package.json'));
    await writeFile(join(candidate, 'sentinel'), 'unrelated');

    await expect(installDeepSeekHarness({ npmPath: fakeNpmPath }))
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    expect(await readFile(join(candidate, 'sentinel'), 'utf8')).toBe('unrelated');
    await expect(readFile(join(paths.current, 'sentinel'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores a displaced SDK directory after a process is killed before publication', async () => {
    const paths = getDeepSeekHarnessManagedPackagePaths();
    await mkdir(paths.current, { recursive: true });
    await copyFile(manifestSource, join(paths.current, 'package.json'));
    await writeFile(join(paths.current, 'sentinel'), 'original SDK');
    const script = `import { installDeepSeekHarness } from ${JSON.stringify(pathToFileURL(fileURLToPath(installerSource)).href)};
await installDeepSeekHarness({
  npmPath: ${JSON.stringify(fakeNpmPath)},
  onDisplaced: () => process.kill(process.pid, 'SIGKILL'),
});`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'ignore',
    });
    const [, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    expect(signal).toBe('SIGKILL');
    expect((await readdir(paths.root))).toContain('sdk-recovered-pending');
    expect((await readdir(paths.root))).toContain('.sdk-recovery.json');
    await expect(readFile(join(paths.current, 'sentinel'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    expect(await readFile(join(paths.current, 'sentinel'), 'utf8')).toBe('original SDK');
    expect((await readdir(paths.root))).not.toContain('sdk-recovered-pending');
    expect((await readdir(paths.root))).not.toContain('.sdk-recovery.json');

    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    await getReadyDeepSeekHarnessPackageDirectory();
    const recovered = (await readdir(paths.root)).find((name) => name.startsWith('sdk-recovered-'));
    expect(recovered).toBeDefined();
    expect(await readFile(join(paths.root, recovered!, 'sentinel'), 'utf8')).toBe('original SDK');
    expect((await readdir(paths.root))).not.toContain('sdk-recovered-pending');
  });

  it.each([
    ['SIGINT', undefined, 130],
    ['SIGTERM', undefined, 143],
    ['SIGINT', 'SIGTERM', 130],
    ['SIGTERM', 'SIGINT', 143],
  ] as const)('stops npm and permits a new CLI install after %s then %s', async (interrupt, next, expectedCode) => {
    const npmExecutable = join(temporaryRoot, 'npm');
    await writeFile(npmExecutable, '#!/bin/sh\nexec node "$TAKT_TEST_FAKE_NPM_SCRIPT" "$@"\n');
    await chmod(npmExecutable, 0o755);
    const pidFile = join(temporaryRoot, 'npm.pid');
    const signalFile = join(temporaryRoot, 'npm-signal');
    const environment = {
      ...process.env,
      PATH: `${temporaryRoot}${delimiter}${process.env.PATH ?? ''}`,
      TAKT_TEST_NPM_HANG: '1',
      TAKT_TEST_NPM_PID_FILE: pidFile,
      TAKT_TEST_NPM_SIGNAL_FILE: next === undefined ? '' : signalFile,
      TAKT_TEST_FAKE_NPM_SCRIPT: fakeNpmPath,
    };
    const first = spawn(process.execPath, ['--import', 'tsx', cliSource, 'install', 'deepseek-harness'], {
      cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let firstOutput = '';
    first.stdout.on('data', (chunk: Buffer) => { firstOutput += chunk.toString(); });
    first.stderr.on('data', (chunk: Buffer) => { firstOutput += chunk.toString(); });
    const npmPid = Number(await waitForFile(pidFile, first, () => firstOutput));
    first.kill(interrupt);
    if (next !== undefined) {
      await waitForFile(signalFile, first, () => firstOutput);
      expect(first.kill(next)).toBe(true);
    }
    const [code] = await once(first, 'close') as [number | null, NodeJS.Signals | null];
    expect(code).toBe(expectedCode);
    expect(() => process.kill(npmPid, 0)).toThrow();
    const paths = getDeepSeekHarnessManagedPackagePaths();
    expect((await readdir(paths.root)).filter((name) => name.startsWith('.sdk-stage-'))).toEqual([]);
    await expect(readFile(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });

    const second = spawn(process.execPath, ['--import', 'tsx', cliSource, 'install', 'deepseek-harness'], {
      cwd: process.cwd(),
      env: { ...environment, TAKT_TEST_NPM_HANG: '0', TAKT_TEST_NPM_PID_FILE: '' },
      stdio: 'ignore',
    });
    const [secondCode] = await once(second, 'close') as [number | null, NodeJS.Signals | null];
    expect(secondCode).toBe(0);
    await getReadyDeepSeekHarnessPackageDirectory();
  });

  it('stops a hung npm install and removes its staging directory', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const manifestPath = join(temporaryRoot, 'next-package.json');
    const lockPath = join(temporaryRoot, 'next-package-lock.json');
    const manifest = JSON.parse(await readFile(manifestSource, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, description: 'next release' })}\n`);
    await copyFile(lockSource, lockPath);
    vi.stubEnv('TAKT_TEST_NPM_HANG', '1');
    await expect(installDeepSeekHarness({
      npmPath: fakeNpmPath,
      npmTimeoutMs: 100,
      assetPaths: { manifestPath, lockPath },
    }))
      .rejects.toThrow(/timed out/u);
    expect((await readdir(getDeepSeekHarnessManagedPackagePaths().root))
      .filter((name) => name.startsWith('.sdk-stage-') || name.startsWith('.sdk-link-'))).toEqual([]);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toBe(previous);
    vi.stubEnv('TAKT_TEST_NPM_HANG', '0');
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
  });
});
