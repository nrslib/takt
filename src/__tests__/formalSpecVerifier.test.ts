import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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

const { mockIsProcessAlive, mockGetProcessIdentity, retainMarkerFailure } = vi.hoisted(() => ({
  mockIsProcessAlive: vi.fn(),
  mockGetProcessIdentity: vi.fn(),
  retainMarkerFailure: { enabled: false, move: false, cwd: undefined as string | undefined },
}));

vi.mock('../infra/task/process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/task/process.js')>()),
  getSelfProcessIdentity: () => ({ startTime: 'darwin-start-v2:100' }),
  getProcessIdentity: (...args: unknown[]) => mockGetProcessIdentity(...args),
  isProcessAlive: (...args: unknown[]) => mockIsProcessAlive(...args),
}));

const { failSpecsDirectoryCreation, failAlloyDirectoryCreation } = vi.hoisted(() => ({
  failSpecsDirectoryCreation: { enabled: false },
  failAlloyDirectoryCreation: { enabled: false },
}));

const { failVerifyRunRemoval, failActiveMarkerRemoval, failActiveMarkerStat, processBoundaryControls, closeSyncControls, openSyncControls } = vi.hoisted(() => ({
  failVerifyRunRemoval: { enabled: false },
  failActiveMarkerRemoval: { enabled: false },
  failActiveMarkerStat: { enabled: false },
  processBoundaryControls: { throwOnSpawn: false },
  closeSyncControls: {
    failNext: false,
    attempts: [] as number[],
  },
  openSyncControls: {
    failPathSuffix: undefined as string | undefined,
    attempts: [] as string[],
    opened: [] as Array<{ path: string; fileDescriptor: number }>,
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (retainMarkerFailure.enabled && retainMarkerFailure.cwd !== undefined
        && String(args[0]).startsWith(retainMarkerFailure.cwd) && String(args[0]).endsWith('.retain')) {
        throw new Error('retention marker write failed');
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (retainMarkerFailure.move && retainMarkerFailure.cwd !== undefined
        && String(args[0]).startsWith(retainMarkerFailure.cwd) && String(args[1]).endsWith('.retain')) {
        throw new Error('retention marker move failed');
      }
      return actual.renameSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (failActiveMarkerStat.enabled && String(args[0]).endsWith('.active')) {
        throw Object.assign(new Error('active marker stat failed'), { code: 'EACCES' });
      }
      return actual.statSync(...args);
    },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      const target = String(args[0]);
      if (failSpecsDirectoryCreation.enabled && (target.endsWith('/specs') || target.endsWith('\\specs'))) {
        throw new Error('specs directory creation failed');
      }
      if (failAlloyDirectoryCreation.enabled && target.endsWith('alloy-run-0')) {
        throw new Error('command output directory creation failed');
      }
      return actual.mkdirSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const path = String(args[0]);
      openSyncControls.attempts.push(path);
      if (openSyncControls.failPathSuffix !== undefined && path.endsWith(openSyncControls.failPathSuffix)) {
        throw new Error('artifact log open failed');
      }
      const fileDescriptor = actual.openSync(...args);
      openSyncControls.opened.push({ path, fileDescriptor });
      return fileDescriptor;
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (failActiveMarkerRemoval.enabled && String(args[0]).endsWith('.active')) {
        throw new Error('active marker removal failed');
      }
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
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      const [fileDescriptor] = args;
      closeSyncControls.attempts.push(fileDescriptor);
      if (closeSyncControls.failNext) {
        closeSyncControls.failNext = false;
        actual.closeSync(...args);
        throw new Error('artifact log close failed');
      }
      return actual.closeSync(...args);
    },
  };
});

vi.mock('../shared/utils/spawn.js', () => ({
  spawnManagedProcess: (...args: unknown[]) => mockSpawnManagedProcess(...args),
}));

import {
  detectJavaMajorVersion,
  cleanupFormalSpecVerificationArtifacts,
  extractFormalSpecBlocks,
  runFormalSpecVerification,
  selectAlloyCheckTargets,
  selectQuintVerificationTargets,
} from '../features/interactive/formalSpecVerifier.js';

const originalAlloyJar = process.env.TAKT_ALLOY_JAR;

interface MockProcessResponse {
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
  readonly hang?: boolean;
  readonly beforeExit?: () => Promise<void>;
  readonly alloySolution?: boolean;
  readonly alloyReceipt?: string | null;
  readonly alloyTrace?: string | null;
}

class MockStream extends EventEmitter {
  setEncoding(_encoding: string): void {
    // The runner only needs the stream event contract in these process-boundary tests.
  }
}

const processResponses: MockProcessResponse[] = [];
const alloyProcessEvents: Array<{ number: number; phase: 'start' | 'end'; time: number }> = [];
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
  let alloyCommands: Array<{ type: string; label: string }> = [];
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
      await response.beforeExit?.();
      if (args.includes('commands') && response.stdout !== undefined) {
        alloyCommands = response.stdout.split('\n').flatMap((line) => {
          const match = /^\s*\d+\s*\.\s+(Check|Run)\s+(.+?)(?:\s+(?:for|expect)\s+.*)?$/iu.exec(line);
          return match ? [{ type: match[1]!.toLowerCase(), label: match[2]! }] : [];
        });
      }
      if (args.includes('exec') && response.alloyReceipt !== null) {
        const outputDirectory = args[args.indexOf('--output') + 1]!;
        const command = alloyCommands[Number(args[args.indexOf('--command') + 1])];
        if (command) {
          const sat = response.alloySolution ?? (command.type === 'run' || Boolean(response.stdout));
          const receipt = { commands: { [command.label]: {
            name: command.label, type: command.type, source: `${command.type} ${command.label}`,
            ...(sat ? { solution: [{ instances: [{ values: {} }] }] } : {}),
          } } };
          writeFileSync(join(outputDirectory, 'receipt.json'), response.alloyReceipt ?? JSON.stringify(receipt));
          if (sat && response.alloyTrace !== null) {
            writeFileSync(join(outputDirectory, `${command.label}-solution-0.txt`), response.alloyTrace ?? '---Trace--- instance');
          }
        }
      }
      if (response.stdout !== undefined) stdout.emit('data', response.stdout);
      if (response.stderr !== undefined) stderr.emit('data', response.stderr);
      if (response.hang) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      if (response.error !== undefined) throw response.error;
      return {
        code: response.code === undefined ? 0 : response.code,
        signal: response.signal ?? null,
      };
    };
    const waitWithEvents = async () => {
      if (!args.includes('exec')) return wait();
      const number = Number(args[args.indexOf('--command') + 1]);
      alloyProcessEvents.push({ number, phase: 'start', time: Date.now() });
      try {
        return await wait();
      } finally {
        alloyProcessEvents.push({ number, phase: 'end', time: Date.now() });
      }
    };
    return {
      child: { stdout, stderr },
      wait: waitWithEvents,
      waitForExit: waitWithEvents,
    };
  });
}

function createTestDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'takt-formal-spec-unit-'));
}

function validAlloyResponse(): string {
  return ['```alloy', 'sig A {}', 'check Safety for 1', '```'].join('\n');
}

function mockTlcVerification(response: MockProcessResponse): void {
  parseResult = {
    modules: [{
      name: 'workflowModel',
      declarations: [
        { kind: 'def', name: 'init', qualifier: 'action' },
        { kind: 'def', name: 'step', qualifier: 'action' },
        { kind: 'def', name: 'propEventually', qualifier: 'temporal' },
      ],
    }],
  };
  processResponses.push(
    { code: 0 },
    { code: 0 },
    { code: 0 },
    { code: 0, stderr: 'openjdk version "17.0.1"' },
    response,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsProcessAlive.mockReset().mockReturnValue(true);
  mockGetProcessIdentity.mockReset().mockReturnValue({ startTime: 'darwin-start-v2:100' });
  retainMarkerFailure.enabled = false;
  retainMarkerFailure.move = false;
  retainMarkerFailure.cwd = undefined;
  processResponses.length = 0;
  spawnedProcesses.length = 0;
  alloyProcessEvents.length = 0;
  vi.stubEnv('TAKT_ALLOY_CONCURRENCY', undefined);
  vi.stubEnv('TAKT_ALLOY_HEAP', undefined);
  vi.stubEnv('TAKT_ALLOY_STACK', undefined);
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
  failAlloyDirectoryCreation.enabled = false;
  failVerifyRunRemoval.enabled = false;
  failActiveMarkerRemoval.enabled = false;
  failActiveMarkerStat.enabled = false;
  processBoundaryControls.throwOnSpawn = false;
  closeSyncControls.failNext = false;
  closeSyncControls.attempts.length = 0;
  openSyncControls.failPathSuffix = undefined;
  openSyncControls.attempts.length = 0;
  openSyncControls.opened.length = 0;
  alloyJarDigestOverride.value = undefined;
  delete process.env.TAKT_ALLOY_JAR;
  mockProcessBoundary();
});

afterEach(() => {
  retainMarkerFailure.enabled = false;
  failActiveMarkerRemoval.enabled = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  failSpecsDirectoryCreation.enabled = false;
  alloyJarDigestOverride.value = undefined;
  if (originalAlloyJar === undefined) {
    delete process.env.TAKT_ALLOY_JAR;
  } else {
    process.env.TAKT_ALLOY_JAR = originalAlloyJar;
  }
});

describe('runFormalSpecVerification', () => {
  function queueAlloyCommands(responses: readonly MockProcessResponse[], sameLabel = false): string {
    const commands = responses.map((_, number) => {
      const type = sameLabel || number % 2 === 0 ? 'run' : 'check';
      const label = sameLabel || number === 0 ? 'Scenario' : number === 1 ? 'Safety' : `Command${number}`;
      return { number, type, label };
    });
    processResponses.push(
      { stderr: 'openjdk version "17.0.1"' },
      { stdout: commands.map(({ number, type, label }) => `${number} . ${type} ${label} for 3`).join('\n') },
      ...responses,
    );
    const definitions = sameLabel
      ? ['pred Scenario { some A }']
      : commands.map(({ type, label }) => `${type === 'run' ? 'pred' : 'assert'} ${label} { some A }`);
    return ['```alloy', 'sig A {}', ...definitions, ...commands.map(({ type, label }, number) => `${type} ${label} for ${number + 3}`), '```'].join('\n');
  }

  it.each([
    { setting: undefined, limit: 2 },
    { setting: '1', limit: 1 },
    { setting: '3', limit: 3 },
  ])('executes all fifteen commands with concurrency $limit when configured as $setting', async ({ setting, limit }) => {
    vi.useFakeTimers();
    vi.stubEnv('TAKT_ALLOY_CONCURRENCY', setting);
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const response = queueAlloyCommands(Array.from({ length: 15 }, () => ({
      beforeExit: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
    })));
    try {
      const verification = runFormalSpecVerification(response, directory, { modelCheckTimeoutSeconds: 1 });
      await vi.runAllTimersAsync();
      const result = await verification;
      let running = 0;
      let maximum = 0;
      for (const event of alloyProcessEvents) {
        running += event.phase === 'start' ? 1 : -1;
        maximum = Math.max(maximum, running);
        expect(running).toBeLessThanOrEqual(limit);
      }
      expect(maximum).toBe(limit);
      expect(running).toBe(0);
      expect(alloyProcessEvents.filter(({ phase }) => phase === 'start').map(({ number }) => number)).toEqual(Array.from({ length: 15 }, (_, i) => i));
      expect(result.alloy.commandResults).toHaveLength(15);
      expect(result.alloy.commandResults?.every(({ status }) => status === 'passed')).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refills a free slot before the slower sibling finishes and preserves command artifact identity', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const response = queueAlloyCommands([1000, 100, 100].map((delay, number) => ({
      stdout: `stdout-${number}`, stderr: `stderr-${number}`,
      beforeExit: () => new Promise<void>((resolve) => setTimeout(resolve, delay)),
    })));
    try {
      const verification = runFormalSpecVerification(response, directory, { modelCheckTimeoutSeconds: 2 });
      await vi.runAllTimersAsync();
      const result = await verification;
      const startOfThird = alloyProcessEvents.find(({ number, phase }) => number === 2 && phase === 'start')!;
      const endOfSecond = alloyProcessEvents.find(({ number, phase }) => number === 1 && phase === 'end')!;
      const endOfFirst = alloyProcessEvents.find(({ number, phase }) => number === 0 && phase === 'end')!;
      expect(startOfThird.time).toBe(endOfSecond.time);
      expect(startOfThird.time).toBeLessThan(endOfFirst.time);
      // stdout は SAT 判定の代用にしないため各コマンドの receipt も照合する。
      expect(result.alloy.commandResults?.map(({ number }) => number)).toEqual([0, 1, 2]);
      for (const command of result.alloy.commandResults!) {
        const stage = `alloy-${command.type}-${command.number}`;
        expect(readFileSync(result.artifacts!.logs[stage]!.stdout, 'utf8')).toBe(`stdout-${command.number}`);
        expect(readFileSync(result.artifacts!.logs[stage]!.stderr, 'utf8')).toBe(`stderr-${command.number}`);
        const receiptPath = result.artifacts!.alloyOutputs!.find((path) => path.endsWith(`${stage}/receipt.json`))!;
        expect(JSON.parse(readFileSync(receiptPath, 'utf8')).commands[command.label]).toMatchObject({ type: command.type, name: command.label });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps separate logs and receipts for repeated labels when the later command finishes first', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const response = queueAlloyCommands([1000, 100].map((delay, number) => ({
      stdout: `run-${number}`,
      alloyTrace: `instance-${number}`,
      beforeExit: () => new Promise<void>((resolve) => setTimeout(resolve, delay)),
    })), true);
    try {
      const verification = runFormalSpecVerification(response, directory, { modelCheckTimeoutSeconds: 2 });
      await vi.runAllTimersAsync();
      const result = await verification;
      expect(alloyProcessEvents.filter(({ phase }) => phase === 'end').map(({ number }) => number)).toEqual([1, 0]);
      expect(result.alloy.commandResults).toMatchObject([
        { number: 0, label: 'Scenario', status: 'passed' },
        { number: 1, label: 'Scenario', status: 'passed' },
      ]);
      for (const number of [0, 1]) {
        const stage = `alloy-run-${number}`;
        expect(readFileSync(result.artifacts!.logs[stage]!.stdout, 'utf8')).toBe(`run-${number}`);
        const paths = result.artifacts!.alloyOutputs!.filter((path) => path.includes(`/${stage}/`));
        expect(paths).toHaveLength(2);
        expect(JSON.parse(readFileSync(paths.find((path) => path.endsWith('receipt.json'))!, 'utf8')).commands.Scenario.name).toBe('Scenario');
        expect(readFileSync(paths.find((path) => path.endsWith('.txt'))!, 'utf8')).toBe(`instance-${number}`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports one timeout separately while collecting fourteen other success and failure results', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const response = queueAlloyCommands(Array.from({ length: 15 }, (_, number) => number === 0
      ? { hang: true }
      : { alloySolution: number === 1 || number % 2 === 0,
        beforeExit: () => new Promise<void>((resolve) => setTimeout(resolve, 100)) }));
    try {
      const verification = runFormalSpecVerification(response, directory, { modelCheckTimeoutSeconds: 1 });
      await vi.runAllTimersAsync();
      const result = await verification;
      expect(result.alloy.commandResults).toHaveLength(15);
      expect(result.alloy.commandResults![0]).toMatchObject({ number: 0, status: 'error', timedOut: true });
      expect(result.alloy.commandResults![1]).toMatchObject({ number: 1, status: 'failed' });
      expect(result.alloy.commandResults?.slice(1).every((command) => !('timedOut' in command) || command.timedOut === false)).toBe(true);
      expect(result.alloy.commandResults?.slice(2).every(({ status }) => status === 'passed')).toBe(true);
      expect(alloyProcessEvents.filter(({ phase }) => phase === 'end')).toHaveLength(15);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('finishes fifteen timed out commands within eight individual deadlines without a global cutoff', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const response = queueAlloyCommands(Array.from({ length: 15 }, () => ({ hang: true })));
    try {
      const verification = runFormalSpecVerification(response, directory, { modelCheckTimeoutSeconds: 1 });
      await vi.runAllTimersAsync();
      const result = await verification;
      expect(result.alloy.commandResults).toHaveLength(15);
      for (let number = 0; number < 15; number++) {
        expect(result.alloy.commandResults![number]).toMatchObject({ number, status: 'error', timedOut: true });
        const start = alloyProcessEvents.find((event) => event.number === number && event.phase === 'start')!;
        const end = alloyProcessEvents.find((event) => event.number === number && event.phase === 'end')!;
        expect(end.time - start.time).toBe(1000);
      }
      expect(alloyProcessEvents.at(-1)!.time - alloyProcessEvents[0]!.time).toBeLessThanOrEqual(8000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { heap: undefined, stack: undefined, expectedHeap: '-Xmx4g', expectedStack: '-Xss64m' },
    { heap: '2g', stack: undefined, expectedHeap: '-Xmx2g', expectedStack: '-Xss64m' },
    { heap: undefined, stack: '128m', expectedHeap: '-Xmx4g', expectedStack: '-Xss128m' },
    { heap: '1536m', stack: '32768k', expectedHeap: '-Xmx1536m', expectedStack: '-Xss32768k' },
  ])('applies heap $heap and stack $stack to enumeration and every execution', async ({ heap, stack, expectedHeap, expectedStack }) => {
    vi.stubEnv('TAKT_ALLOY_HEAP', heap);
    vi.stubEnv('TAKT_ALLOY_STACK', stack);
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    try {
      const result = await runFormalSpecVerification(queueAlloyCommands([{}, {}]), directory, { modelCheckTimeoutSeconds: 1 });
      expect(result.verdict).toBe('passed');
      const launches = spawnedProcesses.filter(({ args }) => args.includes('-jar'));
      expect(launches).toHaveLength(3);
      for (const { args } of launches) {
        expect(args.filter((arg) => arg.startsWith('-Xmx'))).toEqual([expectedHeap]);
        expect(args.filter((arg) => arg.startsWith('-Xss'))).toEqual([expectedStack]);
        expect(args.indexOf(expectedHeap)).toBeLessThan(args.indexOf('-jar'));
        expect(args.indexOf(expectedStack)).toBeLessThan(args.indexOf('-jar'));
      }
      expect(spawnedProcesses.find(({ args }) => args.includes('-version'))!.args).toEqual(['-version']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['TAKT_ALLOY_CONCURRENCY', '0'], ['TAKT_ALLOY_CONCURRENCY', '-1'],
    ['TAKT_ALLOY_CONCURRENCY', '1.5'], ['TAKT_ALLOY_CONCURRENCY', 'abc'],
    ['TAKT_ALLOY_CONCURRENCY', '9007199254740992'], ['TAKT_ALLOY_CONCURRENCY', ''],
    ['TAKT_ALLOY_HEAP', '0g'], ['TAKT_ALLOY_HEAP', '4'],
    ['TAKT_ALLOY_STACK', '-1m'], ['TAKT_ALLOY_STACK', '64m -jar other.jar'],
  ])('rejects invalid %s=%j with a named configuration error', async (name, value) => {
    vi.stubEnv(name, value);
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    try {
      const result = await runFormalSpecVerification(queueAlloyCommands([{}]), directory, { modelCheckTimeoutSeconds: 1 });
      expect(result.verdict).toBe('error');
      expect([result.message, result.alloy.message].join('\n')).toContain(name);
      expect(spawnedProcesses.filter(({ args }) => args.includes('exec'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores Alloy-only settings for a Quint-only response', async () => {
    vi.stubEnv('TAKT_ALLOY_CONCURRENCY', 'invalid');
    vi.stubEnv('TAKT_ALLOY_HEAP', 'invalid');
    vi.stubEnv('TAKT_ALLOY_STACK', 'invalid');
    const directory = createTestDirectory();
    processResponses.push({}, {}, {}, { error: new Error('Java unavailable') });
    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 1 });
      expect(result.verdict).toBe('passed');
      expect(result.quint.run?.status).toBe('passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('continues Quint verification when Alloy execution settings are invalid', async () => {
    vi.stubEnv('TAKT_ALLOY_CONCURRENCY', 'invalid');
    const directory = createTestDirectory();
    processResponses.push(
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0 },
    );

    try {
      const response = ['```quint', 'module verify {}', '```', validAlloyResponse()].join('\n');
      const result = await runFormalSpecVerification(response, directory, { modelCheckTimeoutSeconds: 1 });

      expect(result.quint).toMatchObject({
        status: 'passed',
        parse: { status: 'passed' },
        typecheck: { status: 'passed' },
        run: { status: 'passed' },
        verify: { status: 'passed' },
      });
      expect(result.alloy).toMatchObject({
        status: 'error',
        message: expect.stringContaining('TAKT_ALLOY_CONCURRENCY'),
      });
      expect(spawnedProcesses.some(({ args }) => args.includes('verify'))).toBe(true);
      expect(spawnedProcesses.some(({ args }) => args.includes('commands'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('collects later commands after one output directory cannot be created', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    failAlloyDirectoryCreation.enabled = true;
    try {
      const result = await runFormalSpecVerification(queueAlloyCommands([{}, {}, {}]), directory, { modelCheckTimeoutSeconds: 1 });
      expect(result.alloy.commandResults).toMatchObject([
        { number: 0, status: 'error', message: expect.stringContaining('command output directory creation failed') },
        { number: 1, status: 'passed' },
        { number: 2, status: 'passed' },
      ]);
      expect(spawnedProcesses.filter(({ args }) => args.includes('exec')).map(({ args }) => args[args.indexOf('--command') + 1])).toEqual(['1', '2']);
    } finally {
      failAlloyDirectoryCreation.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts verification of closed Quint and Alloy fences from the current response', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    parseResult = { modules: [{ name: 'current', declarations: [] }] };
    processResponses.push(
      { code: 0 },
      { code: 0 },
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: '0 . Run Default for 3\n' },
      { code: 0 },
    );
    try {
      const result = await runFormalSpecVerification(
        '```quint\nmodule current {}\n```\n~~~alloy\nrun {} for 3\n~~~',
        directory,
        { modelCheckTimeoutSeconds: 300 },
      );

      expect(result.verificationStarted).toBe(true);
      expect(readFileSync(result.artifacts!.specifications.quint!, 'utf8').trim()).toBe('module current {}');
      expect(readFileSync(result.artifacts!.specifications.alloy!, 'utf8').trim()).toBe('run {} for 3');
      expect(spawnedProcesses.some(({ args }) => args.includes('parse') && args.includes(result.artifacts!.specifications.quint!))).toBe(true);
      expect(spawnedProcesses.some(({ args }) => args.includes('commands') && args.includes(result.artifacts!.specifications.alloy!))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'quoted and nested fences',
      response: '> ```quint\n> module quoted {}\n> ```\n````text\n```alloy\nrun {} for 3\n```\n````',
    },
    { label: 'inline fence notation', response: 'inline ` ```quint module fake {} ``` `' },
    { label: 'unclosed target fence', response: '```quint\nmodule incomplete {}' },
  ])('does not verify $label as a partial or independent specification', async ({ response }) => {
    const directory = createTestDirectory();
    try {
      const result = await runFormalSpecVerification(response, directory, { modelCheckTimeoutSeconds: 300 });

      expect(result).toMatchObject({ verdict: 'error', verificationStarted: false });
      expect(result.artifacts).toBeUndefined();
      expect(mockSpawnManagedProcess).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should fail explicitly without invoking verification for unfenced headings and quoted, inline or nested blocks', async () => {
    const response = [
      '## Quint', 'module current {}', '## Alloy', 'run {} for 3',
      '> ```quint', '> module quoted {}', '> ```',
      'inline ` ```alloy `',
      '````text', '```quint', 'module nested {}', '```', '````',
    ].join('\n');

    const result = await runFormalSpecVerification(response, '/repo', { modelCheckTimeoutSeconds: 300 });

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
    expect(mockSpawnManagedProcess).not.toHaveBeenCalled();
  });

  it('should treat a run workspace creation failure as a started verification error', async () => {
    const directory = createTestDirectory();
    writeFileSync(join(directory, '.takt'), 'not a directory');

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

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

  it('should retain a partially created run workspace when specs creation fails', async () => {
    const directory = createTestDirectory();
    failSpecsDirectoryCreation.enabled = true;

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

      expect(result).toMatchObject({
        verdict: 'error',
        verificationStarted: true,
        quint: { status: 'error', message: 'specs directory creation failed' },
        alloy: { status: 'skipped' },
      });
      expect(readdirSync(join(directory, '.takt', 'runs'))
        .filter((name) => name.startsWith('verify-'))).toHaveLength(1);
      expect(result.artifacts?.runDirectory).toBeDefined();
      cleanupFormalSpecVerificationArtifacts(result);
      expect(existsSync(result.artifacts!.runDirectory)).toBe(true);
    } finally {
      failSpecsDirectoryCreation.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should retain a synchronous spawn failure workspace after the interpretation cleanup', async () => {
    const directory = createTestDirectory();
    processBoundaryControls.throwOnSpawn = true;

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });

      expect(result).toMatchObject({ verdict: 'error', verificationStarted: true });
      expect(mockSpawnManagedProcess).toHaveBeenCalledOnce();
      expect(readdirSync(join(directory, '.takt', 'runs'))
        .filter((name) => name.startsWith('verify-'))).toHaveLength(1);
      expect(result.artifacts?.runDirectory).toBeDefined();
      cleanupFormalSpecVerificationArtifacts(result);
      expect(readdirSync(join(directory, '.takt', 'runs'))
        .filter((name) => name.startsWith('verify-'))).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('returns an initialization error and its retained directory when ownership release fails=%s', async (ownershipFailure) => {
    const directory = createTestDirectory();
    failSpecsDirectoryCreation.enabled = true;
    failActiveMarkerRemoval.enabled = ownershipFailure;
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(result).toMatchObject({ verdict: 'error', verificationStarted: true, quint: { status: 'error' } });
      const runDirectory = result.artifacts!.runDirectory;
      expect(result.message).toContain(runDirectory);
      expect(existsSync(join(runDirectory, '.retain'))).toBe(true);
      expect(existsSync(join(runDirectory, '.active'))).toBe(ownershipFailure);
      if (ownershipFailure) expect(result.message).toContain('active marker removal failed');
      expect(mockSpawnManagedProcess).not.toHaveBeenCalled();
    } finally {
      failActiveMarkerRemoval.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each((['failed', 'error', 'timeout'] as const).flatMap((mode) =>
    (['none', 'ownership', 'write', 'move'] as const).map((failure) => ({ mode, failure })),
  ))('returns $mode results and readable logs with retention failure=$failure', async ({ mode, failure }) => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { stderr: 'openjdk version "17.0.1"' },
      { stdout: '0 . Check Safety for 1\n' },
      {
        stdout: 'verification output', stderr: 'verification diagnostic',
        alloySolution: true,
        ...(mode === 'error' ? { error: new Error('process failed') } : {}),
        ...(mode === 'timeout' ? { hang: true } : {}),
      },
    );
    const ownershipFailure = failure === 'ownership';
    retainMarkerFailure.cwd = directory;
    retainMarkerFailure.enabled = failure === 'write' || failure === 'move';
    retainMarkerFailure.move = failure === 'move';
    failActiveMarkerRemoval.enabled = ownershipFailure;
    try {
      const verification = runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 1 });
      const [result] = await Promise.all([verification, vi.advanceTimersByTimeAsync(1000)]);
      const verdict = mode === 'failed' ? 'failed' : 'error';
      expect(result).toMatchObject({
        verdict, verificationStarted: true,
        quint: { status: 'skipped' },
        alloy: { status: verdict, commandResults: [{ number: 0, status: verdict, timedOut: mode === 'timeout' }] },
      });
      const artifacts = result.artifacts!;
      expect(result.message).toContain(artifacts.runDirectory);
      expect(result.artifactRetention?.status).toBe(failure === 'move' ? 'error' : 'passed');
      if (mode === 'error') expect(result.alloy.message).toContain('process failed');
      if (mode === 'timeout') expect(result.alloy.message).toContain('timed out');
      if (retainMarkerFailure.enabled) expect(result.artifactRetention?.message).toContain('retention marker write failed');
      if (failure === 'move') {
        expect(result.artifactRetention?.message).toContain('retention marker move failed');
        expect(result.message).not.toMatch(/artifacts retained at/iu);
      }
      if (ownershipFailure) expect(result.message).toContain('active marker removal failed');
      expect(existsSync(join(artifacts.runDirectory, '.retain'))).toBe(failure !== 'move');
      expect(existsSync(join(artifacts.runDirectory, '.active'))).toBe(ownershipFailure || failure === 'move');
      cleanupFormalSpecVerificationArtifacts(result);
      failActiveMarkerRemoval.enabled = false;
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(artifacts.runDirectory, old, old);
      await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 1 });
      expect(readFileSync(artifacts.specifications.alloy!, 'utf8')).toContain('check Safety');
      expect(readFileSync(artifacts.logs['alloy-check-0']!.stdout, 'utf8')).toBe('verification output');
      expect(readFileSync(artifacts.logs['alloy-check-0']!.stderr, 'utf8')).toBe('verification diagnostic');
      mockIsProcessAlive.mockReturnValue(false);
      await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 1 });
      expect(readFileSync(artifacts.specifications.alloy!, 'utf8')).toContain('check Safety');
      expect(readFileSync(artifacts.logs['alloy-check-0']!.stdout, 'utf8')).toBe('verification output');
      expect(readFileSync(artifacts.logs['alloy-check-0']!.stderr, 'utf8')).toBe('verification diagnostic');
      vi.resetModules();
      const nextVerifier = await import('../features/interactive/formalSpecVerifier.js');
      await nextVerifier.runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 1 });
      expect(readFileSync(artifacts.specifications.alloy!, 'utf8')).toContain('check Safety');
      expect(readFileSync(artifacts.logs['alloy-check-0']!.stdout, 'utf8')).toBe('verification output');
      expect(readFileSync(artifacts.logs['alloy-check-0']!.stderr, 'utf8')).toBe('verification diagnostic');
    } finally {
      failActiveMarkerRemoval.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { age: 60 * 60 * 1000 - 1, removed: false },
    { age: 60 * 60 * 1000, removed: false },
    { age: 60 * 60 * 1000 + 1, removed: true },
    { age: 2 * 60 * 60 * 1000, removed: true },
  ])('sweeps unmarked verify workspaces at age=$age while retaining recent and unrelated entries', async ({ age, removed }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const directory = createTestDirectory();
    const runsDirectory = join(directory, '.takt', 'runs');
    const staleDirectory = join(runsDirectory, 'verify-stale');
    const recentDirectory = join(runsDirectory, 'verify-recent');
    const unrelatedDirectory = join(runsDirectory, 'unrelated');
    mkdirSync(staleDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(recentDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(unrelatedDirectory, { recursive: true, mode: 0o700 });
    const staleTime = new Date(Date.now() - age);
    utimesSync(staleDirectory, staleTime, staleTime);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(statSync(staleDirectory).mtimeMs + age);

    try {
      await runFormalSpecVerification('No formal specification was generated.', directory, { modelCheckTimeoutSeconds: 300 });

      expect(existsSync(staleDirectory)).toBe(!removed);
      expect(existsSync(recentDirectory)).toBe(true);
      expect(existsSync(unrelatedDirectory)).toBe(true);
    } finally {
      nowSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { owner: 'dead', age: 60 * 60 * 1000 - 1 },
    { owner: 'dead', age: 60 * 60 * 1000 },
    { owner: 'dead', age: 60 * 60 * 1000 + 1 },
    { owner: 'alive', age: 2 * 60 * 60 * 1000 },
    { owner: 'reused', age: 2 * 60 * 60 * 1000 },
    { owner: 'unknown', age: 2 * 60 * 60 * 1000 },
    { owner: 'unavailable', age: 2 * 60 * 60 * 1000 },
  ])('protects marked workspaces for owner=$owner age=$age until explicitly removed', async ({ owner, age }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const controller = new AbortController();
    let observed = false;
    processResponses.push({ code: 0, stderr: 'openjdk version "17.0.1"', beforeExit: async () => {
      const activeWorkspace = spawnedProcesses.at(-1)!.options.cwd!;
      const staleTime = new Date(Date.now() - age);
      utimesSync(activeWorkspace, staleTime, staleTime);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(statSync(activeWorkspace).mtimeMs + age);
      try {
        await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 300 });
        expect(existsSync(join(activeWorkspace, 'specs', 'spec.als'))).toBe(true);
        mockIsProcessAlive.mockReturnValue(owner !== 'dead');
        if (owner === 'reused') mockGetProcessIdentity.mockReturnValue({ startTime: 'darwin-start-v2:101' });
        if (owner === 'unknown') mockGetProcessIdentity.mockReturnValue(undefined);
        if (owner === 'unavailable') mockIsProcessAlive.mockImplementation(() => { throw new Error('process lookup unavailable'); });
        await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 300 });
        expect(existsSync(join(activeWorkspace, 'specs', 'spec.als'))).toBe(true);
        observed = true;
        controller.abort(new Error('test owner stopped'));
      } finally {
        nowSpy.mockRestore();
      }
    } });
    try {
      await expect(runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300, abortSignal: controller.signal }))
        .rejects.toThrow('test owner stopped');
      expect(observed).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('protects stale workspaces when the active marker cannot be inspected', async () => {
    const directory = createTestDirectory();
    const runDirectory = join(directory, '.takt', 'runs', 'verify-inaccessible');
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, '.active'), '{}');
    writeFileSync(join(runDirectory, 'spec.als'), 'sig A {}');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(runDirectory, old, old);
    failActiveMarkerStat.enabled = true;
    try {
      await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 300 });
      expect(readFileSync(join(runDirectory, 'spec.als'), 'utf8')).toBe('sig A {}');
    } finally {
      failActiveMarkerStat.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('protects successful artifacts until interpretation cleanup even after one hour', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push({ code: 0, stderr: 'openjdk version "17.0.1"' }, { code: 0, stdout: '0 . Check Safety for 1' }, { code: 0 });
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(result.verdict).toBe('passed');
      const runDirectory = result.artifacts!.runDirectory;
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(runDirectory, old, old);
      await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 300 });
      expect(readFileSync(result.artifacts!.specifications.alloy!, 'utf8')).toContain('check');
      cleanupFormalSpecVerificationArtifacts(result);
      expect(existsSync(runDirectory)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('returns initialization errors and protects their directory when retention writing fails=%s', async (writeFailure) => {
    const directory = createTestDirectory();
    failSpecsDirectoryCreation.enabled = true;
    retainMarkerFailure.enabled = writeFailure;
    retainMarkerFailure.cwd = directory;
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(result).toMatchObject({ verdict: 'error', verificationStarted: true });
      expect(result.artifactRetention?.status).toBe('passed');
      const runDirectory = result.artifacts!.runDirectory;
      expect(result.message).toContain('specs directory creation failed');
      expect(result.message).toContain(runDirectory);
      if (writeFailure) expect(result.message).toContain('retention marker write failed');
      expect(result.artifacts!.specifications).toEqual({});
      expect(result.artifacts!.logs).toEqual({});
      expect(existsSync(join(runDirectory, '.retain'))).toBe(true);
      expect(existsSync(join(runDirectory, '.active'))).toBe(false);
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(runDirectory, old, old);
      await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 300 });
      expect(existsSync(runDirectory)).toBe(true);
      mockIsProcessAlive.mockReturnValue(false);
      await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 300 });
      expect(existsSync(runDirectory)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should retain an active workspace when sequential Alloy checks outlive the stale threshold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('TAKT_ALLOY_CONCURRENCY', '1');
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const checkNumbers = Array.from({ length: 80 }, (_, index) => index);
    const retainedSpecifications: boolean[] = [];
    processResponses.push(
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: checkNumbers.map((index) => `${index} . Check Safety${index} for 1`).join('\n') },
      ...checkNumbers.map(() => ({
        code: 0,
        beforeExit: async () => {
          const activeWorkspace = spawnedProcesses.at(-1)?.options.cwd;
          if (activeWorkspace === undefined) {
            throw new Error('Alloy process has no workspace');
          }
          vi.setSystemTime(Date.now() + 50_000);
          await runFormalSpecVerification('No formal specification was generated.', directory, { modelCheckTimeoutSeconds: 300 });
          retainedSpecifications.push(existsSync(join(activeWorkspace, 'specs', 'spec.als')));
        },
      })),
    );

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.alloy).toMatchObject({ status: 'passed', checks: checkNumbers });
      expect(retainedSpecifications).toEqual(checkNumbers.map(() => true));
      cleanupFormalSpecVerificationArtifacts(result);
      expect(readdirSync(join(directory, '.takt', 'runs'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { age: 60 * 60 * 1000 - 1, removed: false },
    { age: 60 * 60 * 1000, removed: false },
    { age: 60 * 60 * 1000 + 1, removed: true },
    { age: 2 * 60 * 60 * 1000, removed: true },
  ].flatMap((boundary) => [false, true].map((ownershipFailure) => ({ ...boundary, ownershipFailure }))))('retries failed successful-workspace cleanup at age=$age ownershipFailure=$ownershipFailure with the owner still alive', async ({ age, removed, ownershipFailure }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: '0 . Check Safety for 1\n' },
      { code: 0 },
    );
    failVerifyRunRemoval.enabled = true;

    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.verdict).toBe('passed');
      expect(result.alloy.status).toBe('passed');
      expect(readdirSync(join(directory, '.takt', 'runs'))
        .filter((name) => name.startsWith('verify-'))).toHaveLength(1);
      failActiveMarkerRemoval.enabled = ownershipFailure;
      cleanupFormalSpecVerificationArtifacts(result);
      expect(readdirSync(join(directory, '.takt', 'runs'))
        .filter((name) => name.startsWith('verify-'))).toHaveLength(1);

      const runDirectory = result.artifacts!.runDirectory;
      const releasedAt = statSync(runDirectory).mtimeMs;
      failVerifyRunRemoval.enabled = false;
      failActiveMarkerRemoval.enabled = false;
      vi.setSystemTime(releasedAt + age);
      await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 300 });
      expect(existsSync(runDirectory)).toBe(!removed);
      expect(result).toMatchObject({ verdict: 'passed', alloy: { status: 'passed' } });
    } finally {
      failVerifyRunRemoval.enabled = false;
      failActiveMarkerRemoval.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes successful artifacts even when active ownership release fails', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: '0 . Check Safety for 1\n' },
      { code: 0 },
    );
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      failActiveMarkerRemoval.enabled = true;
      cleanupFormalSpecVerificationArtifacts(result);
      expect(existsSync(result.artifacts!.runDirectory)).toBe(false);
      expect(result).toMatchObject({ verdict: 'passed', alloy: { status: 'passed' } });
    } finally {
      failActiveMarkerRemoval.enabled = false;
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
      const failed = await runFormalSpecVerification(quintResponse, directory, { modelCheckTimeoutSeconds: 300 });
      expect(failed.verdict).toBe('failed');
      expect(failed.quint.run).toMatchObject({ status: 'failed', message: 'counterexample' });

      processResponses.push(
        { code: 0 },
        { code: 0 },
        { error: new Error('spawn failed') },
      );
      const errored = await runFormalSpecVerification(quintResponse, directory, { modelCheckTimeoutSeconds: 300 });
      expect(errored.verdict).toBe('error');
      expect(errored.quint.run).toMatchObject({ status: 'error', message: 'spawn failed' });

      processResponses.push(
        { code: 0 },
        { code: 0 },
        { code: null },
      );
      const statusless = await runFormalSpecVerification(quintResponse, directory, { modelCheckTimeoutSeconds: 300 });
      expect(statusless.verdict).toBe('error');
      expect(statusless.quint.run).toMatchObject({ status: 'error' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should fail a successful exit when closing its diagnostic artifact fails', async () => {
    const directory = createTestDirectory();
    closeSyncControls.failNext = true;

    try {
      const result = await runFormalSpecVerification(
        '```quint\nmodule verify {}\n```',
        directory,
        { modelCheckTimeoutSeconds: 300 },
      );

      expect(result.verdict).toBe('error');
      expect(result.quint.parse).toMatchObject({ status: 'error' });
      expect(result.quint.parse?.message).toContain('artifact log close failed');
      expect(closeSyncControls.attempts).toHaveLength(2);
      expect(new Set(closeSyncControls.attempts)).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should retain a Java version artifact close error instead of skipping verification', async () => {
    const directory = createTestDirectory();
    processResponses.push(
      { code: 0 },
      { code: 0 },
      { code: 0 },
      {
        code: 0,
        stderr: 'openjdk version "17.0.1"',
        beforeExit: async () => {
          closeSyncControls.failNext = true;
        },
      },
    );

    try {
      const result = await runFormalSpecVerification(
        '```quint\nmodule verify {}\n```',
        directory,
        { modelCheckTimeoutSeconds: 300 },
      );

      expect(result.verdict).toBe('error');
      expect(result.message).toContain('artifact log close failed');
      expect(result.quint.status).toBe('error');
      expect(spawnedProcesses).toHaveLength(4);
      expect(spawnedProcesses.at(-1)).toMatchObject({ command: 'java', args: ['-version'] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['stdout', 'java-version.stdout.log'],
    ['stderr', 'java-version.stderr.log'],
  ])('should retain a Java version %s log open error instead of skipping verification', async (stream, pathSuffix) => {
    const directory = createTestDirectory();
    openSyncControls.failPathSuffix = pathSuffix;
    processResponses.push({ code: 0 }, { code: 0 }, { code: 0 });

    try {
      const result = await runFormalSpecVerification(
        '```quint\nmodule verify {}\n```',
        directory,
        { modelCheckTimeoutSeconds: 300 },
      );

      expect(result.verdict).toBe('error');
      expect(result.message).toContain('artifact log open failed');
      expect(result.quint.status).toBe('error');
      expect(spawnedProcesses).toHaveLength(3);

      if (stream === 'stderr') {
        const javaVersionStdout = openSyncControls.opened.find(({ path }) => path.endsWith('java-version.stdout.log'));
        expect(javaVersionStdout).toBeDefined();
        if (javaVersionStdout === undefined) {
          throw new Error('Java version stdout log was not opened before stderr failed');
        }
        expect(closeSyncControls.attempts).toContain(javaVersionStdout.fileDescriptor);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should keep verification skipped when Java is unavailable and its diagnostic logs open', async () => {
    const directory = createTestDirectory();
    processResponses.push(
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { error: new Error('spawn java ENOENT') },
    );

    try {
      const result = await runFormalSpecVerification(
        '```quint\nmodule verify {}\n```',
        directory,
        { modelCheckTimeoutSeconds: 300 },
      );

      expect(result.quint.verify).toMatchObject({
        status: 'skipped',
        message: 'Java 17 or later was not detected; Quint verification was skipped.',
      });
      expect(spawnedProcesses.at(-1)).toMatchObject({ command: 'java', args: ['-version'] });
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
      const verification = runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });
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
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });
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
      expect(verifyCall?.args).not.toContain('--verbosity');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should extract TLC stdout diagnostics without including the stderr summary or startup logs', async () => {
    const directory = createTestDirectory();
    const diagnostics = [
      'Error: TLC threw an unexpected exception.',
      'This was probably caused by an error in the spec or model.',
      'The exception was a java.lang.RuntimeException',
      ': TLC encountered a non-enumerable quantifier bound',
      'Int.',
      'Error: The behavior up to this point is:',
      'State 1: <Initial predicate>',
      '/\\ rejected = FALSE',
      '[failure] TLC encountered an error (592ms).',
    ].join('\n');
    mockTlcVerification({
      code: 1,
      stderr: 'error: TLC error (see output above)',
      stdout: [
        'Parsing file /tmp/spec.tla',
        'Semantic processing of module verify',
        'SANY parser log',
        'WARNING: protobuf warning',
        '[0.123s][warning][gc] GC warning',
        'fingerprint statistics: 100 states',
        diagnostics,
      ].join('\n'),
    });

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.quint.verify).toEqual({ status: 'failed', message: diagnostics });
      expect(result.message).toContain(diagnostics);
      expect(result.message).toContain(result.artifacts!.runDirectory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['\n', '\r\n'])('should retain diagnostic words and trace values with line ending %j', async (newline) => {
    const directory = createTestDirectory();
    const diagnosticLines = [
      'Error: TLC could not compute a fingerprint.',
      'Error: The behavior up to this point is:',
      'State 1: <Initial predicate>',
      '/\\ phase = "GC"',
      '/\\ source = "SANY"',
      '/\\ format = "protobuf"',
      '/\\ fingerprint = 1',
      '[failure] TLC encountered an error (592ms).',
    ];
    mockTlcVerification({
      code: 1,
      stdout: diagnosticLines.join(newline),
      stderr: 'error: TLC error (see output above)',
    });

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.quint.verify).toEqual({ status: 'failed', message: diagnosticLines.join('\n') });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { stdout: 'unclassified TLC output', stderr: 'error: TLC error (see output above)' },
    { stdout: 'error: unknown failure\nParsing file /tmp/spec.tla', stderr: 'unknown stderr detail' },
    { stdout: 'unclassified TLC output', stderr: 'Error: stderr failure\n[failure] stderr summary' },
  ])('should retain both raw streams when stdout has no TLC diagnostic marker: %j', async (output) => {
    const directory = createTestDirectory();
    mockTlcVerification({ code: 1, ...output });

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.quint.verify).toEqual({ status: 'failed', message: `${output.stderr}\n${output.stdout}` });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should retain both raw streams when a failure summary has no Error block', async () => {
    const directory = createTestDirectory();
    const summary = '[failure] TLC encountered an error (592ms).';
    const output = {
      stdout: `Parsing file /tmp/spec.tla\n${summary}`,
      stderr: 'error: TLC error (see output above)',
    };
    mockTlcVerification({ code: 1, ...output });

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.quint.verify).toEqual({ status: 'failed', message: `${output.stderr}\n${output.stdout}` });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should retain the Java spawn failure from stderr alongside the stdout failure summary', async () => {
    const directory = createTestDirectory();
    const output = {
      stdout: '[failure] TLC encountered an error (592ms).',
      stderr: 'error: Failed to spawn TLC: spawn java EAGAIN',
    };
    mockTlcVerification({ code: 1, ...output });

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.quint.verify).toEqual({ status: 'failed', message: `${output.stderr}\n${output.stdout}` });
      expect(result.message).toContain(result.quint.verify?.message);
      expect(result.message).toContain(result.artifacts!.runDirectory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0, 8_001, 1024 * 1024 + 1])('should retain timeout diagnostics and bound captured output with %i output characters', async (outputLength) => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    mockTlcVerification({ hang: true, stdout: 'x'.repeat(outputLength) });

    try {
      const verification = runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });
      await vi.advanceTimersByTimeAsync(300_000);
      const result = await verification;

      expect(result.verdict).toBe('error');
      expect(result.quint.verify).toMatchObject({ status: 'error' });
      expect(result.quint.verify?.message).toContain('TLC');
      expect(result.quint.verify?.message).toContain('Process timed out after 300000 ms');
      if (outputLength > 8_000) {
        expect(result.quint.verify?.message).toHaveLength(8_000 + '\n[output truncated]'.length);
        expect(result.quint.verify?.message).toContain('[output truncated]');
      }
      if (outputLength > 1024 * 1024) {
        expect(result.quint.verify?.message).toContain('capture limit');
      } else {
        expect(result.quint.verify?.message).not.toContain('capture limit');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['stdout', 'stderr'] as const)('should warn when TLC %s exceeds the capture limit', async (stream) => {
    const directory = createTestDirectory();
    mockTlcVerification({
      code: 1,
      stdout: 'Error: TLC encountered a non-enumerable quantifier bound\nInt.',
      stderr: 'error: TLC error (see output above)',
      [stream]: `${'x'.repeat(1024 * 1024)}\nError: diagnostic beyond capture limit`,
    });

    try {
      const result = await runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.quint.verify).toMatchObject({ status: 'failed' });
      expect(result.quint.verify?.message).toMatch(/^TLC output[^\n]*capture limit[^\n]*diagnostics may be missing/);
      expect(result.quint.verify?.message).not.toContain('diagnostic beyond capture limit');
      expect(result.message).toContain(result.quint.verify?.message);
      expect(result.message).toContain(result.artifacts!.runDirectory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should apply a configured timeout to Quint model checking while keeping TLC guidance', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    mockTlcVerification({ hang: true });

    try {
      const verification = runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, {
        modelCheckTimeoutSeconds: 2,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await verification;

      expect(result.quint.verify?.message).toContain('Process timed out after 2000 ms');
      expect(result.quint.verify?.message).toContain('TLC');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should keep Quint parse, typecheck, and run at 60 seconds when model-check timeout is customized', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    processResponses.push(
      { code: 0 },
      { code: 0 },
      { hang: true },
    );
    let settled = false;

    try {
      const verification = runFormalSpecVerification('```quint\nmodule verify {}\n```', directory, {
        modelCheckTimeoutSeconds: 2,
      });
      void verification.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(58_000);
      const result = await verification;
      expect(result.quint.run?.message).toContain('Process timed out after 60000 ms');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should apply the configured timeout to Alloy command enumeration', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { hang: true },
    );

    try {
      const verification = runFormalSpecVerification(validAlloyResponse(), directory, {
        modelCheckTimeoutSeconds: 3,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await verification;

      expect(result.alloy).toMatchObject({
        status: 'error',
        message: expect.stringContaining('Process timed out after 3000 ms'),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should apply the configured timeout to each Alloy check execution', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { code: 0, stderr: 'openjdk version "17.0.1"' },
      { code: 0, stdout: '0 . Check Safety for 1\n' },
      { hang: true },
    );

    try {
      const verification = runFormalSpecVerification(validAlloyResponse(), directory, {
        modelCheckTimeoutSeconds: 4,
      });
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await verification;

      expect(result.alloy).toMatchObject({
        status: 'error',
        message: expect.stringContaining('Process timed out after 4000 ms'),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should use the configured timeout for Alloy jar downloads', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    let downloadSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      downloadSignal = init?.signal ?? undefined;
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    processResponses.push({ code: 0, stderr: 'openjdk version "17.0.1"' });

    try {
      const verification = runFormalSpecVerification(validAlloyResponse(), directory, {
        modelCheckTimeoutSeconds: 5,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await verification;

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(downloadSignal?.aborted).toBe(true);
      expect(result.alloy.status).toBe('error');
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
      const result = await runFormalSpecVerification('```quint\nmodule helper {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

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
      const result = await runFormalSpecVerification('```quint\nmodule invalid {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

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

  it('should surface Quint parse.json errors[] when --out captures diagnostics that stdout/stderr do not', async () => {
    const directory = createTestDirectory();
    parseResult = {
      errors: [
        {
          explanation: "[QNT101] Built-in name 'enabled' is redefined in module 'm'",
          locs: [{ source: 'spec.qnt', start: { line: 4, col: 2, index: 0 } }],
        },
      ],
    };
    processResponses.push({ code: 1 });

    try {
      const result = await runFormalSpecVerification('```quint\nmodule invalid {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.quint.parse).toMatchObject({ status: 'error' });
      expect(result.quint.parse?.message).toContain('[QNT101]');
      expect(result.quint.parse?.message).toContain('spec.qnt:5:3');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should fall back to the process-failure message when parse.json has no errors[]', async () => {
    const directory = createTestDirectory();
    parseResult = { modules: [] };
    processResponses.push({ code: 1, stderr: 'Quint parse failed' });

    try {
      const result = await runFormalSpecVerification('```quint\nmodule invalid {}\n```', directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.quint.parse).toMatchObject({ status: 'error', message: 'Quint parse failed' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should collect Alloy results after an independent Quint parse error and retain the run directory', async () => {
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
        { modelCheckTimeoutSeconds: 300 },
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
      cleanupFormalSpecVerificationArtifacts(result);
      expect(readdirSync(runParent).filter((name) => name.startsWith('verify-'))).toHaveLength(1);
      expect(readFileSync(result.artifacts!.logs['quint-parse']!.stderr, 'utf8')).toBe('Quint parse failed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should not report an Alloy-only specification as passed when every stage is skipped', async () => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push({ error: new Error('java is unavailable') });
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });

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
      const failed = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(failed.verdict).toBe('failed');
      expect(failed.alloy).toMatchObject({ status: 'failed' });
      expect(failed.alloy.commandResults).toMatchObject([{ number: 0, type: 'check', status: 'failed' }]);

      processResponses.push(
        { code: 0, stderr: 'openjdk version "17.0.1"' },
        { code: 0, stdout: '0 . Check Safety for 3\n' },
        { error: new Error('Alloy process unavailable') },
      );
      const errored = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(errored.verdict).toBe('error');
      expect(errored.alloy).toMatchObject({ status: 'error', message: expect.stringContaining('Alloy process unavailable') });

      processResponses.push(
        { code: 0, stderr: 'openjdk version "17.0.1"' },
        { code: 0, stdout: '0 . Check Safety for 3\n' },
        { code: null },
      );
      const statusless = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(statusless.verdict).toBe('error');
      expect(statusless.alloy).toMatchObject({ status: 'error' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [true, false, 'passed', 'passed', 'passed'],
    [false, false, 'failed', 'failed', 'passed'],
    [true, true, 'failed', 'passed', 'failed'],
  ] as const)('should distinguish run SAT=%s from check SAT=%s and execute every command', async (
    runSat, checkSat, verdict, runStatus, checkStatus,
  ) => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { stderr: 'openjdk version "17.0.1"' },
      { stdout: '0 . Run Scenario for 3\n1 . Check Safety for 3\n2 . Run Scenario for 1\n' },
      { alloySolution: runSat },
      { alloySolution: checkSat },
      { alloySolution: true },
    );
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(result.verdict).toBe(verdict);
      expect(result.alloy.checks).toEqual([1]);
      expect(result.alloy.commandResults).toMatchObject([
        { number: 0, type: 'run', label: 'Scenario', status: runStatus },
        { number: 1, type: 'check', label: 'Safety', status: checkStatus },
        { number: 2, type: 'run', label: 'Scenario', status: 'passed' },
      ]);
      expect(spawnedProcesses.filter(({ args }) => args.includes('exec'))
        .map(({ args }) => args[args.indexOf('--command') + 1])).toEqual(['0', '1', '2']);
      expect(result.artifacts?.alloyOutputs?.filter((path) => path.endsWith('receipt.json'))).toHaveLength(3);
      cleanupFormalSpecVerificationArtifacts(result);
      expect(existsSync(result.artifacts!.runDirectory)).toBe(verdict !== 'passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['run$1', 'run {} for 0'],
    ['Scenario', 'Scenario: run {} for 0'],
    ['run$1', 'run\t{} for 0'],
  ])('should accept an empty SAT instance for label %s and source %s', async (label, source) => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { stderr: 'openjdk version "17.0.1"' },
      { stdout: `0 . Run ${label} for 0\n` },
      { alloyReceipt: JSON.stringify({ commands: { [label]: {
        name: label, type: 'run', source, solution: [{ instances: [{}] }],
      } } }) },
    );
    try {
      const result = await runFormalSpecVerification(`\`\`\`alloy\n${source}\n\`\`\``, directory, { modelCheckTimeoutSeconds: 300 });
      expect(result.verdict).toBe('passed');
      expect(result.alloy.checks).toEqual([]);
      expect(result.alloy.commandResults).toMatchObject([{ type: 'run', label, status: 'passed' }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['run', true, 0, 'passed'], ['run', true, 1, 'passed'],
    ['run', false, 0, 'failed'], ['run', false, 1, 'failed'],
    ['check', true, 0, 'failed'], ['check', true, 1, 'failed'],
    ['check', false, 0, 'passed'], ['check', false, 1, 'passed'],
  ] as const)('uses %s SAT=%s independently of expect %s without an explicit scope', async (type, sat, expects, status) => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const kind = type === 'run' ? 'Run' : 'Check';
    const mismatch = Number(sat) !== expects;
    const receipt = { commands: { Scenario: {
      name: 'Scenario', type, source: `${type} Scenario expect ${expects}`,
      ...(expects === 1 ? { expects } : {}),
      ...(sat ? { solution: [{ instances: [{}] }] } : {}),
    } } };
    processResponses.push(
      { stderr: 'openjdk version "17.0.1"' },
      { stdout: `0 . ${kind} Scenario expect ${expects}\n1 . Check Later for 1\n` },
      {
        code: mismatch ? 1 : 0, alloySolution: sat, alloyReceipt: JSON.stringify(receipt),
        stderr: mismatch ? `Error\n  0. '${kind} Scenario expect ${expects}' was ${sat ? '' : 'not '}satisfied against expectation\n` : '',
      },
      {},
    );
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(result.verdict).toBe(status);
      expect(result.alloy.commandResults).toMatchObject([
        { number: 0, type, label: 'Scenario', status },
        { number: 1, type: 'check', label: 'Later', status: 'passed' },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['different exit status', { code: 2 }],
    ['additional error', { stderr: "Error\n  0. 'Run Scenario expect 0' was satisfied against expectation\nError: broken solver\n" }],
    ['wrong command', { stderr: "Error\n  0. 'Run Other expect 0' was satisfied against expectation\n" }],
    ['wrong type', { stderr: "Error\n  0. 'Check Scenario expect 0' was satisfied against expectation\n" }],
    ['missing receipt', { alloyReceipt: null }],
    ['missing trace', { alloyTrace: null }],
    ['contradictory SAT diagnostic', { stderr: "Error\n  0. 'Run Scenario expect 1' was not satisfied against expectation\n" }],
    ['contradictory expectation', { alloyReceipt: JSON.stringify({ commands: { Scenario: {
      name: 'Scenario', type: 'run', source: 'run Scenario expect 1', expects: 1, solution: [{ instances: [{}] }],
    } } }) }],
    ['matching expectation', { alloySolution: false, stderr: "Error\n  0. 'Run Scenario expect 0' was not satisfied against expectation\n" }],
  ] satisfies Array<[string, MockProcessResponse]>)('rejects an apparent expect mismatch with %s', async (_name, override) => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { stderr: 'openjdk version "17.0.1"' },
      { stdout: '0 . Run Scenario expect 0\n1 . Check Later for 1\n' },
      { code: 1, alloySolution: true, stderr: "Error\n  0. 'Run Scenario expect 0' was satisfied against expectation\n", ...override },
      {},
    );
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(result.verdict).toBe('error');
      expect(result.alloy.commandResults).toMatchObject([
        { number: 0, type: 'run', status: 'error' },
        { number: 1, type: 'check', status: 'passed' },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing receipt', { alloyReceipt: null }],
    ['missing trace', { alloyTrace: null }],
    ['empty trace', { alloyTrace: '' }],
    ['invalid JSON', { alloyReceipt: '{"commands":' }],
    ['missing commands', { alloyReceipt: '{}' }],
    ['wrong command', { alloyReceipt: JSON.stringify({ commands: { Other: { name: 'Other', type: 'run', source: 'run Other' } } }) }],
    ['wrong key', { alloyReceipt: JSON.stringify({ commands: { Other: { name: 'Scenario', type: 'run', source: 'run Scenario' } } }) }],
    ['wrong type', { alloyReceipt: JSON.stringify({ commands: { Scenario: { name: 'Scenario', type: 'check', source: 'check Scenario' } } }) }],
    ['incomplete solution', { alloyReceipt: JSON.stringify({ commands: { Scenario: { name: 'Scenario', type: 'run', source: 'run Scenario', solution: [] } } }) }],
    ['oversized receipt', { alloyReceipt: ' '.repeat(1024 * 1024 + 1) }],
    ['truncated stdout', { stdout: 'x'.repeat(1024 * 1024 + 1) }],
    ['truncated stderr', { stderr: 'x'.repeat(1024 * 1024 + 1) }],
    ['nonzero exit', { code: 1, stderr: 'syntax error' }],
    ['spawn failure', { error: new Error('Alloy unavailable') }],
  ] satisfies Array<[string, MockProcessResponse]>)('should reject %s and still collect later Alloy commands', async (_name, response) => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { stderr: 'openjdk version "17.0.1"' },
      { stdout: '0 . Run Scenario for 3\n1 . Check Safety for 3\n' },
      response,
      {},
    );
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
      expect(result.verdict).toBe('error');
      expect(result.alloy.commandResults).toMatchObject([
        { number: 0, type: 'run', status: 'error' },
        { number: 1, type: 'check', status: 'passed' },
      ]);
      expect(result.alloy.commandResults![0]!.message).toBeTruthy();
      expect(spawnedProcesses.filter(({ args }) => args.includes('exec'))).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should time out an Alloy run and still execute the following check', async () => {
    vi.useFakeTimers();
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    processResponses.push(
      { stderr: 'openjdk version "17.0.1"' },
      { stdout: '0 . Run Scenario for 3\n1 . Check Safety for 3\n' },
      { hang: true },
      {},
    );
    try {
      const verification = runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await verification;
      expect(result.verdict).toBe('error');
      expect(result.alloy.commandResults).toMatchObject([
        { type: 'run', status: 'error' },
        { type: 'check', status: 'passed' },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['none', 'directory', 'ownership', 'both'] as const)('cleans cancelled Alloy artifacts with cleanup failure=%s', async (failure) => {
    const directory = createTestDirectory();
    installConfiguredAlloyJar(directory);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    processResponses.push(
      { stderr: 'openjdk version "17.0.1"' },
      { stdout: '0 . Run Scenario for 3\n' },
      { beforeExit: async () => controller.abort(reason) },
    );
    failVerifyRunRemoval.enabled = failure === 'directory' || failure === 'both';
    failActiveMarkerRemoval.enabled = failure === 'ownership' || failure === 'both';
    try {
      await expect(runFormalSpecVerification(validAlloyResponse(), directory, {
        modelCheckTimeoutSeconds: 300, abortSignal: controller.signal,
      })).rejects.toBe(reason);
      expect(spawnedProcesses.at(-1)!.args).toContain('exec');
      if (failure === 'directory' || failure === 'both') {
        const runDirectory = spawnedProcesses.at(-1)!.options.cwd!;
        expect(readFileSync(join(runDirectory, 'specs', 'spec.als'), 'utf8')).toContain('check');
        failVerifyRunRemoval.enabled = false;
        failActiveMarkerRemoval.enabled = false;
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(runDirectory, old, old);
        await runFormalSpecVerification('No specification.', directory, { modelCheckTimeoutSeconds: 300 });
        expect(existsSync(runDirectory)).toBe(false);
      }
      expect(readdirSync(join(directory, '.takt', 'runs'))).toEqual([]);
    } finally {
      failVerifyRunRemoval.enabled = false;
      failActiveMarkerRemoval.enabled = false;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should report a configured Alloy jar preparation failure as error', async () => {
    const directory = createTestDirectory();
    const previousJarPath = process.env.TAKT_ALLOY_JAR;
    process.env.TAKT_ALLOY_JAR = join(directory, 'missing-alloy.jar');
    processResponses.push({ code: 0, stderr: 'openjdk version "17.0.1"' });
    try {
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });

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
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });

      expect(result.alloy.status).toBe('passed');
      const alloyCalls = spawnedProcesses.filter(({ command }) => command === 'java');
      const args = alloyCalls.at(-1)!.args;
      expect(args[args.indexOf('-jar') + 1]).toBe(jarPath);
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
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
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
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
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
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
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
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });

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
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });

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
      const result = await runFormalSpecVerification(validAlloyResponse(), directory, { modelCheckTimeoutSeconds: 300 });
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
