import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getGlobalConfigDir } from '../config/paths.js';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { resolveManagedNpmCommand } from '../deepseek-harness/npm-command.js';
import { MANAGED_MODULES, type ManagedProvider } from './definitions.js';
import { publishManagedGeneration, recoverManagedPublication, resolveManagedGeneration } from './generation.js';

type SdkProvider = Exclude<ManagedProvider, 'deepseek-harness'>;
interface Manifest { name: string; dependencies: Record<string, string> }
interface Assets { manifest: Manifest; manifestBytes: Buffer; lockBytes: Buffer }
interface ReadyRecord { manifestSha256: string; lockSha256: string; files: Record<string, string> }
export interface ManagedProviderInstallation {
  state: 'missing' | 'stale' | 'ready';
  directory?: string;
  cause?: unknown;
}
export interface ManagedInstallOptions { force?: boolean; signal?: AbortSignal; npmPath?: string; npmTimeoutMs?: number }
const READY_FILE = '.ready.json';
const hashCache = new Map<string, { key: string; digest: string }>();

export function managedPackageRoot(provider: SdkProvider): string {
  return resolve(getGlobalConfigDir(), provider);
}

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

async function hashFile(path: string): Promise<string> {
  const metadata = await stat(path);
  const key = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  const cached = hashCache.get(path);
  if (cached?.key === key) return cached.digest;

  const file = await open(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const digest = createHash('sha256');
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
    }
    const result = digest.digest('hex');
    hashCache.set(path, { key, digest: result });
    return result;
  } finally {
    await file.close();
  }
}

async function readAssets(directory: string): Promise<Assets> {
  const [manifestBytes, lockBytes] = await Promise.all([
    readFile(join(directory, 'package.json')), readFile(join(directory, 'package-lock.json')),
  ]);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest;
  const lock = JSON.parse(lockBytes.toString('utf8')) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
  if (typeof manifest.name !== 'string' || !manifest.dependencies) throw new Error('Invalid managed manifest.');
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version)
      || lock.packages['']?.dependencies?.[name] !== version
      || lock.packages[`node_modules/${name}`]?.version !== version) throw new Error('Managed manifest and lock are inconsistent.');
  }
  return { manifest, manifestBytes, lockBytes };
}

async function ownedPath(directory: string, path: string): Promise<string> {
  const [modules, target] = await Promise.all([realpath(join(directory, 'node_modules')), realpath(path)]);
  if (!modules.startsWith(`${await realpath(directory)}${sep}`) || !target.startsWith(`${modules}${sep}`) || !(await stat(target)).isFile()) throw new Error('Managed asset resolves outside its installation.');
  return target;
}

function importExport(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const conditions = value as Record<string, unknown>;
    for (const key of ['node', 'import', 'default']) {
      if (Object.hasOwn(conditions, key)) return importExport(conditions[key]);
    }
  }
  throw new Error('Managed SDK has no supported module entrypoint.');
}

export async function managedModulePath(directory: string, name: string, exportName: string): Promise<string> {
  const manifestPath = await ownedPath(directory, join(directory, 'node_modules', name, 'package.json'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { exports?: unknown; main?: string };
  const exports = manifest.exports;
  const entry = exports === undefined
    ? (manifest.main ?? 'index.js')
    : importExport(typeof exports === 'object' && exports !== null && Object.hasOwn(exports, exportName)
      ? (exports as Record<string, unknown>)[exportName] : exports);
  return ownedPath(directory, resolve(dirname(manifestPath), entry));
}

async function installationFiles(provider: SdkProvider, directory: string, assets: Assets): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  const add = async (path: string): Promise<void> => {
    const owned = await ownedPath(directory, path);
    files[relative(directory, owned)] = await hashFile(owned);
  };
  for (const [name, version] of Object.entries(assets.manifest.dependencies)) {
    const manifestPath = join(directory, 'node_modules', name, 'package.json');
    await add(manifestPath);
    if ((JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string }).version !== version) throw new Error(`Managed package version mismatch: ${name}`);
  }
  for (const module of MANAGED_MODULES[provider]) {
    const entry = await managedModulePath(directory, module.name, module.export);
    await add(entry);
    const sdk = await import(pathToFileURL(entry).href) as Record<string, unknown>;
    for (const name of module.required) {
      if (typeof sdk[name] !== 'function' && typeof sdk[name] !== 'object') throw new Error(`Managed SDK export is missing: ${name}`);
    }
  }
  if (provider === 'claude-sdk') {
    const suffix = process.platform === 'linux' && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? '-musl' : '';
    const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}`;
    await add(join(directory, 'node_modules', name, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  } else if (provider === 'codex') {
    const sdkRequire = createRequire(join(directory, 'node_modules', '@openai/codex-sdk', 'package.json'));
    const cliManifest = await ownedPath(directory, sdkRequire.resolve('@openai/codex/package.json'));
    const cliRequire = createRequire(cliManifest);
    const manifestPath = await ownedPath(directory, cliRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
    const triples: Record<string, string> = {
      'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
      'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
      'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
    };
    const nativeRoot = join(dirname(manifestPath), 'vendor', triples[`${process.platform}-${process.arch}`]!);
    await add(join(nativeRoot, 'codex-package.json'));
    await add(join(nativeRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
  }
  return files;
}

async function verify(provider: SdkProvider, directory: string, assets: Assets): Promise<void> {
  const marker = JSON.parse(await readFile(join(directory, READY_FILE), 'utf8')) as ReadyRecord;
  if (marker.manifestSha256 !== hash(assets.manifestBytes) || marker.lockSha256 !== hash(assets.lockBytes)) throw new Error('Managed generation integrity check failed.');
  const files = await installationFiles(provider, directory, assets);
  if (JSON.stringify(files) !== JSON.stringify(marker.files)) throw new Error('Managed SDK integrity check failed.');
}

function bundledDirectory(provider: SdkProvider): string {
  return fileURLToPath(new URL(`../../../managed/${provider}/`, import.meta.url));
}

export async function inspectManagedProvider(provider: SdkProvider): Promise<ManagedProviderInstallation> {
  const root = managedPackageRoot(provider);
  try {
    const directory = await resolveManagedGeneration(root, { platform: process.platform });
    if (directory === undefined) return { state: 'missing' };
    const installed = await readAssets(directory);
    await verify(provider, directory, installed);
    const bundled = await readAssets(bundledDirectory(provider));
    return { state: hash(installed.manifestBytes) === hash(bundled.manifestBytes) && hash(installed.lockBytes) === hash(bundled.lockBytes) ? 'ready' : 'stale', directory };
  } catch (cause) { return { state: 'missing', cause }; }
}

export async function installManagedSdk(provider: SdkProvider, options: ManagedInstallOptions): Promise<void> {
  if ((provider === 'claude-sdk' || provider === 'codex')
    && (!['darwin', 'linux', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch))) throw new Error(`Unsupported platform for ${provider}.`);
  const assets = await readAssets(bundledDirectory(provider));
  const root = managedPackageRoot(provider);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await runPrivateFileExclusiveAsync(join(root, 'install.lock'), async () => {
    options.signal?.throwIfAborted();
    await recoverManagedPublication(root, { platform: process.platform });
    if (!options.force && (await inspectManagedProvider(provider)).state === 'ready') return;
    const stage = await mkdtemp(join(root, '.sdk-stage-'));
    const directory = join(root, `sdk-${randomUUID()}`);
    let published = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Managed npm ci timed out.')), options.npmTimeoutMs ?? 600_000);
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    try {
      await Promise.all([copyFile(join(bundledDirectory(provider), 'package.json'), join(stage, 'package.json')), copyFile(join(bundledDirectory(provider), 'package-lock.json'), join(stage, 'package-lock.json'))]);
      const npm = await resolveManagedNpmCommand({ npmPath: options.npmPath });
      const managedProcess = spawnManagedProcess(npm.command, [...npm.argsPrefix, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' }, controller.signal);
      const { code } = await managedProcess.wait();
      if (code !== 0) throw new Error(`Managed npm ci failed with status ${String(code)}.`);
      controller.signal.throwIfAborted();
      const marker: ReadyRecord = { manifestSha256: hash(assets.manifestBytes), lockSha256: hash(assets.lockBytes), files: await installationFiles(provider, stage, assets) };
      await writeFile(join(stage, READY_FILE), JSON.stringify(marker), { mode: 0o600 });
      await verify(provider, stage, assets);
      controller.signal.throwIfAborted();
      await rename(stage, directory);
      await publishManagedGeneration(root, directory, { platform: process.platform, signal: controller.signal });
      published = true;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      await rm(stage, { recursive: true, force: true });
      if (!published) {
        const active = await resolveManagedGeneration(root, { platform: process.platform }).catch(() => directory);
        if (active !== directory) await rm(directory, { recursive: true, force: true });
      }
    }
  }, { timeoutMs: 300_000, onWait: () => options.signal?.throwIfAborted() });
}
