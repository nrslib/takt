import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installManagedDeepSeekHarness,
  resolveDeepSeekHarnessManagedPaths,
  validateDeepSeekHarnessInstallation,
} from '../infra/deepseek-harness/index.js';
import type { ValidateDeepSeekHarnessInstallationOptions } from '../infra/deepseek-harness/index.js';
import { getDeepSeekHarnessConstructorArguments } from '../infra/deepseek-harness/managed-venv.js';

const PINNED_VERSION = '0.1.1rc1';
const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-managed-'));
  temporaryRoots.push(root);
  return root;
}

async function createExitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('Expected stale lock owner process to have a PID');
  }
  await new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolvePromise());
  });
  return pid;
}

async function createProbeExecutable(
  root: string,
  result: Record<string, unknown>,
): Promise<string> {
  const executable = path.join(root, 'probe-python.sh');
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(result)}'\n`,
    'utf8',
  );
  await chmod(executable, 0o755);
  return executable;
}

async function createHangingProbeExecutable(root: string): Promise<string> {
  const executable = path.join(root, 'hanging-probe.sh');
  await writeFile(executable, '#!/bin/sh\nwhile :; do sleep 1; done\n', 'utf8');
  await chmod(executable, 0o755);
  return executable;
}

async function createBootstrapExecutable(root: string, pipArgsPath: string): Promise<string> {
  const executable = path.join(root, 'bootstrap-python.sh');
  const managedPython = `#!/bin/sh
set -eu
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  printf '%s\\n' "$@" > '${pipArgsPath}'
  exit 0
fi
if [ "$1" = "-c" ]; then
  printf '%s\\n' '{"pythonVersion":[3,10],"sdkVersion":"${PINNED_VERSION}","runtimeVersion":"${PINNED_VERSION}"}'
  exit 0
fi
exit 1
`;
  await writeFile(
    executable,
    `#!/bin/sh
set -eu
if [ "$1" = "-c" ]; then
  printf '%s\\n' '{"pythonVersion":[3,10],"sdkVersion":"${PINNED_VERSION}","runtimeVersion":"${PINNED_VERSION}"}'
  exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  target="$3"
  mkdir -p "$target/bin"
  cat > "$target/bin/python" <<'PYTHON_WRAPPER'
${managedPython}PYTHON_WRAPPER
  chmod 755 "$target/bin/python"
  exit 0
fi
exit 1
`,
    'utf8',
  );
  await chmod(executable, 0o755);
  return executable;
}

type ManagedInstallFixtureOptions = {
  readonly bootstrapResult?: Record<string, unknown>;
  readonly failVenv?: boolean;
  readonly failFirstPip?: boolean;
  readonly pipArgsPath?: string;
  readonly eventLogPath?: string;
  readonly failureMessage?: string;
  readonly includeGeneralEnvironmentValue?: boolean;
  readonly includeVersionEnvironmentValue?: boolean;
  readonly controlledWorkerId?: string;
  readonly bootstrapOwnerFile?: string;
  readonly bootstrapReleaseFile?: string;
  readonly venvReleaseFile?: string;
  readonly pipReleaseFile?: string;
  readonly validationReleaseFile?: string;
  readonly venvMarkerFile?: string;
  readonly pipMarkerFile?: string;
  readonly validationMarkerFile?: string;
};

async function createManagedInstallExecutable(
  root: string,
  options: ManagedInstallFixtureOptions = {},
  executablePath = path.join(root, 'managed-bootstrap.cjs'),
): Promise<string> {
  const configuration = {
    ...options,
    pipFailureStateFile: path.join(root, 'pip-failure-state'),
    pinnedVersion: PINNED_VERSION,
  };
  const createScript = (
    role: 'bootstrap' | 'managed',
    managedSource: string | undefined,
  ): string => `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const role = ${JSON.stringify(role)};
const config = ${JSON.stringify(configuration)};
const managedSource = ${JSON.stringify(managedSource)};
const workerId = process.env.DSH_TEST_WORKER_ID || 'single';
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const args = process.argv.slice(2);

function appendEvent(event) {
  if (config.eventLogPath !== undefined) {
    fs.appendFileSync(config.eventLogPath, event + '\\n');
  }
}

function waitFor(file) {
  while (!fs.existsSync(file)) {
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
}

function ownsBootstrapBarrier() {
  if (config.bootstrapOwnerFile === undefined) {
    return false;
  }
  try {
    return fs.readFileSync(config.bootstrapOwnerFile, 'utf8') === workerId;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function claimBootstrapBarrier() {
  if (config.bootstrapOwnerFile === undefined) {
    return false;
  }
  try {
    fs.writeFileSync(config.bootstrapOwnerFile, workerId, { flag: 'wx' });
    appendEvent('bootstrap-owner:' + workerId);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function fail(message) {
  process.stderr.write(String(message) + '\\n');
  process.exit(1);
}

function acquireMarker(marker, phase) {
  if (marker === undefined) {
    return;
  }
  try {
    fs.writeFileSync(marker, workerId, { flag: 'wx' });
  } catch {
    appendEvent('conflict:' + phase + ':' + workerId);
    fail('concurrent ' + phase + ' execution');
  }
}

function releaseMarker(marker) {
  if (marker !== undefined) {
    fs.rmSync(marker, { force: true });
  }
}

function validResult() {
  return {
    pythonVersion: [3, 10],
    sdkVersion: config.pinnedVersion,
    runtimeVersion: config.pinnedVersion,
  };
}

function failureDiagnostic() {
  return [
    config.failureMessage,
    config.includeGeneralEnvironmentValue ? process.env.TAKT_TEST_GENERAL_VALUE : undefined,
    config.includeVersionEnvironmentValue ? process.env.TAKT_TEST_VERSION_VALUE : undefined,
  ].filter((value) => typeof value === 'string').join(' ');
}

if (args[0] === '-c') {
  if (role === 'bootstrap') {
    appendEvent('probe:' + workerId);
    const ownsBarrier = claimBootstrapBarrier();
    if (
      (config.controlledWorkerId === workerId || ownsBarrier)
      && config.bootstrapReleaseFile !== undefined
    ) {
      waitFor(config.bootstrapReleaseFile);
    }
    process.stdout.write(JSON.stringify(
      config.bootstrapResult === undefined ? validResult() : config.bootstrapResult,
    ) + '\\n');
    process.exit(0);
  }

  acquireMarker(config.validationMarkerFile, 'validation');
  appendEvent('validate:' + workerId);
  if (
    (config.controlledWorkerId === workerId || ownsBootstrapBarrier())
    && config.validationReleaseFile !== undefined
  ) {
    waitFor(config.validationReleaseFile);
  }
  releaseMarker(config.validationMarkerFile);
  process.stdout.write(JSON.stringify(validResult()) + '\\n');
  process.exit(0);
}

if (args[0] === '-m' && args[1] === 'venv') {
  if (config.failVenv) {
    fail('bootstrap Python is not supported');
  }
  const target = args[2];
  if (typeof target !== 'string' || managedSource === undefined) {
    fail('managed VENV target is missing');
  }
  acquireMarker(config.venvMarkerFile, 'venv');
  try {
    fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(target, 'bin', 'python'), managedSource, { mode: 0o755 });
    appendEvent('venv:' + workerId);
    if (ownsBootstrapBarrier() && config.venvReleaseFile !== undefined) {
      waitFor(config.venvReleaseFile);
    }
  } finally {
    releaseMarker(config.venvMarkerFile);
  }
  process.exit(0);
}

if (args[0] === '-m' && args[1] === 'pip') {
  acquireMarker(config.pipMarkerFile, 'pip');
  appendEvent('pip:' + workerId);
  if (config.pipArgsPath !== undefined) {
    fs.appendFileSync(config.pipArgsPath, JSON.stringify(args) + '\\n');
  }
  if (config.failFirstPip && !fs.existsSync(config.pipFailureStateFile)) {
    fs.writeFileSync(config.pipFailureStateFile, 'failed');
    const venvRoot = path.resolve(path.dirname(process.argv[1]), '..');
    fs.writeFileSync(path.join(venvRoot, 'partial-marker'), 'partial VENV');
    releaseMarker(config.pipMarkerFile);
    process.stderr.write(failureDiagnostic() + '\\n');
    process.exit(1);
  }
  if (
    (config.controlledWorkerId === workerId || ownsBootstrapBarrier())
    && config.pipReleaseFile !== undefined
  ) {
    waitFor(config.pipReleaseFile);
  }
  releaseMarker(config.pipMarkerFile);
  process.exit(0);
}

fail('unexpected bootstrap Python invocation');
`;

  const managedSource = createScript('managed', undefined);
  await writeFile(executablePath, createScript('bootstrap', managedSource), 'utf8');
  await chmod(executablePath, 0o755);
  return executablePath;
}

async function createManagedInstallRacePreload(root: string): Promise<string> {
  const preloadPath = path.join(root, 'managed-install-race-preload.cjs');
  await writeFile(preloadPath, `
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const originalMkdir = fs.promises.mkdir;
const originalOpen = fs.promises.open;
const originalRename = fs.promises.rename;
const originalUnlink = fs.promises.unlink;
const originalRm = fs.promises.rm;
let delayed = false;
let restoreConflictPrepared = false;
let restoreConflictInjected = false;

function restoreConflictCode() {
  return process.env.DSH_TEST_RESTORE_CONFLICT_CODE;
}

function replacementOwner() {
  const pid = Number(process.env.DSH_TEST_REPLACEMENT_OWNER_PID);
  return JSON.stringify({ pid, token: 'replacement-recovery' });
}

function isRecoveryQuarantinePath(candidate) {
  return path.basename(String(candidate)).startsWith('.recovery.quarantine-');
}

function shouldDelay(candidate) {
  if (delayed) {
    return false;
  }
  const basename = path.basename(String(candidate));
  if (process.env.DSH_TEST_RACE_MODE === 'recovery-cleanup') {
    return basename.startsWith('.recovery.quarantine-');
  }
  if (process.env.DSH_TEST_RACE_MODE === 'owner-publication') {
    return false;
  }
  return basename === '.install.lock'
    || basename.startsWith('.install.lock.candidate-')
    || basename.startsWith('.install.lock.recovery-candidate-');
}

function shouldDelayOwnerPublication(candidate) {
  return process.env.DSH_TEST_RACE_MODE === 'owner-publication'
    && path.basename(String(candidate)) === 'owner'
    && path.basename(path.dirname(String(candidate))).startsWith('.install.lock.candidate-');
}

function waitForRelease() {
  const entered = process.env.DSH_TEST_RACE_ENTER;
  const release = process.env.DSH_TEST_RACE_RELEASE;
  if (entered === undefined || release === undefined) {
    return;
  }
  fs.writeFileSync(entered, process.env.DSH_TEST_WORKER_ID || 'unknown', 'utf8');
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(release)) {
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
}

fs.promises.mkdir = async function mkdir(directory, ...args) {
  if (shouldDelay(directory)) {
    delayed = true;
    waitForRelease();
  }
  return originalMkdir.call(this, directory, ...args);
};
  fs.promises.open = async function open(filePath, ...args) {
  if (shouldDelayOwnerPublication(filePath)) {
    delayed = true;
    waitForRelease();
  }
  return originalOpen.call(this, filePath, ...args);
};
fs.promises.rename = async function rename(source, destination) {
  if (shouldDelay(source) || shouldDelay(destination)) {
    delayed = true;
    waitForRelease();
  }
  const sourceBase = path.basename(String(source));
  const destinationBase = path.basename(String(destination));
  const conflictCode = restoreConflictCode();
  if (
    conflictCode !== undefined
    && !restoreConflictInjected
    && isRecoveryQuarantinePath(source)
    && destinationBase === '.recovery'
  ) {
    if (process.env.DSH_TEST_RECREATE_RESTORE_TARGET === '1') {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(String(destination), 'owner'), replacementOwner(), 'utf8');
    }
    restoreConflictInjected = true;
    const error = new Error('Injected restore conflict: ' + conflictCode);
    error.code = conflictCode;
    throw error;
  }
  const result = await originalRename.call(this, source, destination);
  if (
    restoreConflictCode() !== undefined
    && !restoreConflictPrepared
    && sourceBase === '.recovery'
    && isRecoveryQuarantinePath(destination)
  ) {
    fs.writeFileSync(path.join(String(destination), 'owner'), replacementOwner(), 'utf8');
    restoreConflictPrepared = true;
  }
  return result;
};
fs.promises.unlink = async function unlink(filePath, ...args) {
  if (shouldDelay(filePath)) {
    delayed = true;
    waitForRelease();
  }
  return originalUnlink.call(this, filePath, ...args);
};
fs.promises.rm = async function rm(filePath, ...args) {
  if (shouldDelay(filePath)) {
    delayed = true;
    waitForRelease();
  }
  return originalRm.call(this, filePath, ...args);
};
syncBuiltinESMExports();
`, 'utf8');
  return preloadPath;
}

const installWorkerFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'deepseek-harness-managed-install.ts',
);
const viteNodePath = path.join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs');

type InstallWorkerHandle = {
  readonly child: ChildProcess;
  readonly completion: Promise<string>;
};

type InstallWorkerOptions = {
  readonly startBarrierFile?: string;
  readonly racePreloadPath?: string;
  readonly raceMode?: 'lock' | 'recovery-cleanup' | 'owner-publication';
  readonly raceEnterFile?: string;
  readonly raceReleaseFile?: string;
  readonly restoreConflictCode?: 'EEXIST' | 'ENOTEMPTY' | 'EPERM' | 'EACCES';
  readonly recreateRestoreTarget?: boolean;
  readonly replacementOwnerPid?: number;
};

function startInstallWorker(
  configDir: string,
  pythonPath: string,
  workerId: string,
  controlDir: string,
  options: InstallWorkerOptions = {},
): InstallWorkerHandle {
  const stdio = ['ignore', 'pipe', 'pipe'] as const;
  const nodeOptions = options.racePreloadPath === undefined
    ? process.env.NODE_OPTIONS
    : [
        process.env.NODE_OPTIONS,
        `--require=${options.racePreloadPath}`,
      ].filter((value): value is string => value !== undefined).join(' ');
  const child = spawn(process.execPath, [
    viteNodePath,
    installWorkerFixturePath,
    configDir,
    pythonPath,
    workerId,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_TEST_CONTROL_DIR: controlDir,
      DSH_TEST_WORKER_ID: workerId,
      ...(options.startBarrierFile === undefined
        ? {}
        : { DSH_TEST_START_BARRIER: options.startBarrierFile }),
      ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }),
      ...(options.raceMode === undefined
        ? {}
        : { DSH_TEST_RACE_MODE: options.raceMode }),
      ...(options.raceEnterFile === undefined
        ? {}
        : { DSH_TEST_RACE_ENTER: options.raceEnterFile }),
      ...(options.raceReleaseFile === undefined
        ? {}
        : { DSH_TEST_RACE_RELEASE: options.raceReleaseFile }),
      ...(options.restoreConflictCode === undefined
        ? {}
        : { DSH_TEST_RESTORE_CONFLICT_CODE: options.restoreConflictCode }),
      ...(options.recreateRestoreTarget === true
        ? { DSH_TEST_RECREATE_RESTORE_TARGET: '1' }
        : {}),
      ...(options.replacementOwnerPid === undefined
        ? {}
        : { DSH_TEST_REPLACEMENT_OWNER_PID: String(options.replacementOwnerPid) }),
    },
    stdio: [...stdio],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const completion = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(
        `DeepSeek Harness install worker ${workerId} exited with ${String(code)}${
          signal === null ? '' : ` (${signal})`
        }: ${stderr}`,
      ));
    });
  });
  return { child, completion };
}

async function readEventLog(logPath: string): Promise<readonly string[]> {
  try {
    const content = await readFile(logPath, 'utf8');
    return content.split(/\r?\n/u).filter((event) => event.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForEvent(logPath: string, event: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readEventLog(logPath)).includes(event)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for event ${event}`);
}

async function waitForAnyEvent(
  logPath: string,
  events: readonly string[],
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await readEventLog(logPath);
    const event = events.find((candidate) => observed.includes(candidate));
    if (event !== undefined) {
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for one of ${events.join(', ')}`);
}

async function expectNoWorkerActivity(
  logPath: string,
  workerId: string,
  observationMs = 500,
): Promise<void> {
  const deadline = Date.now() + observationMs;
  while (Date.now() < deadline) {
    const activity = (await readEventLog(logPath)).some((event) => event.endsWith(`:${workerId}`));
    expect(activity).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('DeepSeek Harness constructor arguments', () => {
  it('returns only the required constructor arguments by default', () => {
    expect(getDeepSeekHarnessConstructorArguments({})).toEqual([
      'provider',
      'model',
      'cwd',
      'runtime_cwd',
      'request_timeout_seconds',
      'shutdown_timeout_seconds',
    ]);
  });

  it.each([
    ['maxTokens', { maxTokens: 256 }, 'max_tokens'],
    ['sessionRoot', { sessionRoot: '/tmp/deepseek-sessions' }, 'session_root'],
    ['cordis', { cordis: 'cordis-profile' }, 'cordis'],
  ] as const)('maps configured %s to its constructor argument', (_name, configuration, expectedArgument) => {
    expect(getDeepSeekHarnessConstructorArguments(configuration)).toEqual([
      'provider',
      'model',
      'cwd',
      'runtime_cwd',
      'request_timeout_seconds',
      'shutdown_timeout_seconds',
      expectedArgument,
    ]);
  });

  it('appends configured optional arguments in their defined order', () => {
    expect(getDeepSeekHarnessConstructorArguments({
      cordis: 'cordis-profile',
      sessionRoot: '/tmp/deepseek-sessions',
      maxTokens: 256,
    })).toEqual([
      'provider',
      'model',
      'cwd',
      'runtime_cwd',
      'request_timeout_seconds',
      'shutdown_timeout_seconds',
      'max_tokens',
      'session_root',
      'cordis',
    ]);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('DeepSeek Harness managed VENV', () => {
  it('validates the pinned package pair and constructor before use', async () => {
    const root = await createTemporaryRoot();
    const pythonPath = await createProbeExecutable(root, {
      pythonVersion: [3, 10],
      sdkVersion: PINNED_VERSION,
      runtimeVersion: PINNED_VERSION,
    });

    const installation = await validateDeepSeekHarnessInstallation(pythonPath);

    expect(installation).toEqual({
      pythonPath,
      pythonVersion: '3.10',
      sdkVersion: PINNED_VERSION,
      runtimeVersion: PINNED_VERSION,
    });
  });

  it('fails a hanging environment probe within the configured timeout', async () => {
    const root = await createTemporaryRoot();
    const pythonPath = await createHangingProbeExecutable(root);
    const startedAt = Date.now();
    const options: ValidateDeepSeekHarnessInstallationOptions = { probeTimeoutMs: 100 };

    await expect(validateDeepSeekHarnessInstallation(pythonPath, options)).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.each([
    [
      'Python below minimum',
      { pythonVersion: [3, 9], sdkVersion: PINNED_VERSION, runtimeVersion: PINNED_VERSION },
      /Python 3\.10 or newer/iu,
    ],
    [
      'missing SDK',
      { pythonVersion: [3, 10], sdkVersion: null, runtimeVersion: PINNED_VERSION },
      /missing deepseek-harness-sdk/iu,
    ],
    [
      'missing runtime',
      { pythonVersion: [3, 10], sdkVersion: PINNED_VERSION, runtimeVersion: null },
      /missing deepseek-harness-runtime-bin/iu,
    ],
    [
      'mismatched pair',
      { pythonVersion: [3, 10], sdkVersion: PINNED_VERSION, runtimeVersion: '0.1.0' },
      /version mismatch/iu,
    ],
    [
      'unpinned pair',
      { pythonVersion: [3, 10], sdkVersion: '0.1.0', runtimeVersion: '0.1.0' },
      /not the pinned version/iu,
    ],
    [
      'unsupported constructor',
      {
        pythonVersion: [3, 10],
        sdkVersion: PINNED_VERSION,
        runtimeVersion: PINNED_VERSION,
        unsupportedConstructorArguments: ['runtime_cwd'],
      },
      /constructor does not support/iu,
    ],
  ] as const)('rejects %s before a bridge can use the environment', async (_name, result, expectedError) => {
    const root = await createTemporaryRoot();
    const pythonPath = await createProbeExecutable(root, result);

    await expect(validateDeepSeekHarnessInstallation(pythonPath)).rejects.toThrow(expectedError);
  });

  it('recreates a partial VENV and validates the pinned pair on retry after pip fails', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const pipArgsPath = path.join(configDir, 'retry-pip-args.jsonl');
    const bootstrapPython = await createManagedInstallExecutable(configDir, {
      failFirstPip: true,
      pipArgsPath,
    });

    await expect(installManagedDeepSeekHarness({
      configDir,
      pythonPath: bootstrapPython,
    })).rejects.toThrow();
    expect(await readFile(path.join(paths.venvPath, 'partial-marker'), 'utf8')).toBe('partial VENV');
    await expect(readFile(path.join(paths.rootPath, '.install.lock'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const installation = await installManagedDeepSeekHarness({
      configDir,
      pythonPath: bootstrapPython,
    });

    await expect(readFile(path.join(paths.venvPath, 'partial-marker'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(installation).toMatchObject({
      pythonPath: paths.pythonPath,
      venvPath: paths.venvPath,
      dshHomePath: paths.dshHomePath,
      pythonVersion: '3.10',
      sdkVersion: PINNED_VERSION,
      runtimeVersion: PINNED_VERSION,
    });
    const pipInvocations = (await readFile(pipArgsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const expectedPinnedPipArguments = [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-input',
      `deepseek-harness-sdk==${PINNED_VERSION}`,
      `deepseek-harness-runtime-bin==${PINNED_VERSION}`,
    ];
    expect(pipInvocations).toHaveLength(2);
    expect(pipInvocations[0]).toEqual(expectedPinnedPipArguments);
    expect(pipInvocations[1]).toEqual(expectedPinnedPipArguments);
  });

  it('preserves DSH_HOME profiles and plugins across a failed install and retry', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const profilePath = path.join(paths.dshHomePath, 'profiles', 'default.yml');
    const pluginPath = path.join(paths.dshHomePath, 'plugins', 'installed.txt');
    await mkdir(path.dirname(profilePath), { recursive: true });
    await mkdir(path.dirname(pluginPath), { recursive: true });
    await writeFile(profilePath, 'profile', 'utf8');
    await writeFile(pluginPath, 'plugin', 'utf8');
    const bootstrapPython = await createManagedInstallExecutable(configDir, { failFirstPip: true });

    await expect(installManagedDeepSeekHarness({
      configDir,
      pythonPath: bootstrapPython,
    })).rejects.toThrow();
    expect(await readFile(profilePath, 'utf8')).toBe('profile');
    expect(await readFile(pluginPath, 'utf8')).toBe('plugin');

    await installManagedDeepSeekHarness({
      configDir,
      pythonPath: bootstrapPython,
    });

    expect(await readFile(profilePath, 'utf8')).toBe('profile');
    expect(await readFile(pluginPath, 'utf8')).toBe('plugin');
  });

  it('does not remove an existing VENV when the bootstrap Python is invalid', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const existingMarker = path.join(paths.venvPath, 'existing-marker');
    await mkdir(paths.venvPath, { recursive: true });
    await writeFile(existingMarker, 'existing environment', 'utf8');
    const bootstrapPython = await createManagedInstallExecutable(configDir, {
      bootstrapResult: { pythonVersion: [3, 9] },
      failVenv: true,
    });

    await expect(installManagedDeepSeekHarness({
      configDir,
      pythonPath: bootstrapPython,
    })).rejects.toThrow();

    expect(await readFile(existingMarker, 'utf8')).toBe('existing environment');
  });

  it('does not remove an existing VENV when the default bootstrap Python is invalid', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const existingMarker = path.join(paths.venvPath, 'existing-marker');
    const bootstrapDir = path.join(configDir, 'bootstrap-bin');
    const bootstrapPython = path.join(bootstrapDir, 'python3');
    await mkdir(paths.venvPath, { recursive: true });
    await writeFile(existingMarker, 'existing environment', 'utf8');
    await mkdir(bootstrapDir, { recursive: true });
    await createManagedInstallExecutable(configDir, {
      bootstrapResult: { pythonVersion: [3, 9] },
      failVenv: true,
    }, bootstrapPython);

    const currentPath = process.env.PATH;
    vi.stubEnv(
      'PATH',
      currentPath === undefined
        ? bootstrapDir
        : `${bootstrapDir}${path.delimiter}${currentPath}`,
    );
    await expect(installManagedDeepSeekHarness({ configDir })).rejects.toThrow();
    expect(await readFile(existingMarker, 'utf8')).toBe('existing environment');
  });

  it('redacts only DeepSeek secret environment values from installation errors', async () => {
    const configDir = await createTemporaryRoot();
    const apiKey = 'dsh-key8';
    const baseUrl = 'https://deepseek-managed-secret.example/v1';
    const generalValue = 'ordinary-installation-environment-value';
    const versionValue = PINNED_VERSION;
    vi.stubEnv('DEEPSEEK_API_KEY', apiKey);
    vi.stubEnv('DEEPSEEK_BASE_URL', baseUrl);
    vi.stubEnv('TAKT_TEST_GENERAL_VALUE', generalValue);
    vi.stubEnv('TAKT_TEST_VERSION_VALUE', versionValue);

    const bootstrapPython = await createManagedInstallExecutable(configDir, {
      failFirstPip: true,
      failureMessage: `${apiKey} ${baseUrl}`,
      includeGeneralEnvironmentValue: true,
      includeVersionEnvironmentValue: true,
    });

    let failure: unknown;
    try {
      await installManagedDeepSeekHarness({
        configDir,
        pythonPath: bootstrapPython,
      });
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof Error)) {
      throw new Error('Expected managed DeepSeek Harness installation to fail');
    }

    expect(failure.message).not.toContain(apiKey);
    expect(failure.message).not.toContain(baseUrl);
    expect(failure.message).toContain('[REDACTED]');
    expect(failure.message).toContain(generalValue);
    expect(failure.message).toContain(versionValue);
  });

  it('does not replace short DeepSeek secret values in installation errors', async () => {
    const configDir = await createTemporaryRoot();
    const shortSecret = 'abc1234';
    vi.stubEnv('DEEPSEEK_API_KEY', shortSecret);
    const bootstrapPython = await createManagedInstallExecutable(configDir, {
      failFirstPip: true,
      failureMessage: `x${shortSecret}x ${shortSecret}`,
    });

    let failure: unknown;
    try {
      await installManagedDeepSeekHarness({
        configDir,
        pythonPath: bootstrapPython,
      });
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof Error)) {
      throw new Error('Expected managed DeepSeek Harness installation to fail');
    }

    expect(failure.message).toContain(`x${shortSecret}x`);
    expect(failure.message).toContain(shortSecret);
    expect(failure.message).not.toContain('[REDACTED]');
  });

  it.each(['EEXIST', 'ENOTEMPTY', 'EPERM'] as const)(
    'treats a recreated recovery target with %s as ownership loss',
    async (conflictCode) => {
      const configDir = await createTemporaryRoot();
      const paths = resolveDeepSeekHarnessManagedPaths(configDir);
      const controlDir = path.join(configDir, 'control');
      await mkdir(controlDir, { recursive: true });
      await mkdir(path.join(paths.rootPath, '.install.lock', '.recovery'), { recursive: true });
      const staleOwnerPid = await createExitedProcessId();
      await writeFile(
        path.join(paths.rootPath, '.install.lock', 'owner'),
        JSON.stringify({ pid: staleOwnerPid, token: 'stale-lock' }),
        'utf8',
      );
      await writeFile(
        path.join(paths.rootPath, '.install.lock', '.recovery', 'owner'),
        JSON.stringify({ pid: staleOwnerPid, token: 'stale-recovery' }),
        'utf8',
      );
      const eventLogPath = path.join(controlDir, 'events.log');
      const bootstrapPython = await createManagedInstallExecutable(configDir, { eventLogPath });
      const racePreloadPath = await createManagedInstallRacePreload(configDir);
      const replacementOwnerPath = path.join(
        paths.rootPath,
        '.install.lock',
        '.recovery',
        'owner',
      );
      const replacementOwner = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1_000);'],
        { stdio: 'ignore' },
      );
      const replacementOwnerExit = new Promise<void>((resolvePromise, reject) => {
        replacementOwner.once('error', reject);
        replacementOwner.once('exit', () => resolvePromise());
      });
      let worker: InstallWorkerHandle | undefined;

      try {
        const replacementOwnerPid = replacementOwner.pid;
        if (replacementOwnerPid === undefined) {
          throw new Error('Expected replacement recovery owner process to have a PID');
        }
        const startedWorker = startInstallWorker(
          configDir,
          bootstrapPython,
          'restore-conflict',
          controlDir,
          {
            racePreloadPath,
            restoreConflictCode: conflictCode,
            recreateRestoreTarget: true,
            replacementOwnerPid,
          },
        );
        worker = startedWorker;

        const expectedReplacementOwnerPid = replacementOwnerPid;
        let replacementOwnerPublished = false;
        const ownerDeadline = Date.now() + 10_000;
        while (Date.now() < ownerDeadline) {
          try {
            const owner = JSON.parse(await readFile(replacementOwnerPath, 'utf8')) as Record<string, unknown>;
            replacementOwnerPublished = owner.pid === expectedReplacementOwnerPid;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
              throw error;
            }
          }
          if (replacementOwnerPublished) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(replacementOwnerPublished).toBe(true);

        const prohibitedPhaseEvents = new Set([
          'venv:restore-conflict',
          'pip:restore-conflict',
          'validate:restore-conflict',
        ]);
        const observationDeadline = Date.now() + 500;
        while (Date.now() < observationDeadline) {
          const owner = JSON.parse(await readFile(replacementOwnerPath, 'utf8')) as Record<string, unknown>;
          expect(owner.pid).toBe(expectedReplacementOwnerPid);
          const phaseEvents = (await readEventLog(eventLogPath))
            .filter((event) => prohibitedPhaseEvents.has(event));
          expect(phaseEvents).toEqual([]);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        if (replacementOwner.exitCode === null && replacementOwner.signalCode === null) {
          replacementOwner.kill('SIGKILL');
        }
        await replacementOwnerExit;

        const installation = JSON.parse((await startedWorker.completion).trim()) as Record<string, unknown>;
        expect(installation).toMatchObject({
          pythonVersion: '3.10',
          sdkVersion: PINNED_VERSION,
          runtimeVersion: PINNED_VERSION,
        });
        expect((await readdir(paths.rootPath)).filter((entry) => entry.startsWith('.install.lock'))).toEqual([]);
      } finally {
        if (worker !== undefined) {
          if (worker.child.exitCode === null && worker.child.signalCode === null) {
            worker.child.kill('SIGKILL');
          }
          await Promise.allSettled([worker.completion]);
        }
        if (replacementOwner.exitCode === null && replacementOwner.signalCode === null) {
          replacementOwner.kill('SIGKILL');
        }
        await Promise.allSettled([replacementOwnerExit]);
      }
    },
  );

  it('propagates EPERM when the recovery target does not exist', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const controlDir = path.join(configDir, 'control');
    await mkdir(controlDir, { recursive: true });
    await mkdir(path.join(paths.rootPath, '.install.lock', '.recovery'), { recursive: true });
    const staleOwnerPid = await createExitedProcessId();
    await writeFile(
      path.join(paths.rootPath, '.install.lock', 'owner'),
      JSON.stringify({ pid: staleOwnerPid, token: 'stale-lock' }),
      'utf8',
    );
    await writeFile(
      path.join(paths.rootPath, '.install.lock', '.recovery', 'owner'),
      JSON.stringify({ pid: staleOwnerPid, token: 'stale-recovery' }),
      'utf8',
    );
    const bootstrapPython = await createManagedInstallExecutable(configDir);
    const racePreloadPath = await createManagedInstallRacePreload(configDir);
    const worker = startInstallWorker(
      configDir,
      bootstrapPython,
      'restore-eperm',
      controlDir,
      {
        racePreloadPath,
        restoreConflictCode: 'EPERM',
        replacementOwnerPid: staleOwnerPid,
      },
    );

    try {
      await expect(worker.completion).rejects.toThrow(/EPERM/u);
    } finally {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
      await Promise.allSettled([worker.completion]);
    }
  });

  it('propagates non-conflicting rename errors during recovery restore', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const controlDir = path.join(configDir, 'control');
    await mkdir(controlDir, { recursive: true });
    await mkdir(path.join(paths.rootPath, '.install.lock', '.recovery'), { recursive: true });
    const staleOwnerPid = await createExitedProcessId();
    await writeFile(
      path.join(paths.rootPath, '.install.lock', 'owner'),
      JSON.stringify({ pid: staleOwnerPid, token: 'stale-lock' }),
      'utf8',
    );
    await writeFile(
      path.join(paths.rootPath, '.install.lock', '.recovery', 'owner'),
      JSON.stringify({ pid: staleOwnerPid, token: 'stale-recovery' }),
      'utf8',
    );
    const bootstrapPython = await createManagedInstallExecutable(configDir);
    const racePreloadPath = await createManagedInstallRacePreload(configDir);
    const worker = startInstallWorker(
      configDir,
      bootstrapPython,
      'restore-eacces',
      controlDir,
      {
        racePreloadPath,
        restoreConflictCode: 'EACCES',
        replacementOwnerPid: staleOwnerPid,
      },
    );

    try {
      await expect(worker.completion).rejects.toThrow(/EACCES/u);
    } finally {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
      await Promise.allSettled([worker.completion]);
    }
  });

  it('atomically reclaims one stale lock owner across concurrent installs', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const controlDir = path.join(configDir, 'control');
    await mkdir(controlDir, { recursive: true });
    await mkdir(paths.rootPath, { recursive: true });
    const eventLogPath = path.join(controlDir, 'events.log');
    const startBarrierFile = path.join(controlDir, 'start');
    const bootstrapOwnerFile = path.join(controlDir, 'bootstrap-owner');
    const bootstrapReleaseFile = path.join(controlDir, 'release-bootstrap');
    const venvReleaseFile = path.join(controlDir, 'release-venv');
    const pipReleaseFile = path.join(controlDir, 'release-pip');
    const validationReleaseFile = path.join(controlDir, 'release-validation');
    const venvMarkerFile = path.join(controlDir, 'venv-active');
    const pipMarkerFile = path.join(controlDir, 'pip-active');
    const validationMarkerFile = path.join(controlDir, 'validation-active');
    const staleOwnerPid = await createExitedProcessId();
    const staleLockPath = path.join(paths.rootPath, '.install.lock');
    await mkdir(staleLockPath, { recursive: true });
    await writeFile(
      path.join(staleLockPath, 'owner'),
      JSON.stringify({ pid: staleOwnerPid, token: 'stale-lock' }),
      'utf8',
    );
    const bootstrapPython = await createManagedInstallExecutable(configDir, {
      eventLogPath,
      bootstrapOwnerFile,
      bootstrapReleaseFile,
      venvReleaseFile,
      pipReleaseFile,
      validationReleaseFile,
      venvMarkerFile,
      pipMarkerFile,
      validationMarkerFile,
    });
    const raceEnterFile = path.join(controlDir, 'race-entered');
    const raceReleaseFile = path.join(controlDir, 'race-release');
    const racePreloadPath = await createManagedInstallRacePreload(configDir);
    const workerIds = ['one', 'two', 'three', 'four'] as const;
    const delayedWorkerId = 'two';
    const competingWorkerIds = ['one', 'three', 'four'] as const;
    const workers: InstallWorkerHandle[] = [startInstallWorker(
      configDir,
      bootstrapPython,
      delayedWorkerId,
      controlDir,
      {
        racePreloadPath,
        raceEnterFile,
        raceReleaseFile,
      },
    )];
    try {
      await waitForFile(raceEnterFile);
      workers.push(...competingWorkerIds.map((workerId) => startInstallWorker(
        configDir,
        bootstrapPython,
        workerId,
        controlDir,
        { startBarrierFile },
      )));
      await Promise.all(competingWorkerIds.map((workerId) => waitForFile(
        path.join(controlDir, `ready-${workerId}`),
      )));
      await writeFile(startBarrierFile, 'start', 'utf8');

      const ownerEvent = await waitForAnyEvent(
        eventLogPath,
        competingWorkerIds.map((workerId) => `bootstrap-owner:${workerId}`),
      );
      const ownerId = ownerEvent.slice('bootstrap-owner:'.length);
      const contendingWorkerIds = workerIds.filter((workerId) => workerId !== ownerId);
      await writeFile(raceReleaseFile, 'release', 'utf8');
      await Promise.all(contendingWorkerIds.map((workerId) => expectNoWorkerActivity(
        eventLogPath,
        workerId,
        1_000,
      )));
      await writeFile(bootstrapReleaseFile, 'release', 'utf8');

      await waitForEvent(eventLogPath, `venv:${ownerId}`);
      await Promise.all(contendingWorkerIds.map((workerId) => expectNoWorkerActivity(
        eventLogPath,
        workerId,
      )));
      await writeFile(venvReleaseFile, 'release', 'utf8');

      await waitForEvent(eventLogPath, `pip:${ownerId}`);
      await Promise.all(contendingWorkerIds.map((workerId) => expectNoWorkerActivity(
        eventLogPath,
        workerId,
      )));
      await writeFile(pipReleaseFile, 'release', 'utf8');

      await waitForEvent(eventLogPath, `validate:${ownerId}`);
      await Promise.all(contendingWorkerIds.map((workerId) => expectNoWorkerActivity(
        eventLogPath,
        workerId,
      )));
      await writeFile(validationReleaseFile, 'release', 'utf8');

      const outputs = await Promise.all(workers.map((worker) => worker.completion));
      const installations = outputs.map((output) => JSON.parse(output.trim()) as Record<string, unknown>);
      expect(installations).toHaveLength(workerIds.length);
      for (const installation of installations) {
        expect(installation).toMatchObject({
          pythonVersion: '3.10',
          sdkVersion: PINNED_VERSION,
          runtimeVersion: PINNED_VERSION,
        });
      }
      const events = await readEventLog(eventLogPath);
      expect(events.filter((event) => event.startsWith('probe:'))).toHaveLength(workerIds.length);
      expect(events.filter((event) => event.startsWith('venv:'))).toHaveLength(workerIds.length);
      expect(events.filter((event) => event.startsWith('pip:'))).toHaveLength(workerIds.length);
      expect(events.filter((event) => event.startsWith('validate:'))).toHaveLength(workerIds.length);
      expect(events.some((event) => event.startsWith('conflict:'))).toBe(false);
      expect((await readdir(paths.rootPath)).filter((entry) => entry.startsWith('.install.lock'))).toEqual([]);
    } finally {
      await Promise.all([
        writeFile(bootstrapReleaseFile, 'release', 'utf8'),
        writeFile(venvReleaseFile, 'release', 'utf8'),
        writeFile(pipReleaseFile, 'release', 'utf8'),
        writeFile(validationReleaseFile, 'release', 'utf8'),
      ]);
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.child.kill('SIGKILL');
        }
      }
      await Promise.allSettled(workers.map((worker) => worker.completion));
    }
  }, 30_000);

  it('does not delete a replacement recovery owner while reclaiming a stale recovery', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const controlDir = path.join(configDir, 'control');
    await mkdir(controlDir, { recursive: true });
    await mkdir(paths.rootPath, { recursive: true });
    const eventLogPath = path.join(controlDir, 'events.log');
    const bootstrapOwnerFile = path.join(controlDir, 'bootstrap-owner');
    const bootstrapReleaseFile = path.join(controlDir, 'release-bootstrap');
    const venvReleaseFile = path.join(controlDir, 'release-venv');
    const pipReleaseFile = path.join(controlDir, 'release-pip');
    const validationReleaseFile = path.join(controlDir, 'release-validation');
    const venvMarkerFile = path.join(controlDir, 'venv-active');
    const pipMarkerFile = path.join(controlDir, 'pip-active');
    const validationMarkerFile = path.join(controlDir, 'validation-active');
    const staleOwnerPid = await createExitedProcessId();
    const staleLockPath = path.join(paths.rootPath, '.install.lock');
    const staleRecoveryPath = path.join(staleLockPath, '.recovery');
    await mkdir(staleRecoveryPath, { recursive: true });
    await writeFile(
      path.join(staleLockPath, 'owner'),
      JSON.stringify({ pid: staleOwnerPid, token: 'stale-lock' }),
      'utf8',
    );
    await writeFile(
      path.join(staleRecoveryPath, 'owner'),
      JSON.stringify({ pid: staleOwnerPid, token: 'stale-recovery' }),
      'utf8',
    );
    const bootstrapPython = await createManagedInstallExecutable(configDir, {
      eventLogPath,
      bootstrapOwnerFile,
      bootstrapReleaseFile,
      venvReleaseFile,
      pipReleaseFile,
      validationReleaseFile,
      venvMarkerFile,
      pipMarkerFile,
      validationMarkerFile,
    });
    const raceEnterFile = path.join(controlDir, 'recovery-cleanup-entered');
    const raceReleaseFile = path.join(controlDir, 'recovery-cleanup-release');
    const racePreloadPath = await createManagedInstallRacePreload(configDir);
    const first = startInstallWorker(
      configDir,
      bootstrapPython,
      'one',
      controlDir,
      {
        racePreloadPath,
        raceMode: 'recovery-cleanup',
        raceEnterFile,
        raceReleaseFile,
      },
    );
    const workers = [first];
    let second: InstallWorkerHandle | undefined;
    try {
      await waitForFile(raceEnterFile);
      second = startInstallWorker(configDir, bootstrapPython, 'two', controlDir);
      workers.push(second);
      await waitForEvent(eventLogPath, 'bootstrap-owner:two');

      const activeEntries = await readdir(staleLockPath);
      expect(activeEntries.filter((entry) => entry === 'owner' || entry === '.recovery'))
        .toEqual(['owner']);
      await expectNoWorkerActivity(eventLogPath, 'one', 1_000);

      await writeFile(raceReleaseFile, 'release', 'utf8');
      await expectNoWorkerActivity(eventLogPath, 'one');
      await writeFile(bootstrapReleaseFile, 'release', 'utf8');
      await waitForEvent(eventLogPath, 'venv:two');
      await expectNoWorkerActivity(eventLogPath, 'one');
      await writeFile(venvReleaseFile, 'release', 'utf8');
      await waitForEvent(eventLogPath, 'pip:two');
      await expectNoWorkerActivity(eventLogPath, 'one');
      await writeFile(pipReleaseFile, 'release', 'utf8');
      await waitForEvent(eventLogPath, 'validate:two');
      await expectNoWorkerActivity(eventLogPath, 'one');
      await writeFile(validationReleaseFile, 'release', 'utf8');

      const outputs = await Promise.all(workers.map((worker) => worker.completion));
      expect(outputs).toHaveLength(2);
      const events = await readEventLog(eventLogPath);
      expect(events.some((event) => event.startsWith('conflict:'))).toBe(false);
      expect(events.filter((event) => event.startsWith('venv:'))).toHaveLength(2);
      expect(events.filter((event) => event.startsWith('pip:'))).toHaveLength(2);
      expect(events.filter((event) => event.startsWith('validate:'))).toHaveLength(2);
      expect((await readdir(paths.rootPath)).filter((entry) => entry.startsWith('.install.lock'))).toEqual([]);
    } finally {
      await Promise.all([
        writeFile(raceReleaseFile, 'release', 'utf8'),
        writeFile(bootstrapReleaseFile, 'release', 'utf8'),
        writeFile(venvReleaseFile, 'release', 'utf8'),
        writeFile(pipReleaseFile, 'release', 'utf8'),
        writeFile(validationReleaseFile, 'release', 'utf8'),
      ]);
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.child.kill('SIGKILL');
        }
      }
      await Promise.allSettled(workers.map((worker) => worker.completion));
    }
  }, 30_000);

  it('preserves a replacement canonical owner when owner publication is interrupted', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const controlDir = path.join(configDir, 'control');
    await mkdir(controlDir, { recursive: true });
    const eventLogPath = path.join(controlDir, 'events.log');
    const bootstrapOwnerFile = path.join(controlDir, 'bootstrap-owner');
    const bootstrapReleaseFile = path.join(controlDir, 'release-bootstrap');
    const venvReleaseFile = path.join(controlDir, 'release-venv');
    const pipReleaseFile = path.join(controlDir, 'release-pip');
    const validationReleaseFile = path.join(controlDir, 'release-validation');
    const venvMarkerFile = path.join(controlDir, 'venv-active');
    const pipMarkerFile = path.join(controlDir, 'pip-active');
    const validationMarkerFile = path.join(controlDir, 'validation-active');
    const bootstrapPython = await createManagedInstallExecutable(configDir, {
      eventLogPath,
      bootstrapOwnerFile,
      bootstrapReleaseFile,
      venvReleaseFile,
      pipReleaseFile,
      validationReleaseFile,
      venvMarkerFile,
      pipMarkerFile,
      validationMarkerFile,
    });
    const raceEnterFile = path.join(controlDir, 'owner-publication-entered');
    const raceReleaseFile = path.join(controlDir, 'owner-publication-release');
    const racePreloadPath = await createManagedInstallRacePreload(configDir);
    const first = startInstallWorker(
      configDir,
      bootstrapPython,
      'one',
      controlDir,
      {
        racePreloadPath,
        raceMode: 'owner-publication',
        raceEnterFile,
        raceReleaseFile,
      },
    );
    let second: InstallWorkerHandle | undefined;
    try {
      await waitForFile(raceEnterFile);
      second = startInstallWorker(configDir, bootstrapPython, 'two', controlDir);
      await waitForEvent(eventLogPath, 'bootstrap-owner:two');
      await expectNoWorkerActivity(eventLogPath, 'one', 1_000);
      await writeFile(raceReleaseFile, 'release', 'utf8');
      await expectNoWorkerActivity(eventLogPath, 'one');
      await writeFile(bootstrapReleaseFile, 'release', 'utf8');
      await waitForEvent(eventLogPath, 'venv:two');
      await expectNoWorkerActivity(eventLogPath, 'one');
      await writeFile(venvReleaseFile, 'release', 'utf8');
      await waitForEvent(eventLogPath, 'pip:two');
      await expectNoWorkerActivity(eventLogPath, 'one');
      await writeFile(pipReleaseFile, 'release', 'utf8');
      await waitForEvent(eventLogPath, 'validate:two');
      await expectNoWorkerActivity(eventLogPath, 'one');
      await writeFile(validationReleaseFile, 'release', 'utf8');

      const results = await Promise.allSettled([first.completion, second.completion]);
      expect(results[1]?.status).toBe('fulfilled');
      const events = await readEventLog(eventLogPath);
      const validationIndex = events.indexOf('validate:two');
      const firstWorkerVenvIndex = events.indexOf('venv:one');
      expect(firstWorkerVenvIndex === -1 || firstWorkerVenvIndex > validationIndex).toBe(true);
      expect(events.some((event) => event.startsWith('conflict:'))).toBe(false);
      expect((await readdir(paths.rootPath)).filter((entry) => entry.startsWith('.install.lock'))).toEqual([]);
    } finally {
      await Promise.all([
        writeFile(raceReleaseFile, 'release', 'utf8'),
        writeFile(bootstrapReleaseFile, 'release', 'utf8'),
        writeFile(venvReleaseFile, 'release', 'utf8'),
        writeFile(pipReleaseFile, 'release', 'utf8'),
        writeFile(validationReleaseFile, 'release', 'utf8'),
      ]);
      for (const worker of [first, second]) {
        if (worker !== undefined && worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.child.kill('SIGKILL');
        }
      }
      await Promise.allSettled([
        first.completion,
        ...(second === undefined ? [] : [second.completion]),
      ]);
    }
  }, 30_000);

  it('serializes concurrent installs through final validation for one managed root', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    const controlDir = path.join(configDir, 'control');
    await mkdir(controlDir, { recursive: true });
    const eventLogPath = path.join(controlDir, 'events.log');
    const bootstrapReleaseFile = path.join(controlDir, 'release-bootstrap');
    const venvReleaseFile = path.join(controlDir, 'release-venv');
    const pipReleaseFile = path.join(controlDir, 'release-pip');
    const validationReleaseFile = path.join(controlDir, 'release-validation');
    const venvMarkerFile = path.join(controlDir, 'venv-active');
    const pipMarkerFile = path.join(controlDir, 'pip-active');
    const validationMarkerFile = path.join(controlDir, 'validation-active');
    const existingVenvMarker = path.join(paths.venvPath, 'existing-marker');
    await mkdir(paths.venvPath, { recursive: true });
    await writeFile(existingVenvMarker, 'existing environment', 'utf8');
    const bootstrapPython = await createManagedInstallExecutable(configDir, {
      eventLogPath,
      controlledWorkerId: 'one',
      bootstrapReleaseFile,
      venvReleaseFile,
      pipReleaseFile,
      validationReleaseFile,
      venvMarkerFile,
      pipMarkerFile,
      validationMarkerFile,
    });
    const first = startInstallWorker(configDir, bootstrapPython, 'one', controlDir);
    let second: InstallWorkerHandle | undefined;
    try {
      await waitForAnyEvent(eventLogPath, ['probe:one', 'venv:one']);
      second = startInstallWorker(configDir, bootstrapPython, 'two', controlDir);
      await waitForFile(path.join(controlDir, 'ready-two'));
      await expectNoWorkerActivity(eventLogPath, 'two');
      await writeFile(bootstrapReleaseFile, 'release', 'utf8');

      await waitForEvent(eventLogPath, 'venv:one');
      await expect(readFile(existingVenvMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expectNoWorkerActivity(eventLogPath, 'two');
      await writeFile(venvReleaseFile, 'release', 'utf8');

      await waitForEvent(eventLogPath, 'pip:one');
      await expectNoWorkerActivity(eventLogPath, 'two');
      await writeFile(pipReleaseFile, 'release', 'utf8');

      await waitForEvent(eventLogPath, 'validate:one');
      await expectNoWorkerActivity(eventLogPath, 'two');
      await writeFile(validationReleaseFile, 'release', 'utf8');

      const outputs = await Promise.all([
        first.completion,
        second.completion,
      ]);
      await expect(readFile(path.join(resolveDeepSeekHarnessManagedPaths(configDir).rootPath, '.install.lock'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      const installations = outputs.map((output) => JSON.parse(output.trim()) as Record<string, unknown>);
      expect(installations).toHaveLength(2);
      for (const installation of installations) {
        expect(installation).toMatchObject({
          pythonVersion: '3.10',
          sdkVersion: PINNED_VERSION,
          runtimeVersion: PINNED_VERSION,
        });
      }
      expect((await readEventLog(eventLogPath)).some((event) => event.startsWith('conflict:'))).toBe(false);
    } finally {
      await Promise.all([
        writeFile(bootstrapReleaseFile, 'release', 'utf8'),
        writeFile(venvReleaseFile, 'release', 'utf8'),
        writeFile(pipReleaseFile, 'release', 'utf8'),
        writeFile(validationReleaseFile, 'release', 'utf8'),
      ]);
      for (const worker of [first, second]) {
        if (worker !== undefined && worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.child.kill('SIGKILL');
        }
      }
      await Promise.allSettled([
        first.completion,
        ...(second === undefined ? [] : [second.completion]),
      ]);
    }
  }, 20_000);

  it('recreates only the VENV, installs exact requirements, and preserves DSH_HOME', async () => {
    const configDir = await createTemporaryRoot();
    const paths = resolveDeepSeekHarnessManagedPaths(configDir);
    await mkdir(paths.venvPath, { recursive: true });
    await writeFile(path.join(paths.venvPath, 'old-marker'), 'old environment', 'utf8');
    await mkdir(path.join(paths.dshHomePath, 'profiles'), { recursive: true });
    await mkdir(path.join(paths.dshHomePath, 'plugins'), { recursive: true });
    await writeFile(path.join(paths.dshHomePath, 'profiles', 'default.yml'), 'profile', 'utf8');
    await writeFile(path.join(paths.dshHomePath, 'plugins', 'installed.txt'), 'plugin', 'utf8');

    const pipArgsPath = path.join(configDir, 'pip-args.txt');
    const bootstrapPython = await createBootstrapExecutable(configDir, pipArgsPath);
    const installation = await installManagedDeepSeekHarness({
      configDir,
      pythonPath: bootstrapPython,
    });

    await expect(readFile(path.join(paths.venvPath, 'old-marker'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(paths.dshHomePath, 'profiles', 'default.yml'), 'utf8')).toBe('profile');
    expect(await readFile(path.join(paths.dshHomePath, 'plugins', 'installed.txt'), 'utf8')).toBe('plugin');
    expect(installation).toMatchObject({
      venvPath: paths.venvPath,
      dshHomePath: paths.dshHomePath,
      sdkVersion: PINNED_VERSION,
      runtimeVersion: PINNED_VERSION,
    });

    const pipArgs = (await readFile(pipArgsPath, 'utf8')).trim().split('\n');
    expect(pipArgs).toEqual(expect.arrayContaining([
      '-m',
      'pip',
      'install',
      `deepseek-harness-sdk==${PINNED_VERSION}`,
      `deepseek-harness-runtime-bin==${PINNED_VERSION}`,
    ]));
  });
});
