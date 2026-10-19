import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DeepSeekHarnessNpmPluginOption,
  DeepSeekHarnessPluginOption,
} from '../../core/models/workflow-provider-options.js';
import type {
  DeepSeekHarnessPluginResolution,
  ResolvedDeepSeekHarnessPlugin,
} from './plugin-types.js';

const execFile = promisify(execFileCallback);
const PLUGIN_DIRECTORY_PREFIX = 'takt-deepseek-npm-plugin-';
const ENTRYPOINT_EXTENSIONS = ['.mjs', '.js', '.cjs'];

type DeepSeekHarnessNpmPluginFailureStage = 'source' | 'install' | 'entrypoint';

export class DeepSeekHarnessNpmPluginResolutionError extends Error {
  readonly stage: DeepSeekHarnessNpmPluginFailureStage;

  /** Preserve the failed resolution stage without including package-owned diagnostics. */
  constructor(stage: DeepSeekHarnessNpmPluginFailureStage) {
    super(`DeepSeek Harness npm plugin ${stage} failed`);
    this.name = 'DeepSeekHarnessNpmPluginResolutionError';
    this.stage = stage;
  }
}

interface ParsedNpmSource {
  spec: string;
}

interface DeepSeekHarnessNpmPluginResolution extends DeepSeekHarnessPluginResolution {
  npmPluginEntrypoints: string[];
}

/** Narrow plugin options to npm sources without interpreting Git options. */
function isNpmPlugin(plugin: DeepSeekHarnessPluginOption): plugin is string | DeepSeekHarnessNpmPluginOption {
  return typeof plugin === 'string'
    ? plugin.startsWith('npm:')
    : plugin.source.startsWith('npm:');
}

/** Identify Git package specs so npm cannot bypass the Git resolver's trust checks. */
function isGitPackageSpec(spec: string): boolean {
  if (/^(?:git(?:\+[^:]+)?|ssh):\/\//iu.test(spec)
    || /^(?:github|gitlab|bitbucket):/iu.test(spec)
    || /^(?!\.{1,2}\/)[^@:/\\\s]+\/[^/\\\s]+(?:#.*)?$/u.test(spec)
    || /^[^@/\\\s]+@[^:/\\\s]+:.+$/u.test(spec)) {
    return true;
  }
  try {
    return /\.git$/iu.test(new URL(spec).pathname);
  } catch {
    return false;
  }
}

/** Reject URL credentials before npm can expose them in its process arguments. */
function assertNoNpmUrlCredentials(spec: string): void {
  const urlSpec = /(?:^|@)(https?:\/\/.*)$/iu.exec(spec)?.[1];
  if (urlSpec === undefined) return;
  let url: URL;
  try {
    url = new URL(urlSpec);
  } catch {
    throw new DeepSeekHarnessNpmPluginResolutionError('source');
  }
  const hasSensitiveQuery = [...url.searchParams.keys()].some((key) =>
    /(?:token|password|passwd|secret|credential|auth|api[-_]?key|signature|key[-_]?pair[-_]?id|expires|^sig$|^policy$)/iu.test(key));
  if (url.username.length > 0 || url.password.length > 0 || hasSensitiveQuery) {
    throw new DeepSeekHarnessNpmPluginResolutionError('source');
  }
}

/** Validate an npm source before allocating temporary files or spawning npm. */
function parseNpmSource(source: string): ParsedNpmSource {
  if (!source.startsWith('npm:')) throw new DeepSeekHarnessNpmPluginResolutionError('source');
  const spec = source.slice('npm:'.length).trim();
  if (spec.length === 0 || spec.startsWith('-') || isGitPackageSpec(spec)) {
    throw new DeepSeekHarnessNpmPluginResolutionError('source');
  }
  assertNoNpmUrlCredentials(spec);
  return { spec };
}

/** Anchor local package paths to the caller's working directory rather than the temporary install root. */
function resolveRelativeNpmSource(source: ParsedNpmSource, baseDirectory: string): ParsedNpmSource {
  if (source.spec.startsWith('file:')) {
    const filePath = source.spec.slice('file:'.length);
    return path.isAbsolute(filePath)
      ? source
      : { spec: `file:${path.resolve(baseDirectory, filePath)}` };
  }
  if (source.spec === '.' || source.spec === '..'
    || source.spec.startsWith('./') || source.spec.startsWith('../')) {
    return { spec: path.resolve(baseDirectory, source.spec) };
  }
  return source;
}

/** Acquire one package tarball with scripts disabled and validate npm's reported identity. */
async function packNpmSource(source: ParsedNpmSource, directory: string, signal?: AbortSignal): Promise<{
  filename: string;
  name: string;
}> {
  let output: string;
  try {
    ({ stdout: output } = await execFile('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', directory, '--', source.spec,
    ], { cwd: directory, signal, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    signal?.throwIfAborted();
    throw new DeepSeekHarnessNpmPluginResolutionError('source');
  }
  try {
    const packed = JSON.parse(output) as unknown;
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0] !== 'object' || packed[0] === null) {
      throw new Error('npm pack returned an invalid package record');
    }
    const record = packed[0] as Record<string, unknown>;
    if (typeof record.filename !== 'string' || path.basename(record.filename) !== record.filename
      || typeof record.name !== 'string' || record.name.length === 0) {
      throw new Error('npm pack returned an invalid package identity');
    }
    return { filename: record.filename, name: record.name };
  } catch {
    throw new DeepSeekHarnessNpmPluginResolutionError('source');
  }
}

/** Locate an installed package, including scoped names, beneath node_modules. */
function installedPackageDirectory(root: string, name: string): string {
  return path.join(root, 'node_modules', ...name.split('/'));
}

/** Select a root export using import/node/default, preserving explicit null blocks. */
function selectExportEntry(exportsField: unknown): string | null | undefined {
  if (typeof exportsField === 'string' || exportsField === null) return exportsField;
  if (Array.isArray(exportsField)) {
    let fallback: null | undefined = exportsField.length === 0 ? null : undefined;
    for (const entry of exportsField) {
      const resolved = selectExportEntry(entry);
      if (resolved === null) {
        fallback = null;
        continue;
      }
      if (resolved !== undefined) return resolved;
    }
    return fallback;
  }
  if (typeof exportsField !== 'object') return undefined;

  const record = exportsField as Record<string, unknown>;
  const rootExport = Object.keys(record).some((key) => key.startsWith('.'))
    ? record['.']
    : exportsField;
  if (rootExport === undefined || rootExport === null) return rootExport;
  if (typeof rootExport === 'string') return rootExport;
  if (Array.isArray(rootExport)) return selectExportEntry(rootExport);
  if (typeof rootExport !== 'object') return undefined;

  const conditions = rootExport as Record<string, unknown>;
  for (const [condition, value] of Object.entries(conditions)) {
    if (condition !== 'import' && condition !== 'node' && condition !== 'default') continue;
    const candidate = selectExportEntry(value);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/** Resolve legacy main files and directories using Node's non-executing package resolver. */
function resolveMainEntry(packageDirectory: string): string | undefined {
  try {
    return createRequire(path.join(packageDirectory, 'package.json')).resolve(packageDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined;
    throw new DeepSeekHarnessNpmPluginResolutionError('entrypoint');
  }
}

/** Check strict package containment using platform-aware relative paths, not string prefixes. */
function isInsidePackage(packageDirectory: string, entrypoint: string): boolean {
  const relative = path.relative(packageDirectory, entrypoint);
  return relative.length > 0 && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve canonical entrypoints so directory aliases cannot break the package containment check. */
async function resolveEntrypoint(packageDirectory: string): Promise<string> {
  let canonicalPackageDirectory: string;
  let manifest: { exports?: unknown; main?: unknown };
  try {
    canonicalPackageDirectory = await realpath(packageDirectory);
    manifest = JSON.parse(await readFile(path.join(canonicalPackageDirectory, 'package.json'), 'utf8')) as typeof manifest;
  } catch {
    throw new DeepSeekHarnessNpmPluginResolutionError('entrypoint');
  }

  const candidates = manifest.exports !== undefined
    ? [selectExportEntry(manifest.exports)]
    : typeof manifest.main === 'string'
      ? [resolveMainEntry(canonicalPackageDirectory)]
      : [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const candidatePath = path.resolve(canonicalPackageDirectory, candidate);
    if (!isInsidePackage(canonicalPackageDirectory, candidatePath)) continue;
    if (!ENTRYPOINT_EXTENSIONS.includes(path.extname(candidatePath))) continue;
    try {
      const entrypoint = await realpath(candidatePath);
      if (!isInsidePackage(canonicalPackageDirectory, entrypoint)) continue;
      if (!ENTRYPOINT_EXTENSIONS.includes(path.extname(entrypoint))) continue;
      if ((await stat(entrypoint)).isFile()) return entrypoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
        && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
        throw new DeepSeekHarnessNpmPluginResolutionError('entrypoint');
      }
    }
  }
  throw new DeepSeekHarnessNpmPluginResolutionError('entrypoint');
}

/** Translate a trusted npm option into a Cordis entry without changing its configuration. */
function toCordisPlugin(
  option: string | DeepSeekHarnessNpmPluginOption,
  entrypoint: string,
): ResolvedDeepSeekHarnessPlugin {
  const sourceOption = typeof option === 'string' ? undefined : option;
  return {
    ...(sourceOption?.id === undefined ? {} : { id: sourceOption.id }),
    name: pathToFileURL(entrypoint).href,
    ...(sourceOption?.config === undefined ? {} : { config: sourceOption.config }),
  };
}

/** Install trusted npm package sources into temporary directories and resolve Cordis entrypoints. */
export async function resolveDeepSeekHarnessNpmPlugins(
  options: readonly DeepSeekHarnessPluginOption[] | undefined,
  signal?: AbortSignal,
): Promise<DeepSeekHarnessNpmPluginResolution> {
  const npmOptions = options?.filter(isNpmPlugin) ?? [];
  if (npmOptions.length === 0) {
    return { plugins: [], npmPluginEntrypoints: [], cleanupPaths: [], dispose: async () => {} };
  }

  const originalWorkingDirectory = process.cwd();
  const parsed = npmOptions.map((option) => {
    if (typeof option !== 'string' && 'ref' in option && option.ref !== undefined) {
      throw new DeepSeekHarnessNpmPluginResolutionError('source');
    }
    return resolveRelativeNpmSource(
      parseNpmSource(typeof option === 'string' ? option : option.source),
      originalWorkingDirectory,
    );
  });
  const directories: string[] = [];
  try {
    const plugins: ResolvedDeepSeekHarnessPlugin[] = [];
    for (let index = 0; index < npmOptions.length; index += 1) {
      signal?.throwIfAborted();
      const source = parsed[index];
      if (source === undefined) throw new DeepSeekHarnessNpmPluginResolutionError('source');
      let temporaryDirectory: string;
      try {
        temporaryDirectory = await mkdtemp(path.join(tmpdir(), PLUGIN_DIRECTORY_PREFIX));
        directories.push(temporaryDirectory);
        await mkdir(path.join(temporaryDirectory, 'install'));
      } catch {
        signal?.throwIfAborted();
        throw new DeepSeekHarnessNpmPluginResolutionError('install');
      }
      const packedPackage = await packNpmSource(source, temporaryDirectory, signal);
      const installRoot = path.join(temporaryDirectory, 'install');
      const tarballPath = path.join(temporaryDirectory, packedPackage.filename);
      try {
        await execFile('npm', [
          'install', '--prefix', installRoot, '--no-save', '--ignore-scripts',
          '--no-audit', '--no-fund', '--package-lock=false', '--', tarballPath,
        ], { cwd: temporaryDirectory, signal, timeout: 300_000, maxBuffer: 1024 * 1024 });
      } catch {
        signal?.throwIfAborted();
        throw new DeepSeekHarnessNpmPluginResolutionError('install');
      }
      const packageDirectory = installedPackageDirectory(installRoot, packedPackage.name);
      try {
        if (!(await stat(packageDirectory)).isDirectory()) {
          throw new DeepSeekHarnessNpmPluginResolutionError('entrypoint');
        }
      } catch (error) {
        if (error instanceof DeepSeekHarnessNpmPluginResolutionError) throw error;
        throw new DeepSeekHarnessNpmPluginResolutionError('entrypoint');
      }
      const entrypoint = await resolveEntrypoint(packageDirectory);
      const option = npmOptions[index];
      if (option === undefined) throw new DeepSeekHarnessNpmPluginResolutionError('source');
      plugins.push(toCordisPlugin(option, entrypoint));
    }

    let disposed = false;
    return {
      plugins,
      npmPluginEntrypoints: plugins.map((plugin) => plugin.name),
      cleanupPaths: directories,
      /** Remove all temporary installations once; failed cleanup remains retryable. */
      dispose: async (): Promise<void> => {
        if (disposed) return;
        await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
        disposed = true;
      },
    };
  } catch (error) {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    throw error;
  }
}
