import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
    const args = [
      vitestBin,
      'run',
      '--config',
      'vitest.config.e2e.mock.ts',
      `--outputFile.json=e2e/results/mock-shard-${shardNumber}.json`,
      ...selectedFiles,
      ...vitestArgs,
    ];

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        TAKT_E2E_PROVIDER: 'mock',
      },
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      resolveResult({
        shardNumber,
        code: code ?? 1,
        signal,
      });
    });

    child.on('error', (error) => {
      console.error(`[takt] Failed to start E2E mock shard ${shardNumber}: ${error.message}`);
      resolveResult({
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
