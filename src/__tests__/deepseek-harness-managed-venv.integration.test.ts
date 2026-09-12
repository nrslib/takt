import { execFileSync, spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import type { StreamEvent } from '../shared/types/provider.js';
import {
  DEEPSEEK_HARNESS_MIN_UV_VERSION,
  DEEPSEEK_HARNESS_PYTHON_REQUIRES,
  DEEPSEEK_HARNESS_PYTHON_VERSION,
  DEEPSEEK_HARNESS_RUNTIME_VERSION,
  DEEPSEEK_HARNESS_SDK_VERSION,
} from '../infra/deepseek-harness/constants.js';
import {
  assertSupportedDeepSeekHarnessPlatform,
  isSupportedDeepSeekHarnessPlatform,
} from '../infra/deepseek-harness/platform.js';
import { installDeepSeekHarness } from '../infra/deepseek-harness/managed-venv.js';
import { callDeepSeekHarness, closeDeepSeekHarnessProcesses } from '../infra/deepseek-harness/index.js';

const supportedPlatform = (
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
  || (process.platform === 'darwin' && process.arch === 'arm64')
);
const fakePythonAvailable = supportedPlatform && findPython() !== undefined;
const testsDirectory = fileURLToPath(new URL('.', import.meta.url));
const manifestPath = path.join(
  testsDirectory,
  '..',
  'infra',
  'deepseek-harness',
  'pyproject.toml',
);
const lockPath = path.join(
  testsDirectory,
  '..',
  'infra',
  'deepseek-harness',
  'uv.lock',
);

interface Workspace {
  root: string;
  projectDir: string;
  globalDir: string;
  managedRoot: string;
  environmentDir: string;
  dshHomeDir: string;
}

interface FakeUvInvocation {
  args: string[];
  cwd: string;
  env: {
    UV_PROJECT_ENVIRONMENT?: string;
    UV_PROJECT?: string;
    UV_PYTHON?: string;
    UV_FROZEN?: string;
    UV_LOCKED?: string;
    UV_NO_SYNC?: string;
    VIRTUAL_ENV?: string;
    UV_INDEX_URL?: string;
    UV_INDEX_URL_HAS_AUTH: boolean;
    UV_INDEX_URL_HAS_USERNAME: boolean;
    UV_INDEX_URL_HAS_PASSWORD: boolean;
    UV_INDEX_URL_HOST?: string;
    HTTPS_PROXY_HOST?: string;
    HTTPS_PROXY_HAS_AUTH: boolean;
    HTTP_PROXY_HOST?: string;
    HTTP_PROXY_HAS_AUTH: boolean;
    SSL_CERT_FILE?: string;
  };
  syncAssets?: {
    manifestMatchesPackaged: boolean;
    lockMatchesPackaged: boolean;
  };
}

interface FakeRuntimeOptions {
  pythonVersion?: string;
  implementation?: string;
  sdkVersion?: string;
  runtimeVersion?: string;
  requiresPython?: string;
  constructorCompatible?: boolean;
  holdProbe?: boolean;
  failProbeOnce?: boolean;
}

interface FakeRuntime {
  pythonRoot: string;
  pythonShimSource: string;
  pythonInvocationLog: string;
  bridgeStartedMarker: string;
  probeStartedMarker: string;
  probeReleasePath: string;
  probeFailOncePath: string;
}

const testRoots: string[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function findPython(): string | undefined {
  const candidates = process.platform === 'win32' ? ['python'] : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      const executable = execFileSync(candidate, ['-c', 'import os, sys; print(os.path.realpath(sys.executable))'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (path.isAbsolute(executable)) {
        return executable;
      }
    } catch {
      // The test fixture tries the next interpreter name.
    }
  }
  return undefined;
}

function extractPinnedVersion(manifest: string, packageName: string): string {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`${escapedPackageName}==([0-9]+(?:\\.[0-9]+)+(?:[a-z]+[0-9]+)?)`, 'u').exec(manifest);
  if (match?.[1] === undefined) {
    throw new Error(`${packageName} must be pinned with == in pyproject.toml`);
  }
  return match[1];
}

async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-managed-env-'));
  testRoots.push(root);
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  const managedRoot = path.join(globalDir, 'deepseek-harness');
  const environmentDir = path.join(managedRoot, 'venv');
  const dshHomeDir = path.join(managedRoot, 'dsh-home');
  await mkdir(projectDir, { recursive: true });
  await mkdir(dshHomeDir, { recursive: true });
  return { root, projectDir, globalDir, managedRoot, environmentDir, dshHomeDir };
}

async function createFakeRuntime(workspace: Workspace, options: FakeRuntimeOptions = {}): Promise<FakeRuntime> {
  const manifest = readFileSync(manifestPath, 'utf8');
  const sdkVersion = options.sdkVersion ?? extractPinnedVersion(manifest, 'deepseek-harness-sdk');
  const runtimeVersion = options.runtimeVersion
    ?? extractPinnedVersion(manifest, 'deepseek-harness-runtime-bin');
  const pythonVersion = options.pythonVersion ?? '3.12.9';
  const requiresPython = options.requiresPython ?? DEEPSEEK_HARNESS_PYTHON_REQUIRES;
  const pythonRoot = path.join(workspace.root, 'fake-python');
  const pythonInvocationLog = path.join(workspace.root, 'managed-python-invocations.log');
  const bridgeStartedMarker = path.join(workspace.root, 'bridge-started.marker');
  const probeStartedMarker = path.join(workspace.root, 'probe-started.marker');
  const probeReleasePath = path.join(workspace.root, 'release-probe');
  const probeFailOncePath = path.join(workspace.root, 'fail-probe-once');
  await mkdir(path.join(pythonRoot, 'deepseek_harness'), { recursive: true });
  await writeFile(path.join(pythonRoot, 'sitecustomize.py'), `
import os
import sys
import time
import types

if sys.argv and sys.argv[0] == '-c':
    if os.environ.get('FAKE_PROBE_HOLD') == '1':
        with open(${JSON.stringify(probeStartedMarker)}, 'a', encoding='utf-8') as marker:
            marker.write(str(os.getpid()) + '\\n')
        while not os.path.exists(${JSON.stringify(probeReleasePath)}):
            time.sleep(0.01)
parts = tuple(int(part) for part in ${JSON.stringify(pythonVersion.split('.'))})
version = parts + ('final', 0)
VersionInfo = type('VersionInfo', (tuple,), {
    'major': property(lambda self: self[0]),
    'minor': property(lambda self: self[1]),
    'micro': property(lambda self: self[2]),
})
sys.version_info = VersionInfo(version)
sys.implementation = types.SimpleNamespace(
    name=${JSON.stringify(options.implementation ?? 'cpython')},
    cache_tag='cpython-312',
    version=sys.version_info,
    hexversion=0x30C0000,
    _multiarch='test',
)
`, 'utf8');
  vi.stubEnv('FAKE_PROBE_HOLD', options.holdProbe === true ? '1' : '0');
  vi.stubEnv('FAKE_PROBE_FAIL_ONCE', options.failProbeOnce === true ? '1' : '0');
  vi.stubEnv('FAKE_PROBE_FAIL_ONCE_PATH', probeFailOncePath);
  const constructor = options.constructorCompatible === false
    ? `    def __init__(self, required):
        self.kwargs = {'required': required}
`
    : `    def __init__(self, provider, model, cwd, runtime_cwd, max_tokens=None, session_root=None, cordis=None, request_timeout_seconds=None, shutdown_timeout_seconds=None):
        self.kwargs = {
            'provider': provider,
            'model': model,
            'cwd': cwd,
            'runtime_cwd': runtime_cwd,
            'max_tokens': max_tokens,
            'session_root': session_root,
            'cordis': cordis,
            'request_timeout_seconds': request_timeout_seconds,
            'shutdown_timeout_seconds': shutdown_timeout_seconds,
        }
        with open(${JSON.stringify(bridgeStartedMarker)}, 'a', encoding='utf-8') as marker:
            marker.write(json.dumps({
                'kwargs': self.kwargs,
                'dshHome': __import__('os').environ.get('DSH_HOME'),
                'path': __import__('os').environ.get('PATH'),
            }, sort_keys=True) + '\\n')
`;
  await writeFile(path.join(pythonRoot, 'deepseek_harness', '__init__.py'), `
import json
import os
import types

if os.environ.get('FAKE_PROBE_FAIL_ONCE') == '1' and not os.path.exists(${JSON.stringify(probeFailOncePath)}):
    with open(${JSON.stringify(probeFailOncePath)}, 'w', encoding='utf-8') as marker:
        marker.write('failed')
    raise RuntimeError('fake managed interpreter probe failed')

class Result:
    def __init__(self, session_id, final_response, finish_reason):
        self.session_id = session_id
        self.final_response = final_response
        self.finish_reason = finish_reason

class DeepSeekHarness:
${constructor}
    def start(self):
        return None

    def close(self):
        return None

    def start_session(self, session_id=None):
        harness = self
        active_session = session_id or 'managed-session'
        class Session:
            id = active_session
            def run(self, input, *, on_notification=None):
                def emit(event):
                    if on_notification is not None:
                        on_notification(types.SimpleNamespace(
                            method='session.event',
                            payload={
                                'sessionId': active_session,
                                'event': event,
                            },
                        ))

                secret = os.environ.get('DEEPSEEK_API_KEY')
                stream_mode = input if input in ('cross-event', 'cross-final', 'normal-stream') else None
                final_response = 'managed response'
                if stream_mode == 'normal-stream':
                    emit({
                        'type': 'assistant/chunk',
                        'data': {
                            'chunk': {
                                'type': 'reasoning-delta',
                                'text': 'safe thinking',
                            },
                        },
                    })
                    emit({
                        'type': 'assistant/chunk',
                        'data': {
                            'chunk': {
                                'type': 'text-delta',
                                'text': 'safe response',
                            },
                        },
                    })
                elif secret and stream_mode in ('cross-event', 'cross-final'):
                    split = len(secret) // 2
                    emit({
                        'type': 'assistant/chunk',
                        'data': {
                            'chunk': {
                                'type': 'reasoning-delta',
                                'text': secret[:split],
                            },
                        },
                    })
                    if stream_mode == 'cross-event':
                        emit({
                            'type': 'assistant/chunk',
                            'data': {
                                'chunk': {
                                    'type': 'text-delta',
                                    'text': secret[split:],
                                },
                            },
                        })
                    else:
                        final_response = secret[split:]
                if stream_mode in ('normal-stream', 'cross-event', 'cross-final'):
                    emit({
                        'type': 'turn/end',
                        'data': {'reason': {'kind': 'completed'}},
                    })
                return Result(active_session, final_response, 'completed')
        return Session()
`, 'utf8');
  const sdkInfoDir = path.join(pythonRoot, `deepseek_harness_sdk-${sdkVersion}.dist-info`);
  const runtimeInfoDir = path.join(pythonRoot, `deepseek_harness_runtime_bin-${runtimeVersion}.dist-info`);
  await mkdir(sdkInfoDir, { recursive: true });
  await mkdir(runtimeInfoDir, { recursive: true });
  await writeFile(path.join(sdkInfoDir, 'METADATA'), [
    'Metadata-Version: 2.1',
    'Name: deepseek-harness-sdk',
    `Version: ${sdkVersion}`,
    `Requires-Python: ${requiresPython}`,
    `Requires-Dist: deepseek-harness-runtime-bin==${runtimeVersion}`,
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(runtimeInfoDir, 'METADATA'), [
    'Metadata-Version: 2.1',
    'Name: deepseek-harness-runtime-bin',
    `Version: ${runtimeVersion}`,
    '',
  ].join('\n'), 'utf8');
  const realPython = findPython();
  if (realPython === undefined) {
    throw new Error('The fake managed-environment fixture requires a local Python interpreter');
  }
  const pythonShimSource = path.join(workspace.root, 'managed-python-shim');
  await writeFile(pythonShimSource, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${shellQuote(pythonInvocationLog)}`,
    `export PYTHONPATH=${shellQuote(pythonRoot)}:"${'${PYTHONPATH:-}'}"`,
    `exec ${shellQuote(realPython)} "$@"`,
    '',
  ].join('\n'), 'utf8');
  await chmod(pythonShimSource, 0o755);
  return {
    pythonRoot,
    pythonShimSource,
    pythonInvocationLog,
    bridgeStartedMarker,
    probeStartedMarker,
    probeReleasePath,
    probeFailOncePath,
  };
}

async function createFakeUv(
  workspace: Workspace,
  runtime: FakeRuntime,
  options: {
    version?: string;
    failSync?: boolean;
    failOnce?: boolean;
    holdVersion?: boolean;
    holdSync?: boolean;
    failureMessage?: string;
    removeAfterVersion?: boolean;
  } = {},
): Promise<{
  path: string;
  logPath: string;
  releasePath: string;
  failOncePath: string;
  versionStartedPath: string;
  versionReleasePath: string;
}> {
  const fakeUvPath = path.join(workspace.root, 'fake-uv.cjs');
  const logPath = path.join(workspace.root, 'fake-uv.jsonl');
  const releasePath = path.join(workspace.root, 'release-sync');
  const failOncePath = path.join(workspace.root, 'fail-sync-once');
  const versionStartedPath = path.join(workspace.root, 'version-started');
  const versionReleasePath = path.join(workspace.root, 'release-version');
  await writeFile(fakeUvPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_UV_LOG;
const indexUrl = process.env.UV_INDEX_URL;
let safeIndexUrl;
let indexUrlHasUsername = false;
let indexUrlHasPassword = false;
let indexUrlHost;
if (indexUrl !== undefined) {
  try {
    const parsed = new URL(indexUrl);
    indexUrlHasUsername = parsed.username.length > 0;
    indexUrlHasPassword = parsed.password.length > 0;
    indexUrlHost = parsed.host;
    safeIndexUrl = indexUrlHasUsername || indexUrlHasPassword
      ? parsed.protocol + '//' + parsed.host + parsed.pathname + parsed.search + parsed.hash
      : indexUrl;
  } catch {
    safeIndexUrl = '<invalid>';
  }
}
function observeProxy(value) {
  if (value === undefined) {
    return { host: undefined, hasAuth: false };
  }
  try {
    const parsed = new URL(value);
    return {
      host: parsed.host,
      hasAuth: parsed.username.length > 0 || parsed.password.length > 0,
    };
  } catch {
    return { host: '<invalid>', hasAuth: false };
  }
}
const httpsProxy = observeProxy(process.env.HTTPS_PROXY);
const httpProxy = observeProxy(process.env.HTTP_PROXY);
let syncAssets;
if (args.includes('sync')) {
  const projectOptionIndex = args.indexOf('--project');
  const project = projectOptionIndex < 0 ? undefined : args[projectOptionIndex + 1];
  try {
    const managedManifest = fs.readFileSync(path.join(project, 'pyproject.toml'), 'utf8');
    const managedLock = fs.readFileSync(path.join(project, 'uv.lock'), 'utf8');
    const packagedManifest = fs.readFileSync(process.env.FAKE_UV_EXPECTED_MANIFEST_PATH, 'utf8');
    const packagedLock = fs.readFileSync(process.env.FAKE_UV_EXPECTED_LOCK_PATH, 'utf8');
    syncAssets = {
      manifestMatchesPackaged: managedManifest === packagedManifest,
      lockMatchesPackaged: managedLock === packagedLock,
    };
  } catch {
    process.stderr.write('managed project assets are unavailable\\n');
    process.exit(25);
  }
  if (!syncAssets.manifestMatchesPackaged || !syncAssets.lockMatchesPackaged) {
    process.stderr.write('managed project assets do not match packaged assets\\n');
    process.exit(26);
  }
}
const record = {
  args,
  cwd: process.cwd(),
  env: {
    UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT,
    UV_PROJECT: process.env.UV_PROJECT,
    UV_PYTHON: process.env.UV_PYTHON,
    UV_FROZEN: process.env.UV_FROZEN,
    UV_LOCKED: process.env.UV_LOCKED,
    UV_NO_SYNC: process.env.UV_NO_SYNC,
    VIRTUAL_ENV: process.env.VIRTUAL_ENV,
    UV_INDEX_URL: safeIndexUrl,
    UV_INDEX_URL_HAS_AUTH: indexUrlHasUsername || indexUrlHasPassword,
    UV_INDEX_URL_HAS_USERNAME: indexUrlHasUsername,
    UV_INDEX_URL_HAS_PASSWORD: indexUrlHasPassword,
    UV_INDEX_URL_HOST: indexUrlHost,
    HTTPS_PROXY_HOST: httpsProxy.host,
    HTTPS_PROXY_HAS_AUTH: httpsProxy.hasAuth,
    HTTP_PROXY_HOST: httpProxy.host,
    HTTP_PROXY_HAS_AUTH: httpProxy.hasAuth,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
  },
  syncAssets,
};
fs.appendFileSync(logPath, JSON.stringify(record) + '\\n');
if (args.length === 1 && args[0] === '--version') {
  if (process.env.FAKE_UV_HOLD_VERSION === '1'
    && !fs.existsSync(process.env.FAKE_UV_VERSION_RELEASE_PATH)) {
    try {
      fs.writeFileSync(process.env.FAKE_UV_VERSION_STARTED_PATH, String(process.pid), { flag: 'wx' });
    } catch {
      process.stderr.write('concurrent uv version probes are not allowed\\n');
      process.exit(27);
    }
    while (!fs.existsSync(process.env.FAKE_UV_VERSION_RELEASE_PATH)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (process.env.FAKE_UV_REMOVE_AFTER_VERSION === '1') {
    fs.unlinkSync(process.argv[1]);
  }
  process.stdout.write(process.env.FAKE_UV_VERSION + '\\n');
  process.exit(0);
}
if (!args.includes('sync')) {
  process.stderr.write('unexpected fake uv command\\n');
  process.exit(2);
}
if (process.env.FAKE_UV_HOLD_SYNC === '1') {
  fs.appendFileSync(process.env.FAKE_UV_SYNC_EVENTS, 'start\\n');
  while (!fs.existsSync(process.env.FAKE_UV_RELEASE_PATH)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const shouldFail = process.env.FAKE_UV_FAIL_SYNC === '1'
  || (process.env.FAKE_UV_FAIL_ONCE === '1' && !fs.existsSync(process.env.FAKE_UV_FAIL_ONCE_PATH));
if (shouldFail) {
  if (process.env.FAKE_UV_FAIL_ONCE === '1') {
    fs.writeFileSync(process.env.FAKE_UV_FAIL_ONCE_PATH, 'failed');
  }
  process.stderr.write((process.env.FAKE_UV_FAILURE_MESSAGE || 'uv sync failed: lockfile is not up to date')
    + '; index=' + (process.env.UV_INDEX_URL || '') + '\\n');
  process.exit(23);
}
const environment = process.env.UV_PROJECT_ENVIRONMENT;
if (typeof environment !== 'string' || !path.isAbsolute(environment)) {
  process.stderr.write('managed environment must be absolute\\n');
  process.exit(24);
}
const binDir = process.platform === 'win32' ? path.join(environment, 'Scripts') : path.join(environment, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const pythonPath = path.join(binDir, process.platform === 'win32' ? 'python.exe' : 'python');
fs.copyFileSync(process.env.FAKE_PYTHON_SHIM_SOURCE, pythonPath);
fs.chmodSync(pythonPath, 0o755);
if (process.env.FAKE_UV_HOLD_SYNC === '1') {
  fs.appendFileSync(process.env.FAKE_UV_SYNC_EVENTS, 'end\\n');
}
`, 'utf8');
  await chmod(fakeUvPath, 0o755);
  vi.stubEnv('FAKE_UV_LOG', logPath);
  vi.stubEnv('FAKE_UV_VERSION', options.version ?? 'uv 0.11.14');
  vi.stubEnv('FAKE_PYTHON_SHIM_SOURCE', runtime.pythonShimSource);
  vi.stubEnv('FAKE_UV_EXPECTED_MANIFEST_PATH', manifestPath);
  vi.stubEnv('FAKE_UV_EXPECTED_LOCK_PATH', lockPath);
  vi.stubEnv('FAKE_UV_FAIL_SYNC', options.failSync === true ? '1' : '0');
  vi.stubEnv('FAKE_UV_FAIL_ONCE', options.failOnce === true ? '1' : '0');
  vi.stubEnv('FAKE_UV_FAIL_ONCE_PATH', failOncePath);
  vi.stubEnv('FAKE_UV_FAILURE_MESSAGE', options.failureMessage ?? 'uv sync failed: lockfile is not up to date');
  vi.stubEnv('FAKE_UV_REMOVE_AFTER_VERSION', options.removeAfterVersion === true ? '1' : '0');
  vi.stubEnv('FAKE_UV_HOLD_VERSION', options.holdVersion === true ? '1' : '0');
  vi.stubEnv('FAKE_UV_VERSION_STARTED_PATH', versionStartedPath);
  vi.stubEnv('FAKE_UV_VERSION_RELEASE_PATH', versionReleasePath);
  vi.stubEnv('FAKE_UV_HOLD_SYNC', options.holdSync === true ? '1' : '0');
  vi.stubEnv('FAKE_UV_RELEASE_PATH', releasePath);
  vi.stubEnv('FAKE_UV_SYNC_EVENTS', path.join(workspace.root, 'sync-events.log'));
  return {
    path: fakeUvPath,
    logPath,
    releasePath,
    failOncePath,
    versionStartedPath,
    versionReleasePath,
  };
}

function readUvInvocations(logPath: string): FakeUvInvocation[] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeUvInvocation);
}

async function snapshotPath(pathValue: string): Promise<string> {
  const stats = await lstat(pathValue).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  });
  if (stats === undefined) {
    return 'missing';
  }
  if (stats.isDirectory()) {
    const entries = (await readdir(pathValue)).sort();
    const children = await Promise.all(entries.map(async (entry) => (
      `${entry}:${await snapshotPath(path.join(pathValue, entry))}`
    )));
    return `directory(${children.join('|')})`;
  }
  if (stats.isFile()) {
    return `file(${(await readFile(pathValue)).toString('base64')})`;
  }
  if (stats.isSymbolicLink()) {
    return `symlink(${await readlink(pathValue)})`;
  }
  return 'other';
}

async function snapshotManagedState(paths: {
  managedRoot: string;
  environmentDir: string;
  pythonPath: string;
  dshHomeDir: string;
}): Promise<Record<string, string>> {
  return {
    managedRoot: await snapshotPath(paths.managedRoot),
    environment: await snapshotPath(paths.environmentDir),
    interpreter: await snapshotPath(paths.pythonPath),
    dshHome: await snapshotPath(paths.dshHomeDir),
  };
}

function expectCanonicalInstallGuidance(content: string): void {
  expect(content).toContain('takt deepseek-harness install');
  expect(content).not.toMatch(/--python|python_path/iu);
}

interface InstallProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface InstallProcessHandle {
  child: ReturnType<typeof spawn>;
  result: Promise<InstallProcessResult>;
}

function startInstallProcess(
  uvPath: string,
  readyPath: string,
  startPath: string,
): InstallProcessHandle {
  const managedVenvModuleUrl = pathToFileURL(
    path.resolve('src/infra/deepseek-harness/managed-venv.ts'),
  ).href;
  const script = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
    `while (!existsSync(${JSON.stringify(startPath)})) {`,
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    '}',
    `const { installDeepSeekHarness } = await import(${JSON.stringify(managedVenvModuleUrl)});`,
    'const childUvPath = process.env.FAKE_UV_PATH;',
    "if (childUvPath === undefined) throw new Error('fake uv path is missing');",
    'await installDeepSeekHarness({ uvPath: childUvPath });',
  ].join('\n');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      env: { ...process.env, FAKE_UV_PATH: uvPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  const result = new Promise<InstallProcessResult>((resolveResult) => {
    let settled = false;
    const finish = (value: InstallProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolveResult(value);
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.once('error', (error) => {
      finish({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code) => {
      finish({ code, stdout, stderr });
    });
  });
  return { child, result };
}

function syncInvocation(invocations: readonly FakeUvInvocation[]): FakeUvInvocation {
  const sync = invocations.find((invocation) => invocation.args.includes('sync'));
  if (sync === undefined) {
    throw new Error('fake uv sync invocation was not recorded');
  }
  return sync;
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${option}=`));
  if (inline !== undefined) {
    return inline.slice(option.length + 1);
  }
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

function hasPythonVersionArgument(args: readonly string[], version: string): boolean {
  return optionValue(args, '--python') === version;
}

async function prepareInstallFixture(
  runtimeOptions: FakeRuntimeOptions = {},
  uvOptions: {
    version?: string;
    failSync?: boolean;
    failOnce?: boolean;
    holdVersion?: boolean;
    holdSync?: boolean;
    failureMessage?: string;
    removeAfterVersion?: boolean;
  } = {},
): Promise<Workspace & { runtime: FakeRuntime; uv: Awaited<ReturnType<typeof createFakeUv>> }> {
  const workspace = await createWorkspace();
  const runtime = await createFakeRuntime(workspace, runtimeOptions);
  const uv = await createFakeUv(workspace, runtime, uvOptions);
  vi.stubEnv('TAKT_CONFIG_DIR', workspace.globalDir);
  vi.stubEnv('UV_PROJECT_ENVIRONMENT', path.join(workspace.root, 'user-controlled-environment'));
  vi.stubEnv('UV_PROJECT', path.join(workspace.root, 'user-project'));
  vi.stubEnv('UV_PYTHON', '3.11');
  vi.stubEnv('UV_FROZEN', '1');
  vi.stubEnv('UV_LOCKED', '0');
  vi.stubEnv('UV_NO_SYNC', '1');
  vi.stubEnv('VIRTUAL_ENV', path.join(workspace.root, 'user-venv'));
  vi.stubEnv('UV_INDEX_URL', 'https://packages.example.test/simple');
  vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:8080');
  vi.stubEnv('HTTP_PROXY', 'http://http-proxy.example.test:8080');
  return { ...workspace, runtime, uv };
}

async function writeExistingManagedState(workspace: Workspace): Promise<void> {
  await mkdir(workspace.environmentDir, { recursive: true });
  await writeFile(path.join(workspace.environmentDir, 'old-marker'), 'old environment', 'utf8');
  await writeFile(path.join(workspace.dshHomeDir, 'profile.json'), '{"profile":"keep"}', 'utf8');
}

function readManifestAndLock(): { manifest: string; lock: string } {
  return {
    manifest: readFileSync(manifestPath, 'utf8'),
    lock: readFileSync(lockPath, 'utf8'),
  };
}

describe('DeepSeek Harness platform contract', () => {
  it.each([
    ['linux', 'x64', true],
    ['linux', 'arm64', true],
    ['darwin', 'arm64', true],
    ['darwin', 'x64', false],
    ['win32', 'x64', false],
    ['freebsd', 'x64', false],
  ] as const)('classifies %s/%s as supported=%s', (platform, arch, expected) => {
    expect(isSupportedDeepSeekHarnessPlatform(platform, arch)).toBe(expected);
  });

  it('reports the supported platform set before any wheel-resolution diagnostic', () => {
    expect(() => assertSupportedDeepSeekHarnessPlatform('win32', 'x64'))
      .toThrow(/Linux x64\/arm64 or macOS arm64/);
    expect(() => assertSupportedDeepSeekHarnessPlatform('win32', 'x64'))
      .toThrow(/not supported|no provider fallback/i);
  });
});

describe('DeepSeek Harness managed runtime constants', () => {
  it('keeps the TAKT runtime contract aligned with the shipped project manifest', () => {
    const { manifest } = readManifestAndLock();
    const sdkVersion = extractPinnedVersion(manifest, 'deepseek-harness-sdk');
    const runtimeVersion = extractPinnedVersion(manifest, 'deepseek-harness-runtime-bin');

    expect(DEEPSEEK_HARNESS_MIN_UV_VERSION).toBe('0.11.0');
    expect(DEEPSEEK_HARNESS_PYTHON_VERSION).toBe('3.12');
    expect(DEEPSEEK_HARNESS_PYTHON_REQUIRES).toBe('>=3.12,<3.13');
    expect(DEEPSEEK_HARNESS_SDK_VERSION).toBe(sdkVersion);
    expect(DEEPSEEK_HARNESS_RUNTIME_VERSION).toBe(runtimeVersion);
    expect(DEEPSEEK_HARNESS_SDK_VERSION).toBe(DEEPSEEK_HARNESS_RUNTIME_VERSION);
    expect(manifest).toContain(`requires-python = "${DEEPSEEK_HARNESS_PYTHON_REQUIRES}"`);
  });
});

describe.skipIf(!fakePythonAvailable)('DeepSeek Harness managed installer', () => {
  afterEach(async () => {
    await closeDeepSeekHarnessProcesses();
    vi.unstubAllEnvs();
    for (const root of testRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('syncs the managed project once with absolute paths and the locked non-dev contract', async () => {
    const fixture = await prepareInstallFixture();
    await writeExistingManagedState(fixture);
    const { manifest, lock } = readManifestAndLock();
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await installDeepSeekHarness({ uvPath: fixture.uv.path });

    const invocations = readUvInvocations(fixture.uv.logPath);
    const sync = syncInvocation(invocations);
    const expectedEnvironment = path.resolve(fixture.environmentDir);
    const expectedProject = path.resolve(fixture.managedRoot);
    const versionInvocations = invocations.filter(
      (invocation) => invocation.args.length === 1 && invocation.args[0] === '--version',
    );
    const syncInvocations = invocations.filter((invocation) => invocation.args.includes('sync'));
    expect(invocations.length).toBeGreaterThan(0);
    expect(versionInvocations.length + syncInvocations.length).toBe(invocations.length);
    expect(invocations.some((invocation) => invocation.args.some(
      (argument) => argument === 'pip' || argument === 'tool',
    ))).toBe(false);
    expect(syncInvocations).toHaveLength(1);
    expect(sync.args).toContain('sync');
    expect(sync.args).toContain('--locked');
    expect(sync.args).toContain('--managed-python');
    expect(sync.args).toContain('--no-install-project');
    expect(sync.args).toContain('--no-dev');
    expect(hasPythonVersionArgument(sync.args, DEEPSEEK_HARNESS_PYTHON_VERSION)).toBe(true);
    expect(sync.args).not.toContain('--frozen');
    expect(sync.args.some((argument) => argument.startsWith('pip'))).toBe(false);
    expect(sync.args.some((argument) => argument.startsWith('tool'))).toBe(false);
    expect(sync.env.UV_PROJECT_ENVIRONMENT).toBe(expectedEnvironment);
    expect(optionValue(sync.args, '--project')).toBe(expectedProject);
    expect(sync.cwd).toBe(expectedProject);
    expect(sync.syncAssets).toEqual({
      manifestMatchesPackaged: true,
      lockMatchesPackaged: true,
    });
    expect(await readFile(path.join(fixture.managedRoot, 'pyproject.toml'), 'utf8')).toBe(manifest);
    expect(await readFile(path.join(fixture.managedRoot, 'uv.lock'), 'utf8')).toBe(lock);
    expect(await readFile(path.join(fixture.dshHomeDir, 'profile.json'), 'utf8')).toBe('{"profile":"keep"}');
    expect(existsSync(path.join(fixture.environmentDir, 'bin', 'python'))).toBe(true);
    expect(await readFile(fixture.runtime.pythonInvocationLog, 'utf8'))
      .not.toMatch(/(?:^|\s)-m\s+(?:venv|pip)(?:\s|$)/u);
    const renderedOutput = output.mock.calls.flatMap((call) => call.map(String)).join('\n');
    expect(renderedOutput).toContain('uv 0.11.14');
    expect(renderedOutput).toContain('Python 3.12.9');
    expect(renderedOutput).toContain(`SDK ${DEEPSEEK_HARNESS_SDK_VERSION}`);
    expect(renderedOutput).toContain(`runtime ${DEEPSEEK_HARNESS_RUNTIME_VERSION}`);
    expect(renderedOutput).toContain(expectedEnvironment);
    expect(renderedOutput).toContain(path.resolve(fixture.dshHomeDir));
  });

  it('consumes packaged assets instead of stale managed copies before uv sync', async () => {
    const fixture = await prepareInstallFixture();
    await writeFile(path.join(fixture.managedRoot, 'pyproject.toml'), 'stale manifest', 'utf8');
    await writeFile(path.join(fixture.managedRoot, 'uv.lock'), 'stale lock', 'utf8');

    await installDeepSeekHarness({ uvPath: fixture.uv.path });

    const sync = syncInvocation(readUvInvocations(fixture.uv.logPath));
    expect(sync.syncAssets).toEqual({
      manifestMatchesPackaged: true,
      lockMatchesPackaged: true,
    });
    expect(await readFile(path.join(fixture.managedRoot, 'pyproject.toml'), 'utf8'))
      .toBe(readFileSync(manifestPath, 'utf8'));
    expect(await readFile(path.join(fixture.managedRoot, 'uv.lock'), 'utf8'))
      .toBe(readFileSync(lockPath, 'utf8'));
  });

  it('accepts the documented minimum uv version', async () => {
    const fixture = await prepareInstallFixture({}, { version: `uv ${DEEPSEEK_HARNESS_MIN_UV_VERSION}` });

    await installDeepSeekHarness({ uvPath: fixture.uv.path });

    expect(readUvInvocations(fixture.uv.logPath).some((invocation) => invocation.args.includes('sync'))).toBe(true);
  });

  it('removes only the managed environment before uv sync starts', async () => {
    const fixture = await prepareInstallFixture({}, { holdSync: true });
    await writeExistingManagedState(fixture);
    const installation = installDeepSeekHarness({ uvPath: fixture.uv.path });
    const syncEventsPath = path.join(fixture.root, 'sync-events.log');

    try {
      await vi.waitFor(() => {
        expect(readFileSync(syncEventsPath, 'utf8')).toBe('start\n');
      });
      expect(existsSync(fixture.environmentDir)).toBe(false);
      expect(await readFile(path.join(fixture.dshHomeDir, 'profile.json'), 'utf8'))
        .toBe('{"profile":"keep"}');
    } finally {
      await writeFile(fixture.uv.releasePath, 'release');
      await installation.catch(() => undefined);
    }
  });

  it('maps a uv sync process-start failure to a managed-install diagnostic', async () => {
    const fixture = await prepareInstallFixture({}, { removeAfterVersion: true });

    await expect(installDeepSeekHarness({ uvPath: fixture.uv.path }))
      .rejects.toThrow(/DeepSeek Harness.*uv sync|uv sync.*DeepSeek Harness/i);

    expect(readUvInvocations(fixture.uv.logPath)
      .filter((invocation) => invocation.args.includes('sync'))).toHaveLength(0);
  });

  it('ignores relative cwd and user-selected uv environment controls', async () => {
    const fixture = await prepareInstallFixture();
    const originalCwd = process.cwd();
    const relativeGlobalDir = 'relative-takt-home';
    try {
      process.chdir(fixture.projectDir);
      vi.stubEnv('TAKT_CONFIG_DIR', relativeGlobalDir);
      vi.stubEnv('UV_PROJECT', path.join(fixture.root, 'user-project'));
      vi.stubEnv('UV_PYTHON', '3.11');
      vi.stubEnv('UV_PROJECT_ENVIRONMENT', path.join(fixture.root, 'user-environment'));
      await installDeepSeekHarness({ uvPath: fixture.uv.path });
    } finally {
      process.chdir(originalCwd);
    }

    const sync = syncInvocation(readUvInvocations(fixture.uv.logPath));
    const expectedManagedRoot = path.resolve(fixture.projectDir, relativeGlobalDir, 'deepseek-harness');
    expect(sync.env.UV_PROJECT_ENVIRONMENT).toBe(path.join(expectedManagedRoot, 'venv'));
    expect(optionValue(sync.args, '--project')).toBe(expectedManagedRoot);
    expect(sync.cwd).toBe(expectedManagedRoot);
    expect(sync.args).not.toContain(path.join(fixture.root, 'user-project'));
    expect(sync.env.UV_PROJECT_ENVIRONMENT).not.toBe(path.join(fixture.root, 'user-environment'));
    expect(sync.env.UV_INDEX_URL).toBe('https://packages.example.test/simple');
    expect(sync.env.HTTPS_PROXY_HOST).toBe('proxy.example.test:8080');
    expect(sync.env.HTTPS_PROXY_HAS_AUTH).toBe(false);
    expect(sync.env.HTTP_PROXY_HOST).toBe('http-proxy.example.test:8080');
    expect(sync.env.HTTP_PROXY_HAS_AUTH).toBe(false);
    expect(sync.env.UV_PROJECT).toBeUndefined();
    expect(sync.env.UV_PYTHON).toBeUndefined();
    expect(sync.env.UV_FROZEN).toBeUndefined();
    expect(sync.env.UV_LOCKED).toBeUndefined();
    expect(sync.env.UV_NO_SYNC).toBeUndefined();
    expect(sync.env.VIRTUAL_ENV).toBeUndefined();
  });

  it('preserves certificate and authenticated index settings for uv without logging credentials', async () => {
    const fixture = await prepareInstallFixture();
    const username = 'test-index-user';
    const password = 'test-index-password';
    const certificatePath = path.join(fixture.root, 'custom-ca.pem');
    vi.stubEnv('SSL_CERT_FILE', certificatePath);
    vi.stubEnv('UV_INDEX_URL', `https://${username}:${password}@packages.example.test/simple`);

    await installDeepSeekHarness({ uvPath: fixture.uv.path });

    const sync = syncInvocation(readUvInvocations(fixture.uv.logPath));
    expect(sync.env.SSL_CERT_FILE).toBe(certificatePath);
    expect(sync.env.UV_INDEX_URL_HAS_AUTH).toBe(true);
    expect(sync.env.UV_INDEX_URL_HAS_USERNAME).toBe(true);
    expect(sync.env.UV_INDEX_URL_HAS_PASSWORD).toBe(true);
    expect(sync.env.UV_INDEX_URL_HOST).toBe('packages.example.test');
    expect(sync.env.UV_INDEX_URL).toBe('https://packages.example.test/simple');
    const invocationLog = await readFile(fixture.uv.logPath, 'utf8');
    expect(invocationLog).not.toContain(username);
    expect(invocationLog).not.toContain(password);
  });

  it('uses a uv executable found through PATH when uvPath is omitted', async () => {
    const fixture = await prepareInstallFixture();
    const fakeUvBinDir = path.join(fixture.root, 'fake-uv-bin');
    const pathUv = path.join(fakeUvBinDir, 'uv');
    await mkdir(fakeUvBinDir, { recursive: true });
    await copyFile(fixture.uv.path, pathUv);
    await chmod(pathUv, 0o755);
    vi.stubEnv('PATH', `${fakeUvBinDir}${path.delimiter}${process.env.PATH ?? ''}`);

    await installDeepSeekHarness();

    const invocations = readUvInvocations(fixture.uv.logPath);
    expect(invocations.some((invocation) => invocation.args.includes('--version'))).toBe(true);
    expect(invocations.some((invocation) => invocation.args.includes('sync'))).toBe(true);
  });

  it.each([
    ['manifest missing', { manifestPath: 'missing-pyproject.toml' }],
    ['lock missing', { lockPath: 'missing-uv.lock' }],
    ['manifest unreadable', { manifestPath: '.' }],
    ['lock unreadable', { lockPath: '.' }],
  ] as const)('rejects a %s before deleting the existing environment', async (_name, assetOverride) => {
    const fixture = await prepareInstallFixture();
    await writeExistingManagedState(fixture);
    const manifestOverride = 'manifestPath' in assetOverride ? assetOverride.manifestPath : undefined;
    const lockOverride = 'lockPath' in assetOverride ? assetOverride.lockPath : undefined;
    const assetPaths = {
      manifestPath: manifestOverride === undefined
        ? manifestPath
        : path.join(fixture.root, manifestOverride),
      lockPath: lockOverride === undefined
        ? lockPath
        : path.join(fixture.root, lockOverride),
    };

    await expect(installDeepSeekHarness({
      uvPath: fixture.uv.path,
      assetPaths,
    })).rejects.toThrow(/manifest|lock|reinstall/i);

    expect(await readFile(path.join(fixture.environmentDir, 'old-marker'), 'utf8')).toBe('old environment');
    expect(await readFile(path.join(fixture.dshHomeDir, 'profile.json'), 'utf8')).toBe('{"profile":"keep"}');
    expect(readUvInvocations(fixture.uv.logPath)).toEqual([]);
  });

  it.each([
    [
      'missing uv',
      undefined,
      'DeepSeek Harness install requires uv on PATH; install uv and retry.',
    ],
    [
      'uv below the minimum',
      'uv 0.0.1',
      `DeepSeek Harness install requires uv ${DEEPSEEK_HARNESS_MIN_UV_VERSION} or newer; found uv 0.0.1`,
    ],
    [
      'unparseable uv version',
      'not-a-uv-version',
      'DeepSeek Harness install could not parse a supported uv version; install the required uv release and retry.',
    ],
  ] as const)('fails preflight for %s without deleting the existing environment', async (_name, version, expectedMessage) => {
    const fixture = await prepareInstallFixture({}, version === undefined ? {} : { version });
    await writeExistingManagedState(fixture);
    const uvPath = version === undefined ? path.join(fixture.root, 'missing-uv') : fixture.uv.path;

    let failure: unknown;
    try {
      await installDeepSeekHarness({ uvPath });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error('expected managed-environment preflight to fail');
    }
    expect(failure.message).toBe(expectedMessage);
    expect(String(failure)).not.toContain('ENOENT');
    expect(await readFile(path.join(fixture.environmentDir, 'old-marker'), 'utf8')).toBe('old environment');
    expect(await readFile(path.join(fixture.dshHomeDir, 'profile.json'), 'utf8')).toBe('{"profile":"keep"}');
    expect(readUvInvocations(fixture.uv.logPath).some((invocation) => invocation.args.includes('sync'))).toBe(false);
  });

  it.each([
    ['3.11.9', /3\.12|CPython|Python/i],
    ['3.13.0', /3\.12|CPython|Python/i],
  ] as const)('rejects a managed interpreter outside the %s-compatible 3.12 contract after sync', async (pythonVersion, message) => {
    const fixture = await prepareInstallFixture({ pythonVersion });
    await expect(installDeepSeekHarness({ uvPath: fixture.uv.path })).rejects.toThrow(message);
    expect(existsSync(path.join(fixture.environmentDir, 'old-marker'))).toBe(false);
    expect(existsSync(fixture.dshHomeDir)).toBe(true);
  });

  it('accepts different CPython 3.12 patch versions and reports each probed version', async () => {
    for (const pythonVersion of ['3.12.1', '3.12.9']) {
      const fixture = await prepareInstallFixture({ pythonVersion });
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      output.mockClear();
      try {
        await installDeepSeekHarness({ uvPath: fixture.uv.path });
        const renderedOutput = output.mock.calls.flatMap((call) => call.map(String)).join('\n');
        expect(renderedOutput).toContain(`Python ${pythonVersion}`);
      } finally {
        output.mockRestore();
        await closeDeepSeekHarnessProcesses();
        for (const root of testRoots.splice(0)) {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  });

  it('uses the probed Python micro version when evaluating Requires-Python', async () => {
    const accepted = await prepareInstallFixture({
      pythonVersion: '3.12.9',
      requiresPython: '>=3.12.1,<3.13',
    });
    await installDeepSeekHarness({ uvPath: accepted.uv.path });
    expect(existsSync(path.join(accepted.environmentDir, 'bin', 'python'))).toBe(true);
    await closeDeepSeekHarnessProcesses();
    for (const root of testRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }

    const rejected = await prepareInstallFixture({
      pythonVersion: '3.12.8',
      requiresPython: '>=3.12.9,<3.13',
    });
    await expect(installDeepSeekHarness({ uvPath: rejected.uv.path }))
      .rejects.toThrow(/Requires-Python|Python|compatible/i);
    expect(existsSync(path.join(rejected.environmentDir, 'bin', 'python'))).toBe(true);
  });

  it.each([
    ['SDK version mismatch', { sdkVersion: '999.0.0' }, /SDK|version/i],
    ['runtime version mismatch', { runtimeVersion: '999.0.0' }, /runtime|version/i],
    ['SDK Requires-Python mismatch', { requiresPython: '>=3.13,<3.14' }, /Requires-Python|Python|compatible/i],
    ['constructor incompatibility', { constructorCompatible: false }, /constructor|signature|compatible/i],
    ['non-CPython implementation', { implementation: 'pypy' }, /CPython|Python|implementation/i],
  ] as const)('rejects %s during the post-sync probe', async (_name, runtimeOptions, message) => {
    const fixture = await prepareInstallFixture(runtimeOptions);
    await expect(installDeepSeekHarness({ uvPath: fixture.uv.path })).rejects.toThrow(message);
    expect(existsSync(path.join(fixture.environmentDir, 'old-marker'))).toBe(false);
    expect(existsSync(fixture.dshHomeDir)).toBe(true);
  });

  it('redacts index credentials from a uv failure diagnostic', async () => {
    const fixture = await prepareInstallFixture({}, { failSync: true });
    const secret = 'uv-index-secret-123';
    vi.stubEnv('UV_INDEX_URL', `https://user:${secret}@packages.example.test/simple`);

    let failure: unknown;
    try {
      await installDeepSeekHarness({ uvPath: fixture.uv.path });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/lock|sync|package/i);
    expect(String(failure)).not.toContain(secret);
  });

  it('redacts API key, base URL, proxy, and index credentials from uv diagnostics', async () => {
    const apiKey = 'managed-api-secret-123';
    const baseUrl = 'https://deepseek.example/v1';
    const proxy = 'http://proxy-user:managed-proxy-secret-456@proxy.example.test:8080';
    const indexUrl = 'https://index-user:managed-index-secret-789@packages.example.test/simple';
    const fixture = await prepareInstallFixture({}, {
      failSync: true,
      failureMessage: `uv sync failed: api=${apiKey} base=${baseUrl} proxy=${proxy}`,
    });
    vi.stubEnv('DEEPSEEK_API_KEY', apiKey);
    vi.stubEnv('DEEPSEEK_BASE_URL', baseUrl);
    vi.stubEnv('HTTPS_PROXY', proxy);
    vi.stubEnv('UV_INDEX_URL', indexUrl);

    let failure: unknown;
    try {
      await installDeepSeekHarness({ uvPath: fixture.uv.path });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = String(failure);
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(baseUrl);
    expect(message).not.toContain(proxy);
    expect(message).not.toContain(indexUrl);
    const sync = syncInvocation(readUvInvocations(fixture.uv.logPath));
    expect(sync.env.HTTPS_PROXY_HOST).toBe('proxy.example.test:8080');
    expect(sync.env.HTTPS_PROXY_HAS_AUTH).toBe(true);
    const invocationLog = await readFile(fixture.uv.logPath, 'utf8');
    expect(invocationLog).not.toContain('proxy-user');
    expect(invocationLog).not.toContain('managed-proxy-secret-456');
  });

  it('classifies a network authentication failure separately from a packaged-asset mismatch', async () => {
    const fixture = await prepareInstallFixture({}, {
      failSync: true,
      failureMessage: 'uv sync failed: network authentication failed',
    });

    await expect(installDeepSeekHarness({ uvPath: fixture.uv.path }))
      .rejects.toThrow(/uv sync failed|network|authentication/i);
    await expect(installDeepSeekHarness({ uvPath: fixture.uv.path }))
      .rejects.not.toThrow(/packaged? assets|reinstall TAKT/i);
  });

  it('classifies a lock mismatch as a packaged managed-project error', async () => {
    const fixture = await prepareInstallFixture({}, {
      failSync: true,
      failureMessage: 'uv sync failed: lockfile does not match pyproject.toml',
    });

    await expect(installDeepSeekHarness({ uvPath: fixture.uv.path }))
      .rejects.toThrow(/packag(?:e|ing)|reinstall TAKT/i);
  });

  it('leaves an incomplete environment after sync failure and succeeds on the next install', async () => {
    const fixture = await prepareInstallFixture({}, { failOnce: true });
    await writeExistingManagedState(fixture);

    await expect(installDeepSeekHarness({ uvPath: fixture.uv.path })).rejects.toThrow(/lock|sync/i);
    expect(existsSync(path.join(fixture.environmentDir, 'old-marker'))).toBe(false);
    expect(existsSync(path.join(fixture.environmentDir, 'bin', 'python'))).toBe(false);
    expect(await readFile(path.join(fixture.dshHomeDir, 'profile.json'), 'utf8')).toBe('{"profile":"keep"}');

    vi.stubEnv('FAKE_UV_FAIL_ONCE', '0');
    await installDeepSeekHarness({ uvPath: fixture.uv.path });
    expect(existsSync(path.join(fixture.environmentDir, 'bin', 'python'))).toBe(true);
    expect(readUvInvocations(fixture.uv.logPath).filter((invocation) => invocation.args.includes('sync'))).toHaveLength(2);
  });

  it('releases the install lock after a probe failure so the next install can retry', async () => {
    const fixture = await prepareInstallFixture({ failProbeOnce: true });

    await expect(installDeepSeekHarness({ uvPath: fixture.uv.path }))
      .rejects.toThrow(/probe/i);
    await installDeepSeekHarness({ uvPath: fixture.uv.path });

    expect(readUvInvocations(fixture.uv.logPath).filter((invocation) => invocation.args.includes('sync')))
      .toHaveLength(2);
  });

  it('holds the managed install lock through concurrent sync and post-sync validation', async () => {
    const fixture = await prepareInstallFixture({ holdProbe: true });
    const first = installDeepSeekHarness({ uvPath: fixture.uv.path });
    await vi.waitFor(() => {
      expect(readFileSync(fixture.runtime.probeStartedMarker, 'utf8')).toMatch(/\d+\n/u);
    });
    const second = installDeepSeekHarness({ uvPath: fixture.uv.path });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readUvInvocations(fixture.uv.logPath).filter((invocation) => invocation.args.includes('sync')))
      .toHaveLength(1);

    await writeFile(fixture.runtime.probeReleasePath, 'release');
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(readFileSync(fixture.runtime.probeStartedMarker, 'utf8')).toMatch(/\d+\n\d+\n/u);
    expect(readUvInvocations(fixture.uv.logPath).filter((invocation) => invocation.args.includes('sync')))
      .toHaveLength(2);
  });

  it('serializes concurrent managed installs across processes with the install lock', async () => {
    const fixture = await prepareInstallFixture({}, { holdVersion: true, holdSync: true });
    await writeExistingManagedState(fixture);
    const startPath = path.join(fixture.root, 'start-install');
    const syncEventsPath = path.join(fixture.root, 'sync-events.log');
    const first = startInstallProcess(
      fixture.uv.path,
      path.join(fixture.root, 'first-ready'),
      startPath,
    );
    const second = startInstallProcess(
      fixture.uv.path,
      path.join(fixture.root, 'second-ready'),
      startPath,
    );

    try {
      await vi.waitFor(() => {
        expect(existsSync(path.join(fixture.root, 'first-ready'))).toBe(true);
        expect(existsSync(path.join(fixture.root, 'second-ready'))).toBe(true);
      });
      await writeFile(startPath, 'start');
      await vi.waitFor(() => {
        expect(existsSync(fixture.uv.versionStartedPath)).toBe(true);
        expect(readUvInvocations(fixture.uv.logPath)
          .filter((invocation) => invocation.args.length === 1 && invocation.args[0] === '--version'))
          .toHaveLength(1);
      });
      expect(existsSync(path.join(fixture.environmentDir, 'old-marker'))).toBe(true);
      expect(existsSync(path.join(fixture.managedRoot, 'pyproject.toml'))).toBe(false);
      expect(existsSync(path.join(fixture.managedRoot, 'uv.lock'))).toBe(false);
      expect(readUvInvocations(fixture.uv.logPath)
        .filter((invocation) => invocation.args.includes('sync'))).toHaveLength(0);

      await writeFile(fixture.uv.versionReleasePath, 'release');
      await vi.waitFor(() => {
        expect(readFileSync(syncEventsPath, 'utf8')).toBe('start\n');
        expect(readUvInvocations(fixture.uv.logPath)
          .filter((invocation) => invocation.args.includes('sync'))).toHaveLength(1);
      });
      await writeFile(fixture.uv.releasePath, 'release');
      const results = await Promise.all([first.result, second.result]);
      expect(results.map((result) => result.code)).toEqual([0, 0]);
      expect(readUvInvocations(fixture.uv.logPath)
        .filter((invocation) => invocation.args.includes('sync'))).toHaveLength(2);
      expect(readFileSync(syncEventsPath, 'utf8')).toBe('start\nend\nstart\nend\n');
    } finally {
      await writeFile(fixture.uv.versionReleasePath, 'release').catch(() => undefined);
      await writeFile(fixture.uv.releasePath, 'release').catch(() => undefined);
      for (const childProcess of [first.child, second.child]) {
        if (childProcess.exitCode === null) {
          childProcess.kill();
        }
      }
      await Promise.allSettled([first.result, second.result]);
    }
  }, 30_000);
});

describe.skipIf(!fakePythonAvailable)('DeepSeek Harness managed provider startup', () => {
  afterEach(async () => {
    await closeDeepSeekHarnessProcesses();
    vi.unstubAllEnvs();
    for (const root of testRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function prepareProviderFixture(runtimeOptions: FakeRuntimeOptions = {}): Promise<Workspace & {
    runtime: FakeRuntime;
    runtimePythonPath: string;
    bridgeStartedMarker: string;
    uvLogPath: string;
  }> {
    const fixture = await createWorkspace();
    const runtime = await createFakeRuntime(fixture, runtimeOptions);
    await copyFile(manifestPath, path.join(fixture.managedRoot, 'pyproject.toml'));
    await copyFile(lockPath, path.join(fixture.managedRoot, 'uv.lock'));
    const runtimePythonPath = path.join(fixture.environmentDir, 'bin', 'python');
    await mkdir(path.dirname(runtimePythonPath), { recursive: true });
    await copyFile(runtime.pythonShimSource, runtimePythonPath);
    await chmod(runtimePythonPath, 0o755);
    const fakeUvBin = path.join(fixture.root, 'fake-uv-bin');
    await mkdir(fakeUvBin);
    const uvLogPath = path.join(fixture.root, 'unexpected-uv.log');
    const fakeUvPath = path.join(fakeUvBin, 'uv');
    await writeFile(fakeUvPath, `#!/bin/sh\nprintf 'called\\n' >> ${shellQuote(uvLogPath)}\nexit 91\n`, 'utf8');
    await chmod(fakeUvPath, 0o755);
    const inheritedPath = process.env.PATH;
    vi.stubEnv('PATH', inheritedPath === undefined
      ? fakeUvBin
      : `${fakeUvBin}${path.delimiter}${inheritedPath}`);
    vi.stubEnv('TAKT_CONFIG_DIR', fixture.globalDir);
    return {
      ...fixture,
      runtime,
      runtimePythonPath,
      bridgeStartedMarker: runtime.bridgeStartedMarker,
      uvLogPath,
    };
  }

  it('uses the managed interpreter by absolute path with an empty child PATH', async () => {
    const fixture = await prepareProviderFixture();
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: fixture.projectDir,
      model: DEEPSEEK_HARNESS_DEFAULT_MODEL_FOR_TEST,
      childProcessEnv: { PATH: '' },
    });

    expect(response).toMatchObject({ status: 'done', content: 'managed response' });
    expect(existsSync(fixture.bridgeStartedMarker)).toBe(true);
    const [startup] = (await readFile(fixture.bridgeStartedMarker, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { dshHome?: string; path?: string });
    expect(startup?.dshHome).toBe(path.resolve(fixture.dshHomeDir));
    expect(startup?.path).toBe('');
    const invocations = await readFile(fixture.runtime.pythonInvocationLog, 'utf8');
    expect(invocations).toMatch(/-u .*bridge\.py/u);
    expect(existsSync(fixture.uvLogPath)).toBe(false);
  });

  it.each([
    ['managed environment', 'environment', /managed environment.*missing/iu],
    ['managed interpreter', 'interpreter', /managed interpreter.*missing/iu],
    ['managed dsh-home', 'dsh-home', /managed dsh-home.*missing/iu],
  ] as const)('reports a missing %s without starting the bridge or repairing it', async (_name, missingPath, expectedMessage) => {
    const fixture = await prepareProviderFixture();
    if (missingPath === 'environment') {
      await rm(fixture.environmentDir, { recursive: true, force: true });
    } else if (missingPath === 'interpreter') {
      await rm(fixture.runtimePythonPath, { force: true });
    } else {
      await rm(fixture.dshHomeDir, { recursive: true, force: true });
    }

    const before = await snapshotManagedState({
      managedRoot: fixture.managedRoot,
      environmentDir: fixture.environmentDir,
      pythonPath: fixture.runtimePythonPath,
      dshHomeDir: fixture.dshHomeDir,
    });
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: fixture.projectDir,
      childProcessEnv: { PATH: '' },
    });

    expect(response).toMatchObject({ status: 'error', failureCategory: 'provider_error' });
    expect(response.content).toMatch(expectedMessage);
    expectCanonicalInstallGuidance(response.content);
    expect(await snapshotManagedState({
      managedRoot: fixture.managedRoot,
      environmentDir: fixture.environmentDir,
      pythonPath: fixture.runtimePythonPath,
      dshHomeDir: fixture.dshHomeDir,
    })).toEqual(before);
    expect(existsSync(fixture.bridgeStartedMarker)).toBe(false);
    expect(existsSync(fixture.uvLogPath)).toBe(false);
  });

  it.each([
    ['managed environment', 'environment', /managed environment must be a directory/iu],
    ['managed interpreter', 'interpreter', /managed interpreter must be a regular file/iu],
    ['managed dsh-home', 'dsh-home', /managed dsh-home must be a directory/iu],
  ] as const)('rejects a wrong filesystem type for %s before probing or bridging', async (_name, wrongPath, expectedMessage) => {
    const fixture = await prepareProviderFixture();
    if (wrongPath === 'environment') {
      await rm(fixture.environmentDir, { recursive: true, force: true });
      await writeFile(fixture.environmentDir, 'not a directory', 'utf8');
    } else if (wrongPath === 'interpreter') {
      await rm(fixture.runtimePythonPath, { force: true });
      await mkdir(fixture.runtimePythonPath);
    } else {
      await rm(fixture.dshHomeDir, { recursive: true, force: true });
      await writeFile(fixture.dshHomeDir, 'not a directory', 'utf8');
    }
    const before = await snapshotManagedState({
      managedRoot: fixture.managedRoot,
      environmentDir: fixture.environmentDir,
      pythonPath: fixture.runtimePythonPath,
      dshHomeDir: fixture.dshHomeDir,
    });

    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: fixture.projectDir,
      childProcessEnv: { PATH: '' },
    });

    expect(response).toMatchObject({ status: 'error', failureCategory: 'provider_error' });
    expect(response.content).toMatch(expectedMessage);
    expectCanonicalInstallGuidance(response.content);
    expect(await snapshotManagedState({
      managedRoot: fixture.managedRoot,
      environmentDir: fixture.environmentDir,
      pythonPath: fixture.runtimePythonPath,
      dshHomeDir: fixture.dshHomeDir,
    })).toEqual(before);
    expect(existsSync(fixture.bridgeStartedMarker)).toBe(false);
    expect(existsSync(fixture.uvLogPath)).toBe(false);
  });

  it.each([
    ['SDK version mismatch', { sdkVersion: '999.0.0' }, /managed DeepSeek Harness SDK version .* does not match/iu],
    ['runtime version mismatch', { runtimeVersion: '999.0.0' }, /managed DeepSeek Harness runtime version .* does not match/iu],
    ['SDK Requires-Python mismatch', { requiresPython: '>=3.13,<3.14' }, /SDK Requires-Python .* does not allow CPython 3\.12/iu],
    ['Python version mismatch', { pythonVersion: '3.13.0' }, /managed interpreter must be CPython 3\.12.*found/iu],
    ['constructor incompatibility', { constructorCompatible: false }, /constructor signature is incompatible/iu],
    ['broken interpreter', undefined, /managed interpreter probe exited with status 17/iu],
  ] as const)('returns a cause-specific startup error for %s without starting the bridge', async (name, runtimeOptions, message) => {
    const fixture = await prepareProviderFixture(runtimeOptions ?? {});
    if (name === 'broken interpreter') {
      await writeFile(fixture.runtimePythonPath, '#!/bin/sh\nexit 17\n', 'utf8');
      await chmod(fixture.runtimePythonPath, 0o755);
    }
    const before = await snapshotManagedState({
      managedRoot: fixture.managedRoot,
      environmentDir: fixture.environmentDir,
      pythonPath: fixture.runtimePythonPath,
      dshHomeDir: fixture.dshHomeDir,
    });
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: fixture.projectDir,
      childProcessEnv: { PATH: '' },
    });

    expect(response).toMatchObject({ status: 'error', failureCategory: 'provider_error' });
    expect(response.content).toMatch(message);
    expectCanonicalInstallGuidance(response.content);
    expect(await snapshotManagedState({
      managedRoot: fixture.managedRoot,
      environmentDir: fixture.environmentDir,
      pythonPath: fixture.runtimePythonPath,
      dshHomeDir: fixture.dshHomeDir,
    })).toEqual(before);
    expect(existsSync(fixture.bridgeStartedMarker)).toBe(false);
    expect(existsSync(fixture.uvLogPath)).toBe(false);
  });

  it('preserves safe text and thinking event types with response redaction enabled', async () => {
    const fixture = await prepareProviderFixture();
    vi.stubEnv('DEEPSEEK_API_KEY', 'normal-stream-secret');
    const events: StreamEvent[] = [];

    const response = await callDeepSeekHarness('worker', 'normal-stream', {
      cwd: fixture.projectDir,
      model: DEEPSEEK_HARNESS_DEFAULT_MODEL_FOR_TEST,
      childProcessEnv: { PATH: '' },
      onStream: (event) => events.push(event),
    });

    expect(response).toMatchObject({ status: 'done', content: 'managed response' });
    expect(events).toContainEqual({ type: 'thinking', data: { thinking: 'safe thinking' } });
    expect(events).toContainEqual({ type: 'text', data: { text: 'safe response' } });
  });

  it.each(['cross-event', 'cross-final'] as const)('redacts API keys across %s stream boundaries and the provider event log', async (streamMode) => {
    const fixture = await prepareProviderFixture();
    const secret = `managed-cross-event-secret-${streamMode}`;
    const split = Math.floor(secret.length / 2);
    vi.stubEnv('DEEPSEEK_API_KEY', secret);
    const logsDir = path.join(fixture.root, 'provider-events');
    await mkdir(logsDir);
    const logger = createProviderEventLogger({
      logsDir,
      sessionId: `${streamMode}-session`,
      runId: `${streamMode}-run`,
      enabled: true,
    });
    const events: StreamEvent[] = [];
    const onStream = (event: StreamEvent): void => {
      events.push(event);
      logger.logEvent({
        provider: 'deepseek-harness',
        providerModel: DEEPSEEK_HARNESS_DEFAULT_MODEL_FOR_TEST,
        step: 'redaction-test',
      }, event);
    };

    const response = await callDeepSeekHarness('worker', streamMode, {
      cwd: fixture.projectDir,
      model: DEEPSEEK_HARNESS_DEFAULT_MODEL_FOR_TEST,
      childProcessEnv: { PATH: '' },
      onStream,
    });

    const serializedEvents = JSON.stringify(events);
    const serializedLog = await readFile(logger.filepath, 'utf8');
    for (const observed of [secret, secret.slice(0, split), secret.slice(split)]) {
      expect(response.content).not.toContain(observed);
      expect(serializedEvents).not.toContain(observed);
      expect(serializedLog).not.toContain(observed);
    }
    expect(serializedEvents).toContain('[REDACTED]');
    expect(serializedLog).toContain('[REDACTED]');
  });
});

const DEEPSEEK_HARNESS_DEFAULT_MODEL_FOR_TEST = 'deepseek-v4-flash';
