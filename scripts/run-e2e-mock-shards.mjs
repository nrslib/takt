import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockE2eShards, mockE2eSpecs } from '../vitest.config.e2e.mock-specs.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const vitestBin = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
const passthroughArgs = process.argv.slice(2);
const vitestOptionsWithValue = new Set([
  '-c',
  '-t',
  '--config',
  '--dir',
  '--exclude',
  '--maxWorkers',
  '--minWorkers',
  '--outputFile',
  '--pool',
  '--project',
  '--reporter',
  '--root',
  '--testNamePattern',
  '--test-name-pattern',
]);

mkdirSync(resolve(repoRoot, 'e2e/results'), { recursive: true });

function copyBaseEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !key.startsWith('TAKT_') &&
      ![
        'HOME',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_STATE_HOME',
      ].includes(key)
    )
  );
}

function createShardEnv(shardNumber) {
  const baseDir = mkdtempSync(join(tmpdir(), `takt-e2e-mock-shard-${shardNumber}-`));
  const homeDir = join(baseDir, 'home');
  const configDir = join(baseDir, 'xdg-config');
  const cacheDir = join(baseDir, 'xdg-cache');
  const stateDir = join(baseDir, 'xdg-state');
  const taktDir = join(baseDir, '.takt');
  const tmpDir = join(baseDir, 'tmp');

  for (const dir of [homeDir, configDir, cacheDir, stateDir, taktDir, tmpDir]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    env: {
      ...copyBaseEnv(),
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_STATE_HOME: stateDir,
      TMPDIR: tmpDir,
      TAKT_CONFIG_DIR: taktDir,
      TAKT_E2E_PROVIDER: 'mock',
      TAKT_NO_TTY: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

function splitPassthroughArgs(args) {
  const vitestArgs = [];
  const positionalFilters = [];
  let optionValueExpected = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (optionValueExpected) {
      vitestArgs.push(arg);
      optionValueExpected = false;
      continue;
    }

    if (arg === '--') {
      positionalFilters.push(...args.slice(index + 1));
      break;
    }

    if (arg.startsWith('-')) {
      vitestArgs.push(arg);
      optionValueExpected = vitestOptionsWithValue.has(arg);
      continue;
    }

    positionalFilters.push(arg);
  }

  return { vitestArgs, positionalFilters };
}

function normalizeFilterPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function matchesPositionalFilter(file, filter) {
  const normalizedFile = normalizeFilterPath(file);
  const normalizedFilter = normalizeFilterPath(filter);

  return (
    normalizedFile === normalizedFilter ||
    normalizedFile.endsWith(`/${normalizedFilter}`) ||
    normalizedFile.includes(normalizedFilter)
  );
}

function selectFilesForFilters(files, positionalFilters) {
  if (positionalFilters.length === 0) {
    return files;
  }

  return files.filter((file) =>
    positionalFilters.some((filter) => matchesPositionalFilter(file, filter))
  );
}

const { vitestArgs, positionalFilters } = splitPassthroughArgs(passthroughArgs);

if (positionalFilters.length > 0) {
  const matchedSpecs = selectFilesForFilters(mockE2eSpecs, positionalFilters);

  if (matchedSpecs.length === 0) {
    console.error(
      `[takt] No mock E2E spec matched positional filter(s): ${positionalFilters.join(', ')}`
    );
    process.exit(1);
  }
}

function runShard(files, index) {
  const selectedFiles = selectFilesForFilters(files, positionalFilters);
  if (selectedFiles.length === 0) {
    return Promise.resolve({
      shardNumber: index + 1,
      code: 0,
      signal: null,
    });
  }

  return new Promise((resolveResult) => {
    const shardNumber = index + 1;
    const shardEnv = createShardEnv(shardNumber);
    const args = [
      vitestBin,
      'run',
      '--config',
      'vitest.config.e2e.mock.ts',
      `--outputFile.json=e2e/results/mock-shard-${shardNumber}.json`,
      ...selectedFiles,
      ...vitestArgs,
    ];

    let finished = false;
    const finish = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      shardEnv.cleanup();
      resolveResult(result);
    };

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: shardEnv.env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      finish({
        shardNumber,
        code: code ?? 1,
        signal,
      });
    });

    child.on('error', (error) => {
      console.error(`[takt] Failed to start E2E mock shard ${shardNumber}: ${error.message}`);
      finish({
        shardNumber,
        code: 1,
        signal: null,
      });
    });
  });
}

const results = await Promise.all(mockE2eShards.map(runShard));
const failed = results.filter((result) => result.code !== 0);

if (failed.length > 0) {
  for (const result of failed) {
    const suffix = result.signal ? ` signal=${result.signal}` : '';
    console.error(`[takt] E2E mock shard ${result.shardNumber} failed with exit=${result.code}${suffix}`);
  }
  process.exit(1);
}
