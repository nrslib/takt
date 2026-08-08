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
import {
  parallelIntegrationTestFiles,
  parallelIntegrationTestGlobs,
  serialGitTestFiles,
  serialWorkflowTestFiles,
} from '../../scripts/test-classification.mjs';
import parallelIntegrationConfig from '../../vitest.config.it.parallel.js';
import unitConfig from '../../vitest.config.unit.parallel.js';

interface PackageManifest {
  scripts: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

const integrationBoundaryNames = new Set([
  'WorkflowEngine',
  'TeamLeaderRunner',
  'runAllTasks',
  'spawnManagedProcess',
  'runProbeProcess',
  'runSmokeScript',
  'initializeGitFixture',
  'createTestFindingLedgerStore',
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
  let importsChildProcess = false;
  let mocksChildProcess = false;
  let invokesBoundary = false;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const importClause = statement.importClause;
    if (statement.moduleSpecifier.text === 'node:child_process' && !importClause?.isTypeOnly) {
      importsChildProcess = true;
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
        && firstArgument.text === 'node:child_process'
      ) {
        mocksChildProcess = true;
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

  return invokesBoundary || (importsChildProcess && !mocksChildProcess);
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
      'test:it': 'npm run test:it:parallel && npm run test:it:serial',
      'test:it:parallel': 'vitest run --config vitest.config.it.parallel.ts',
      'test:it:serial': 'node scripts/run-it-serial-groups.mjs',
      'test:it:serial:git': 'vitest run --config vitest.config.it.serial.git.ts',
      'test:it:serial:workflow': 'vitest run --config vitest.config.it.serial.workflow.ts',
      'test:prompt-evals': 'node prompt-evals/run-smoke.mjs',
    });
  });

  it('should run every release gate once', () => {
    const commands = releaseCommands();

    expect(commands).toEqual([
      'npm run build',
      'npm run lint',
      'npm run test',
      'npm run test:it',
      'npm run test:prompt-evals',
      'npm run test:e2e:all',
    ]);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it('should execute the complete release path when every gate succeeds', () => {
    const result = executeReleaseScript(undefined);

    expect(result.commands).toEqual([
      'run build',
      'run lint',
      'run test',
      'run test:it',
      'run test:prompt-evals',
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
      failingCommand: 'run test:it',
      expectedCommands: ['run build', 'run lint', 'run test', 'run test:it'],
    },
    {
      failingCommand: 'run test:prompt-evals',
      expectedCommands: [
        'run build',
        'run lint',
        'run test',
        'run test:it',
        'run test:prompt-evals',
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
    const serialGit = new Set(serialGitTestFiles);
    const serialWorkflow = new Set(serialWorkflowTestFiles);
    const serialFiles = [...serialGit, ...serialWorkflow];

    expect(new Set(serialFiles).size).toBe(serialFiles.length);
    expect(parallelIntegration.size).toBe(parallelIntegrationTestFiles.length);
    for (const testFile of serialFiles) {
      expect(existsSync(new URL(`../../${testFile}`, import.meta.url))).toBe(true);
      expect(parallelIntegration.has(testFile)).toBe(false);
    }
    for (const testFile of parallelIntegration) {
      expect(existsSync(new URL(`../../${testFile}`, import.meta.url))).toBe(true);
      expect(serialGit.has(testFile)).toBe(false);
      expect(serialWorkflow.has(testFile)).toBe(false);
    }
    expect(parallelIntegrationConfig.test?.exclude).toEqual(serialFiles);
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
