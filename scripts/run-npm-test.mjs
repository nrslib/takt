#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const UNIT_SHARDS = ['1/4', '2/4', '3/4', '4/4'];
const NO_ARG_UNIT_RUN_OPTIONS = ['--maxWorkers=1'];
const VITEST_OPTIONS_WITH_REQUIRED_VALUE = new Set([
  '-c',
  '-r',
  '-t',
  '--attachmentsDir',
  '--bail',
  '--browser',
  '--config',
  '--configLoader',
  '--diff',
  '--dir',
  '--environment',
  '--exclude',
  '--hookTimeout',
  '--maxConcurrency',
  '--maxWorkers',
  '--minWorkers',
  '--mode',
  '--outputFile',
  '--pool',
  '--poolOptions',
  '--project',
  '--reporter',
  '--retry',
  '--root',
  '--sequence',
  '--shard',
  '--slowTestThreshold',
  '--testNamePattern',
  '--test-name-pattern',
  '--testTimeout',
  '--teardownTimeout',
  '--workspace',
]);
const VITEST_OPTIONS_WITH_OPTIONAL_VALUE = new Set([
  '--api',
  '--changed',
  '--inspect',
  '--inspectBrk',
  '--mergeReports',
  '--silent',
]);
const VITEST_OPTIONAL_BOOLEAN_OPTIONS = new Set([
  '--api',
  '--changed',
  '--inspect',
  '--inspectBrk',
  '--silent',
]);

export function selectNpmTestRuns(args) {
  if (args.length === 0) {
    return UNIT_SHARDS.map((shard) => ({
      npmArgs: ['run', 'test:unit:parallel', '--', `--shard=${shard}`, ...NO_ARG_UNIT_RUN_OPTIONS],
    }));
  }

  const targets = splitTestTargets(args);
  if (targets.integration.length === 0) {
    return [{
      npmArgs: ['run', 'test:unit:parallel', '--', ...targets.shared, ...targets.unit],
    }];
  }
  if (targets.unit.length === 0) {
    return [{
      npmArgs: ['run', 'test:it:parallel', '--', ...targets.shared, ...targets.integration],
    }];
  }

  return [
    {
      npmArgs: ['run', 'test:unit:parallel', '--', ...targets.shared, ...targets.unit],
    },
    {
      npmArgs: ['run', 'test:it:parallel', '--', ...targets.shared, ...targets.integration],
    },
  ];
}

export function hasIntegrationTestTarget(args) {
  return args.some(isIntegrationTestTarget);
}

function splitTestTargets(args) {
  const shared = [];
  const unit = [];
  const integration = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg.startsWith('-')) {
      shared.push(arg);
      if (isRequiredValueOption(arg) && index + 1 < args.length) {
        shared.push(args[index + 1]);
        index += 1;
      } else if (isOptionalValueOption(arg)) {
        if (shouldConsumeOptionalValue(args[index + 1])) {
          shared.push(args[index + 1]);
          index += 1;
        } else if (isTestFileTarget(args[index + 1])) {
          shared[shared.length - 1] = normalizeOptionalOptionWithoutValue(arg);
        }
      }
    } else if (isIntegrationTestTarget(arg)) {
      integration.push(arg);
    } else {
      unit.push(arg);
    }
  }

  return { shared, unit, integration };
}

function isRequiredValueOption(arg) {
  return VITEST_OPTIONS_WITH_REQUIRED_VALUE.has(arg);
}

function isOptionalValueOption(arg) {
  return VITEST_OPTIONS_WITH_OPTIONAL_VALUE.has(arg);
}

function shouldConsumeOptionalValue(value) {
  if (value === undefined || value.startsWith('-')) {
    return false;
  }
  return !isTestFileTarget(value);
}

function normalizeOptionalOptionWithoutValue(arg) {
  if (VITEST_OPTIONAL_BOOLEAN_OPTIONS.has(arg)) {
    return `${arg}=true`;
  }
  return arg;
}

function isTestFileTarget(arg) {
  if (arg === undefined) {
    return false;
  }
  const fileName = basename(arg);
  return fileName.endsWith('.test.ts')
    || fileName.endsWith('.test.tsx')
    || fileName.endsWith('.spec.ts')
    || fileName.endsWith('.spec.tsx');
}

function isIntegrationTestTarget(arg) {
  if (arg.startsWith('-')) {
    return false;
  }

  const fileName = basename(arg);
  return fileName.startsWith('it-')
    || fileName.endsWith('.integration.test.ts')
    || fileName.endsWith('.regression.test.ts')
    || fileName.endsWith('.performance.test.ts');
}

async function runNpmCommand(npmArgs) {
  return new Promise((resolve) => {
    const child = spawn('npm', npmArgs, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('exit', (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
      });
    });

    child.on('error', (error) => {
      console.error(`[takt] Failed to start npm ${npmArgs.join(' ')}: ${error.message}`);
      resolve({
        code: 1,
        signal: null,
      });
    });
  });
}

export async function runNpmTest(args) {
  for (const run of selectNpmTestRuns(args)) {
    const result = await runNpmCommand(run.npmArgs);
    if (result.code !== 0) {
      const suffix = result.signal ? ` signal=${result.signal}` : '';
      console.error(`[takt] npm ${run.npmArgs.join(' ')} failed with exit=${result.code}${suffix}`);
      return result.code;
    }
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await runNpmTest(process.argv.slice(2));
  process.exit(code);
}
