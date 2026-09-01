import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { alloyJarDigestOverride } = vi.hoisted(() => ({
  alloyJarDigestOverride: { value: undefined as string | undefined },
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      const digest = alloyJarDigestOverride.value;
      if (digest === undefined) {
        return actual.createHash(...args);
      }
      return {
        update: () => ({ digest: () => digest }),
      } as unknown as ReturnType<typeof actual.createHash>;
    },
  };
});

const { mockSpawnManagedProcess } = vi.hoisted(() => ({
  mockSpawnManagedProcess: vi.fn(),
}));

const { failSpecsDirectoryCreation } = vi.hoisted(() => ({
  failSpecsDirectoryCreation: { enabled: false },
}));

const { failVerifyRunRemoval, processBoundaryControls } = vi.hoisted(() => ({
  failVerifyRunRemoval: { enabled: false },
  processBoundaryControls: { throwOnSpawn: false },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      const target = String(args[0]);
      if (failSpecsDirectoryCreation.enabled && (target.endsWith('/specs') || target.endsWith('\\specs'))) {
        throw new Error('specs directory creation failed');
      }
      return actual.mkdirSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const options = args[1];
      if (failVerifyRunRemoval.enabled
        && typeof options === 'object'
        && options !== null
        && 'recursive' in options
        && options.recursive === true) {
        throw new Error('verify run cleanup failed');
      }
      return actual.rmSync(...args);
    },
  };
});

vi.mock('../shared/utils/spawn.js', () => ({
  spawnManagedProcess: (...args: unknown[]) => mockSpawnManagedProcess(...args),
}));

import {
  detectJavaMajorVersion,
  extractFormalSpecBlocks,
  runFormalSpecVerification,
  selectAlloyCheckTargets,
  selectQuintVerificationTargets,
} from '../features/interactive/formalSpecVerifier.js';
import { providerSupportsFormalSpecVerification } from '../features/interactive/formalSpecVerification.js';

const originalAlloyJar = process.env.TAKT_ALLOY_JAR;

interface MockProcessResponse {
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
  readonly hang?: boolean;
}

class MockStream extends EventEmitter {
  setEncoding(_encoding: string): void {
    // The runner only needs the stream event contract in these process-boundary tests.
  }
}

const processResponses: MockProcessResponse[] = [];
const spawnedProcesses: Array<{
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv };
}> = [];
let parseResult: unknown = {
  modules: [{
    name: 'verify',
    declarations: [
      { kind: 'def', name: 'init', qualifier: 'action' },
      { kind: 'def', name: 'step', qualifier: 'action' },
      { kind: 'def', name: 'invSafe', qualifier: 'val' },
    ],
  }],
};

const EXPECTED_ALLOY_JAR_SHA256 = '6037cbeee0e8423c1c468447ed10f5fcf2f2743a2ffc39cb1c81f2905c0fdb9d';

function installConfiguredAlloyJar(directory: string): void {
  const jarPath = join(directory, 'alloy-fixture.jar');
  writeFileSync(jarPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]), { mode: 0o600 });
  process.env.TAKT_ALLOY_JAR = jarPath;
}

function mockProcessBoundary(): void {
  mockSpawnManagedProcess.mockImplementation((
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
    signal: AbortSignal,
  ) => {
    spawnedProcesses.push({ command, args, options });
    if (processBoundaryControls.throwOnSpawn) {
      throw new Error('spawn failed synchronously');
    }
    const response = processResponses.shift() ?? { code: 0 };
    const stdout = new MockStream();
    const stderr = new MockStream();
    const parseOutputIndex = args.indexOf('--out');
    if (parseOutputIndex >= 0) {
      const parseOutputPath = args[parseOutputIndex + 1];
      if (parseOutputPath !== undefined) {
        writeFileSync(parseOutputPath, JSON.stringify(parseResult));
      }
    }
    const wait = async () => {
      if (response.hang) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      if (response.stdout !== undefined) stdout.emit('data', response.stdout);
      if (response.stderr !== undefined) stderr.emit('data', response.stderr);
      if (response.error !== undefined) throw response.error;
      return {
        code: response.code === undefined ? 0 : response.code,
        signal: response.signal ?? null,
      };
    };
    return {
      child: { stdout, stderr },
      wait,
      waitForExit: wait,
    };
  });
}

function createTestDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'takt-formal-spec-unit-'));
}

function validAlloyResponse(): string {
  return ['```alloy', 'sig A {}', 'check Safety for 1', '```'].join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  processResponses.length = 0;
  spawnedProcesses.length = 0;
  parseResult = {
    modules: [{
      name: 'verify',
      declarations: [
        { kind: 'def', name: 'init', qualifier: 'action' },
        { kind: 'def', name: 'step', qualifier: 'action' },
        { kind: 'def', name: 'invSafe', qualifier: 'val' },
      ],
    }],
  };
  failSpecsDirectoryCreation.enabled = false;
  failVerifyRunRemoval.enabled = false;
  processBoundaryControls.throwOnSpawn = false;
  alloyJarDigestOverride.value = undefined;
  delete process.env.TAKT_ALLOY_JAR;
  mockProcessBoundary();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  failSpecsDirectoryCreation.enabled = false;
  alloyJarDigestOverride.value = undefined;
  if (originalAlloyJar === undefined) {
    delete process.env.TAKT_ALLOY_JAR;
  } else {
    process.env.TAKT_ALLOY_JAR = originalAlloyJar;
  }
});

describe('runFormalSpecVerification', () => {
  it('should fail explicitly without invoking verification when the response has no target blocks', async () => {
    const result = await runFormalSpecVerification('No formal specification was generated.', '/repo');

    expect(result).toEqual({
      verdict: 'error',
      verificationStarted: false,
      message: 'No formal specification blocks found.',
      quint: {
        status: 'skipped',
        message: 'No formal specification blocks found.',
      },
      alloy: {
        status: 'skipped',
        message: 'No formal specification blocks found.',
      },
    });
  });

  it('should treat a run workspace creation failure as a started verification error', async () => {
    const directory = createTestDirectory();
    writeFileSync(join(directory, '.takt'), 'not a directory');

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory);

      expect(result).toMatchObject({
        verdict: 'error',
        verificationStarted: true,
        quint: { status: 'error' },
        alloy: { status: 'skipped' },
      });
      expect(mockSpawnManagedProcess).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should remove a partially created run workspace when specs creation fails', async () => {
    const directory = createTestDirectory();
    failSpecsDirectoryCreation.enabled = true;

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory);

      expect(result).toMatchObject({
        verdict: 'error',
        verificationStarted: true,
        quint: { status: 'error', message: 'specs directory creation failed' },
        alloy: { status: 'skipped' },
      });
      expect(readdirSync(join(directory, '.takt', 'runs'))
        .filter((name) => name.startsWith('verify-'))).toEqual([]);
    } finally {
      failSpecsDirectoryCreation.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should remove a workspace after a synchronous spawn failure with no child returned', async () => {
    const directory = createTestDirectory();
    processBoundaryControls.throwOnSpawn = true;

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);

      expect(result).toMatchObject({ verdict: 'error', verificationStarted: true });
      expect(mockSpawnManagedProcess).toHaveBeenCalledOnce();
      expect(readdirSync(join(directory, '.takt', 'runs'))
        .filter((name) => name.startsWith('verify-'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should remove stale abandoned verify workspaces while retaining recent and unrelated entries', async () => {
    const directory = createTestDirectory();
    const runsDirectory = join(directory, '.takt', 'runs');
    const staleDirectory = join(runsDirectory, 'verify-stale');
    const recentDirectory = join(runsDirectory, 'verify-recent');
    const unrelatedDirectory = join(runsDirectory, 'unrelated');
    mkdirSync(staleDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(recentDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(unrelatedDirectory, { recursive: true, mode: 0o700 });
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleDirectory, staleTime, staleTime);

    try {
      await runFormalSpecVerification('No formal specification was generated.', directory);

      expect(existsSync(staleDirectory)).toBe(false);
      expect(existsSync(recentDirectory)).toBe(true);
      expect(existsSync(unrelatedDirectory)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should preserve the verification result when run cleanup fails', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: '0 . Check Safety for 1\n' },
      { code: 1, stderr: 'counterexample' },
    );
    failVerifyRunRemoval.enabled = true;

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);

      expect(result.verdict).toBe('failed');
      expect(result.alloy).toMatchObject({ status: 'failed', message: 'counterexample' });
      expect(readdirSync(join(directory, '.takt', 'runs'))
        .filter((name) => name.startsWith('verify-'))).toHaveLength(1);
    } finally {
      failVerifyRunRemoval.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should classify a normal verification exit as failed and a process error as error', async () => {
    const directory = createTestDirectory();
    const quintResponse = '```quint\nmodule verify {}\n```';
    try {
      processResponses.push(
        { code: 0 },
        { code: 0 },
        { code: 1, stderr: 'counterexample' },
      );
      const failed = await runFormalSpecVerification(quintResponse, directory);
      expect(failed.verdict).toBe('failed');
      expect(failed.quint.run).toMatchObject({ status: 'failed', message: 'counterexample' });

      processResponses.push(
        { code: 0 },
        { code: 0 },
        { error: new Error('spawn failed') },
      );
      const errored = await runFormalSpecVerification(quintResponse, directory);
      expect(errored.verdict).toBe('error');
      expect(errored.quint.run).toMatchObject({ status: 'error', message: 'spawn failed' });

      processResponses.push(
        { code: 0 },
        { code: 0 },
        { code: null },
      );
      const statusless = await runFormalSpecVerification(quintResponse, directory);
      expect(statusless.verdict).toBe('error');
      expect(statusless.quint.run).toMatchObject({ status: 'error' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should classify a process timeout as error', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    processResponses.push(
      { code: 0 },
      { code: 0 },
      { hang: true },
    );
    try {
      const verification = runFormalSpecVerification('```quint\nmodule verify {}\n```', directory);
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await verification;

      expect(result.verdict).toBe('error');
      expect(result.quint.run).toMatchObject({ status: 'error' });
      expect(result.quint.run?.message).toContain('timed out');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should pass every parsed Quint target to verification and select the temporal backend', async () => {
    const directory = createTestDirectory();
    parseResult = {
      modules: [{
        name: 'workflowModel',
        declarations: [
          { kind: 'def', name: 'init', qualifier: 'action' },
          { kind: 'def', name: 'step', qualifier: 'action' },
          { kind: 'def', name: 'invSafe', qualifier: 'val' },
          { kind: 'def', name: 'invConsistent', qualifier: 'val' },
          { kind: 'def', name: 'propEventually', qualifier: 'temporal' },
        ],
      }],
    };
    processResponses.push(
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0 },
    );
    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory);
      const runCall = spawnedProcesses.find(({ args }) => args.includes('run'));
      const verifyCall = spawnedProcesses.find(({ args }) => args.includes('verify'));

      expect(result.quint.invariants).toEqual(['invSafe', 'invConsistent']);
      expect(result.quint.temporal).toEqual(['propEventually']);
      expect(runCall?.args).toEqual(expect.arrayContaining(['--invariants', 'invSafe', 'invConsistent']));
      expect(runCall?.args).toEqual(expect.arrayContaining(['--main', 'workflowModel']));
      expect(verifyCall?.args).toEqual(expect.arrayContaining([
        '--main', 'workflowModel',
        '--backend', 'tlc',
        '--invariant', 'invSafe,invConsistent',
        '--temporal', 'propEventually',
      ]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should fail explicitly when no parsed module has both executable actions', async () => {
    const directory = createTestDirectory();
    parseResult = {
      modules: [{
        name: 'helper',
        declarations: [{ kind: 'def', name: 'constant', qualifier: 'val' }],
      }],
    };
    processResponses.push(
      { code: 0 },
      { code: 0 },
      { code: 0, stderr: 'openjdk version "17.0.1"' },
    );

    try {
      const result = await runFormalSpecVerification('```quint\nmodule helper {}\n```', directory);

      expect(result.verdict).toBe('error');
      expect(result.quint.run).toMatchObject({
        status: 'error',
        message: 'Quint verification requires a module with action init and action step.',
      });
      expect(spawnedProcesses.some(({ args }) => args.includes('run'))).toBe(false);
      expect(spawnedProcesses.some(({ args }) => args.includes('verify'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should not invoke Java discovery when Quint verification cannot run and Alloy is absent', async () => {
    const directory = createTestDirectory();
    processResponses.push({ code: 1, stderr: 'Quint parse failed' });

    try {
      const result = await runFormalSpecVerification('```quint\nmodule invalid {}\n```', directory);

      expect(result.quint.verify).toMatchObject({
        status: 'skipped',
        message: 'Quint verification was skipped because an earlier Quint stage did not pass.',
      });
      expect(spawnedProcesses).toHaveLength(1);
      expect(spawnedProcesses.some(({ command }) => command === 'java')).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should collect Alloy results after an independent Quint parse error and clean the run directory', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { code: 1, stderr: 'Quint parse failed' },
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: '0 . Check Safety for 3\n1 . Run Report for 3\n' },
      { code: 0 },
    );
    try {
      const result = await runFormalSpecVerification(
        ['```quint', 'module invalid {', '```', validAlloyResponse()].join('\n'),
        directory,
      );

      expect(result.verdict).toBe('error');
      expect(result.quint.parse).toMatchObject({ status: 'error', message: 'Quint parse failed' });
      expect(result.alloy).toMatchObject({ status: 'passed', checks: [0] });
      expect(result.alloy.commands).toEqual([
        { number: 0, type: 'check', label: 'Safety' },
        { number: 1, type: 'run', label: 'Report' },
      ]);
      expect(spawnedProcesses.every(({ options }) => options.cwd?.includes('/.takt/runs/verify-'))).toBe(true);
      expect(spawnedProcesses.every(({ options }) => options.env?.TMPDIR === options.cwd)).toBe(true);
      const runParent = join(directory, '.takt', 'runs');
      expect(readdirSync(runParent).filter((name) => name.startsWith('verify-'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should not report an Alloy-only specification as passed when every stage is skipped', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push({ error: new Error('java is unavailable') });
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);

      expect(result.verdict).toBe('error');
      expect(result.quint.status).toBe('skipped');
      expect(result.alloy.status).toBe('skipped');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should classify an Alloy counterexample as failed and an Alloy process error as error', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    try {
      processResponses.push(
        { code: 0, stderr: 'openjdk version "17.0.1"' },
        { code: 0, stdout: '0 . Check Safety for 3\n' },
        { code: 0, stdout: 'counterexample' },
      );
      const failed = await runFormalSpecVerification(validAlloyResponse(), directory);
      expect(failed.verdict).toBe('failed');
      expect(failed.alloy).toMatchObject({ status: 'failed', message: 'counterexample' });

      processResponses.push(
        { code: 0, stderr: 'openjdk version "17.0.1"' },
        { code: 0, stdout: '0 . Check Safety for 3\n' },
        { error: new Error('Alloy process unavailable') },
      );
      const errored = await runFormalSpecVerification(validAlloyResponse(), directory);
      expect(errored.verdict).toBe('error');
      expect(errored.alloy).toMatchObject({ status: 'error', message: 'Alloy process unavailable' });

      processResponses.push(
        { code: 0, stderr: 'openjdk version "17.0.1"' },
        { code: 0, stdout: '0 . Check Safety for 3\n' },
        { code: null },
      );
      const statusless = await runFormalSpecVerification(validAlloyResponse(), directory);
      expect(statusless.verdict).toBe('error');
      expect(statusless.alloy).toMatchObject({ status: 'error' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should report a configured Alloy jar preparation failure as error', async () => {
    const directory = createTestDirectory();
    const previousJarPath = process.env.TAKT_ALLOY_JAR;
    process.env.TAKT_ALLOY_JAR = join(directory, 'missing-alloy.jar');
    processResponses.push({ code: 0, stderr: 'openjdk version "17.0.1"' });
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);

      expect(result.verdict).toBe('error');
      expect(result.alloy).toMatchObject({ status: 'error' });
      expect(result.alloy.message).toContain('Configured Alloy jar is not a readable file');
      expect(spawnedProcesses).toHaveLength(1);
    } finally {
      if (previousJarPath === undefined) {
        delete process.env.TAKT_ALLOY_JAR;
      } else {
        process.env.TAKT_ALLOY_JAR = previousJarPath;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should resolve a relative configured Alloy jar from the project cwd', async () => {
    const directory = createTestDirectory();
    const fixtureDirectory = join(directory, 'fixtures');
    mkdirSync(fixtureDirectory, { recursive: true, mode: 0o700 });
    const jarPath = join(fixtureDirectory, 'alloy.jar');
    writeFileSync(jarPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]), { mode: 0o600 });
    process.env.TAKT_ALLOY_JAR = 'fixtures/alloy.jar';
    processResponses.push(
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: '0 . Check Safety for 1\n' },
      { code: 0 },
    );

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);

      expect(result.alloy.status).toBe('passed');
      const alloyCalls = spawnedProcesses.filter(({ command }) => command === 'java');
      expect(alloyCalls.at(-1)?.args[1]).toBe(jarPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should download the Alloy jar into the isolated cache without using a real fetch', async () => {
    const directory = createTestDirectory();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    alloyJarDigestOverride.value = EXPECTED_ALLOY_JAR_SHA256;
    processResponses.push(
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: '0 . Check Safety for 1\n' },
      { code: 0 },
    );

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);
      const cacheDirectory = join(directory, '.takt', 'cache', 'alloy', '6.2.0');

      expect(result.alloy.status).toBe('passed');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(existsSync(join(cacheDirectory, 'alloy.jar'))).toBe(true);
      expect(readdirSync(cacheDirectory).filter((name) => name.startsWith('.alloy-'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should report an Alloy jar HTTP failure without leaving a temporary archive', async () => {
    const directory = createTestDirectory();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    processResponses.push({ code: 0, stderr: 'openjdk version "17.0.1"' });

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);
      const cacheDirectory = join(directory, '.takt', 'cache', 'alloy', '6.2.0');

      expect(result.alloy).toMatchObject({
        status: 'error',
        message: 'Alloy Analyzer could not be prepared: Alloy jar download failed with HTTP status 503',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(readdirSync(cacheDirectory).filter((name) => name.startsWith('.alloy-'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should reject a downloaded Alloy jar whose SHA-256 does not match the pinned artifact', async () => {
    const directory = createTestDirectory();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    processResponses.push({ code: 0, stderr: 'openjdk version "17.0.1"' });

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);
      const cacheDirectory = join(directory, '.takt', 'cache', 'alloy', '6.2.0');

      expect(result.alloy).toMatchObject({
        status: 'error',
        message: expect.stringContaining('Alloy jar SHA-256 mismatch'),
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(existsSync(join(cacheDirectory, 'alloy.jar'))).toBe(false);
      expect(readdirSync(cacheDirectory).filter((name) => name.startsWith('.alloy-'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should reject a cached Alloy jar whose SHA-256 does not match the pinned artifact', async () => {
    const directory = createTestDirectory();
    const cacheDirectory = join(directory, '.takt', 'cache', 'alloy', '6.2.0');
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDirectory, 'alloy.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]), { mode: 0o600 });
    processResponses.push({ code: 0, stderr: 'openjdk version "17.0.1"' });

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);

      expect(result.alloy).toMatchObject({
        status: 'error',
        message: expect.stringContaining('Alloy jar SHA-256 mismatch'),
      });
      expect(spawnedProcesses).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should reject truncated Alloy command enumeration output before executing any check', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const oversizedCommands = `0 . Check First\n${'not-a-command\n'.repeat(100_000)}1 . Check Later\n`;
    processResponses.push(
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: oversizedCommands },
    );

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);

      expect(result.alloy).toMatchObject({
        status: 'error',
        message: 'Alloy command enumeration output was truncated before all commands could be read.',
      });
      expect(spawnedProcesses).toHaveLength(2);
      expect(spawnedProcesses.some(({ args }) => args.includes('exec'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should reject an invalid Alloy jar archive without leaving a temporary archive', async () => {
    const directory = createTestDirectory();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('not a jar'),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    processResponses.push({ code: 0, stderr: 'openjdk version "17.0.1"' });

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory);
      const cacheDirectory = join(directory, '.takt', 'cache', 'alloy', '6.2.0');

      expect(result.alloy).toMatchObject({
        status: 'error',
        message: 'Alloy Analyzer could not be prepared: Alloy jar download did not return a valid archive',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(readdirSync(cacheDirectory).filter((name) => name.startsWith('.alloy-'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('extractFormalSpecBlocks', () => {
  it('should return closed quint and alloy blocks in response order without using older or unrelated text', () => {
    const response = [
      'Earlier context contained ```quint, but it is not part of this response.',
      '````text',
      '```quint',
      'This nested-looking line is text, not a Quint block.',
      '````',
      '```quint',
      'module first {}',
      '```',
      '~~~quint',
      'module second {}',
      '~~~',
      '> ```alloy',
      'check QuotedText',
      '> ```',
      '```alloy',
      'check CurrentAgreement',
      '```',
    ].join('\n');

    expect(extractFormalSpecBlocks(response)).toEqual({
      quint: ['module first {}', 'module second {}'],
      alloy: ['check CurrentAgreement'],
    });
  });

  it('should return empty block lists when the response contains no target block', () => {
    expect(extractFormalSpecBlocks('inline ` ```quint module fake {} ``` `\n```text\nplain text\n```')).toEqual({
      quint: [],
      alloy: [],
    });
  });

  it('should reject an unclosed target block instead of returning a partial specification', () => {
    expect(() => extractFormalSpecBlocks('```quint\nmodule incomplete {}')).toThrow(/fence|closed|block/i);
  });
});

describe('detectJavaMajorVersion', () => {
  it.each([
    ['openjdk version "17.0.12" 2024-07-16', 17],
    ['openjdk version "21.0.4" 2024-07-16 LTS', 21],
    ['java version "1.8.0_402"', 8],
    ['openjdk 16.0.2 2021-07-20', 16],
  ])('should parse the Java major version from %s', (output, expected) => {
    expect(detectJavaMajorVersion(output)).toBe(expected);
  });

  it.each(['', 'java: command not found', 'version unavailable'])('should return undefined for unparseable Java output: %s', (output) => {
    expect(detectJavaMajorVersion(output)).toBeUndefined();
  });
});

describe('selectQuintVerificationTargets', () => {
  it('should select every inv value and prop temporal definition while ignoring other definitions', () => {
    const parseResult = {
      modules: [{
        name: 'workflowModel',
        declarations: [
          { kind: 'def', name: 'invSafe', qualifier: 'val' },
          { kind: 'def', name: 'invOwner', qualifier: 'val' },
          { kind: 'def', name: 'propEventuallyDone', qualifier: 'temporal' },
          { kind: 'def', name: 'notAnInvariant', qualifier: 'val' },
          { kind: 'def', name: 'step', qualifier: 'action' },
        ],
      }],
    };

    expect(selectQuintVerificationTargets(parseResult)).toEqual({
      invariants: [
        { moduleName: 'workflowModel', name: 'invSafe' },
        { moduleName: 'workflowModel', name: 'invOwner' },
      ],
      temporal: [{ moduleName: 'workflowModel', name: 'propEventuallyDone' }],
    });
  });

  it('should not turn names from comments or string-like entries into verification targets', () => {
    const parseResult = {
      modules: [{
        name: 'workflowModel',
        declarations: [
          { kind: 'comment', name: 'invFake' },
          { kind: 'string', name: 'propFake' },
          { kind: 'def', name: 'invReal', qualifier: 'val' },
        ],
      }],
    };

    expect(selectQuintVerificationTargets(parseResult)).toEqual({
      invariants: [{ moduleName: 'workflowModel', name: 'invReal' }],
      temporal: [],
    });
  });
});

describe('selectAlloyCheckTargets', () => {
  it('should return every parsed check number, preserve duplicates by number, and exclude run commands', () => {
    expect(selectAlloyCheckTargets([
      { number: 0, type: 'check', label: 'ModeGate' },
      { number: 1, type: 'run', label: 'ReachReport' },
      { number: 2, type: 'check', label: 'NoRetry' },
      { number: 3, type: 'check', label: 'ModeGate' },
    ])).toEqual([0, 2, 3]);
  });
});

describe('providerSupportsFormalSpecVerification', () => {
  it('should allow only providers with an explicit tool-free execution capability', () => {
    expect(providerSupportsFormalSpecVerification('claude')).toBe(true);
    expect(providerSupportsFormalSpecVerification('claude-sdk')).toBe(true);
    expect(providerSupportsFormalSpecVerification('claude-terminal')).toBe(true);
    expect(providerSupportsFormalSpecVerification('opencode')).toBe(true);
    expect(providerSupportsFormalSpecVerification('pi')).toBe(true);
    expect(providerSupportsFormalSpecVerification('mock')).toBe(true);
    expect(providerSupportsFormalSpecVerification('deepseek-harness')).toBe(false);
    expect(providerSupportsFormalSpecVerification('codex')).toBe(false);
    expect(providerSupportsFormalSpecVerification('cursor')).toBe(false);
    expect(providerSupportsFormalSpecVerification('copilot')).toBe(false);
    expect(providerSupportsFormalSpecVerification('kiro')).toBe(false);
    expect(providerSupportsFormalSpecVerification(undefined)).toBe(false);
  });
});
