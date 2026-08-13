import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  auditedIntegrationBoundaryTestFiles,
  fileSystemIntegrationTestFiles,
  heavyParallelIntegrationTestFiles,
  lightContractIntegrationTestFiles,
  lightIntegrationTestFiles,
  lightNamedIntegrationTestFiles,
  parallelIntegrationTestFiles,
  parallelIntegrationTestGlobs,
  publicContractIntegrationTestFiles,
  serialGitTestFiles,
  serialWorkflowTestFiles,
} from '../../scripts/test-classification.mjs';
import heavyParallelIntegrationConfig from '../../vitest.config.it.heavy.parallel.js';
import lightIntegrationConfig from '../../vitest.config.it.parallel.js';
import serialGitConfig from '../../vitest.config.it.serial.git.js';
import serialWorkflowConfig from '../../vitest.config.it.serial.workflow.js';
import unitConfig from '../../vitest.config.unit.parallel.js';
import { selectNpmTestRuns } from '../../scripts/run-npm-test.mjs';
import {
  RELEASE_GATE_SCRIPTS,
  RELEASE_LOG_RELATIVE_PATH,
  runReleaseCheck,
} from '../../scripts/run-release-check.mjs';

interface PackageManifest {
  scripts: Record<string, string>;
}

interface CiWorkflowStep {
  run?: string;
}

interface CiWorkflowJob {
  if?: string;
  name?: string;
  needs?: string[];
  strategy?: {
    matrix?: {
      os?: string[];
      shard?: number[];
      include?: Array<{
        group: string;
        script: string;
      }>;
    };
  };
  steps?: CiWorkflowStep[];
}

interface CiWorkflow {
  jobs?: Record<string, CiWorkflowJob>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageManifest;
const ciWorkflow = parseYaml(
  readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as CiWorkflow;

const integrationBoundaryNames = new Set([
  'WorkflowEngine',
  'TeamLeaderRunner',
  'captureReviewScopeProofSnapshot',
  'createWorkflowRunLifecycle',
  'runAllTasks',
  'runCommandQualityGate',
  'spawnManagedProcess',
  'runProbeProcess',
  'runSmokeScript',
  'prepareRuntimeEnvironment',
  'resolveTask',
  'initializeGitFixture',
]);

const integrationBuiltinModules = new Set([
  'node:child_process',
  'node:fs',
  'node:fs/promises',
  'node:net',
  'node:sqlite',
]);

function listTestFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? listTestFiles(path)
      : path.endsWith('.test.ts') ? [path] : [];
  });
}

function hasIntegrationBoundary(filePath: string): boolean {
  const sourceText = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const importedBoundaryNames = new Set<string>();
  const importedBuiltinModules = new Set<string>();
  const mockedModules = new Set<string>();
  let invokesBoundary = false;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const importClause = statement.importClause;
    if (
      integrationBuiltinModules.has(statement.moduleSpecifier.text)
      && !importClause?.isTypeOnly
    ) {
      importedBuiltinModules.add(statement.moduleSpecifier.text);
    }
    const namedBindings = importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (!element.isTypeOnly && integrationBoundaryNames.has(importedName)) {
        importedBoundaryNames.add(element.name.text);
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const firstArgument = node.arguments[0];
      if (
        ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && ['vi', 'jest'].includes(node.expression.expression.text)
        && node.expression.name.text === 'mock'
        && firstArgument !== undefined
        && ts.isStringLiteral(firstArgument)
      ) {
        mockedModules.add(firstArgument.text);
      }
      if (ts.isIdentifier(node.expression) && importedBoundaryNames.has(node.expression.text)) {
        invokesBoundary = true;
      }
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && importedBoundaryNames.has(node.expression.text)
    ) {
      invokesBoundary = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const importsUnmockedBuiltin = [...importedBuiltinModules]
    .some((moduleName) => !mockedModules.has(moduleName));
  return invokesBoundary || importsUnmockedBuiltin;
}

function hasIntegrationFileName(filePath: string): boolean {
  const fileName = basename(filePath);
  return fileName.startsWith('it-')
    || fileName.endsWith('.integration.test.ts')
    || fileName.endsWith('-integration.test.ts')
    || fileName.endsWith('.regression.test.ts')
    || fileName.endsWith('.performance.test.ts');
}

function executeReleaseScript(failingCommand: string | undefined): {
  commands: string[];
  status: number | null;
  stdout: string;
  log: string;
} {
  const tempRoot = mkdtempSync(join(tmpdir(), 'takt-release-verification-'));
  const repositoryRoot = process.cwd();
  const binDir = join(tempRoot, 'bin');
  const logPath = join(tempRoot, 'npm.log');
  const releaseLogPath = join(tempRoot, RELEASE_LOG_RELATIVE_PATH);
  const npmStubPath = join(binDir, 'npm-cli.js');
  mkdirSync(binDir);
  writeFileSync(npmStubPath, `
import { appendFileSync } from 'node:fs';

const command = process.argv.slice(2).join(' ');
appendFileSync(process.env.TAKT_RELEASE_LOG, command + '\\n');
process.stdout.write('stdout:' + command + '\\n');
process.stderr.write('stderr:' + command + '\\n');
if (command === process.env.TAKT_FAIL_COMMAND) {
  process.exit(23);
}
  `);
  mkdirSync(dirname(releaseLogPath), { recursive: true });
  writeFileSync(releaseLogPath, 'stale log entry\\n');

  try {
    const result = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/run-release-check.mjs')], {
      encoding: 'utf8',
      cwd: tempRoot,
      env: {
        ...process.env,
        npm_execpath: npmStubPath,
        TAKT_FAIL_COMMAND: failingCommand === undefined ? '' : failingCommand,
        TAKT_RELEASE_LOG: logPath,
      },
    });
    const commands = readFileSync(logPath, 'utf8').trim().split('\n');
    const log = readFileSync(releaseLogPath, 'utf8');
    return { commands, status: result.status, stdout: result.stdout, log };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe('release verification wiring', () => {
  it('should connect each public test entrypoint to its intended runner', () => {
    expect(manifest.scripts).toMatchObject({
      test: 'npm run test:type-contracts && node scripts/run-npm-test.mjs',
      'test:unit': 'vitest run --config vitest.config.unit.parallel.ts',
      'test:unit:parallel': 'vitest run --config vitest.config.unit.parallel.ts',
      'test:it': 'npm run test:it:light',
      'test:it:light': 'vitest run --config vitest.config.it.parallel.ts',
      'test:it:heavy': 'npm run test:it:heavy:parallel && npm run test:it:heavy:serial',
      'test:it:heavy:parallel': 'vitest run --config vitest.config.it.heavy.parallel.ts',
      'test:it:heavy:serial': 'node scripts/run-it-serial-groups.mjs',
      'test:it:heavy:serial:git': 'vitest run --config vitest.config.it.serial.git.ts',
      'test:it:heavy:serial:workflow': 'vitest run --config vitest.config.it.serial.workflow.ts',
      'test:it:all': 'npm run test:it && npm run test:it:heavy',
      'test:it:serial:git': 'npm run test:it:heavy:serial:git',
      'test:it:serial:workflow': 'npm run test:it:heavy:serial:workflow',
      'test:prompt-evals': 'node prompt-evals/run-smoke.mjs',
    });
    expect(manifest.scripts['test:e2e:provider:claude-sdk'])
      .toMatch(/TAKT_E2E_PROVIDER=claude-sdk/);
    expect(manifest.scripts['test:e2e:provider'])
      .toContain('test:e2e:provider:claude-sdk');
    expect(manifest.scripts['test:e2e:provider']!.indexOf('claude-sdk'))
      .toBeLessThan(manifest.scripts['test:e2e:provider']!.indexOf('provider:codex'));
  });

  it('should run every release gate once', () => {
    expect(manifest.scripts['check:release']).toBe('node scripts/run-release-check.mjs');
    expect(RELEASE_GATE_SCRIPTS).toEqual([
      'build',
      'lint',
      'test',
      'test:it:all',
      'test:e2e:all',
    ]);
    expect(new Set(RELEASE_GATE_SCRIPTS).size).toBe(RELEASE_GATE_SCRIPTS.length);
  });

  it('should run light integration and isolated heavy integration shards as pull-request gates', () => {
    const lightIntegrationJob = ciWorkflow.jobs?.it;
    const heavyShardJob = ciWorkflow.jobs?.heavy_it_shard;
    const heavySerialJob = ciWorkflow.jobs?.heavy_it_serial;
    const heavyAggregateJob = ciWorkflow.jobs?.heavy_it;

    expect(lightIntegrationJob?.name).toBe('test:it');
    expect(lightIntegrationJob?.steps?.map((step) => step.run).filter(Boolean)).toContain(
      'npm run test:it',
    );

    expect(heavyShardJob?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4, 5, 6]);
    expect(heavyShardJob?.steps?.map((step) => step.run).filter(Boolean)).toContain(
      'npm run test:it:heavy:parallel -- --shard=${{ matrix.shard }}/6',
    );

    expect(heavySerialJob?.strategy?.matrix?.include).toEqual([
      { group: 'git', script: 'test:it:heavy:serial:git' },
      { group: 'workflow', script: 'test:it:heavy:serial:workflow' },
    ]);
    expect(heavySerialJob?.steps?.map((step) => step.run).filter(Boolean)).toContain(
      'npm run ${{ matrix.script }}',
    );

    expect(heavyAggregateJob?.name).toBe('test:it:heavy');
    expect(heavyAggregateJob?.needs).toEqual(['heavy_it_shard', 'heavy_it_serial']);
    expect(heavyAggregateJob?.if).toBe('${{ always() }}');
    const aggregateCommand = heavyAggregateJob?.steps
      ?.map((step) => step.run)
      .filter(Boolean)
      .join('\n');
    expect(aggregateCommand).toContain('needs.heavy_it_shard.result');
    expect(aggregateCommand).toContain('needs.heavy_it_serial.result');
    expect(aggregateCommand).toContain('!= "success"');
    expect(aggregateCommand).toContain('exit 1');
  });

  it('should build and smoke test the Pi SDK on Windows and macOS', () => {
    const piJob = ciWorkflow.jobs?.['pi-cross-platform'];
    const commands = piJob?.steps?.map((step) => step.run).filter(Boolean);

    expect(piJob?.strategy?.matrix?.os).toEqual(['windows-latest', 'macos-latest']);
    expect(commands).toEqual(expect.arrayContaining([
      'npm ci',
      'npm run build',
      'npm test -- src/__tests__/pi-client.test.ts src/__tests__/pi-provider.test.ts',
      'npm run test:pi-sdk-smoke',
    ]));
  });

  it('should execute the complete release path when every gate succeeds', () => {
    const result = executeReleaseScript(undefined);

    expect(result.commands).toEqual([
      'run build',
      'run lint',
      'run test',
      'run test:it:all',
      'run test:e2e:all',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[takt] check:release log: ${RELEASE_LOG_RELATIVE_PATH}`);
    expect(result.stdout).toContain('[takt] check:release passed');
    expect(result.log).toContain(`[takt] check:release log: ${RELEASE_LOG_RELATIVE_PATH}`);
    expect(result.log).toContain('stdout:run build');
    expect(result.log).toContain('stderr:run build');
    expect(result.log).not.toContain('stale log entry');
  });

  it('should fail when the release log rejects the final result write', async () => {
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        const error = chunk.toString().includes('check:release passed')
          ? new Error('final release log write failed')
          : undefined;
        callback(error);
      },
    });
    const runCommand = vi.fn().mockResolvedValue({ code: 0, signal: null, output: '' });

    const code = await runReleaseCheck(runCommand, async () => logStream);

    expect(runCommand).toHaveBeenCalledTimes(RELEASE_GATE_SCRIPTS.length);
    expect(code).toBe(1);
  });

  it.each([
    {
      failingCommand: 'run lint',
      expectedCommands: ['run build', 'run lint'],
    },
    {
      failingCommand: 'run test:it:all',
      expectedCommands: ['run build', 'run lint', 'run test', 'run test:it:all'],
    },
    {
      failingCommand: 'run test:e2e:all',
      expectedCommands: [
        'run build',
        'run lint',
        'run test',
        'run test:it:all',
        'run test:e2e:all',
      ],
    },
  ])('should stop at a failing $failingCommand release gate and preserve its exit code', ({
    failingCommand,
    expectedCommands,
  }) => {
    const result = executeReleaseScript(failingCommand);

    expect(result.commands).toEqual(expectedCommands);
    expect(result.status).toBe(23);
    expect(result.stdout).toContain(`[takt] check:release log: ${RELEASE_LOG_RELATIVE_PATH}`);
    expect(result.stdout).toContain('[takt] check:release failed (exit=23)');
    expect(result.log).toContain('[takt] check:release failed (exit=23)');
    expect(result.log).not.toContain('stale log entry');
  });

  it('should keep fast unit and integration classifications disjoint', () => {
    const parallelIntegration = new Set(parallelIntegrationTestFiles);
    const lightIntegration = new Set(lightIntegrationTestFiles);
    const heavyParallelIntegration = new Set(heavyParallelIntegrationTestFiles);
    const serialGit = new Set(serialGitTestFiles);
    const serialWorkflow = new Set(serialWorkflowTestFiles);
    const serialFiles = [...serialGit, ...serialWorkflow];

    expect(new Set(serialFiles).size).toBe(serialFiles.length);
    expect(parallelIntegration.size).toBe(parallelIntegrationTestFiles.length);
    expect(lightIntegration.size).toBe(lightIntegrationTestFiles.length);
    expect(heavyParallelIntegration.size).toBe(heavyParallelIntegrationTestFiles.length);
    expect(auditedIntegrationBoundaryTestFiles).toEqual(
      [...auditedIntegrationBoundaryTestFiles].sort(),
    );
    expect(fileSystemIntegrationTestFiles).toEqual(
      [...fileSystemIntegrationTestFiles].sort(),
    );
    expect(publicContractIntegrationTestFiles).toEqual(
      [...publicContractIntegrationTestFiles].sort(),
    );
    expect(lightContractIntegrationTestFiles).toEqual(
      [...lightContractIntegrationTestFiles].sort(),
    );
    expect(lightNamedIntegrationTestFiles).toEqual(
      [...lightNamedIntegrationTestFiles].sort(),
    );
    for (const testFile of lightIntegration) {
      expect(heavyParallelIntegration.has(testFile)).toBe(false);
    }
    for (const testFile of serialFiles) {
      expect(existsSync(new URL(`../../${testFile}`, import.meta.url))).toBe(true);
      expect(parallelIntegration.has(testFile)).toBe(false);
    }
    for (const testFile of parallelIntegration) {
      expect(existsSync(new URL(`../../${testFile}`, import.meta.url))).toBe(true);
      expect(serialGit.has(testFile)).toBe(false);
      expect(serialWorkflow.has(testFile)).toBe(false);
    }
    expect(lightIntegrationConfig.test?.include).toEqual(lightIntegrationTestFiles);
    expect(heavyParallelIntegrationConfig.test?.include).toEqual([
      ...parallelIntegrationTestGlobs,
      ...heavyParallelIntegrationTestFiles,
    ]);
    expect(heavyParallelIntegrationConfig.test?.exclude).toEqual([
      ...lightIntegrationTestFiles,
      ...serialFiles,
    ]);
    expect(serialGitConfig.test?.include).toEqual(serialGitTestFiles);
    expect(serialWorkflowConfig.test?.include).toEqual(serialWorkflowTestFiles);
    expect(unitConfig.test?.exclude).toEqual([
      ...parallelIntegrationTestGlobs,
      ...parallelIntegrationTestFiles,
      ...serialFiles,
    ]);
  });

  it('should keep process, Git, storage, and workflow-engine boundaries out of unit tests', () => {
    const explicitlyClassified = new Set([
      ...parallelIntegrationTestFiles,
      ...serialGitTestFiles,
      ...serialWorkflowTestFiles,
    ]);
    const testRoot = fileURLToPath(new URL('.', import.meta.url));
    const unclassifiedBoundaryFiles = listTestFiles(testRoot)
      .filter(hasIntegrationBoundary)
      .map((filePath) => relative(process.cwd(), filePath).replaceAll('\\', '/'))
      .filter((filePath) => !hasIntegrationFileName(filePath) && !explicitlyClassified.has(filePath))
      .sort();

    expect(unclassifiedBoundaryFiles).toEqual([]);
  });

  it.each([
    {
      target: 'companion-prompt-loop.test.ts',
      script: 'test:unit:parallel',
      normalized: 'companion-prompt-loop.test.ts',
    },
    {
      target: 'src/__tests__/companion-mailbox.integration.test.ts',
      script: 'test:it:heavy:parallel',
      normalized: 'src/__tests__/companion-mailbox.integration.test.ts',
    },
    {
      target: 'companion-step-executor.integration.test.ts',
      script: 'test:it:heavy:parallel',
      normalized: 'companion-step-executor.integration.test.ts',
    },
    {
      target: 'src/__tests__/companion-step-executor.integration.test.ts',
      script: 'test:it:heavy:parallel',
      normalized: 'src/__tests__/companion-step-executor.integration.test.ts',
    },
    {
      target: 'src/__tests__/workflow-step-fragment-runtime.test.ts',
      script: 'test:it:heavy:serial:workflow',
      normalized: 'src/__tests__/workflow-step-fragment-runtime.test.ts',
    },
    {
      target: 'companion-diff-runtime.integration.test.ts',
      script: 'test:it:heavy:serial:git',
      normalized: 'src/__tests__/companion-diff-runtime.integration.test.ts',
    },
  ])('should route $target to $script', ({ target, script, normalized }) => {
    expect(selectNpmTestRuns([target])).toEqual([{
      npmArgs: ['run', script, '--', normalized],
    }]);
  });
});
