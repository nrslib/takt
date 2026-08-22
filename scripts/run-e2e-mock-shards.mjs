import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mockE2eShards, mockE2eSpecs } from '../vitest.config.e2e.mock-specs.mjs';
import { runTeedCommand } from './teed-command.mjs';
import { isBirpcNoiseOnlyFailure } from './vitest-birpc-noise.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const vitestBin = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
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

export async function settleShardResults(results, { isCI, remeasureShard }) {
  const settledResults = [];
  for (const result of results) {
    if (result.code === 0 || !isBirpcNoiseOnlyFailure({ output: result.output, isCI })) {
      settledResults.push(result);
      continue;
    }

    console.error(
      `[takt] E2E mock shard ${result.shardNumber} exited ${result.code} with every test passed and only birpc noise; re-measuring this shard once`,
    );
    settledResults.push(await remeasureShard(result.shardNumber));
  }
  return settledResults;
}

export async function runShard(files, shardNumber, positionalFilters, vitestArgs) {
  const selectedFiles = selectFilesForFilters(files, positionalFilters);
  if (selectedFiles.length === 0) {
    return {
      shardNumber,
      code: 0,
      signal: null,
      output: '',
    };
  }

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

  try {
    return {
      shardNumber,
      ...(await runTeedCommand(process.execPath, args, {
        cwd: repoRoot,
        env: shardEnv.env,
      })),
    };
  } catch (error) {
    console.error(`[takt] Failed to start E2E mock shard ${shardNumber}: ${error.message}`);
    return {
      shardNumber,
      code: 1,
      signal: null,
      output: '',
    };
  } finally {
    shardEnv.cleanup();
  }
}

async function runE2eMockShards(passthroughArgs) {
  mkdirSync(resolve(repoRoot, 'e2e/results'), { recursive: true });

  const { vitestArgs, positionalFilters } = splitPassthroughArgs(passthroughArgs);

  if (positionalFilters.length > 0) {
    const matchedSpecs = selectFilesForFilters(mockE2eSpecs, positionalFilters);

    if (matchedSpecs.length === 0) {
      console.error(
        `[takt] No mock E2E spec matched positional filter(s): ${positionalFilters.join(', ')}`
      );
      return 1;
    }
  }

  const results = await Promise.all(
    mockE2eShards.map((files, index) => runShard(files, index + 1, positionalFilters, vitestArgs)),
  );
  const settledResults = await settleShardResults(results, {
    isCI: Boolean(process.env.CI),
    remeasureShard: (shardNumber) =>
      runShard(mockE2eShards[shardNumber - 1], shardNumber, positionalFilters, vitestArgs),
  });
  const failed = settledResults.filter((result) => result.code !== 0);

  if (failed.length > 0) {
    for (const result of failed) {
      const suffix = result.signal ? ` signal=${result.signal}` : '';
      console.error(`[takt] E2E mock shard ${result.shardNumber} failed with exit=${result.code}${suffix}`);
    }
    return 1;
  }

  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // process.exit() would truncate teed shard output still flushing to the
  // terminal; the exit code is set and the event loop drains naturally
  // (runTeedCommand destroys lingering pipe ends at settle time).
  process.exitCode = await runE2eMockShards(process.argv.slice(2));
}
