import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DeepSeekHarnessGitPluginOption } from '../../core/models/workflow-provider-options.js';
import type {
  DeepSeekHarnessPluginResolution,
  ResolvedDeepSeekHarnessPlugin,
} from './plugin-types.js';

const execFile = promisify(execFileCallback);
const PLUGIN_DIRECTORY_PREFIX = 'takt-deepseek-plugin-';
const ENTRYPOINT_EXTENSIONS = ['.mjs', '.js', '.cjs'];

export type DeepSeekHarnessPluginFailureStage =
  | 'clone'
  | 'checkout'
  | 'dependency-install'
  | 'entrypoint';

export class DeepSeekHarnessPluginResolutionError extends Error {
  /** Report the failed resolution stage without copying upstream credential-bearing diagnostics. */
  constructor(readonly stage: DeepSeekHarnessPluginFailureStage) {
    super(`DeepSeek Harness Git plugin ${stage} failed`);
    this.name = 'DeepSeekHarnessPluginResolutionError';
  }
}

interface ParsedGitSource {
  remote: string;
}

/** Validate encrypted remote transports or local file sources before any clone is allocated. */
function parseGitSource(source: string): ParsedGitSource {
  const remote = source.startsWith('git:') && !source.startsWith('git://') ? source.slice(4) : source;
  if (/^(?:http|git):\/\//iu.test(remote)) {
    throw new Error('DeepSeek Harness plugin source must be a Git HTTPS or SSH source');
  }
  if (/^(?:https|ssh|file):\/\//iu.test(remote)) {
    let parsed: URL;
    try {
      parsed = new URL(remote);
    } catch {
      throw new Error('DeepSeek Harness Git plugin source is invalid');
    }
    const isStandardSshUser = parsed.protocol === 'ssh:'
      && parsed.username === 'git'
      && parsed.password.length === 0;
    if ((parsed.username.length > 0 || parsed.password.length > 0) && !isStandardSshUser) {
      throw new Error('DeepSeek Harness Git plugin source contains URL credentials');
    }
    for (const key of parsed.searchParams.keys()) {
      if (/(?:token|password|passwd|secret|credential|auth|api[-_]?key)/iu.test(key)) {
        throw new Error('DeepSeek Harness Git plugin source contains a secret query parameter');
      }
    }
    parsed.hash = '';
    return { remote: parsed.toString() };
  }
  const scpSource = /^([^@:\s]+)@([^:\s]+):(.+)$/u.exec(remote);
  if (scpSource !== null) {
    if (scpSource[1] !== 'git') {
      throw new Error('DeepSeek Harness Git plugin source contains URL credentials');
    }
    return { remote };
  }
  throw new Error('DeepSeek Harness plugin source must be a Git HTTPS or SSH source');
}

/** Disable user-configured filters during local checkout while leaving clone authentication intact. */
function gitEnvironmentWithoutConfiguredFilters(): NodeJS.ProcessEnv {
  // A repository's attributes must not activate external commands from the user's Git configuration.
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete environment.GIT_CONFIG_COUNT;
  delete environment.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete environment[key];
  }
  return environment;
}

/** Preserve helpers and SSH agents but disable interactive authentication for bounded Git operations. */
function nonInteractiveGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    ...(environment.GIT_SSH_COMMAND === undefined && environment.GIT_SSH === undefined
      ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
      : {}),
  };
}

/** Execute a hook-free, non-interactive Git operation with cancellation and a fixed deadline. */
async function runGit(args: string[], signal: AbortSignal | undefined, environment: NodeJS.ProcessEnv): Promise<void> {
  await execFile('git', ['-c', `core.hooksPath=${devNull}`, ...args], {
    env: nonInteractiveGitEnvironment(environment),
    signal,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}

/** Resolve tags, commits and origin branches to a verified commit without interpreting ref options. */
async function resolveCommit(directory: string, ref: string, signal?: AbortSignal): Promise<string> {
  const candidates = [ref, `refs/remotes/origin/${ref}`];
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFile(
        'git',
        ['-c', `core.hooksPath=${devNull}`, '-C', directory, 'rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`],
        { env: nonInteractiveGitEnvironment(gitEnvironmentWithoutConfiguredFilters()), signal, timeout: 120_000, maxBuffer: 1024 * 1024 },
      );
      return stdout.trim();
    } catch {
      signal?.throwIfAborted();
    }
  }
  throw new Error('Git ref did not resolve to a commit');
}

/** Select a JavaScript manifest or index entrypoint contained within the cloned repository. */
async function resolveEntrypoint(directory: string): Promise<string> {
  let manifest: { main?: unknown; module?: unknown } | undefined;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as typeof manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const candidates: string[] = [];
  if (typeof manifest?.module === 'string') candidates.push(manifest.module);
  if (typeof manifest?.main === 'string') candidates.push(manifest.main);
  candidates.push('index.mjs', 'index.js', 'index.cjs');
  for (const candidate of candidates) {
    const entrypoint = path.resolve(directory, candidate);
    if (entrypoint !== directory && !entrypoint.startsWith(`${directory}${path.sep}`)) continue;
    try {
      const entryStat = await stat(entrypoint);
      if (entryStat.isFile() && ENTRYPOINT_EXTENSIONS.includes(path.extname(entrypoint))) return entrypoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
        throw error;
      }
    }
  }
  throw new DeepSeekHarnessPluginResolutionError('entrypoint');
}

/** Install manifest dependencies without lifecycle scripts, skipping repositories without a manifest. */
async function installDependencies(directory: string, signal?: AbortSignal): Promise<void> {
  try {
    await stat(path.join(directory, 'package.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new DeepSeekHarnessPluginResolutionError('dependency-install');
  }
  try {
    await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], {
      cwd: directory,
      signal,
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new DeepSeekHarnessPluginResolutionError('dependency-install');
  }
}

/** Resolve plugins into temporary Cordis entrypoints; callers own successful clones until disposal. */
export async function resolveDeepSeekHarnessGitPlugins(
  options: readonly DeepSeekHarnessGitPluginOption[] | undefined,
  signal?: AbortSignal,
): Promise<DeepSeekHarnessPluginResolution> {
  if (options === undefined || options.length === 0) {
    return { plugins: [], cleanupPaths: [], dispose: async () => {} };
  }

  const parsed = options.map((plugin) => ({ plugin, source: parseGitSource(plugin.source) }));
  const directories: string[] = [];
  try {
    const plugins: ResolvedDeepSeekHarnessPlugin[] = [];
    for (const { plugin, source } of parsed) {
      signal?.throwIfAborted();
      if (plugin.ref === undefined) {
        console.warn('DeepSeek Harness Git plugin has no ref; the resolved version may change');
      }
      let directory: string;
      try {
        const temporaryDirectory = await mkdtemp(path.join(tmpdir(), PLUGIN_DIRECTORY_PREFIX));
        directories.push(temporaryDirectory);
        const templateDirectory = path.join(temporaryDirectory, 'git-template');
        directory = path.join(temporaryDirectory, 'repository');
        await mkdir(templateDirectory);
        await runGit(['clone', `--template=${templateDirectory}`, '--no-checkout', '--', source.remote, directory], signal, process.env);
      } catch {
        signal?.throwIfAborted();
        throw new DeepSeekHarnessPluginResolutionError('clone');
      }
      try {
        const commit = await resolveCommit(directory, plugin.ref ?? 'HEAD', signal);
        await runGit(['-C', directory, 'checkout', '--detach', commit], signal, gitEnvironmentWithoutConfiguredFilters());
      } catch {
        signal?.throwIfAborted();
        throw new DeepSeekHarnessPluginResolutionError('checkout');
      }
      try {
        await installDependencies(directory, signal);
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
      let entrypoint: string;
      try {
        entrypoint = await resolveEntrypoint(directory);
      } catch (error) {
        if (error instanceof DeepSeekHarnessPluginResolutionError) throw error;
        throw new DeepSeekHarnessPluginResolutionError('entrypoint');
      }
      plugins.push({
        id: plugin.id,
        name: pathToFileURL(entrypoint).href,
        ...(plugin.config === undefined ? {} : { config: plugin.config }),
      });
    }
    let disposed = false;
    return {
      plugins,
      cleanupPaths: directories,
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
