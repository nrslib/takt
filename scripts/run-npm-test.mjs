#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { basename, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  serialGitTestFiles,
  serialWorkflowTestFiles,
} from './test-classification.mjs';
import { resolveNpmInvocation } from './npm-invocation.mjs';

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
  if (!hasExplicitTargets(targets)) {
    return buildDefaultRuns(targets.shared);
  }
  return [
    buildTargetedRun('test:unit:parallel', targets.shared, targets.unit),
    buildTargetedRun('test:it:parallel', targets.shared, targets.integration),
    buildTargetedRun('test:it:serial:git', targets.shared, targets.serialGit),
    buildTargetedRun('test:it:serial:workflow', targets.shared, targets.serialWorkflow),
  ].filter((run) => run !== undefined);
}

function buildDefaultRuns(shared) {
  const separator = shared.length > 0 ? ['--', ...shared] : [];
  return [{ npmArgs: ['run', 'test:unit:parallel', ...separator] }];
}

function hasExplicitTargets(targets) {
  return targets.unit.length > 0
    || targets.integration.length > 0
    || targets.serialGit.length > 0
    || targets.serialWorkflow.length > 0;
}

function splitTestTargets(args) {
  const shared = [];
  const unit = [];
  const integration = [];
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
    } else if (isIntegrationTestTarget(arg)) {
      integration.push(normalizeTestTarget(arg));
    } else {
      unit.push(normalizeTestTarget(arg));
    }
  }

  return { shared, unit, integration, serialGit, serialWorkflow };
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
  const matchingClassifiedTargets = [...serialGitTestFiles, ...serialWorkflowTestFiles]
    .filter((target) => basename(target) === workspaceRelative);
  return matchingClassifiedTargets.length === 1
    ? matchingClassifiedTargets[0]
    : workspaceRelative;
}

async function runNpmCommand(npmArgs) {
  return new Promise((resolve) => {
    const invocation = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
    const child = spawn(invocation.executable, [...invocation.args, ...npmArgs], {
      stdio: 'inherit',
      shell: false,
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

export async function runNpmTest(args, runCommand = runNpmCommand) {
  const runs = selectNpmTestRuns(args);
  const results = args.length === 0
    ? await runNpmTestCommandsSequentially(runs, runCommand)
    : await Promise.all(runs.map(async (run) => {
        const result = await runCommand(run.npmArgs);
        return { run, result };
      }));

  const failed = results.filter(({ result }) => result.code !== 0);
  for (const { run, result } of failed) {
    const suffix = result.signal ? ` signal=${result.signal}` : '';
    console.error(`[takt] npm ${run.npmArgs.join(' ')} failed with exit=${result.code}${suffix}`);
  }

  return failed[0]?.result.code ?? 0;
}

async function runNpmTestCommandsSequentially(runs, runCommand) {
  const results = [];
  for (const run of runs) {
    const result = await runCommand(run.npmArgs);
    results.push({ run, result });
  }
  return results;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await runNpmTest(process.argv.slice(2));
  process.exit(code);
}
