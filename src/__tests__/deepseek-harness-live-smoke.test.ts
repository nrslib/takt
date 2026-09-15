import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveNpmInvocation } from '../../scripts/npm-invocation.mjs';

const liveSmokeEnabled = process.env.TAKT_DEEPSEEK_HARNESS_LIVE === '1';
const supportedRuntime = (
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
  || (process.platform === 'darwin' && process.arch === 'arm64')
);
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

interface NpmPackResult {
  filename?: string;
}

function runNpm(
  cwd: string,
  cacheDir: string,
  args: readonly string[],
): string {
  const invocation = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
  const result = spawnSync(invocation.executable, [...invocation.args, ...args, '--cache', cacheDir], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed while preparing the packed live smoke`);
  }
  return result.stdout;
}

function runPackedCli(
  packageRoot: string,
  workspace: string,
  environment: Record<string, string>,
): void {
  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, 'bin', 'takt'), 'deepseek-harness', 'install'],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error('packed DeepSeek Harness install command failed');
  }
}

describe('DeepSeek Harness live smoke', () => {
  it.skipIf(!liveSmokeEnabled)('runs the packed CLI and distribution through one real workspace turn when explicitly enabled', async () => {
    if (!supportedRuntime) {
      throw new Error('DeepSeek Harness live smoke requires Linux x64/arm64 or macOS arm64');
    }
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new Error('DEEPSEEK_API_KEY must be set for the DeepSeek Harness live smoke');
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-live-smoke-'));
    const npmCache = path.join(root, 'npm-cache');
    const packageExtractRoot = path.join(root, 'package-extract');
    const workspace = path.join(root, 'workspace');
    const configDir = path.join(root, 'takt-config');
    await mkdir(npmCache, { recursive: true });
    await mkdir(packageExtractRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });
    try {
      runNpm(repositoryRoot, npmCache, ['run', 'build']);
      const packOutput = runNpm(repositoryRoot, npmCache, [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        root,
      ]);
      const packResults = JSON.parse(packOutput) as readonly NpmPackResult[];
      const archiveName = packResults[0]?.filename;
      if (archiveName === undefined) {
        throw new Error('npm pack did not produce an archive');
      }
      const archivePath = path.isAbsolute(archiveName)
        ? archiveName
        : path.join(root, archiveName);
      execFileSync('tar', ['-xzf', archivePath, '-C', packageExtractRoot], { stdio: 'ignore' });
      const packageRoot = path.join(packageExtractRoot, 'package');
      await readFile(path.join(packageRoot, 'dist', 'infra', 'deepseek-harness', 'pyproject.toml'), 'utf8');
      await readFile(path.join(packageRoot, 'dist', 'infra', 'deepseek-harness', 'uv.lock'), 'utf8');
      await symlink(path.join(repositoryRoot, 'node_modules'), path.join(packageRoot, 'node_modules'), 'junction');

      runPackedCli(packageRoot, workspace, { TAKT_CONFIG_DIR: configDir });
      const previousConfigDir = process.env.TAKT_CONFIG_DIR;
      process.env.TAKT_CONFIG_DIR = configDir;
      try {
        const packedHarness = await import(
          pathToFileURL(path.join(packageRoot, 'dist', 'infra', 'deepseek-harness', 'index.js')).href
        );
        const packedConstants = await import(
          pathToFileURL(path.join(packageRoot, 'dist', 'infra', 'deepseek-harness', 'constants.js')).href
        );
        try {
          const response = await packedHarness.callDeepSeekHarness(
            'live-smoke',
            'Reply with a short confirmation that the packed DeepSeek Harness workspace smoke test completed.',
            {
              cwd: workspace,
              model: packedConstants.DEEPSEEK_HARNESS_DEFAULT_MODEL,
            },
          );

          expect(response.status).toBe('done');
          expect(response.content.trim().length).toBeGreaterThan(0);
        } finally {
          await packedHarness.closeDeepSeekHarnessProcesses();
        }
      } finally {
        if (previousConfigDir === undefined) {
          delete process.env.TAKT_CONFIG_DIR;
        } else {
          process.env.TAKT_CONFIG_DIR = previousConfigDir;
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
