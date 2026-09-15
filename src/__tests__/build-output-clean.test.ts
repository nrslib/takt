import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanBuildOutput } from '../../scripts/clean-build-output.mjs';
import { resolveNpmInvocation } from '../../scripts/npm-invocation.mjs';

interface PackResult {
  readonly filename?: string;
}

const deepSeekHarnessAssetNames = ['pyproject.toml', 'uv.lock'] as const;

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const buildTimeoutMs = 60_000;
const packTimeoutMs = 30_000;
const isolatedProjectEntries = [
  'LICENSE',
  'README.md',
  'bin',
  'builtins',
  'package-lock.json',
  'package.json',
  'scripts',
  'src',
  'tools/opencode-probe',
  'tsconfig.json',
  'tsconfig.opencode-probe.json',
] as const;

function runNpm(
  projectRoot: string,
  npmCache: string,
  args: readonly string[],
  timeout: number,
): string {
  const invocation = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
  const result = spawnSync(invocation.executable, [...invocation.args, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: npmCache,
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(' ')} failed with status ${String(result.status)}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

describe('build output cleanup', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes stale generated files without touching project sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-build-output-clean-'));
    roots.push(root);
    mkdirSync(join(root, 'dist', 'core'), { recursive: true });
    writeFileSync(join(root, 'dist', 'core', 'removed-module.js'), 'stale output');
    writeFileSync(join(root, 'source.ts'), 'export const current = true;\n');

    cleanBuildOutput(root);

    expect(existsSync(join(root, 'dist'))).toBe(false);
    expect(readFileSync(join(root, 'source.ts'), 'utf8')).toBe('export const current = true;\n');
  });

  it('packs managed runtime assets and excludes stale dist artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-build-package-clean-'));
    roots.push(root);
    const projectRoot = join(root, 'project');
    const npmCache = join(root, 'npm-cache');
    mkdirSync(projectRoot);
    mkdirSync(npmCache);
    for (const entry of isolatedProjectEntries) {
      cpSync(join(repositoryRoot, entry), join(projectRoot, entry), { recursive: true });
    }
    symlinkSync(join(repositoryRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'junction');

    const staleArtifact = 'dist/core/stale-build-output.js';
    mkdirSync(join(projectRoot, 'dist', 'core'), { recursive: true });
    writeFileSync(join(projectRoot, staleArtifact), 'stale output');

    runNpm(projectRoot, npmCache, ['run', 'build'], buildTimeoutMs);
    const packOutput = runNpm(projectRoot, npmCache, [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      root,
      '--cache',
      npmCache,
    ], packTimeoutMs);
    const packResults = JSON.parse(packOutput) as readonly PackResult[];
    const packResult = packResults[0];
    const archiveName = packResult?.filename;
    if (archiveName === undefined) {
      throw new Error('npm pack did not produce an archive');
    }

    const packageExtractRoot = join(root, 'package-extract');
    mkdirSync(packageExtractRoot);
    const archivePath = isAbsolute(archiveName) ? archiveName : join(root, archiveName);
    execFileSync('tar', ['-xzf', archivePath, '-C', packageExtractRoot], { stdio: 'ignore' });

    const packagedRoot = join(packageExtractRoot, 'package');
    expect(existsSync(join(packagedRoot, 'dist', 'index.js'))).toBe(true);
    const packagedHarnessRoot = join(
      packagedRoot,
      'dist',
      'infra',
      'deepseek-harness',
    );
    for (const assetName of deepSeekHarnessAssetNames) {
      expect(readFileSync(join(packagedHarnessRoot, assetName), 'utf8'))
        .toBe(readFileSync(join(projectRoot, 'src', 'infra', 'deepseek-harness', assetName), 'utf8'));
    }
    expect(existsSync(join(packagedRoot, staleArtifact))).toBe(false);
  });
});
