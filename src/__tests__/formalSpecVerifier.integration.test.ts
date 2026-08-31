import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnedProcessCalls } = vi.hoisted(() => ({
  spawnedProcessCalls: [] as Array<{ command: string; args: readonly string[] }>,
}));

const { fakeQuintVerify } = vi.hoisted(() => ({
  fakeQuintVerify: { mode: 'passthrough' as 'passthrough' | 'passed' | 'failed' },
}));

vi.mock('../shared/utils/spawn.js', async () => {
  const actual = await vi.importActual<typeof import('../shared/utils/spawn.js')>('../shared/utils/spawn.js');
  return {
    ...actual,
    spawnManagedProcess: (...args: Parameters<typeof actual.spawnManagedProcess>) => {
      spawnedProcessCalls.push({ command: args[0], args: [...args[1]] });
      if (fakeQuintVerify.mode !== 'passthrough' && args[1][1] === 'verify') {
        const exitCode = fakeQuintVerify.mode === 'failed' ? 1 : 0;
        const script = exitCode === 0
          ? 'process.exit(0)'
          : "process.stderr.write('counterexample'); process.exit(1)";
        return actual.spawnManagedProcess(
          process.execPath,
          ['-e', script],
          args[2],
          args[3],
          args[4],
        );
      }
      return actual.spawnManagedProcess(...args);
    },
  };
});

import { runFormalSpecVerification } from '../features/interactive/formalSpecVerifier.js';

const require = createRequire(import.meta.url);

function runQuint(quintCli: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [quintCli, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
}

interface AlloyFixture {
  readonly jarPath: string;
  readonly logPath: string;
}

function assertCommandSucceeded(result: ReturnType<typeof spawnSync>): void {
  expect(result.status, String(result.stderr || result.error?.message || '')).toBe(0);
}

function buildAlloyFixture(directory: string): AlloyFixture {
  const sourceDirectory = join(directory, 'alloy-fixture-source');
  const classesDirectory = join(directory, 'alloy-fixture-classes');
  const sourcePath = join(sourceDirectory, 'AlloyFixture.java');
  const jarPath = join(directory, 'alloy-fixture.jar');
  const logPath = join(directory, 'alloy-fixture-invocations.log');
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(classesDirectory, { recursive: true });
  writeFileSync(sourcePath, [
    'import java.nio.file.Files;',
    'import java.nio.file.Path;',
    'import java.nio.file.StandardOpenOption;',
    'import java.util.Locale;',
    '',
    'public final class AlloyFixture {',
    '  private static final String SEPARATOR = "\\u001f";',
    '',
    '  public static void main(String[] args) throws Exception {',
    '    String logPath = System.getenv("TAKT_ALLOY_FIXTURE_LOG");',
    '    if (logPath != null && !logPath.isEmpty()) {',
    '      Files.writeString(',
    '        Path.of(logPath),',
    '        String.join(SEPARATOR, args) + System.lineSeparator(),',
    '        StandardOpenOption.CREATE,',
    '        StandardOpenOption.APPEND',
    '      );',
    '    }',
    '    if (args.length == 0) {',
    '      System.exit(2);',
    '    }',
    '    if ("commands".equals(args[0])) {',
    '      printCommands(Path.of(args[args.length - 1]));',
    '      return;',
    '    }',
    '    if ("exec".equals(args[0])) {',
    '      int command = commandNumber(args);',
    '      if (!isCheckCommand(Path.of(args[args.length - 1]), command)) {',
    '        System.err.print("run commands are not executable checks");',
    '        System.exit(2);',
    '      }',
    '      return;',
    '    }',
    '    System.exit(2);',
    '  }',
    '',
    '  private static void printCommands(Path specification) throws Exception {',
    '    int number = 0;',
    '    for (String rawLine : Files.readAllLines(specification)) {',
    '      String line = rawLine.trim();',
    '      if (line.isEmpty() || line.startsWith("//")) {',
    '        continue;',
    '      }',
    '      if (line.startsWith("check ")) {',
    '        printCommand(number++, "check", line);',
    '      } else if (line.startsWith("run ")) {',
    '        printCommand(number++, "run", line);',
    '      }',
    '    }',
    '  }',
    '',
    '  private static void printCommand(int number, String type, String declaration) {',
    '    String label = declaration.substring(type.length()).trim();',
    '    int scopeIndex = label.indexOf(" for ");',
    '    if (scopeIndex >= 0) {',
    '      label = label.substring(0, scopeIndex).trim();',
    '    }',
    '    String displayType = type.substring(0, 1).toUpperCase(Locale.ROOT) + type.substring(1);',
    '    System.out.printf(Locale.ROOT, "%-2d. %s%n", number, displayType + " " + label + " for 1");',
    '  }',
    '',
    '  private static int commandNumber(String[] args) {',
    '    for (int index = 0; index < args.length - 1; index++) {',
    '      if ("--command".equals(args[index])) {',
    '        return Integer.parseInt(args[index + 1]);',
    '      }',
    '    }',
    '    throw new IllegalArgumentException("--command is required");',
    '  }',
    '',
    '  private static boolean isCheckCommand(Path specification, int target) throws Exception {',
    '    int number = 0;',
    '    for (String rawLine : Files.readAllLines(specification)) {',
    '      String line = rawLine.trim();',
    '      if (line.startsWith("check ")) {',
    '        if (number == target) {',
    '          return true;',
    '        }',
    '        number++;',
    '      } else if (line.startsWith("run ")) {',
    '        if (number == target) {',
    '          return false;',
    '        }',
    '        number++;',
    '      }',
    '    }',
    '    return false;',
    '  }',
    '}',
    '',
  ].join('\n'), { encoding: 'utf8' });

  const compile = spawnSync('javac', ['-d', classesDirectory, sourcePath], {
    cwd: directory,
    encoding: 'utf8',
  });
  assertCommandSucceeded(compile);

  const packageJar = spawnSync(
    'jar',
    ['--create', '--file', jarPath, '--main-class', 'AlloyFixture', '-C', classesDirectory, 'AlloyFixture.class'],
    { cwd: directory, encoding: 'utf8' },
  );
  assertCommandSucceeded(packageJar);
  expect(existsSync(jarPath)).toBe(true);
  return { jarPath, logPath };
}

function installHangingJava(directory: string): { binDirectory: string } {
  const binDirectory = join(directory, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  const javaPath = join(binDirectory, 'java');
  writeFileSync(javaPath, [
    `#!${process.execPath}`,
    'const args = process.argv.slice(2);',
    "if (args[0] === '-version') setInterval(() => undefined, 1000);",
    'else process.exit(1);',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o700 });
  chmodSync(javaPath, 0o755);
  return { binDirectory };
}

function validAlloyResponse(): string {
  return ['```alloy', 'sig A {}', 'check Safety for 1', '```'].join('\n');
}

function restoreEnvironmentVariable(name: 'PATH' | 'TAKT_ALLOY_JAR' | 'TAKT_ALLOY_FIXTURE_LOG', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function readAlloyFixtureInvocations(logPath: string): string[][] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\u001f'));
}

function argumentAfter(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

beforeEach(() => {
  spawnedProcessCalls.length = 0;
  fakeQuintVerify.mode = 'passthrough';
});

describe('bundled Quint CLI verification boundary', () => {
  it('should parse, typecheck, and run a generated Quint specification in an isolated directory', () => {
    const quintCli = require.resolve('@informalsystems/quint/dist/src/cli.js');
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-quint-'));

    try {
      const specificationPath = join(directory, 'spec.qnt');
      const parseOutputPath = join(directory, 'parse.json');
      writeFileSync(specificationPath, [
        'module verify {',
        '  var counter: int',
        '  action init = counter\' = 0',
        '  action step = counter\' = counter',
        '  val invNonNegative = counter >= 0',
        '}',
        '',
      ].join('\n'));

      const parse = runQuint(quintCli, ['parse', specificationPath, '--out', parseOutputPath], directory);
      expect(parse.status, parse.stderr).toBe(0);

      const parseResult = JSON.parse(readFileSync(parseOutputPath, 'utf8')) as {
        modules?: Array<{ declarations?: Array<{ name?: string }> }>;
      };
      expect(parseResult.modules?.[0]?.declarations?.some(({ name }) => name === 'invNonNegative')).toBe(true);

      const typecheck = runQuint(quintCli, ['typecheck', specificationPath], directory);
      expect(typecheck.status, typecheck.stderr).toBe(0);

      const run = runQuint(
        quintCli,
        [
          'run',
          specificationPath,
          '--backend',
          'typescript',
          '--max-samples',
          '1',
          '--max-steps',
          '1',
          '--invariants',
          'invNonNegative',
        ],
        directory,
      );
      expect(run.status, run.stderr).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    expect(existsSync(directory)).toBe(false);
  });

  it('runs Quint basic verification and reports Java-dependent stages as skipped when Java is unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-runner-'));
    const originalPath = process.env.PATH;
    process.env.PATH = directory;

    try {
      const prime = String.fromCharCode(39);
      const response = [
        '```quint',
        'module verify {',
        '  var counter: int',
        `  action init = counter${prime} = 0`,
        `  action step = counter${prime} = counter`,
        '  val invNonNegative = counter >= 0',
        '}',
        '```',
        '```alloy',
        'sig A {}',
        'check Empty for 1',
        '```',
      ].join('\n');

      const result = await runFormalSpecVerification(response, directory);

      expect(result.verdict).toBe('passed');
      expect(result.quint.parse?.status).toBe('passed');
      expect(result.quint.typecheck?.status).toBe('passed');
      expect(result.quint.run?.status).toBe('passed');
      expect(result.quint.verify?.status).toBe('skipped');
      expect(result.alloy.status).toBe('skipped');
      expect(result.alloy.message).toContain('Alloy specifications remain unverified');
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs temporal Quint verification non-interactively with the TLC backend', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-temporal-'));
    const prime = String.fromCharCode(39);
    const response = [
      '```quint',
      'module verify {',
      '  var counter: int',
      `  action init = counter${prime} = 0`,
      `  action step = counter${prime} = counter + 1`,
      '  temporal propEventually = eventually(counter >= 0)',
      '}',
      '```',
    ].join('\n');
    fakeQuintVerify.mode = 'failed';

    try {
      const result = await runFormalSpecVerification(response, directory);

      expect(result.verdict).toBe('failed');
      expect(result.quint.temporal).toEqual(['propEventually']);
      expect(result.quint.verify?.status).toBe('failed');
      expect(result.quint.verify?.message).not.toMatch(/Do you want to proceed/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('propagates every conventionally named Quint and Alloy target through the public runner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-targets-'));
    const alloyFixture = buildAlloyFixture(directory);
    const originalJar = process.env.TAKT_ALLOY_JAR;
    const originalLog = process.env.TAKT_ALLOY_FIXTURE_LOG;
    process.env.TAKT_ALLOY_JAR = alloyFixture.jarPath;
    process.env.TAKT_ALLOY_FIXTURE_LOG = alloyFixture.logPath;
    fakeQuintVerify.mode = 'passed';

    const prime = String.fromCharCode(39);
    const response = [
      '```quint',
      'module helper {',
      '  val constant = true',
      '}',
      'module workflowModel {',
      '  var counter: int',
      `  action init = counter${prime} = 0`,
      `  action step = counter${prime} = counter`,
      '  val invSafe = counter >= 0',
      '  val invConsistent = counter <= 10',
      '  temporal propEventually = eventually(counter > 0)',
      '}',
      '```',
      '```alloy',
      'sig A {}',
      'check Safety for 1',
      'run Example for 1',
      'check Liveness for 1',
      '```',
    ].join('\n');

    try {
      const result = await runFormalSpecVerification(response, directory);
      const quintCli = require.resolve('@informalsystems/quint/dist/src/cli.js');
      const quintCalls = spawnedProcessCalls.filter(({ command, args }) => (
        command === process.execPath && args.includes(quintCli)
      ));
      const runCall = quintCalls.find(({ args }) => args.includes('run'));
      const verifyCall = quintCalls.find(({ args }) => args.includes('verify'));

      expect(result.quint.invariants).toEqual(['invSafe', 'invConsistent']);
      expect(result.quint.temporal).toEqual(['propEventually']);
      expect(result.quint.run?.status).toBe('passed');
      expect(result.quint.verify?.status).toBe('passed');
      expect(result.javaMajorVersion).toBeGreaterThanOrEqual(17);
      expect(runCall?.args).toEqual(expect.arrayContaining(['run', '--main', 'workflowModel']));
      expect(runCall?.args.slice((runCall?.args.indexOf('--invariants') ?? -1) + 1))
        .toEqual(['invSafe', 'invConsistent']);
      expect(argumentAfter(verifyCall?.args ?? [], '--main')).toBe('workflowModel');
      expect(argumentAfter(verifyCall?.args ?? [], '--invariant')).toBe('invSafe,invConsistent');
      expect(argumentAfter(verifyCall?.args ?? [], '--temporal')).toBe('propEventually');
      expect(result.alloy).toMatchObject({
        status: 'passed',
        checks: [0, 2],
        commands: [
          { number: 0, type: 'check', label: 'Safety' },
          { number: 1, type: 'run', label: 'Example' },
          { number: 2, type: 'check', label: 'Liveness' },
        ],
      });
      const execInvocations = readAlloyFixtureInvocations(alloyFixture.logPath)
        .filter((args) => args.includes('exec'));
      expect(execInvocations.map((args) => argumentAfter(args, '--command'))).toEqual(['0', '2']);
      expect(execInvocations.filter((args) => argumentAfter(args, '--command') === '0')).toHaveLength(1);
      expect(execInvocations.filter((args) => argumentAfter(args, '--command') === '2')).toHaveLength(1);
      expect(execInvocations.some((args) => argumentAfter(args, '--command') === '1')).toBe(false);
      expect(readdirSync(join(directory, '.takt', 'runs'))
        .filter((name) => name.startsWith('verify-'))).toEqual([]);
    } finally {
      restoreEnvironmentVariable('TAKT_ALLOY_JAR', originalJar);
      restoreEnvironmentVariable('TAKT_ALLOY_FIXTURE_LOG', originalLog);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects Quint targets declared outside the selected main module before run and verify', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-target-scope-'));
    const response = [
      '```quint',
      'module helper {',
      '  val invHelper = true',
      '  temporal propHelper = eventually(true)',
      '}',
      'module workflowModel {',
      '  var counter: int',
      "  action init = counter' = 0",
      "  action step = counter' = counter",
      '}',
      '```',
    ].join('\n');

    try {
      const result = await runFormalSpecVerification(response, directory);
      const quintCli = require.resolve('@informalsystems/quint/dist/src/cli.js');
      const quintCalls = spawnedProcessCalls.filter(({ command, args }) => (
        command === process.execPath && args.includes(quintCli)
      ));

      expect(result.verdict).toBe('error');
      expect(result.quint.parse?.status).toBe('passed');
      expect(result.quint.typecheck?.status).toBe('passed');
      expect(result.quint.run).toMatchObject({
        status: 'error',
        message: expect.stringContaining('helper::invHelper'),
      });
      expect(result.quint.run?.message).toContain('helper::propHelper');
      expect(quintCalls.some(({ args }) => args.includes('run'))).toBe(false);
      expect(quintCalls.some(({ args }) => args.includes('verify'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not infer a basename main when parsed modules have no executable actions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-no-main-'));

    try {
      const result = await runFormalSpecVerification([
        '```quint',
        'module helper {',
        '  val constant = true',
        '}',
        'module properties {',
        '  val invSafe = true',
        '}',
        '```',
      ].join('\n'), directory);

      const quintCli = require.resolve('@informalsystems/quint/dist/src/cli.js');
      const quintCalls = spawnedProcessCalls.filter(({ command, args }) => (
        command === process.execPath && args.includes(quintCli)
      ));

      expect(result.verdict).toBe('error');
      expect(result.quint.invariants).toEqual(['invSafe']);
      expect(result.quint.run).toMatchObject({
        status: 'error',
        message: 'Quint verification requires a module with action init and action step.',
      });
      expect(quintCalls.some(({ args }) => args.includes('run'))).toBe(false);
      expect(quintCalls.some(({ args }) => args.includes('verify'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not treat comments, non-convention names, or Alloy run commands as verification targets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-targets-negative-'));
    const alloyFixture = buildAlloyFixture(directory);
    const originalJar = process.env.TAKT_ALLOY_JAR;
    const originalLog = process.env.TAKT_ALLOY_FIXTURE_LOG;
    process.env.TAKT_ALLOY_JAR = alloyFixture.jarPath;
    process.env.TAKT_ALLOY_FIXTURE_LOG = alloyFixture.logPath;

    const prime = String.fromCharCode(39);
    const response = [
      '```quint',
      'module workflowModel {',
      '  var counter: int',
      `  action init = counter${prime} = 0`,
      `  action step = counter${prime} = counter`,
      '  // val invComment = true',
      '  val safety = true',
      '}',
      '```',
      '```alloy',
      'sig A {}',
      'run Example for 1',
      '```',
    ].join('\n');

    try {
      const result = await runFormalSpecVerification(response, directory);
      const quintCli = require.resolve('@informalsystems/quint/dist/src/cli.js');
      const runCall = spawnedProcessCalls.find(({ command, args }) => (
        command === process.execPath && args.includes(quintCli) && args.includes('run')
      ));
      const invocations = readAlloyFixtureInvocations(alloyFixture.logPath);

      expect(result.quint.invariants).toEqual([]);
      expect(result.quint.temporal).toEqual([]);
      expect(runCall?.args).not.toContain('invComment');
      expect(runCall?.args).not.toContain('safety');
      expect(result.alloy).toMatchObject({
        status: 'error',
        commands: [{ number: 0, type: 'run', label: 'Example' }],
      });
      expect(invocations.some((args) => args.includes('exec'))).toBe(false);
    } finally {
      restoreEnvironmentVariable('TAKT_ALLOY_JAR', originalJar);
      restoreEnvironmentVariable('TAKT_ALLOY_FIXTURE_LOG', originalLog);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs Alloy checks through the public runner with Java 17 and removes its run workspace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-alloy-'));
    const alloyFixture = buildAlloyFixture(directory);
    const originalJar = process.env.TAKT_ALLOY_JAR;
    const originalLog = process.env.TAKT_ALLOY_FIXTURE_LOG;
    process.env.TAKT_ALLOY_JAR = alloyFixture.jarPath;
    process.env.TAKT_ALLOY_FIXTURE_LOG = alloyFixture.logPath;

    try {
      const result = await runFormalSpecVerification([
        '```alloy',
        'sig A {}',
        'check Safety for 3',
        'check Liveness for 3',
        'run Report for 3',
        '```',
      ].join('\n'), directory);

      expect(result.verdict).toBe('passed');
      expect(result.javaMajorVersion).toBeGreaterThanOrEqual(17);
      expect(result.alloy).toMatchObject({ status: 'passed', checks: [0, 1] });
      expect(result.alloy.commands).toEqual([
        { number: 0, type: 'check', label: 'Safety' },
        { number: 1, type: 'check', label: 'Liveness' },
        { number: 2, type: 'run', label: 'Report' },
      ]);

      const invocations = readAlloyFixtureInvocations(alloyFixture.logPath);
      const javaCalls = spawnedProcessCalls.filter(({ command }) => command === 'java');
      expect(invocations.length).toBe(3);
      const commandCalls = javaCalls.filter(({ args }) => args.includes('commands'));
      const execCalls = javaCalls.filter(({ args }) => args.includes('exec'));
      expect(commandCalls).toHaveLength(1);
      expect(execCalls).toHaveLength(2);
      expect(commandCalls
        .every(({ args }) => args.includes(alloyFixture.jarPath))).toBe(true);
      expect(execCalls
        .every(({ args }) => args.includes(alloyFixture.jarPath))).toBe(true);
      expect(invocations.filter((args) => args.includes('exec'))
        .map((args) => argumentAfter(args, '--command'))).toEqual(['0', '1']);
      expect(invocations.filter((args) => args.includes('commands'))).toHaveLength(1);
      expect(readdirSync(join(directory, '.takt', 'runs')).filter((name) => name.startsWith('verify-'))).toEqual([]);
      expect(existsSync(join(directory, 'spec.als'))).toBe(false);
    } finally {
      restoreEnvironmentVariable('TAKT_ALLOY_JAR', originalJar);
      restoreEnvironmentVariable('TAKT_ALLOY_FIXTURE_LOG', originalLog);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enumerates and executes checks at two-digit Alloy command indexes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-alloy-two-digit-'));
    const alloyFixture = buildAlloyFixture(directory);
    const originalJar = process.env.TAKT_ALLOY_JAR;
    const originalLog = process.env.TAKT_ALLOY_FIXTURE_LOG;
    process.env.TAKT_ALLOY_JAR = alloyFixture.jarPath;
    process.env.TAKT_ALLOY_FIXTURE_LOG = alloyFixture.logPath;

    try {
      const result = await runFormalSpecVerification([
        '```alloy',
        'sig A {}',
        'check Check0 for 3',
        'run Run1 for 3',
        'check Check2 for 3',
        'run Run3 for 3',
        'check Check4 for 3',
        'run Run5 for 3',
        'check Check6 for 3',
        'run Run7 for 3',
        'check Check8 for 3',
        'run Run9 for 3',
        'check Check10 for 3',
        '```',
      ].join('\n'), directory);

      expect(result.verdict).toBe('passed');
      expect(result.alloy).toMatchObject({
        status: 'passed',
        checks: [0, 2, 4, 6, 8, 10],
        commands: [
          { number: 0, type: 'check', label: 'Check0' },
          { number: 1, type: 'run', label: 'Run1' },
          { number: 2, type: 'check', label: 'Check2' },
          { number: 3, type: 'run', label: 'Run3' },
          { number: 4, type: 'check', label: 'Check4' },
          { number: 5, type: 'run', label: 'Run5' },
          { number: 6, type: 'check', label: 'Check6' },
          { number: 7, type: 'run', label: 'Run7' },
          { number: 8, type: 'check', label: 'Check8' },
          { number: 9, type: 'run', label: 'Run9' },
          { number: 10, type: 'check', label: 'Check10' },
        ],
      });

      const invocations = readAlloyFixtureInvocations(alloyFixture.logPath);
      expect(invocations.filter((args) => args.includes('exec'))
        .map((args) => argumentAfter(args, '--command'))).toEqual(['0', '2', '4', '6', '8', '10']);
    } finally {
      restoreEnvironmentVariable('TAKT_ALLOY_JAR', originalJar);
      restoreEnvironmentVariable('TAKT_ALLOY_FIXTURE_LOG', originalLog);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps an independent Alloy result after a real Quint parse failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-independent-'));
    const alloyFixture = buildAlloyFixture(directory);
    const originalJar = process.env.TAKT_ALLOY_JAR;
    const originalLog = process.env.TAKT_ALLOY_FIXTURE_LOG;
    process.env.TAKT_ALLOY_JAR = alloyFixture.jarPath;
    process.env.TAKT_ALLOY_FIXTURE_LOG = alloyFixture.logPath;

    try {
      const result = await runFormalSpecVerification([
        '```quint',
        'module invalid {',
        '```',
        '```alloy',
        'sig A {}',
        'check Safety for 1',
        '```',
      ].join('\n'), directory);

      expect(result.verdict).toBe('error');
      expect(result.quint.parse?.status).toBe('error');
      expect(result.alloy.status).toBe('passed');
      expect(result.javaMajorVersion).toBeGreaterThanOrEqual(17);
      expect(readAlloyFixtureInvocations(alloyFixture.logPath)
        .filter((args) => args.includes('exec'))).toHaveLength(1);
      expect(readdirSync(join(directory, '.takt', 'runs')).filter((name) => name.startsWith('verify-'))).toEqual([]);
    } finally {
      restoreEnvironmentVariable('TAKT_ALLOY_JAR', originalJar);
      restoreEnvironmentVariable('TAKT_ALLOY_FIXTURE_LOG', originalLog);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('terminates a verification process tree and cleans the run directory on abort', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-abort-'));
    const hangingJava = installHangingJava(directory);
    const originalPath = process.env.PATH;
    process.env.PATH = `${hangingJava.binDirectory}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
    const abortController = new AbortController();

    try {
      const verification = runFormalSpecVerification(validAlloyResponse(), directory, abortController.signal);
      setTimeout(() => abortController.abort(), 50);
      await expect(verification).rejects.toBeDefined();
      expect(readdirSync(join(directory, '.takt', 'runs')).filter((name) => name.startsWith('verify-'))).toEqual([]);
    } finally {
      restoreEnvironmentVariable('PATH', originalPath);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains an active child when restart observes an unconfirmed launch phase', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-formal-spec-launch-race-'));
    const runDirectory = join(directory, '.takt', 'runs', 'verify-unconfirmed-launch');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
      stdio: 'ignore',
    });
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(runDirectory, '.verify-run.json'), JSON.stringify({
      version: 1,
      ownerPid: 2_147_483_647,
      launchUncertain: true,
      processes: [{ id: 'detached-child', pid: child.pid! }],
    }));

    try {
      await runFormalSpecVerification('No formal specification was generated.', directory);

      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(existsSync(runDirectory)).toBe(true);
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
        } else {
          child.once('exit', () => resolve());
        }
      });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
