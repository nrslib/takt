import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
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
import unitConfig from '../../vitest.config.unit.parallel.js';

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
  'createTestFindingLedgerStore',
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

function releaseCommands(): string[] {
  const [gateCommands, notification] = manifest.scripts['check:release'].split('; code=$?;');
  expect(notification).toContain('exit $code');
  return gateCommands.split(' && ');
}

function executeReleaseScript(failingCommand: string | undefined): {
  commands: string[];
  status: number | null;
  stdout: string;
} {
  const tempRoot = mkdtempSync(join(tmpdir(), 'takt-release-verification-'));
  const binDir = join(tempRoot, 'bin');
  const logPath = join(tempRoot, 'npm.log');
  const npmStubPath = join(binDir, 'npm');
  mkdirSync(binDir);
  writeFileSync(npmStubPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$TAKT_RELEASE_LOG"
if [ "$*" = "$TAKT_FAIL_COMMAND" ]; then
  exit 23
fi
`);
  chmodSync(npmStubPath, 0o755);

  try {
    const result = spawnSync('/bin/sh', ['-c', manifest.scripts['check:release']], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: binDir,
        TAKT_FAIL_COMMAND: failingCommand === undefined ? '' : failingCommand,
        TAKT_RELEASE_LOG: logPath,
      },
    });
    const commands = readFileSync(logPath, 'utf8').trim().split('\n');
    return { commands, status: result.status, stdout: result.stdout };
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
  });

  it('should run every release gate once', () => {
    const commands = releaseCommands();

    expect(commands).toEqual([
      'npm run build',
      'npm run lint',
      'npm run test',
      'npm run test:it:all',
      'npm run test:e2e:all',
    ]);
    expect(new Set(commands).size).toBe(commands.length);
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

    expect(heavyShardJob?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(heavyShardJob?.steps?.map((step) => step.run).filter(Boolean)).toContain(
      'npm run test:it:heavy:parallel -- --shard=${{ matrix.shard }}/4',
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
    expect(result.stdout).toContain('[takt] check:release passed');
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
    expect(result.stdout).toContain('[takt] check:release failed (exit=23)');
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
});
