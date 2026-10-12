import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getGlobalConfigDir } from '../config/paths.js';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { assertSupportedDeepSeekHarnessPlatform } from './platform.js';
import { resolveManagedNpmCommand } from './npm-command.js';
import { warnStaleProvider } from '../managed-providers/messages.js';
import {
  DEEPSEEK_HARNESS_RUNTIME_VERSION,
  DEEPSEEK_HARNESS_SDK_VERSION,
} from './constants.js';

const MANAGED_DIRECTORY = 'deepseek-harness';
const CURRENT_LINK = 'sdk';
const INSTALL_LOCK = 'install.lock';
const READY_FILE = '.ready.json';
const RECOVERY_DIRECTORY = 'sdk-recovered-pending';
const RECOVERY_JOURNAL = '.sdk-recovery.json';
const LOCK_TIMEOUT_MS = 5 * 60_000;
const NPM_TIMEOUT_MS = 10 * 60_000;
const PACKAGE_DIRECTORY = new URL('../../../managed/deepseek-harness/', import.meta.url);

interface ManagedAssets {
  manifestPath: string;
  lockPath: string;
  manifest: {
    name: string;
    dependencies: Record<string, string>;
    overrides: { fflate: string };
  };
  manifestSha256: string;
  lockSha256: string;
}

export interface DeepSeekHarnessInstallOptions {
  npmPath?: string;
  npmTimeoutMs?: number;
  force?: boolean;
  assetPaths?: { manifestPath: string; lockPath: string };
  onLockWait?: () => void;
  onDisplaced?: () => void;
  signal?: AbortSignal;
}

export class DeepSeekHarnessInstallRequiredError extends Error {
  constructor(cause?: unknown) {
    super('DeepSeek Harness SDK/runtime is missing or failed an integrity check. Run `takt install deepseek-harness` to repair detected damage. If it still malfunctions, run `takt install deepseek-harness --force` to reinstall it.', { cause });
    this.name = 'DeepSeekHarnessInstallRequiredError';
  }
}

export function getDeepSeekHarnessManagedPackagePaths(): {
  root: string;
  current: string;
  lock: string;
} {
  const root = resolve(getGlobalConfigDir(), MANAGED_DIRECTORY);
  return { root, current: join(root, CURRENT_LINK), lock: join(root, INSTALL_LOCK) };
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readAssets(paths: { manifestPath: string; lockPath: string }, installed = false): Promise<ManagedAssets> {
  let manifestBytes: Buffer;
  let lockBytes: Buffer;
  try {
    [manifestBytes, lockBytes] = await Promise.all([
      readFile(paths.manifestPath),
      readFile(paths.lockPath),
    ]);
  } catch (error) {
    throw new Error('DeepSeek Harness managed npm manifest or lock is unavailable; reinstall TAKT.', { cause: error });
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as ManagedAssets['manifest'];
  const lock = JSON.parse(lockBytes.toString('utf8')) as {
    packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };
  if (manifest.name !== 'takt-deepseek-harness-runtime'
    || manifest.overrides?.fflate !== '0.8.3'
    || (!installed && manifest.dependencies?.['@deepseek-ai/dsh-sdk-client'] !== DEEPSEEK_HARNESS_SDK_VERSION)
    || (!installed && manifest.dependencies?.['@deepseek-ai/dsh-llm'] !== DEEPSEEK_HARNESS_SDK_VERSION)
    || (!installed && manifest.dependencies?.['@deepseek-ai/dsh'] !== DEEPSEEK_HARNESS_RUNTIME_VERSION)
    || lock.packages?.['']?.dependencies?.['@deepseek-ai/dsh'] !== manifest.dependencies?.['@deepseek-ai/dsh']
    || lock.packages?.['node_modules/fflate']?.version !== '0.8.3') {
    throw new Error('DeepSeek Harness managed npm assets are inconsistent; reinstall TAKT.');
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error('DeepSeek Harness managed npm assets are inconsistent; reinstall TAKT.');
    }
  }
  return {
    ...paths,
    manifest,
    manifestSha256: sha256(manifestBytes),
    lockSha256: sha256(lockBytes),
  };
}

async function isInside(directory: string, child: string): Promise<boolean> {
  const [realDirectory, realChild] = await Promise.all([realpath(directory), realpath(child)]);
  return realChild.startsWith(`${realDirectory}${sep}`);
}

async function resolveCurrentDirectory(current: string, root: string): Promise<string> {
  const link = await lstat(current);
  if (!link.isSymbolicLink()) throw new DeepSeekHarnessInstallRequiredError();
  const target = await readlink(current);
  if (isAbsolute(target) || basename(target) !== target || !/^sdk-[a-f0-9-]+$/u.test(target)) {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  const directory = join(root, target);
  if (!(await lstat(directory)).isDirectory()) throw new DeepSeekHarnessInstallRequiredError();
  return directory;
}

async function assertInstalledPackage(
  directory: string,
  name: string,
  expectedVersion: string,
): Promise<string> {
  const require = createRequire(join(directory, 'package.json'));
  const manifestPath = require.resolve(`${name}/package.json`);
  if (!(await isInside(join(directory, 'node_modules'), manifestPath))) {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };
  if (manifest.version !== expectedVersion) throw new DeepSeekHarnessInstallRequiredError();
  return manifestPath;
}

interface NodePtyHashes {
  entrySha256: string;
  nativePath: string;
  nativeSha256: string;
  helperSha256?: string;
}

async function readNodePtyHashes(directory: string): Promise<NodePtyHashes> {
  try {
    const require = createRequire(join(directory, 'package.json'));
    const entryPath = require.resolve('node-pty');
    const utilsPath = require.resolve('node-pty/lib/utils.js');
    require('node-pty');
    const utils = require(utilsPath) as { loadNativeModule: (name: string) => { dir: string } };
    const nativeDir = utils.loadNativeModule('pty').dir;
    const nativePath = resolve(dirname(utilsPath), nativeDir, 'pty.node');
    const helperPath = process.platform === 'darwin'
      ? resolve(dirname(utilsPath), nativeDir, 'spawn-helper') : undefined;
    for (const path of [entryPath, nativePath, ...(helperPath === undefined ? [] : [helperPath])]) {
      if (!(await isInside(join(directory, 'node_modules'), path))) throw new DeepSeekHarnessInstallRequiredError();
    }
    if (helperPath !== undefined && ((await stat(helperPath)).mode & 0o100) === 0) {
      throw new DeepSeekHarnessInstallRequiredError();
    }
    return {
      entrySha256: sha256(await readFile(entryPath)),
      nativePath: relative(directory, nativePath),
      nativeSha256: sha256(await readFile(nativePath)),
      helperSha256: helperPath === undefined ? undefined : sha256(await readFile(helperPath)),
    };
  } catch (error) {
    throw new DeepSeekHarnessInstallRequiredError(error);
  }
}

async function inspectInstallation(directory: string, assets: ManagedAssets): Promise<void> {
  const marker = JSON.parse(await readFile(join(directory, READY_FILE), 'utf8')) as {
    manifestSha256?: string;
    lockSha256?: string;
    sdkSha256?: string;
    llmSha256?: string;
    runtimeBinSha256?: string;
    ptyEntrySha256?: string;
    ptyNativePath?: string;
    ptyNativeSha256?: string;
    ptyHelperSha256?: string;
  };
  if (marker.manifestSha256 !== assets.manifestSha256 || marker.lockSha256 !== assets.lockSha256) {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  const [installedManifest, installedLock] = await Promise.all([
    readFile(join(directory, 'package.json')),
    readFile(join(directory, 'package-lock.json')),
  ]);
  if (sha256(installedManifest) !== assets.manifestSha256 || sha256(installedLock) !== assets.lockSha256) {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  for (const [name, version] of Object.entries(assets.manifest.dependencies)) {
    await assertInstalledPackage(directory, name, version);
  }
  const toolkitPath = await assertInstalledPackage(directory, '@deepseek-ai/libreoffice-kit', '0.1.5');
  const toolkitRequire = createRequire(toolkitPath);
  const fflatePath = toolkitRequire.resolve('fflate/package.json');
  if (!(await isInside(join(directory, 'node_modules'), fflatePath))) throw new DeepSeekHarnessInstallRequiredError();
  const fflate = JSON.parse(await readFile(fflatePath, 'utf8')) as { version: string };
  if (fflate.version !== '0.8.3') throw new DeepSeekHarnessInstallRequiredError();
  const require = createRequire(join(directory, 'package.json'));
  const sdkPath = require.resolve('@deepseek-ai/dsh-sdk-client');
  const llmPath = require.resolve('@deepseek-ai/dsh-llm');
  for (const entry of [sdkPath, llmPath]) {
    if (!(await isInside(join(directory, 'node_modules'), entry))) throw new DeepSeekHarnessInstallRequiredError();
  }
  if (marker.sdkSha256 !== sha256(await readFile(sdkPath))
    || marker.llmSha256 !== sha256(await readFile(llmPath))) {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  const [sdk, llm] = await Promise.all([
    import(pathToFileURL(sdkPath).href),
    import(pathToFileURL(llmPath).href),
  ]);
  if (typeof sdk.DeepSeekHarness !== 'function' || typeof llm.ReasoningEffortId !== 'function') {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  const runtimePath = await assertInstalledPackage(directory, '@deepseek-ai/dsh', assets.manifest.dependencies['@deepseek-ai/dsh']!);
  const runtimeManifest = JSON.parse(await readFile(runtimePath, 'utf8')) as { bin?: { dsh?: string } };
  if (typeof runtimeManifest.bin?.dsh !== 'string') throw new DeepSeekHarnessInstallRequiredError();
  const runtimeBin = require.resolve(`@deepseek-ai/dsh/${runtimeManifest.bin.dsh}`);
  if (!(await isInside(join(directory, 'node_modules'), runtimeBin))) throw new DeepSeekHarnessInstallRequiredError();
  if (marker.runtimeBinSha256 !== sha256(await readFile(runtimeBin))) {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  const nativePath = toolkitRequire.resolve('koffi');
  if (!(await isInside(join(directory, 'node_modules'), nativePath))) throw new DeepSeekHarnessInstallRequiredError();
  const koffi = toolkitRequire('koffi') as {
    load: (library: string) => { func: (signature: string) => () => number };
  };
  const systemLibrary = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
  if (koffi.load(systemLibrary).func('int getpid()')() !== process.pid) {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  const pty = await readNodePtyHashes(directory);
  if (marker.ptyEntrySha256 !== pty.entrySha256
    || marker.ptyNativePath !== pty.nativePath
    || marker.ptyNativeSha256 !== pty.nativeSha256
    || marker.ptyHelperSha256 !== pty.helperSha256) {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  for (const name of ['protobufjs']) {
    const entry = require.resolve(name);
    if (!(await isInside(join(directory, 'node_modules'), entry))) throw new DeepSeekHarnessInstallRequiredError();
    require(name);
  }
}

async function verifyInstallation(directory: string, assets: ManagedAssets): Promise<void> {
  try {
    await inspectInstallation(directory, assets);
  } catch (error) {
    throw new DeepSeekHarnessInstallRequiredError(error);
  }
}

export async function getReadyDeepSeekHarnessPackageDirectory(): Promise<string> {
  assertSupportedDeepSeekHarnessPlatform();
  const paths = getDeepSeekHarnessManagedPackagePaths();
  const assets = await readAssets({
    manifestPath: fileURLToPath(new URL('package.json', PACKAGE_DIRECTORY)),
    lockPath: fileURLToPath(new URL('package-lock.json', PACKAGE_DIRECTORY)),
  });
  try {
    try {
      const [journal, pending] = await Promise.all([
        lstatIfExists(join(paths.root, RECOVERY_JOURNAL)),
        lstatIfExists(join(paths.root, RECOVERY_DIRECTORY)),
      ]);
      if (journal === undefined && pending === undefined) {
        const directory = await resolveCurrentDirectory(paths.current, paths.root);
        await verifyInstallation(directory, await readAssets({ manifestPath: join(directory, 'package.json'), lockPath: join(directory, 'package-lock.json') }, true));
        return directory;
      }
      await runPrivateFileExclusiveAsync(
        paths.lock,
        () => recoverDisplacedDirectory(paths, assets),
        { timeoutMs: LOCK_TIMEOUT_MS },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const directory = await resolveCurrentDirectory(paths.current, paths.root);
    await verifyInstallation(directory, await readAssets({ manifestPath: join(directory, 'package.json'), lockPath: join(directory, 'package-lock.json') }, true));
    return directory;
  } catch (error) {
    if (error instanceof DeepSeekHarnessInstallRequiredError) throw error;
    throw new DeepSeekHarnessInstallRequiredError();
  }
}

export interface ManagedDeepSeekHarnessModules {
  directory: string;
  stale?: boolean;
  sdk: typeof import('@deepseek-ai/dsh-sdk-client');
  llm: typeof import('@deepseek-ai/dsh-llm');
}

async function isStaleInstallation(directory: string): Promise<boolean> {
  const installed = await readAssets({ manifestPath: join(directory, 'package.json'), lockPath: join(directory, 'package-lock.json') }, true);
  const bundled = await readAssets({ manifestPath: fileURLToPath(new URL('package.json', PACKAGE_DIRECTORY)), lockPath: fileURLToPath(new URL('package-lock.json', PACKAGE_DIRECTORY)) });
  return installed.manifestSha256 !== bundled.manifestSha256 || installed.lockSha256 !== bundled.lockSha256;
}

export async function inspectDeepSeekHarnessInstallation(): Promise<{ state: 'ready' | 'stale' | 'missing'; directory?: string; cause?: unknown }> {
  try {
    const directory = await getReadyDeepSeekHarnessPackageDirectory();
    return { state: await isStaleInstallation(directory) ? 'stale' : 'ready', directory };
  } catch (cause) { return { state: 'missing', cause }; }
}

export async function loadManagedDeepSeekHarnessModules(): Promise<ManagedDeepSeekHarnessModules> {
  const directory = await getReadyDeepSeekHarnessPackageDirectory();
  const require = createRequire(join(directory, 'package.json'));
  try {
    const stale = await isStaleInstallation(directory);
    if (stale) warnStaleProvider('deepseek-harness');
    const [sdk, llm] = await Promise.all([
      import(pathToFileURL(require.resolve('@deepseek-ai/dsh-sdk-client')).href),
      import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href),
    ]);
    return {
      directory,
      stale,
      sdk: sdk as ManagedDeepSeekHarnessModules['sdk'],
      llm: llm as ManagedDeepSeekHarnessModules['llm'],
    };
  } catch {
    throw new DeepSeekHarnessInstallRequiredError();
  }
}

async function runNpmCi(directory: string, npmPath: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`DeepSeek Harness npm ci timed out after ${timeoutMs} ms.`)), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const npm = await resolveManagedNpmCommand({ npmPath });
    const managed = spawnManagedProcess(npm.command, [...npm.argsPrefix, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: directory,
      stdio: 'inherit',
      env: process.env,
    }, controller.signal);
    const { code } = await managed.wait();
    if (code !== 0) throw new Error(`DeepSeek Harness npm ci failed with status ${String(code)}.`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

interface RecoveryJournal {
  dev: number;
  ino: number;
  targetVersion: string;
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeRecoveryJournal(
  paths: ReturnType<typeof getDeepSeekHarnessManagedPackagePaths>,
  journal: RecoveryJournal,
): Promise<void> {
  const temporary = join(paths.root, `.sdk-recovery-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(journal)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(paths.root, RECOVERY_JOURNAL));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readRecoveryJournal(path: string): Promise<RecoveryJournal | undefined> {
  const state = await lstatIfExists(path);
  if (state === undefined) return undefined;
  if (!state.isFile()) throw new DeepSeekHarnessInstallRequiredError();
  const journal = JSON.parse(await readFile(path, 'utf8')) as RecoveryJournal;
  if (!Number.isSafeInteger(journal.dev) || !Number.isSafeInteger(journal.ino)
    || !/^sdk-[a-f0-9-]+$/u.test(journal.targetVersion)) {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  return journal;
}

async function recoverDisplacedDirectory(
  paths: ReturnType<typeof getDeepSeekHarnessManagedPackagePaths>,
  assets: ManagedAssets,
): Promise<void> {
  const pending = join(paths.root, RECOVERY_DIRECTORY);
  const journalPath = join(paths.root, RECOVERY_JOURNAL);
  const [journal, pendingState, currentState] = await Promise.all([
    readRecoveryJournal(journalPath),
    lstatIfExists(pending),
    lstatIfExists(paths.current),
  ]);
  if (journal === undefined) {
    if (pendingState !== undefined) throw new DeepSeekHarnessInstallRequiredError();
    return;
  }
  if (pendingState !== undefined) {
    if (!pendingState.isDirectory()
      || pendingState.dev !== journal.dev
      || pendingState.ino !== journal.ino) throw new DeepSeekHarnessInstallRequiredError();
    const manifest = JSON.parse(await readFile(join(pending, 'package.json'), 'utf8')) as { name?: string };
    if (manifest.name !== assets.manifest.name) throw new DeepSeekHarnessInstallRequiredError();
    if (currentState === undefined) {
      await rename(pending, paths.current);
    } else if (currentState.isSymbolicLink()) {
      const current = await resolveCurrentDirectory(paths.current, paths.root);
      if (basename(current) !== journal.targetVersion) throw new DeepSeekHarnessInstallRequiredError();
      await rename(pending, join(paths.root, `sdk-recovered-${randomUUID()}`));
    } else {
      throw new DeepSeekHarnessInstallRequiredError();
    }
  } else if (currentState?.isDirectory()
    && currentState.dev === journal.dev
    && currentState.ino === journal.ino) {
    // The process stopped before displacement or after restoring the old directory.
  } else if (currentState?.isSymbolicLink()) {
    const current = await resolveCurrentDirectory(paths.current, paths.root);
    if (basename(current) !== journal.targetVersion) throw new DeepSeekHarnessInstallRequiredError();
  } else {
    throw new DeepSeekHarnessInstallRequiredError();
  }
  await rm(journalPath);
}

async function installLocked(paths: ReturnType<typeof getDeepSeekHarnessManagedPackagePaths>, assets: ManagedAssets, options: DeepSeekHarnessInstallOptions): Promise<void> {
  options.signal?.throwIfAborted();
  await recoverDisplacedDirectory(paths, assets);
  if (!options.force) {
    try {
      const current = await resolveCurrentDirectory(paths.current, paths.root);
      await verifyInstallation(current, assets);
      return;
    } catch (error) {
      if (!(error instanceof DeepSeekHarnessInstallRequiredError)
        && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const stage = await mkdtemp(join(paths.root, '.sdk-stage-'));
  const versionName = `sdk-${randomUUID()}`;
  const versionDirectory = join(paths.root, versionName);
  const pendingLink = join(paths.root, `.sdk-link-${randomUUID()}`);
  const displacedDirectory = join(paths.root, RECOVERY_DIRECTORY);
  const journalPath = join(paths.root, RECOVERY_JOURNAL);
  let published = false;
  let displaced = false;
  let journalWritten = false;
  try {
    await Promise.all([
      copyFile(assets.manifestPath, join(stage, 'package.json')),
      copyFile(assets.lockPath, join(stage, 'package-lock.json')),
    ]);
    await runNpmCi(stage, options.npmPath, options.npmTimeoutMs ?? NPM_TIMEOUT_MS, options.signal);
    const require = createRequire(join(stage, 'package.json'));
    const sdkSha256 = sha256(await readFile(require.resolve('@deepseek-ai/dsh-sdk-client')));
    const llmSha256 = sha256(await readFile(require.resolve('@deepseek-ai/dsh-llm')));
    const runtimeManifest = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')) as { bin: { dsh: string } };
    const runtimeBinSha256 = sha256(await readFile(require.resolve(`@deepseek-ai/dsh/${runtimeManifest.bin.dsh}`)));
    const pty = await readNodePtyHashes(stage);
    await writeFile(join(stage, READY_FILE), `${JSON.stringify({
      manifestSha256: assets.manifestSha256,
      lockSha256: assets.lockSha256,
      sdkSha256,
      llmSha256,
      runtimeBinSha256,
      ptyEntrySha256: pty.entrySha256,
      ptyNativePath: pty.nativePath,
      ptyNativeSha256: pty.nativeSha256,
      ptyHelperSha256: pty.helperSha256,
    })}\n`, { mode: 0o600 });
    await verifyInstallation(stage, assets);
    options.signal?.throwIfAborted();
    await rename(stage, versionDirectory);
    await symlink(versionName, pendingLink);
    try {
      const current = await lstat(paths.current);
      if (current.isDirectory()) {
        const currentManifest = JSON.parse(await readFile(join(paths.current, 'package.json'), 'utf8')) as { name?: string };
        if (currentManifest.name !== assets.manifest.name) {
          throw new DeepSeekHarnessInstallRequiredError();
        }
        if (await lstatIfExists(journalPath) !== undefined
          || await lstatIfExists(displacedDirectory) !== undefined) {
          throw new DeepSeekHarnessInstallRequiredError();
        }
        await writeRecoveryJournal(paths, {
          dev: current.dev,
          ino: current.ino,
          targetVersion: versionName,
        });
        journalWritten = true;
        await rename(paths.current, displacedDirectory);
        displaced = true;
        options.onDisplaced?.();
      } else if (!current.isSymbolicLink()) {
        throw new DeepSeekHarnessInstallRequiredError();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    options.signal?.throwIfAborted();
    await rename(pendingLink, paths.current);
    published = true;
    if (displaced) {
      await rename(displacedDirectory, join(paths.root, `sdk-recovered-${randomUUID()}`));
      await rm(journalPath);
      journalWritten = false;
    }
  } finally {
    if (!published) {
      if (displaced) await rename(displacedDirectory, paths.current);
      if (journalWritten) await rm(journalPath);
    }
    await rm(stage, { recursive: true, force: true });
    await rm(pendingLink, { force: true });
    if (!published) await rm(versionDirectory, { recursive: true, force: true });
  }
}

export async function installDeepSeekHarness(options: DeepSeekHarnessInstallOptions = {}): Promise<void> {
  assertSupportedDeepSeekHarnessPlatform();
  const paths = getDeepSeekHarnessManagedPackagePaths();
  const assetPaths = options.assetPaths ?? {
    manifestPath: fileURLToPath(new URL('package.json', PACKAGE_DIRECTORY)),
    lockPath: fileURLToPath(new URL('package-lock.json', PACKAGE_DIRECTORY)),
  };
  const assets = await readAssets(assetPaths);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await runPrivateFileExclusiveAsync(
    paths.lock,
    () => installLocked(paths, assets, options),
    {
      timeoutMs: LOCK_TIMEOUT_MS,
      onWait: () => {
        options.signal?.throwIfAborted();
        options.onLockWait?.();
      },
    },
  );
}
