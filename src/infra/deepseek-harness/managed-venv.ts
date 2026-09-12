import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { getGlobalConfigDir } from '../config/paths.js';
import {
  DEEPSEEK_HARNESS_MIN_UV_VERSION,
  DEEPSEEK_HARNESS_PYTHON_VERSION,
} from './constants.js';
import { assertSupportedDeepSeekHarnessPlatform } from './platform.js';
import {
  redactDeepSeekHarnessDiagnostic,
  validateDeepSeekHarnessRuntime,
} from './runtime.js';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';

const MANAGED_DIRECTORY_NAME = 'deepseek-harness';
const ENVIRONMENT_DIRECTORY_NAME = 'venv';
const DSH_HOME_DIRECTORY_NAME = 'dsh-home';
const INSTALL_LOCK_NAME = 'install.lock';
const manifestSourcePath = fileURLToPath(new URL('./pyproject.toml', import.meta.url));
const lockSourcePath = fileURLToPath(new URL('./uv.lock', import.meta.url));

export interface DeepSeekHarnessManagedPaths {
  managedRoot: string;
  environmentDir: string;
  pythonPath: string;
  dshHomeDir: string;
}

export interface DeepSeekHarnessInstallOptions {
  /** Internal test seam. The CLI intentionally does not expose this option. */
  uvPath?: string;
  /** Internal test seam for exercising packaged-asset preflight failures. */
  assetPaths?: {
    manifestPath: string;
    lockPath: string;
  };
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function getDeepSeekHarnessManagedPaths(): DeepSeekHarnessManagedPaths {
  const managedRoot = resolve(getGlobalConfigDir(), MANAGED_DIRECTORY_NAME);
  const environmentDir = join(managedRoot, ENVIRONMENT_DIRECTORY_NAME);
  return {
    managedRoot,
    environmentDir,
    pythonPath: process.platform === 'win32'
      ? join(environmentDir, 'Scripts', 'python.exe')
      : join(environmentDir, 'bin', 'python'),
    dshHomeDir: join(managedRoot, DSH_HOME_DIRECTORY_NAME),
  };
}

function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1;
    }
  }
  return 0;
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(value.trim());
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectResult(error);
    });
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveResult({ code, stdout, stderr });
    });
  });
}

async function resolveUvVersion(
  uvPath: string,
  paths: DeepSeekHarnessManagedPaths,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  let result: CommandResult;
  try {
    result = await runCommand(uvPath, ['--version'], { cwd: paths.managedRoot, env: environment });
  } catch (error) {
    throw new Error(
      'DeepSeek Harness install requires uv on PATH; install uv and retry.',
      { cause: error },
    );
  }
  const version = parseVersion(result.stdout);
  if (result.code !== 0 || version === undefined) {
    throw new Error(
      'DeepSeek Harness install could not parse a supported uv version; '
      + 'install the required uv release and retry.',
      { cause: new Error(redactDeepSeekHarnessDiagnostic(result.stderr || result.stdout, process.env)) },
    );
  }
  const minimum = parseVersion(DEEPSEEK_HARNESS_MIN_UV_VERSION);
  if (minimum === undefined || compareVersions(version, minimum) < 0) {
    throw new Error(
      `DeepSeek Harness install requires uv ${DEEPSEEK_HARNESS_MIN_UV_VERSION} or newer; found ${redactDeepSeekHarnessDiagnostic(result.stdout, process.env)}`,
    );
  }
  return redactDeepSeekHarnessDiagnostic(result.stdout, process.env);
}

function buildUvEnvironment(environmentDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    UV_PROJECT_ENVIRONMENT: environmentDir,
  };
  for (const name of [
    'UV_PROJECT',
    'UV_PYTHON',
    'UV_FROZEN',
    'UV_LOCKED',
    'UV_NO_SYNC',
    'VIRTUAL_ENV',
  ]) {
    delete environment[name];
  }
  return environment;
}

async function syncManagedProject(
  uvPath: string,
  paths: DeepSeekHarnessManagedPaths,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  let result: CommandResult;
  try {
    result = await runCommand(
      uvPath,
      [
        'sync',
        '--locked',
        '--managed-python',
        '--python',
        DEEPSEEK_HARNESS_PYTHON_VERSION,
        '--no-install-project',
        '--no-dev',
        '--project',
        paths.managedRoot,
      ],
      { cwd: paths.managedRoot, env: environment },
    );
  } catch (error) {
    const diagnostic = redactDeepSeekHarnessDiagnostic(
      error instanceof Error ? error.message : String(error),
      process.env,
    );
    throw new Error(
      diagnostic.length === 0
        ? 'DeepSeek Harness uv sync could not start.'
        : `DeepSeek Harness uv sync could not start: ${diagnostic}`,
      { cause: error },
    );
  }
  if (result.code === 0) {
    return;
  }
  const diagnostic = redactDeepSeekHarnessDiagnostic(result.stderr || result.stdout, process.env);
  if (isManagedAssetIntegrityFailure(diagnostic)) {
    throw new Error(
      diagnostic.length === 0
        ? 'DeepSeek Harness managed package assets are inconsistent; reinstall TAKT.'
        : `DeepSeek Harness managed package assets are inconsistent; reinstall TAKT. ${diagnostic}`,
    );
  }
  throw new Error(
    diagnostic.length === 0
      ? `DeepSeek Harness uv sync failed with status ${String(result.code)}`
      : `DeepSeek Harness uv sync failed: ${diagnostic}`,
  );
}

function isManagedAssetIntegrityFailure(diagnostic: string): boolean {
  const mentionsManagedAsset = /\b(?:lock(?:file)?|pyproject(?:\.toml)?|manifest)\b/iu.test(diagnostic);
  const describesMismatch = /(?:mismatch|not\s+up\s+to\s+date|out\s+of\s+date|does\s+not\s+match|needs?\s+to\s+be\s+updated|changed|inconsistent|incompatible|stale)/iu.test(diagnostic);
  return mentionsManagedAsset && describesMismatch;
}

async function installManagedEnvironment(
  uvPath: string,
  paths: DeepSeekHarnessManagedPaths,
  assetPaths: {
    manifestPath: string;
    lockPath: string;
  },
): Promise<void> {
  const environment = buildUvEnvironment(paths.environmentDir);
  await Promise.all([
    readFile(assetPaths.manifestPath),
    readFile(assetPaths.lockPath),
  ]).catch((error: unknown) => {
    throw new Error(
      'DeepSeek Harness managed project manifest or lock is unavailable; reinstall TAKT.',
      { cause: error },
    );
  });
  const uvVersion = await resolveUvVersion(uvPath, paths, environment);
  await mkdir(paths.dshHomeDir, { recursive: true });
  await copyFile(assetPaths.manifestPath, join(paths.managedRoot, 'pyproject.toml'));
  await copyFile(assetPaths.lockPath, join(paths.managedRoot, 'uv.lock'));
  await rm(paths.environmentDir, { recursive: true, force: true });
  await syncManagedProject(uvPath, paths, environment);
  const runtime = await validateDeepSeekHarnessRuntime(paths.pythonPath);
  console.log(
    `DeepSeek Harness managed environment installed: ${uvVersion}; `
    + `Python ${runtime.python.join('.')}; `
    + `SDK ${runtime.sdkVersion}; runtime ${runtime.runtimeVersion}; `
    + `environment ${paths.environmentDir}; dsh-home ${paths.dshHomeDir}`,
  );
}

export async function installDeepSeekHarness(
  options: DeepSeekHarnessInstallOptions = {},
): Promise<void> {
  assertSupportedDeepSeekHarnessPlatform();
  const paths = getDeepSeekHarnessManagedPaths();
  const uvPath = options.uvPath === undefined || options.uvPath.trim().length === 0
    ? 'uv'
    : options.uvPath;
  const assetPaths = options.assetPaths ?? {
    manifestPath: manifestSourcePath,
    lockPath: lockSourcePath,
  };
  await runPrivateFileExclusiveAsync(
    join(paths.managedRoot, INSTALL_LOCK_NAME),
    () => installManagedEnvironment(uvPath, paths, assetPaths),
  );
}
