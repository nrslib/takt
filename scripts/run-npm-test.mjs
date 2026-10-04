#!/usr/bin/env node

import { availableParallelism } from 'node:os';
import { basename, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  heavyParallelIntegrationTestFiles,
  lightIntegrationTestFiles,
  parallelIntegrationTestFiles,
  serialGitTestFiles,
  serialWorkflowTestFiles,
} from './test-classification.mjs';
import { resolveNpmInvocation } from './npm-invocation.mjs';
import { runTeedCommand } from './teed-command.mjs';
import {
  BIRPC_REMEASURE_ON_CI_ENV,
  isBirpcNoiseOnlyFailure,
} from './vitest-birpc-noise.mjs';

const MAX_LOCAL_UNIT_SHARDS = 8;
// Keep headroom for the npm parent, the OS, and test setup on low-core machines.
const LOCAL_PARALLELISM_HEADROOM = 2;
const NO_ARG_UNIT_RUN_OPTIONS = ['--maxWorkers=1'];
const INTEGRATION_NOTICE = '[takt] Fast unit gate only. After implementation run "npm run test:it" for light integration coverage. If you add or change an integration test, run the classification contract by itself with "npm test -- src/__tests__/releaseVerificationWiring.test.ts". The main pull-request CI workflow and "npm run check:release" run heavy integration coverage too. If you add or change a heavy integration test, run that file directly with "npm test -- <test-file>" before handoff.';
const PARALLEL_TEST_SCRIPTS = new Set([
  'test:unit:parallel',
  'test:it:light',
  'test:it:heavy:parallel',
]);
const SERIAL_TEST_SCRIPTS = [
  'test:it:heavy:serial:git',
  'test:it:heavy:serial:workflow',
];
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

export function resolveLocalUnitShardCount(availableParallelismCount) {
  if (!Number.isInteger(availableParallelismCount) || availableParallelismCount < 1) {
    throw new RangeError(`availableParallelism must be a positive integer: ${availableParallelismCount}`);
  }
  return Math.min(
    MAX_LOCAL_UNIT_SHARDS,
    Math.max(1, availableParallelismCount - LOCAL_PARALLELISM_HEADROOM),
  );
}

export function selectNpmTestRuns(args, unitShardCount) {
  if (args.length === 0) {
    const resolvedUnitShardCount = unitShardCount
      ?? resolveLocalUnitShardCount(availableParallelism());
    return createUnitShardRuns(resolvedUnitShardCount).map((shard) => ({
      npmArgs: ['run', 'test:unit:parallel', '--', `--shard=${shard}`, ...NO_ARG_UNIT_RUN_OPTIONS],
    }));
  }

  const targets = splitTestTargets(args);
  if (!hasExplicitTargets(targets)) {
    return buildDefaultRuns(targets.shared);
  }
  return [
    buildTargetedRun('test:unit:parallel', targets.shared, targets.unit),
    buildTargetedRun('test:it:light', targets.shared, targets.lightIntegration),
    buildTargetedRun('test:it:heavy:parallel', targets.shared, targets.heavyIntegration),
    buildTargetedRun('test:it:heavy:serial:git', targets.shared, targets.serialGit),
    buildTargetedRun('test:it:heavy:serial:workflow', targets.shared, targets.serialWorkflow),
  ].filter((run) => run !== undefined);
}

function createUnitShardRuns(unitShardCount) {
  if (!Number.isInteger(unitShardCount) || unitShardCount < 1) {
    throw new RangeError(`unitShardCount must be a positive integer: ${unitShardCount}`);
  }
  return Array.from(
    { length: unitShardCount },
    (_, index) => `${index + 1}/${unitShardCount}`,
  );
}

function buildDefaultRuns(shared) {
  const separator = shared.length > 0 ? ['--', ...shared] : [];
  return [{ npmArgs: ['run', 'test:unit:parallel', ...separator] }];
}

function hasExplicitTargets(targets) {
  return targets.unit.length > 0
    || targets.lightIntegration.length > 0
    || targets.heavyIntegration.length > 0
    || targets.serialGit.length > 0
    || targets.serialWorkflow.length > 0;
}

function splitTestTargets(args) {
  const shared = [];
  const unit = [];
  const lightIntegration = [];
  const heavyIntegration = [];
  const serialGit = [];
  const serialWorkflow = [];

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
    } else if (isSerialGitTarget(arg)) {
      serialGit.push(normalizeTestTarget(arg));
    } else if (isSerialWorkflowTarget(arg)) {
      serialWorkflow.push(normalizeTestTarget(arg));
    } else if (isHeavyIntegrationTestTarget(arg)) {
      heavyIntegration.push(normalizeTestTarget(arg));
    } else if (isLightIntegrationTestTarget(arg)) {
      lightIntegration.push(normalizeTestTarget(arg));
    } else {
      unit.push(normalizeTestTarget(arg));
    }
  }

  return { shared, unit, lightIntegration, heavyIntegration, serialGit, serialWorkflow };
}

function buildTargetedRun(script, shared, targets) {
  if (targets.length === 0) {
    return undefined;
  }
  return { npmArgs: ['run', script, '--', ...shared, ...targets] };
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

function isHeavyIntegrationTestTarget(arg) {
  if (arg.startsWith('-')) {
    return false;
  }

  const normalizedTarget = normalizeTestTarget(arg);
  if (lightIntegrationTestFiles.includes(normalizedTarget)) {
    return false;
  }

  const fileName = basename(arg);
  return fileName.startsWith('it-')
    || fileName.endsWith('.integration.test.ts')
    || fileName.endsWith('-integration.test.ts')
    || fileName.endsWith('.regression.test.ts')
    || fileName.endsWith('.performance.test.ts')
    || heavyParallelIntegrationTestFiles.includes(normalizedTarget);
}

function isLightIntegrationTestTarget(arg) {
  if (arg.startsWith('-')) {
    return false;
  }
  return lightIntegrationTestFiles.includes(normalizeTestTarget(arg));
}

function isSerialGitTarget(arg) {
  return serialGitTestFiles.includes(normalizeTestTarget(arg));
}

function isSerialWorkflowTarget(arg) {
  return serialWorkflowTestFiles.includes(normalizeTestTarget(arg));
}

function normalizeTestTarget(arg) {
  const slashNormalized = arg.replaceAll('\\', '/');
  const workspaceRelative = isAbsolute(slashNormalized)
    ? relative(process.cwd(), slashNormalized).replaceAll('\\', '/')
    : slashNormalized.replace(/^\.\//, '');
  if (workspaceRelative.includes('/')) {
    return workspaceRelative;
  }
  const matchingClassifiedTargets = [
    ...parallelIntegrationTestFiles,
    ...serialGitTestFiles,
    ...serialWorkflowTestFiles,
  ]
    .filter((target) => basename(target) === workspaceRelative);
  return matchingClassifiedTargets.length === 1
    ? matchingClassifiedTargets[0]
    : workspaceRelative;
}

async function runNpmCommand(npmArgs) {
  const invocation = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
  // Shard output is teed rather than inherited so a non-zero exit can be read
  // back and classified before it is reported as a failure.
  try {
    return await runTeedCommand(invocation.executable, [...invocation.args, ...npmArgs]);
  } catch (error) {
    console.error(`[takt] Failed to start npm ${npmArgs.join(' ')}: ${error.message}`);
    return {
      code: 1,
      signal: null,
      output: '',
    };
  }
}

async function remeasureBirpcNoiseShards(results, runCommand) {
  const isCI = Boolean(process.env.CI);
  const remeasureOnCI = process.env[BIRPC_REMEASURE_ON_CI_ENV] === '1';
  const settled = [];
  for (const { run, result } of results) {
    if (result.code === 0 || !isBirpcNoiseOnlyFailure({
      output: result.output,
      isCI,
      remeasureOnCI,
    })) {
      settled.push({ run, result });
      continue;
    }
    console.error(
      `[takt] npm ${run.npmArgs.join(' ')} exited ${result.code} with every test passed and only birpc noise; re-measuring this shard once`,
    );
    settled.push({ run, result: await runCommand(run.npmArgs) });
  }
  return settled;
}

export async function executeNpmTestRuns(runs, runCommand) {
  const indexedRuns = runs.map((run, index) => ({ run, index }));
  const parallelRuns = indexedRuns.filter(({ run }) => PARALLEL_TEST_SCRIPTS.has(run.npmArgs[1]));
  const serialRuns = SERIAL_TEST_SCRIPTS.flatMap((script) =>
    indexedRuns.filter(({ run }) => run.npmArgs[1] === script));
  if (parallelRuns.length + serialRuns.length !== runs.length) {
    const unknownScripts = indexedRuns
      .filter(({ run }) => !PARALLEL_TEST_SCRIPTS.has(run.npmArgs[1]) && !SERIAL_TEST_SCRIPTS.includes(run.npmArgs[1]))
      .map(({ run }) => run.npmArgs[1] ?? '(missing)');
    throw new Error(`Unknown npm test runner classification: ${[...new Set(unknownScripts)].join(', ')}`);
  }
  const executeRun = async (run) => ({
    ...run,
    result: await runCommand(run.run.npmArgs),
  });
  const results = await Promise.all(parallelRuns.map(executeRun));
  for (const run of serialRuns) {
    results.push(await executeRun(run));
  }
  return results.sort((left, right) => left.index - right.index);
}

export async function runNpmTest(args, runCommand = runNpmCommand, unitShardCount) {
  if (!hasExplicitTargets(splitTestTargets(args))) {
    console.log(INTEGRATION_NOTICE);
  }
  const results = await executeNpmTestRuns(selectNpmTestRuns(args, unitShardCount), runCommand);

  const failed = (await remeasureBirpcNoiseShards(results, runCommand))
    .filter(({ result }) => result.code !== 0);
  for (const { run, result } of failed) {
    const suffix = result.signal ? ` signal=${result.signal}` : '';
    console.error(`[takt] npm ${run.npmArgs.join(' ')} failed with exit=${result.code}${suffix}`);
  }

  return failed[0]?.result.code ?? 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await runNpmTest(process.argv.slice(2));
  process.exit(code);
}
