import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import type { ContextWindowLimits } from '../providers/context-window.js';
import { resolveCodexHomeDirectory } from './home.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { resolveWindowsPowerShellExecutablePath } from '../../shared/utils/executable-path.js';

const log = createLogger('codex-model-context');
const execFileAsync = promisify(execFile);

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectConfigPaths(cwd: string): string[] {
  const paths: string[] = [];
  let directory = resolve(cwd);
  while (true) {
    paths.push(join(directory, '.codex', 'config.toml'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return paths;
}

async function readConfigWindow(path: string): Promise<{ window: number | null; customCatalog: boolean } | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { window: null, customCatalog: false };
    log.debug('Codex config unavailable for context window selection', { error: getErrorMessage(error) });
    return undefined;
  }
  try {
    const config = parse(raw, { unsafeKeyBehaviour: 'throw' });
    const value = config.model_context_window;
    if (value !== undefined && positiveInteger(value) === undefined) return undefined;
    return { window: value === undefined ? null : positiveInteger(value)!, customCatalog: config.model_catalog_json !== undefined };
  } catch (error) {
    log.debug('Codex config could not be parsed for context window selection', { error: getErrorMessage(error) });
    return undefined;
  }
}

async function windowsSystemConfigPath(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      resolveWindowsPowerShellExecutablePath(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); '
        + '[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)'],
      { timeout: 5_000, maxBuffer: 4096, windowsHide: true },
    );
    const directory = stdout.trim();
    return join(directory === '' ? 'C:\\ProgramData' : directory, 'OpenAI', 'Codex', 'config.toml');
  } catch (error) {
    log.debug('Codex Windows system config path unavailable', { error: getErrorMessage(error) });
    return undefined;
  }
}

async function configuredWindow(
  home: string,
  cwd: string,
  profile: string | undefined,
): Promise<number | null | undefined> {
  if (profile !== undefined && !/^[A-Za-z0-9_-]+$/.test(profile)) return undefined;
  let selected: number | null = null;
  const systemPath = process.platform === 'win32' ? await windowsSystemConfigPath() : '/etc/codex/config.toml';
  if (systemPath === undefined) return undefined;
  const knownLayers = [
    systemPath,
    join(home, 'config.toml'),
    ...(profile === undefined ? [] : [join(home, `${profile}.config.toml`)]),
  ];
  for (const path of knownLayers) {
    const value = await readConfigWindow(path);
    if (value === undefined || value.customCatalog) return undefined;
    if (value.window !== null) selected = value.window;
  }
  const basePath = resolve(join(home, 'config.toml'));
  let canonicalBasePath: string | undefined;
  try {
    canonicalBasePath = await realpath(basePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }
  // Project config is loaded only for trusted projects. Trust is decided by
  // Codex, so a project override cannot be treated as the effective default.
  for (const path of projectConfigPaths(cwd)) {
    if (resolve(path) === basePath) continue;
    if (canonicalBasePath !== undefined) {
      try {
        if (await realpath(path) === canonicalBasePath) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      }
    }
    const value = await readConfigWindow(path);
    if (value === undefined || value.customCatalog || value.window !== null) return undefined;
  }
  return selected;
}

export async function readCodexModelContextWindow(
  model: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  cwd?: string,
  profile?: string,
): Promise<ContextWindowLimits | undefined> {
  if (model === undefined) return undefined;
  const environment = { ...process.env, ...childProcessEnv };
  const home = resolveCodexHomeDirectory(environment);
  const path = join(home, 'models_cache.json');
  let cache: unknown;
  try {
    cache = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.debug('Codex model context cache unavailable', { error: getErrorMessage(error) });
    }
    return undefined;
  }
  if (!isRecord(cache) || !Array.isArray(cache.models)) return undefined;
  const entry = cache.models.find((candidate: unknown) => isRecord(candidate) && candidate.slug === model);
  if (entry === undefined) return undefined;
  const defaultWindow = positiveInteger(entry.context_window);
  if (defaultWindow === undefined) return undefined;
  const nativeWindow = await configuredWindow(home, cwd ?? process.cwd(), profile);
  if (nativeWindow === undefined) return undefined;
  const maximum = positiveInteger(entry.max_context_window);
  const percent = positiveInteger(entry.effective_context_window_percent);
  return {
    default: nativeWindow ?? defaultWindow,
    ...(maximum !== undefined ? { maximum } : {}),
    ...(percent !== undefined && percent <= 100 ? { effectivePercent: percent } : {}),
  };
}
