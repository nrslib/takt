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
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { JsonTestResults } from 'vitest/reporters';
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
import heavyParallelIntegrationConfig, { resolveHeavyItMaxWorkers } from '../../vitest.config.it.heavy.parallel.js';
import lightIntegrationConfig, { resolveLightItMaxWorkers } from '../../vitest.config.it.parallel.js';
import serialGitConfig from '../../vitest.config.it.serial.git.js';
import serialWorkflowConfig from '../../vitest.config.it.serial.workflow.js';
import unitConfig from '../../vitest.config.unit.parallel.js';
import defaultConfig from '../../vitest.config.js';
import { selectNpmTestRuns } from '../../scripts/run-npm-test.mjs';
import {
  RELEASE_GATE_SCRIPTS,
  RELEASE_LOG_RELATIVE_PATH,
  runReleaseCheck,
} from '../../scripts/run-release-check.mjs';

interface PackageManifest {
  scripts: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

/** Exercises the install hook without spawning npm or changing real dependencies. */
function runDependencyPostinstall(
  files: readonly string[],
  execute: (command: string, options: { stdio: string }) => unknown,
): void {
  const source = manifest.scripts.postinstall?.match(/^node -e "(.*)"$/)?.[1];
  if (source === undefined) {
    throw new Error('Expected a guarded Node postinstall hook');
  }
  runInNewContext(source, {
    /** Supplies only controlled filesystem and process mocks to the install-hook sandbox. */
    require: (specifier: string) => {
      if (specifier === 'node:fs') {
        return {
          /** Reports fixture file presence without reading the actual dependency tree. */
          existsSync: (path: string) => files.includes(path),
        };
      }
      if (specifier === 'node:child_process') {
        return { execSync: execute };
      }
      throw new Error(`Unexpected install-hook module: ${specifier}`);
    },
  });
}

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
]);

function listTestFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const isTestFile = path.endsWith('.test.ts') || path.endsWith('.test.tsx');
    return statSync(path).isDirectory()
      ? listTestFiles(path)
      : isTestFile ? [path] : [];
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

const localHeavyItEnv = {
  GITHUB_ACTIONS: '',
  GITHUB_EVENT_NAME: '',
  TAKT_ALLOW_FULL_HEAVY_IT: '',
};
const fullReleaseEnv = { ...localHeavyItEnv, TAKT_ALLOW_FULL_HEAVY_IT: '1' };
const staleReleaseLog = 'stale log entry\n';

function executeReleaseScript(failingCommand: string | undefined, heavyItEnv: NodeJS.ProcessEnv): {
  commands: string[];
  status: number | null;
  stdout: string;
  stderr: string;
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
  writeFileSync(releaseLogPath, staleReleaseLog);

  try {
    const result = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/run-release-check.mjs')], {
      encoding: 'utf8',
      cwd: tempRoot,
      env: {
        ...process.env,
        ...heavyItEnv,
        npm_execpath: npmStubPath,
        TAKT_FAIL_COMMAND: failingCommand === undefined ? '' : failingCommand,
        TAKT_RELEASE_LOG: logPath,
      },
      timeout: 10_000,
    });
    if (result.error !== undefined) {
      throw result.error;
    }
    const commands = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n') : [];
    const log = readFileSync(releaseLogPath, 'utf8');
    return { commands, status: result.status, stdout: result.stdout, stderr: result.stderr, log };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function executeHeavyItFixture(
  entrypoint: string,
  args: string[],
  heavyItEnv: NodeJS.ProcessEnv,
  configuredSearch?: 'root' | 'dir',
) {
  const root = mkdtempSync(join(tmpdir(), 'takt-heavy-it-guard-'));
  try {
    const cwd = join(root, 'caller');
    const testDir = join(root, 'src/__tests__');
    const callerTestDir = join(cwd, 'src/__tests__');
    mkdirSync(testDir, { recursive: true });
    mkdirSync(callerTestDir, { recursive: true });
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/test-notification-silence.cjs'), '');
    writeFileSync(join(testDir, 'test-setup.ts'), '');
    writeFileSync(join(testDir, 'it-heavy-guard-target.test.ts'), 'test("requested", () => expect(1).toBe(1));');
    writeFileSync(join(testDir, 'it-collision-it-heavy-guard-target.test.ts'), 'test("outside selection", () => expect(1).toBe(1));');
    writeFileSync(join(callerTestDir, 'it-heavy-guard-target.test.ts'), 'test("caller directory", () => expect(1).toBe(1));');

    let locationArgs = ['--root', root];
    if (configuredSearch !== undefined) {
      const configPath = join(root, 'vitest.config.ts');
      const configRoot = configuredSearch === 'root' ? root : join(root, 'scripts');
      const dir = configuredSearch === 'dir' ? '..' : undefined;
      const guardPath = fileURLToPath(new URL('../../scripts/vitest-heavy-it-guard.ts', import.meta.url));
      writeFileSync(configPath, `
import { heavyItGuard } from ${JSON.stringify(guardPath)};
export default {
  plugins: [heavyItGuard],
  root: ${JSON.stringify(configRoot)},
  test: ${JSON.stringify({ dir, include: ['src/__tests__/it-*.test.ts'] })},
};
      `);
      locationArgs = ['--config', configPath];
    }

    const npmStub = join(root, 'npm-cli.js');
    const preparationLog = join(root, 'npm-args.json');
    const reportPath = join(root, 'vitest-report.json');
    writeFileSync(npmStub, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.TAKT_PREPARATION_LOG, JSON.stringify(process.argv.slice(2)));
    `);

    const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== 'npm_config_ignore_scripts',
    ));
    const result = spawnSync(process.execPath, [
      join(process.cwd(), entrypoint), ...args, ...locationArgs, '--globals',
      '--reporter=json', '--outputFile.json', reportPath,
    ], {
      encoding: 'utf8',
      cwd,
      env: {
        ...inheritedEnv,
        ...localHeavyItEnv,
        ...heavyItEnv,
        npm_execpath: npmStub,
        TAKT_PREPARATION_LOG: preparationLog,
      },
      timeout: 10_000,
    });
    if (result.error !== undefined) {
      throw result.error;
    }
    const report = result.status === 0
      ? JSON.parse(readFileSync(reportPath, 'utf8')) as JsonTestResults
      : undefined;
    const passedTestTitles = report?.testResults
      .flatMap(({ assertionResults }) => assertionResults)
      .filter(({ status }) => status === 'passed')
      .map(({ title }) => title)
      .sort();
    return {
      status: result.status,
      stderr: result.stderr,
      passedTestTitles,
      preparation: existsSync(preparationLog) ? readFileSync(preparationLog, 'utf8') : '',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('release verification wiring', () => {

  it.each([
    { name: 'development checkout', patches: true, patchPackage: true, applies: true },
    { name: 'production checkout', patches: true, patchPackage: false, applies: false },
    { name: 'published bundle', patches: false, patchPackage: false, applies: false },
    { name: 'bundle with an unrelated patch-package', patches: false, patchPackage: true, applies: false },
  ])('should apply install-time patches only in a $name', ({ patches, patchPackage, applies }) => {
    const execute = vi.fn();
    const files = [
      ...(patches ? ['patches/ink+7.1.1.patch'] : []),
      ...(patchPackage ? ['node_modules/patch-package/index.js'] : []),
    ];
    runDependencyPostinstall(files, execute);
    if (applies) {
      expect(execute).toHaveBeenCalledExactlyOnceWith('npm run patch:dependencies', { stdio: 'inherit' });
    } else {
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('should not hide a failed install-time dependency patch', () => {
    expect(() => runDependencyPostinstall(
      ['patches/ink+7.1.1.patch', 'node_modules/patch-package/index.js'],
      () => { throw new Error('Patch failed'); },
    )).toThrow('Patch failed');
  });

  it('should validate the managed DeepSeek SDK lock', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../scripts/verify-deepseek-sdk-lock.mjs', import.meta.url))],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    );

    if (result.error !== undefined) {
      throw result.error;
    }
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('should execute the complete release path when every gate succeeds', () => {
    const result = executeReleaseScript(undefined, fullReleaseEnv);

    expect(result.commands).toEqual([
      'run sync:nix-deps',
      'run build',
      'run test:global-install',
      'run test:managed-install',
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

  it('should refuse a full release check before starting dependency sync or opening its log', () => {
    const result = executeReleaseScript(undefined, { ...localHeavyItEnv, CI: 'true' });

    expect(result.status).toBe(1);
    expect(result.commands).toEqual([]);
    expect(result.log).toBe(staleReleaseLog);
    expect(result.stderr).toContain('TAKT_ALLOW_FULL_HEAVY_IT=1');
  });

  it.each([
    { filter: [], env: { CI: 'true' } },
    { filter: [], env: { GITHUB_EVENT_NAME: 'pull_request' } },
    { filter: [], env: { TAKT_ALLOW_FULL_HEAVY_IT: 'true' } },
    { filter: ['--shard=1/6'], env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' } },
    { filter: ['-t', 'it-heavy-guard-target.test.ts'], env: {} },
    { filter: ['--reporter', 'it-heavy-guard-target.test.ts'], env: {} },
    { filter: ['src/__tests__'], env: {} },
    { filter: ['it-*.test.ts'], env: {} },
  ])('should refuse unscoped Heavy IT before SDK preparation ($filter)', ({ filter, env }) => {
    const result = executeHeavyItFixture('scripts/run-heavy-it-parallel.mjs', filter, env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm test -- src/__tests__/<file>.test.ts');
    expect(result.preparation).toBe('');
  });

  it('should refuse unscoped execution of a directly loaded Heavy IT config', () => {
    const result = executeHeavyItFixture('node_modules/vitest/vitest.mjs', [
      'run', '--config', join(process.cwd(), 'vitest.config.it.heavy.parallel.ts'),
    ], {});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TAKT_ALLOW_FULL_HEAVY_IT=1');
  });

  it.each([
    'it-heavy-guard-target.test.ts',
    'src/__tests__/it-heavy-guard-target.test.ts',
  ])('should prepare and run only the explicitly selected Heavy IT file (%s)', (filter) => {
    const result = executeHeavyItFixture('scripts/run-heavy-it-parallel.mjs', [
      filter,
    ], {});

    expect(result.status, result.stderr).toBe(0);
    expect(result.preparation).toBe(JSON.stringify(['run', 'test:deepseek-harness:types']));
    expect(result.passedTestTitles).toEqual(['requested']);
  });

  it.each(['root', 'dir'] as const)('should use the scan directory from Vitest config (%s)', (setting) => {
    const result = executeHeavyItFixture('node_modules/vitest/vitest.mjs', [
      'run', 'src/__tests__/it-collision-it-heavy-guard-target.test.ts',
    ], {}, setting);

    expect(result.status, result.stderr).toBe(0);
    expect(result.passedTestTitles).toEqual(['outside selection']);
  });

  it('should skip Heavy IT setup when npm disables lifecycle scripts via the uppercase variable', () => {
    const result = executeHeavyItFixture('scripts/run-heavy-it-parallel.mjs', [
      'src/__tests__/it-heavy-guard-target.test.ts',
    ], { NPM_CONFIG_IGNORE_SCRIPTS: 'true' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.passedTestTitles).toEqual(['requested']);
    expect(result.preparation).toBe('');
  });

  it.skipIf(process.platform === 'win32')('should prefer lowercase npm config when both spellings exist', () => {
    const result = executeHeavyItFixture('scripts/run-heavy-it-parallel.mjs', [
      'src/__tests__/it-heavy-guard-target.test.ts',
    ], { npm_config_ignore_scripts: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'false' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.passedTestTitles).toEqual(['requested']);
    expect(result.preparation).toBe('');
  });

  it.skipIf(process.platform === 'win32')('should prepare Heavy IT when the npm CLI re-enables lifecycle scripts', () => {
    const result = executeHeavyItFixture('scripts/run-heavy-it-parallel.mjs', [
      'src/__tests__/it-heavy-guard-target.test.ts',
    ], { npm_config_ignore_scripts: '', NPM_CONFIG_IGNORE_SCRIPTS: 'true' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.passedTestTitles).toEqual(['requested']);
    expect(result.preparation).toBe(JSON.stringify(['run', 'test:deepseek-harness:types']));
  });

  it('should allow an unscoped Heavy IT run in GitHub Actions pull-request CI', () => {
    const result = executeHeavyItFixture('scripts/run-heavy-it-parallel.mjs', [], {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.passedTestTitles).toEqual(['outside selection', 'requested']);
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

    vi.stubEnv('TAKT_ALLOW_FULL_HEAVY_IT', '1');
    try {
      const code = await runReleaseCheck(runCommand, async () => logStream);

      expect(runCommand).toHaveBeenCalledTimes(RELEASE_GATE_SCRIPTS.length);
      expect(code).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      failingCommand: 'run sync:nix-deps',
      expectedCommands: ['run sync:nix-deps'],
    },
    {
      failingCommand: 'run lint',
      expectedCommands: ['run sync:nix-deps', 'run build', 'run test:global-install', 'run test:managed-install', 'run lint'],
    },
    {
      failingCommand: 'run test:it:all',
      expectedCommands: ['run sync:nix-deps', 'run build', 'run test:global-install', 'run test:managed-install', 'run lint', 'run test', 'run test:it:all'],
    },
    {
      failingCommand: 'run test:e2e:all',
      expectedCommands: [
        'run sync:nix-deps',
        'run build',
        'run test:global-install',
        'run test:managed-install',
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
    const result = executeReleaseScript(failingCommand, fullReleaseEnv);

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
    expect(defaultConfig.test?.exclude).toEqual(unitConfig.test?.exclude);
  });

  it.each([
    { cpuCount: 1, isCi: false, expected: 1 },
    { cpuCount: 2, isCi: false, expected: 1 },
    { cpuCount: 3, isCi: false, expected: 2 },
    { cpuCount: 10, isCi: false, expected: 2 },
    { cpuCount: 10, isCi: true, expected: 1 },
  ])('should run light integration with $expected worker(s) on $cpuCount CPUs (CI: $isCi)', ({
    cpuCount,
    isCi,
    expected,
  }) => {
    expect(resolveLightItMaxWorkers(cpuCount, isCi)).toBe(expected);
  });

  it('should apply the local or CI worker limit to the light integration gate', () => {
    expect(lightIntegrationConfig.test?.maxWorkers).toBe(
      resolveLightItMaxWorkers(availableParallelism(), Boolean(process.env.CI)),
    );
  });

  it.each([
    { cpuCount: 1, isCi: false, expected: 1 },
    { cpuCount: 2, isCi: false, expected: 1 },
    { cpuCount: 3, isCi: false, expected: 1 },
    { cpuCount: 4, isCi: false, expected: 2 },
    { cpuCount: 8, isCi: false, expected: 4 },
    { cpuCount: 10, isCi: false, expected: 4 },
    { cpuCount: 16, isCi: false, expected: 4 },
    { cpuCount: 10, isCi: true, expected: 1 },
  ])('should run heavy integration with $expected worker(s) on $cpuCount CPUs (CI: $isCi)', ({
    cpuCount,
    isCi,
    expected,
  }) => {
    expect(resolveHeavyItMaxWorkers(cpuCount, isCi)).toBe(expected);
  });

  it('should apply the local or CI worker limit to the heavy integration gate', () => {
    expect(heavyParallelIntegrationConfig.test?.maxWorkers).toBe(
      resolveHeavyItMaxWorkers(availableParallelism(), Boolean(process.env.CI)),
    );
  });

  it('should route the measured slow integration suites to the sharded heavy gate', () => {
    const movedFiles = [
      'src/__tests__/deepseek-harness-error-mapping.test.ts',
      'src/__tests__/it-issue-dispatch-notification.test.ts',
      'src/__tests__/it-manager-question-display.test.ts',
      'src/__tests__/it-manager-tui.test.ts',
      'src/__tests__/it-workflow-maker-retry-availability.test.ts',
      'src/__tests__/tui-conversation-view.test.tsx',
    ];

    for (const testFile of movedFiles) {
      expect(lightIntegrationTestFiles).not.toContain(testFile);
      expect(heavyParallelIntegrationTestFiles).toContain(testFile);
    }
    expect(selectNpmTestRuns(movedFiles)).toEqual([
      { npmArgs: ['run', 'test:it:heavy:parallel', '--ignore-scripts', '--', ...movedFiles] },
    ]);
  });

  it('routes tell task specification persistence through the light integration gate', () => {
    const testFile = 'src/__tests__/it-live-intervention-task-spec.test.ts';

    expect(selectNpmTestRuns([testFile])).toEqual([
      { npmArgs: ['run', 'test:it:light', '--', testFile] },
    ]);
  });

  it('routes system command configuration to light IT and excludes it from heavy IT', () => {
    const testFile = 'src/__tests__/it-system-command-input-config.test.ts';
    expect(lightIntegrationConfig.test?.include).toContain(testFile);
    expect(heavyParallelIntegrationConfig.test?.exclude).toContain(testFile);
    expect(selectNpmTestRuns([testFile])).toEqual([
      { npmArgs: ['run', 'test:it:light', '--', testFile] },
    ]);
  });

  it('routes tell publication concurrency through the heavy integration gate', () => {
    const testFile = 'src/__tests__/it-live-intervention-task-spec-concurrency.test.ts';
    expect(selectNpmTestRuns([testFile])).toEqual([
      { npmArgs: ['run', 'test:it:heavy:parallel', '--ignore-scripts', '--', testFile] },
    ]);
  });

  it('routes Epic filesystem storage to light IT and real Git lifecycle scenarios to heavy IT', () => {
    const storage = 'src/__tests__/epic-storage.integration.test.ts';
    const lifecycle = 'src/__tests__/it-workspace-epics.test.ts';
    expect(lightIntegrationConfig.test?.include).toContain(storage);
    expect(heavyParallelIntegrationConfig.test?.exclude).toContain(storage);
    expect(selectNpmTestRuns([storage, lifecycle])).toEqual([
      { npmArgs: ['run', 'test:it:light', '--', storage] },
      { npmArgs: ['run', 'test:it:heavy:parallel', '--ignore-scripts', '--', lifecycle] },
    ]);
  });

  it('should type-check every test on the whitelist, and only tests that exist', () => {
    const testsConfigPath = new URL('../../tsconfig.tests.json', import.meta.url);
    // The file carries the rule as comments, which JSON.parse does not take.
    const raw = readFileSync(testsConfigPath, 'utf-8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const listed = (JSON.parse(raw) as { include: string[] }).include;

    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toContain('src/__tests__/epic-schema.test.ts');
    expect(listed).toContain('src/__tests__/epic-storage.integration.test.ts');
    expect(listed).toContain('src/__tests__/it-workspace-epics.test.ts');
    expect(listed).toContain('src/__tests__/initialization.test.ts');
    expect(listed).toContain('src/__tests__/it-live-intervention-engine.test.ts');
    expect(listed).toContain('src/__tests__/it-live-intervention-task-spec.test.ts');
    expect(listed).toContain('src/__tests__/taskSpecContext.test.ts');
    expect(listed).toContain('src/__tests__/it-live-intervention-task-spec-concurrency.test.ts');
    expect(listed).toContain('src/__tests__/liveInterventionPersistence.test.ts');
    expect(listed, 'the list is read by people; keep it sorted').toEqual([...listed].sort());
    for (const entry of listed) {
      expect(existsSync(new URL(`../../${entry}`, import.meta.url)), entry).toBe(true);
    }

    // The gate has to run it, or the list is decoration.
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['test:types']).toContain('tsconfig.tests.json');
    expect(packageJson.scripts.test).toContain('test:types');
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
      target: 'src/__tests__/sdk-version-update.test.ts',
      script: 'test:it:light',
      normalized: 'src/__tests__/sdk-version-update.test.ts',
    },
    {
      target: 'companion-prompt-loop.test.ts',
      script: 'test:unit:parallel',
      normalized: 'companion-prompt-loop.test.ts',
    },
    {
      target: 'src/__tests__/statusLine.test.ts',
      script: 'test:it:light',
      normalized: 'src/__tests__/statusLine.test.ts',
    },
    {
      target: 'statusLine.test.ts',
      script: 'test:it:light',
      normalized: 'src/__tests__/statusLine.test.ts',
    },
    {
      target: 'src/__tests__/taskDeleteActions.test.ts',
      script: 'test:it:heavy:parallel',
      normalized: 'src/__tests__/taskDeleteActions.test.ts',
    },
    {
      target: 'taskDeleteActions.test.ts',
      script: 'test:it:heavy:parallel',
      normalized: 'src/__tests__/taskDeleteActions.test.ts',
    },
    {
      target: 'src/__tests__/it-web-ui-retry-dom.test.ts',
      script: 'test:it:heavy:parallel',
      normalized: 'src/__tests__/it-web-ui-retry-dom.test.ts',
    },
    {
      target: 'src/__tests__/codex-spawn-guard.test.ts',
      script: 'test:it:heavy:parallel',
      normalized: 'src/__tests__/codex-spawn-guard.test.ts',
    },
    {
      target: 'codex-spawn-guard.test.ts',
      script: 'test:it:heavy:parallel',
      normalized: 'src/__tests__/codex-spawn-guard.test.ts',
    },
    {
      target: 'it-web-ui-retry-dom.test.ts',
      script: 'test:it:heavy:parallel',
      normalized: 'src/__tests__/it-web-ui-retry-dom.test.ts',
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
    {
      target: 'src/__tests__/caccia-published-pr.integration.test.ts',
      script: 'test:it:heavy:serial:git',
      normalized: 'src/__tests__/caccia-published-pr.integration.test.ts',
    },
    {
      target: 'caccia-published-pr.integration.test.ts',
      script: 'test:it:heavy:serial:git',
      normalized: 'src/__tests__/caccia-published-pr.integration.test.ts',
    },
    {
      target: 'src/__tests__/it-list-filtered-delete.test.ts',
      script: 'test:it:heavy:serial:git',
      normalized: 'src/__tests__/it-list-filtered-delete.test.ts',
    },
    {
      target: 'it-list-filtered-delete.test.ts',
      script: 'test:it:heavy:serial:git',
      normalized: 'src/__tests__/it-list-filtered-delete.test.ts',
    },
  ])('should route $target to $script', ({ target, script, normalized }) => {
    expect(selectNpmTestRuns([target])).toEqual([{
      npmArgs: [
        'run',
        script,
        ...(['test:unit:parallel', 'test:it:heavy:parallel'].includes(script) ? ['--ignore-scripts'] : []),
        '--',
        normalized,
      ],
    }]);
  });
});
