import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeepSeekHarnessInstallRequiredError,
  getDeepSeekHarnessManagedPackagePaths,
  getReadyDeepSeekHarnessPackageDirectory,
  installDeepSeekHarness,
  loadManagedDeepSeekHarnessModules,
} from '../infra/deepseek-harness/managed-package.js';
import { callDeepSeekHarness } from '../infra/deepseek-harness/index.js';
import { isSupportedDeepSeekHarnessPlatform } from '../infra/deepseek-harness/platform.js';
import { createConversationSession } from '../features/interactive/conversationSession.js';
import { makeProvider, makeSessionContext } from './test-helpers.js';
import { selectAndExecuteTask } from '../features/tasks/execute/selectAndExecute.js';
import { getProvider } from '../infra/providers/index.js';
import * as ui from '../shared/ui/index.js';
import { executePipeline } from '../features/pipeline/index.js';
import * as managedProcess from '../shared/utils/spawn.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import { TaskRunner } from '../infra/task/index.js';
import * as taskInfrastructure from '../infra/task/index.js';
import { saveTaskFile, saveTaskFromInteractive } from '../features/tasks/add/index.js';
import { runAllTasks } from '../features/tasks/execute/runAllTasks.js';
import { watchTasks } from '../features/tasks/watch/index.js';
import * as lineEditor from '../features/interactive/lineEditor.js';
import { runConversationLoop } from '../features/interactive/conversationLoop.js';
import { createTuiConversation } from '../features/tui/tuiConversation.js';
import { inspectManagedProvider, managedModulePath } from '../infra/managed-providers/package.js';
import { loadManagedSdk } from '../infra/managed-providers/loader.js';
import { MANAGED_MODULES } from '../infra/managed-providers/definitions.js';
import { persistFailedTaskRetry } from '../features/tasks/taskRetryPersistence.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import { createSessionImageAttachmentStore } from '../features/interactive/imageAttachments.js';

const { mockConfirm, mockSdkInvocation, afterReadlink } = vi.hoisted(() => ({
  mockConfirm: vi.fn().mockResolvedValue(false),
  afterReadlink: vi.fn<(path: unknown, target: unknown) => Promise<void>>().mockResolvedValue(undefined),
  mockSdkInvocation: vi.fn(() => { throw new Error('A development SDK was used without a managed installation'); }),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readlink: async (...args: Parameters<typeof actual.readlink>) => {
      const target = await actual.readlink(...args);
      await afterReadlink(args[0], target);
      return target;
    },
  };
});
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: mockSdkInvocation,
}));
vi.mock('@openai/codex-sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@openai/codex-sdk')>();
  return {
    ...sdk,
    Codex: class extends sdk.Codex {
      constructor(...options: ConstructorParameters<typeof sdk.Codex>) {
        super(...options);
        mockSdkInvocation();
      }
    },
  };
});
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  createAgentSession: mockSdkInvocation,
}));
vi.mock('@opencode-ai/sdk/v2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opencode-ai/sdk/v2')>()),
  createOpencodeClient: mockSdkInvocation,
}));
vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  confirm: mockConfirm,
}));

const supported = isSupportedDeepSeekHarnessPlatform(process.platform, process.arch);
const manifestSource = new URL('../../managed/deepseek-harness/package.json', import.meta.url);
const lockSource = new URL('../../managed/deepseek-harness/package-lock.json', import.meta.url);
const cliSource = fileURLToPath(new URL('../app/cli/index.ts', import.meta.url));
const installerSource = new URL('../infra/deepseek-harness/managed-package.ts', import.meta.url);

let temporaryRoot: string;
let fakeNpmPath: string;
const nodeExecutable = process.execPath;
const terminalDescriptors = [process.stdin, process.stdout].map((stream) => ({
  stream, descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY'),
}));

beforeEach(async () => {
  mockConfirm.mockReset().mockResolvedValue(false);
  afterReadlink.mockReset().mockResolvedValue(undefined);
  mockSdkInvocation.mockClear();
  temporaryRoot = await mkdtemp(join(process.cwd(), '.deepseek-managed-test-'));
  vi.stubEnv('TAKT_CONFIG_DIR', join(temporaryRoot, 'config'));
  vi.stubEnv('DSH_HOME', join(temporaryRoot, 'credential-source'));
  fakeNpmPath = join(temporaryRoot, 'fake-npm.cjs');
  await writeFile(fakeNpmPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.env.TAKT_TEST_NPM_LOG) fs.appendFileSync(process.env.TAKT_TEST_NPM_LOG,
  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), dependencies: JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies }) + '\\n');
if (process.env.TAKT_TEST_NPM_FAIL === '1') process.exit(9);
if (process.env.TAKT_TEST_NPM_GATE) {
  fs.writeFileSync(process.env.TAKT_TEST_NPM_STARTED, 'started');
  while (!fs.existsSync(process.env.TAKT_TEST_NPM_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (process.env.TAKT_TEST_NPM_SIGNAL_FILE) {
  process.on('SIGTERM', () => fs.writeFileSync(process.env.TAKT_TEST_NPM_SIGNAL_FILE, 'received'));
}
if (process.env.TAKT_TEST_NPM_PID_FILE) fs.writeFileSync(process.env.TAKT_TEST_NPM_PID_FILE, String(process.pid));
if (process.env.TAKT_TEST_NPM_HANG === '1') setInterval(() => {}, 1000);
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!manifest.dependencies['@deepseek-ai/dsh']) {
  const sourceRoot = process.env.TAKT_TEST_PACKAGE_SOURCE;
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  for (const relative of Object.keys(lock.packages)) {
    if (!relative.startsWith('node_modules/')) continue;
    const source = path.join(sourceRoot, relative);
    if (!fs.existsSync(source)) continue;
    const destination = path.resolve(relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, dereference: true });
  }
  if (process.env.TAKT_TEST_CODEX_BINARY) {
    function replaceCodex(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) replaceCodex(target);
        else if (entry.name === 'codex') {
          fs.copyFileSync(process.env.TAKT_TEST_CODEX_BINARY, target);
          fs.chmodSync(target, 0o755);
        }
      }
    }
    replaceCodex(path.resolve('node_modules/@openai'));
  }
  if (process.env.TAKT_TEST_CLAUDE_BINARY) {
    for (const name of fs.readdirSync('node_modules/@anthropic-ai')) {
      const binary = path.join('node_modules/@anthropic-ai', name, process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (fs.existsSync(binary)) {
        fs.copyFileSync(process.env.TAKT_TEST_CLAUDE_BINARY, binary);
        fs.chmodSync(binary, 0o755);
      }
    }
  }
  if (process.env.TAKT_TEST_MISSING_PACKAGE) {
    fs.rmSync(path.join('node_modules', process.env.TAKT_TEST_MISSING_PACKAGE), { recursive: true, force: true });
  }
  if (process.env.TAKT_TEST_MISSING_BINARY === '1') {
    function removeBinaries(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) removeBinaries(target);
        else if (['codex', 'codex.exe', 'claude', 'claude.exe'].includes(entry.name)) fs.rmSync(target);
      }
    }
    removeBinaries(path.resolve('node_modules'));
  }
  process.exit(0);
}
for (const [name, version] of Object.entries(manifest.dependencies)) {
  const directory = path.join('node_modules', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name, version, type: 'module',
    exports: { '.': './index.js', './package.json': './package.json', './lib/*': './lib/*' },
    ...(name === '@deepseek-ai/dsh' ? { bin: { dsh: 'lib/bin.js' } } : {}),
  }));
  fs.writeFileSync(path.join(directory, 'index.js'),
    name === '@deepseek-ai/dsh-sdk-client' ? (process.env.TAKT_TEST_NPM_MISSING_EXPORT === '1'
      ? 'export const ready = true;\\n' : 'export class DeepSeekHarness {}\\n')
      : name === '@deepseek-ai/dsh-llm' ? 'export const ReasoningEffortId = (value) => value;\\n'
        : 'export const ready = true;\\n');
  if (name === '@deepseek-ai/dsh-sdk-client' && process.env.TAKT_TEST_DSH_ERROR) {
    fs.writeFileSync(path.join(directory, 'index.js'),
      'export class RequestTimeoutError extends Error {}\\n' +
      'export class JsonRpcResponseError extends Error {}\\n' +
      'export class SdkProtocolError extends Error {}\\n' +
      'export class TransportClosedError extends Error {}\\n' +
      'import { appendFileSync } from "node:fs";\\n' +
      'export class DeepSeekHarness { async start() {} async close() {} async run(_prompt, options) {\\n' +
      'if (process.env.TAKT_TEST_DSH_CALL_LOG) appendFileSync(process.env.TAKT_TEST_DSH_CALL_LOG, import.meta.url + "\\\\n");\\n' +
      'if (process.env.TAKT_TEST_DSH_FIRST_SUCCESS === "1" && !this.used) { this.used = true;\\n' +
      'options?.onNotification?.({ method: "session.event", params: { sessionId: "managed-session", event: { type: "turn/end", data: { reason: { kind: "completed" } } } } });\\n' +
      'return { sessionId: "managed-session", finalResponse: "First response", finishReason: "completed" }; }\\n' +
      'throw new RequestTimeoutError("fixture request timed out"); } }\\n');
  }
  if (name === '@deepseek-ai/dsh') {
    fs.mkdirSync(path.join(directory, 'lib'));
    fs.writeFileSync(path.join(directory, 'lib', 'bin.js'), 'export const ready = true;\\n');
  }
}
const fflate = path.join('node_modules', 'fflate');
fs.mkdirSync(fflate, { recursive: true });
fs.writeFileSync(path.join(fflate, 'package.json'), JSON.stringify({name: 'fflate', version: '0.8.3', exports: { './package.json': './package.json' }}));
const koffi = path.join('node_modules', 'koffi');
fs.mkdirSync(koffi, { recursive: true });
fs.writeFileSync(path.join(koffi, 'package.json'), JSON.stringify({name: 'koffi', version: '3.1.1', main: 'index.cjs'}));
fs.writeFileSync(path.join(koffi, 'index.cjs'), 'module.exports = { load() { return { func() { return () => process.pid; } }; } };\\n');
const protobuf = path.join('node_modules', 'protobufjs');
fs.mkdirSync(protobuf, { recursive: true });
fs.writeFileSync(path.join(protobuf, 'package.json'), JSON.stringify({ name: 'protobufjs', version: '1.0.0', main: 'index.cjs' }));
fs.writeFileSync(path.join(protobuf, 'index.cjs'), 'module.exports = {};\\n');
const pty = path.join('node_modules', 'node-pty');
const nativeDir = path.join(pty, 'prebuilds', process.platform + '-' + process.arch);
fs.mkdirSync(path.join(pty, 'lib'), { recursive: true });
fs.mkdirSync(nativeDir, { recursive: true });
fs.writeFileSync(path.join(pty, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.0.0', main: 'lib/index.js' }));
fs.writeFileSync(path.join(pty, 'lib', 'index.js'), 'exports.spawn = () => {};\\n');
fs.writeFileSync(path.join(pty, 'lib', 'utils.js'),
  'const fs = require("node:fs"); const path = require("node:path");\\n' +
  'exports.loadNativeModule = () => {\\n' +
  '  const dir = "../prebuilds/" + process.platform + "-" + process.arch;\\n' +
  '  if (!fs.existsSync(path.resolve(__dirname, dir, "pty.node"))) throw new Error("pty.node missing");\\n' +
  '  return { dir };\\n' +
  '};\\n');
fs.writeFileSync(path.join(nativeDir, 'pty.node'), 'native fixture');
if (process.platform === 'darwin') {
  fs.writeFileSync(path.join(nativeDir, 'spawn-helper'), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
}
`);
  await chmod(fakeNpmPath, 0o755);
  vi.stubEnv('TAKT_TEST_PACKAGE_SOURCE', process.cwd());
});

afterEach(async () => {
  process.execPath = nodeExecutable;
  vi.restoreAllMocks();
  for (const { stream, descriptor } of terminalDescriptors) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
  vi.unstubAllEnvs();
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function waitForFile(path: string, child?: ReturnType<typeof spawn>, getError?: () => string): Promise<string> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Child exited before writing ${path}: ${getError?.() ?? ''}`);
      }
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function makeOldDeepSeekInstallation(): Promise<string> {
  await installDeepSeekHarness({ npmPath: fakeNpmPath });
  const directory = await getReadyDeepSeekHarnessPackageDirectory();
  const manifestPath = join(directory, 'package.json');
  const lockPath = join(directory, 'package-lock.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies: Record<string, string> };
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
    packages: Record<string, { version?: string; dependencies?: Record<string, string>; resolved?: string; integrity?: string }>;
  };
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh-llm']) {
    manifest.dependencies[name] = '0.2.0-rc.1';
    for (const record of Object.values(lock.packages)) {
      if (record.dependencies?.[name] !== undefined) record.dependencies[name] = '0.2.0-rc.1';
    }
    lock.packages[`node_modules/${name}`]!.version = '0.2.0-rc.1';
    delete lock.packages[`node_modules/${name}`]!.resolved;
    delete lock.packages[`node_modules/${name}`]!.integrity;
    const packagePath = join(directory, 'node_modules', name, 'package.json');
    const installed = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
    await writeFile(packagePath, JSON.stringify({ ...installed, version: '0.2.0-rc.1' }));
  }
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  const lockBytes = `${JSON.stringify(lock)}\n`;
  await writeFile(manifestPath, manifestBytes);
  await writeFile(lockPath, lockBytes);
  const markerPath = join(directory, '.ready.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
  await writeFile(markerPath, JSON.stringify({
    ...marker,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    lockSha256: createHash('sha256').update(lockBytes).digest('hex'),
  }));
  return directory;
}

async function runManagedCli(args: string[], platform?: 'win32'): Promise<{ code: number | null; output: string }> {
  if (args[0] === 'update') {
    const help = await runManagedCli(['--help'], platform);
    if (!/^\s+update(?:\s|\[)/mu.test(help.output)) throw new Error('takt update is not registered');
  }
  const npmExecutable = join(temporaryRoot, 'npm');
  await writeFile(npmExecutable, '#!/bin/sh\nexec node "$TAKT_TEST_FAKE_NPM_SCRIPT" "$@"\n');
  await chmod(npmExecutable, 0o755);
  const nodePath = join(temporaryRoot, 'node-without-npm', 'bin', platform === 'win32' ? 'node.exe' : 'node');
  await mkdir(dirname(nodePath), { recursive: true });
  try {
    await symlink(process.execPath, nodePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (platform === 'win32') {
    const npmCli = join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await mkdir(dirname(npmCli), { recursive: true });
    await writeFile(npmCli, `require(${JSON.stringify(fakeNpmPath)});\n`);
  }
  const preload = join(temporaryRoot, 'no-bundled-npm.cjs');
  await writeFile(preload, `process.execPath = ${JSON.stringify(nodePath)};\n${platform === undefined ? ''
    : `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });\n`}`);
  const child = spawn(process.execPath, ['--require', preload, '--import', 'tsx', cliSource, ...args], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      NO_UPDATE_NOTIFIER: '1',
      PATH: `${temporaryRoot}${delimiter}${process.env.PATH ?? ''}`,
      TAKT_TEST_FAKE_NPM_SCRIPT: fakeNpmPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    return { code, output };
  } finally {
    clearTimeout(timer);
  }
}

async function prepareTerminalManagedTask() {
  for (const { stream } of terminalDescriptors) Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  vi.stubEnv('TAKT_NO_TTY', '0');
  vi.stubEnv('CI', '');
  const personas = join(temporaryRoot, '.takt', 'personas');
  await mkdir(personas, { recursive: true });
  await writeFile(join(personas, 'worker.md'), 'Execute the task.');
  const workflowPath = join(temporaryRoot, 'workflow.yaml');
  await writeFile(workflowPath, `name: install-first
initial_step: execute
max_steps: 2
steps:
  - name: execute
    persona: ./.takt/personas/worker.md
    instruction: "{task}"
    rules:
      - condition: done
        next: COMPLETE
`);
  const providerCall = vi.fn().mockResolvedValue({
    persona: 'worker', status: 'done', content: '[EXECUTE:1]\nCompleted.', timestamp: new Date(),
  });
  vi.spyOn(getProvider('deepseek-harness'), 'setup').mockReturnValue({ call: providerCall });
  const warning = vi.spyOn(ui, 'warn');
  const engineEvents = vi.spyOn(WorkflowEngine.prototype, 'emit');
  return {
    providerCall,
    warning,
    stepStarts: () => engineEvents.mock.calls.filter(([name]) => name === 'step:start').length,
    workflowPath,
    run: () => selectAndExecuteTask(temporaryRoot, 'Installation before execution', {
      workflow: workflowPath, skipTaskList: true, failureMode: 'return',
    }, { provider: 'deepseek-harness' }),
  };
}

async function useFakeNpmForCurrentProcess(): Promise<void> {
  const nodePath = join(temporaryRoot, 'node-without-npm', 'bin', 'node');
  await mkdir(dirname(nodePath), { recursive: true });
  if (!existsSync(nodePath)) await symlink(nodeExecutable, nodePath);
  else expect(realpathSync(nodePath)).toBe(realpathSync(nodeExecutable));
  await writeFile(join(temporaryRoot, 'npm'), '#!/bin/sh\nexec node "$TAKT_TEST_FAKE_NPM_SCRIPT" "$@"\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${temporaryRoot}${delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('TAKT_TEST_FAKE_NPM_SCRIPT', fakeNpmPath);
  process.execPath = nodePath;
}

function interruptNewHandlers(previous: ReturnType<typeof process.rawListeners>): void {
  const handlers = process.rawListeners('SIGINT').filter((handler) => !previous.includes(handler));
  expect(handlers).toHaveLength(1);
  handlers[0]!.call(process, 'SIGINT');
}

const managedTargets = [
  { provider: 'claude-sdk', packageName: '@anthropic-ai/claude-agent-sdk' },
  { provider: 'codex', packageName: '@openai/codex-sdk' },
  { provider: 'opencode', packageName: '@opencode-ai/sdk' },
  { provider: 'pi', packageName: '@earendil-works/pi-coding-agent' },
] as const;

function installedGeneration(packageName: string): string {
  function visit(directory: string): string | undefined {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    for (const entry of entries.filter((entry) => entry.isSymbolicLink())) {
      const published = join(directory, entry.name);
      try {
        readFileSync(join(published, 'node_modules', packageName, 'package.json'));
        return realpathSync(published);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const found = visit(join(directory, entry.name));
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const found = visit(join(temporaryRoot, 'config'));
  if (found === undefined) throw new Error(`No published installation for ${packageName}`);
  return found;
}

async function makeManagedGenerationStale(packageName: string): Promise<string> {
  const directory = installedGeneration(packageName);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
  manifest.dependencies[packageName] = '0.0.1';
  lock.packages['']!.dependencies![packageName] = '0.0.1';
  lock.packages[`node_modules/${packageName}`]!.version = '0.0.1';
  const packagePath = join(directory, 'node_modules', packageName, 'package.json');
  const installed = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
  const installedBytes = JSON.stringify({ ...installed, version: '0.0.1' });
  await writeFile(packagePath, installedBytes);
  const manifestBytes = JSON.stringify(manifest);
  const lockBytes = JSON.stringify(lock);
  await writeFile(join(directory, 'package.json'), manifestBytes);
  await writeFile(join(directory, 'package-lock.json'), lockBytes);
  const markerPath = join(directory, '.ready.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { manifestSha256: string; lockSha256: string; files: Record<string, string> };
  marker.manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  marker.lockSha256 = createHash('sha256').update(lockBytes).digest('hex');
  marker.files[`node_modules/${packageName}/package.json`] = createHash('sha256').update(installedBytes).digest('hex');
  await writeFile(markerPath, JSON.stringify(marker));
  return directory;
}

async function prepareQueuedWorkflow() {
  const terminal = await prepareTerminalManagedTask();
  await writeFile(join(temporaryRoot, '.takt', 'config.yaml'), 'concurrency: 1\ntask_poll_interval_ms: 100\n');
  await writeFile(join(temporaryRoot, '.takt', 'runtime.yaml'), `version: 1
provider:
  defaults: { profile: active }
  profiles:
    active: { provider: mock, model: mock/default-model }
    managed: { provider: deepseek-harness, model: deepseek-v4-flash }
  targets:
    steps:
      execute: { profile: managed }
`);
  return terminal;
}

async function prepareNamingWorkflow() {
  const terminal = await prepareTerminalManagedTask();
  vi.spyOn(taskInfrastructure, 'autoCommitAndPush').mockResolvedValue({ success: true, message: 'Test Git completion' });
  await writeFile(join(temporaryRoot, '.takt', 'runtime.yaml'), `version: 1
provider:
  defaults: { profile: naming }
  profiles:
    naming: { provider: deepseek-harness, model: deepseek-v4-flash }
    active: { provider: mock, model: mock/default-model }
    later: { provider: codex, model: gpt-5 }
  targets:
    steps:
      execute: { profile: active }
      later: { profile: later }
`);
  return terminal;
}

describe.skipIf(!supported)('managed DeepSeek installation', () => {
  it.each([
    { provider: 'claude-sdk', isolated: false },
    { provider: 'claude-sdk', isolated: true },
    { provider: 'codex', isolated: false },
    { provider: 'codex', isolated: true },
    { provider: 'opencode', isolated: false },
    { provider: 'pi', isolated: false },
  ] as const)('fails a missing managed $provider call with install advice and no SDK or npm invocation (isolated=$isolated)', async ({ provider, isolated }) => {
    if (provider === 'opencode') {
      const command = join(temporaryRoot, 'opencode.cjs');
      await writeFile(command, '#!/usr/bin/env node\nconsole.log("2.0.0");\n', { mode: 0o755 });
      vi.stubEnv('TAKT_OPENCODE_PATH', command);
      vi.stubEnv('TAKT_OPENCODE_VERSION', 'v2');
    }
    const spawn = vi.spyOn(managedProcess, 'spawnManagedProcess').mockImplementation(() => {
      throw new Error('Unexpected process during provider execution');
    });
    const crossSpawn = vi.spyOn(managedProcess, 'crossSpawn').mockImplementation(() => {
      throw new Error('Unexpected external CLI during provider execution');
    });
    const adapter = getProvider(provider);
    const agent = isolated ? adapter.setupIsolatedStructured!({ name: 'worker' }) : adapter.setup({ name: 'worker' });
    const failure = await agent.call('Execute a step', {
      cwd: temporaryRoot,
      ...(provider === 'opencode' ? { model: 'opencode/big-pickle' } : {}),
      outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
    }).then((response) => {
      expect(response.status).toBe('error');
      return `${response.error ?? ''}\n${response.content}`;
    }, (error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      return (error as Error).message;
    });
    expect(failure).toContain(`takt install ${provider}`);
    expect(mockSdkInvocation).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(crossSpawn).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it.each(managedTargets)('installs a usable pinned $provider SDK and leaves it unchanged on a repeated install', async ({ provider, packageName }) => {
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const first = await runManagedCli(['install', provider]);
    expect(first.code, first.output).toBe(0);
    const directory = await installedGeneration(packageName);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const installed = JSON.parse(await readFile(join(directory, 'node_modules', packageName, 'package.json'), 'utf8')) as { version: string };
    expect(installed.version).toBe(manifest.dependencies[packageName]);
    const second = await runManagedCli(['install', provider]);
    expect(second.code, second.output).toBe(0);
    expect(await installedGeneration(packageName)).toBe(directory);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['ci', '--omit=dev', '--ignore-scripts']));
    const consumer = spawn(nodeExecutable, ['--input-type=module', '--eval', `const sdk = await import(${JSON.stringify(packageName)});
if (Object.keys(sdk).length === 0) process.exit(2);`], { cwd: directory, stdio: 'ignore' });
    const [code] = await once(consumer, 'close');
    expect(code).toBe(0);
  });

  it.each(managedTargets)('loads an intact older $provider generation and rejects damaged SDK code', async ({ provider, packageName }) => {
    const first = await runManagedCli(['install', provider]);
    expect(first.code, first.output).toBe(0);
    const directory = await makeManagedGenerationStale(packageName);
    expect(await inspectManagedProvider(provider)).toMatchObject({ state: 'stale', directory });
    expect(await loadManagedSdk(provider)).toMatchObject({ directory, stale: true });
    const module = MANAGED_MODULES[provider][0];
    const entry = await managedModulePath(directory, module.name, module.export);
    await writeFile(entry, `${await readFile(entry, 'utf8')}\n// damaged SDK fixture\n`);
    expect(await inspectManagedProvider(provider)).toMatchObject({ state: 'missing' });
    await expect(loadManagedSdk(provider)).rejects.toThrow(`takt install ${provider}`);
  });

  it.each(managedTargets)('keeps the installed $provider generation when a forced replacement fails', async ({ provider, packageName }) => {
    const first = await runManagedCli(['install', provider]);
    expect(first.code, first.output).toBe(0);
    const directory = await installedGeneration(packageName);
    const originalManifest = await readFile(join(directory, 'package.json'));
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    const failed = await runManagedCli(['install', provider, '--force']);
    expect(failed.code, failed.output).not.toBe(0);
    expect(await installedGeneration(packageName)).toBe(directory);
    expect(await readFile(join(directory, 'package.json'))).toEqual(originalManifest);
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '0');
    const recovered = await runManagedCli(['install', provider]);
    expect(recovered.code, recovered.output).toBe(0);
    expect(await installedGeneration(packageName)).toBe(directory);
  });

  it.each(managedTargets)('keeps the installed $provider generation when npm succeeds without its SDK', async ({ provider, packageName }) => {
    const first = await runManagedCli(['install', provider]);
    expect(first.code, first.output).toBe(0);
    const directory = installedGeneration(packageName);
    const manifest = await readFile(join(directory, 'package.json'));
    vi.stubEnv('TAKT_TEST_MISSING_PACKAGE', packageName);
    const rejected = await runManagedCli(['install', provider, '--force']);
    expect(rejected.code, rejected.output).not.toBe(0);
    expect(installedGeneration(packageName)).toBe(directory);
    expect(await readFile(join(directory, 'package.json'))).toEqual(manifest);
    vi.stubEnv('TAKT_TEST_MISSING_PACKAGE', undefined);
    const repeated = await runManagedCli(['install', provider]);
    expect(repeated.code, repeated.output).toBe(0);
    expect(installedGeneration(packageName)).toBe(directory);
  });

  it.each(managedTargets)('stops an interrupted $provider replacement and keeps its installed generation usable', async ({ provider, packageName }) => {
    const first = await runManagedCli(['install', provider]);
    expect(first.code, first.output).toBe(0);
    const directory = installedGeneration(packageName);
    const pidFile = join(temporaryRoot, 'replacement-npm.pid');
    const child = spawn(nodeExecutable, ['--require', join(temporaryRoot, 'no-bundled-npm.cjs'), '--import', 'tsx', cliSource, 'install', provider, '--force'], {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        NO_UPDATE_NOTIFIER: '1',
        PATH: `${temporaryRoot}${delimiter}${process.env.PATH ?? ''}`,
        TAKT_TEST_FAKE_NPM_SCRIPT: fakeNpmPath,
        TAKT_TEST_NPM_HANG: '1',
        TAKT_TEST_NPM_PID_FILE: pidFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const npmPid = Number(await waitForFile(pidFile, child, () => output));
      expect(child.kill('SIGINT')).toBe(true);
      const [code] = await closed;
      expect(code, output).toBe(130);
      expect(() => process.kill(npmPid, 0)).toThrow();
      expect(installedGeneration(packageName)).toBe(directory);
      const repeated = await runManagedCli(['install', provider]);
      expect(repeated.code, repeated.output).toBe(0);
      expect(installedGeneration(packageName)).toBe(directory);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await closed;
      }
    }
  });

  it.each(managedTargets.filter(({ provider }) => provider === 'claude-sdk' || provider === 'codex'))('does not publish $provider when its native binary is missing', async ({ provider, packageName }) => {
    const first = await runManagedCli(['install', provider]);
    expect(first.code, first.output).toBe(0);
    const directory = installedGeneration(packageName);
    vi.stubEnv('TAKT_TEST_MISSING_BINARY', '1');
    const failed = await runManagedCli(['install', provider, '--force']);
    expect(failed.code, failed.output).not.toBe(0);
    expect(installedGeneration(packageName)).toBe(directory);
    expect((await inspectManagedProvider(provider)).state).toBe('ready');
  });

  it('runs the managed Codex CLI instead of a same-name command on PATH', async () => {
    const binary = join(temporaryRoot, 'codex-fixture.cjs');
    const log = join(temporaryRoot, 'codex-executions.jsonl');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.TAKT_TEST_CODEX_LOG, JSON.stringify({ executable: __filename, args: process.argv.slice(2) }) + '\\n');
for (const event of [
  { type: 'thread.started', thread_id: 'managed-thread' },
  { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Answer from managed Codex' } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } },
]) process.stdout.write(JSON.stringify(event) + '\\n');
`, { mode: 0o755 });
    vi.stubEnv('TAKT_TEST_CODEX_BINARY', binary);
    vi.stubEnv('TAKT_TEST_CODEX_LOG', log);
    vi.stubEnv('TAKT_CODEX_CLI_PATH', undefined);
    const installed = await runManagedCli(['install', 'codex']);
    expect(installed.code, installed.output).toBe(0);
    const directory = await installedGeneration('@openai/codex-sdk');
    await writeFile(join(temporaryRoot, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${temporaryRoot}${delimiter}${process.env.PATH ?? ''}`);
    const response = await getProvider('codex').setup({ name: 'worker' }).call('Answer the task', { cwd: temporaryRoot });
    expect(response).toMatchObject({ status: 'done', content: 'Answer from managed Codex' });
    const executions = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { executable: string });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.executable.startsWith(`${directory}/node_modules/`)).toBe(true);
    const marker = JSON.parse(await readFile(join(directory, '.ready.json'), 'utf8')) as { files: Record<string, string> };
    expect(marker.files[executions[0]!.executable.slice(directory.length + 1)]).toBe(createHash('sha256').update(await readFile(binary)).digest('hex'));
    const bytes = await readFile(binary);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(executions[0]!.executable, bytes);
    expect((await inspectManagedProvider('codex')).state).toBe('missing');
    await expect(loadManagedSdk('codex')).rejects.toThrow('takt install codex');
    expect(mockSdkInvocation).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('starts the managed Claude CLI instead of a same-name command on PATH', async () => {
    const binary = join(temporaryRoot, 'claude-fixture.cjs');
    const log = join(temporaryRoot, 'claude-executions.jsonl');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.TAKT_TEST_CLAUDE_LOG, JSON.stringify({ executable: __filename, args: process.argv.slice(2) }) + '\\n');
process.stderr.write('Managed Claude CLI fixture failure');
process.exit(2);
`, { mode: 0o755 });
    vi.stubEnv('TAKT_TEST_CLAUDE_BINARY', binary);
    vi.stubEnv('TAKT_TEST_CLAUDE_LOG', log);
    vi.stubEnv('TAKT_CLAUDE_CLI_PATH', undefined);
    const installed = await runManagedCli(['install', 'claude-sdk']);
    expect(installed.code, installed.output).toBe(0);
    const directory = installedGeneration('@anthropic-ai/claude-agent-sdk');
    await writeFile(join(temporaryRoot, 'claude'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${temporaryRoot}${delimiter}${process.env.PATH ?? ''}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await getProvider('claude-sdk').setup({ name: 'worker' }).call('Answer the task', { cwd: temporaryRoot, abortSignal: controller.signal });
      expect(response.status).toBe('error');
      expect(controller.signal.aborted).toBe(false);
      const executions = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { executable: string });
      expect(executions).toHaveLength(1);
      expect(executions[0]!.executable.startsWith(`${directory}/node_modules/`)).toBe(true);
      const marker = JSON.parse(await readFile(join(directory, '.ready.json'), 'utf8')) as { files: Record<string, string> };
      expect(marker.files[executions[0]!.executable.slice(directory.length + 1)]).toBe(createHash('sha256').update(await readFile(binary)).digest('hex'));
      const bytes = await readFile(binary);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await writeFile(executions[0]!.executable, bytes);
      expect((await inspectManagedProvider('claude-sdk')).state).toBe('missing');
      await expect(loadManagedSdk('claude-sdk')).rejects.toThrow('takt install claude-sdk');
      expect(mockSdkInvocation).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
    }
  });

  it.each([{ target: [] }, { target: ['deepseek-harness'] }])('updates only the stale installation in a mixed managed environment with target=$target', async ({ target }) => {
    const previous = await makeOldDeepSeekInstallation();
    const codex = await runManagedCli(['install', 'codex']);
    expect(codex.code, codex.output).toBe(0);
    const codexDirectory = await installedGeneration('@openai/codex-sdk');
    const codexManifest = await readFile(join(codexDirectory, 'package.json'));
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const updated = await runManagedCli(['update', ...target]);
    expect(updated.code, updated.output).toBe(0);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
    expect(await installedGeneration('@openai/codex-sdk')).toBe(codexDirectory);
    expect(await readFile(join(codexDirectory, 'package.json'))).toEqual(codexManifest);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { dependencies: Record<string, string> });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.dependencies).toHaveProperty('@deepseek-ai/dsh');
    expect(() => installedGeneration('@earendil-works/pi-coding-agent')).toThrow('No published installation');
  });

  it('preserves another stale SDK when updating only the explicitly named provider', async () => {
    const deepSeekDirectory = await makeOldDeepSeekInstallation();
    const installed = await runManagedCli(['install', 'codex']);
    expect(installed.code, installed.output).toBe(0);
    const codexDirectory = await makeManagedGenerationStale('@openai/codex-sdk');
    const manifest = await readFile(join(codexDirectory, 'package.json'));
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const updated = await runManagedCli(['update', 'deepseek-harness']);
    expect(updated.code, updated.output).toBe(0);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(deepSeekDirectory);
    expect(await inspectManagedProvider('codex')).toMatchObject({ state: 'stale', directory: codexDirectory });
    expect(await readFile(join(codexDirectory, 'package.json'))).toEqual(manifest);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it.each(['interactive', 'headless'] as const)('does not save a task with a missing provider through the %s queue entry', async (entry) => {
    const { workflowPath, providerCall } = await prepareQueuedWorkflow();
    if (entry === 'headless') vi.stubEnv('TAKT_NO_TTY', '1');
    const save = entry === 'interactive'
      ? saveTaskFromInteractive(temporaryRoot, 'Queued task', workflowPath, { presetSettings: { worktree: false, autoPr: false } })
      : saveTaskFile(temporaryRoot, 'Queued task', { workflow: workflowPath, worktree: false });
    await save.catch(() => undefined);
    expect(new TaskRunner(temporaryRoot).listTasks()).toEqual([]);
    expect(providerCall).not.toHaveBeenCalled();
    if (entry === 'interactive') expect(mockConfirm).toHaveBeenCalled();
    else expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('checks every pending task before claiming the first run slot', async () => {
    const { workflowPath, stepStarts, providerCall } = await prepareQueuedWorkflow();
    const mockWorkflow = join(temporaryRoot, 'mock-workflow.yaml');
    await writeFile(mockWorkflow, (await readFile(workflowPath, 'utf8')).replaceAll('execute', 'ready'));
    const runner = new TaskRunner(temporaryRoot);
    runner.addTask('First ready task', { workflow: mockWorkflow, worktree: false });
    runner.addTask('Second missing task', { workflow: workflowPath, worktree: false });
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    await runAllTasks(temporaryRoot).catch(() => undefined);
    expect(mockConfirm).toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(stepStarts()).toBe(0);
    expect(providerCall).not.toHaveBeenCalled();
    expect(runner.listTasks()).toHaveLength(2);
  });

  it.each(['retry', 'automatic requeue'] as const)('leaves a failed task unchanged when its missing SDK is declined before %s', async (operation) => {
    const { workflowPath, providerCall, stepStarts } = await prepareQueuedWorkflow();
    const worktreePath = join(temporaryRoot, '.takt', 'worktrees', 'retry-target');
    await mkdir(worktreePath, { recursive: true });
    const runner = new TaskRunner(temporaryRoot);
    runner.addTask('Retry without changing state', { workflow: workflowPath, worktree_path: worktreePath });
    const task = runner.claimNextTasks(1)[0]!;
    runner.failTask({ task, success: false, response: 'Previous failure', executionLog: [], failureRetryable: true, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), worktreePath });
    const before = await readFile(join(temporaryRoot, '.takt', 'tasks.yaml'));
    if (operation === 'retry') {
      const failed = runner.listFailedTasks()[0]!;
      await expect(persistFailedTaskRetry({ task: failed, projectDir: temporaryRoot, worktreePath, startStep: undefined, retryNote: undefined, resumePoint: undefined, workflow: workflowPath, taskDir: undefined, sourceRunSlug: null, restartPoint: undefined })).rejects.toThrow('takt install deepseek-harness');
    } else {
      await writeFile(join(temporaryRoot, '.takt', 'config.yaml'), 'concurrency: 1\nauto_requeue_max_attempts: 2\n');
      await expect(runAllTasks(temporaryRoot)).rejects.toThrow('takt install deepseek-harness');
    }
    expect(await readFile(join(temporaryRoot, '.takt', 'tasks.yaml'))).toEqual(before);
    expect(runner.listTasks()).toEqual([]);
    expect(runner.listFailedTasks()).toHaveLength(1);
    expect(stepStarts()).toBe(0);
    expect(providerCall).not.toHaveBeenCalled();
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('stops a missing watcher task before any step without prompting or installing', async () => {
    const { workflowPath, providerCall, stepStarts } = await prepareQueuedWorkflow();
    await useFakeNpmForCurrentProcess();
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const runner = new TaskRunner(temporaryRoot);
    runner.addTask('Watched missing task', { workflow: workflowPath, worktree: false });
    const before = await readFile(join(temporaryRoot, '.takt', 'tasks.yaml'));
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    await expect(watchTasks(temporaryRoot)).rejects.toThrow('takt install deepseek-harness');
    expect(claim).not.toHaveBeenCalled();
    expect(await readFile(join(temporaryRoot, '.takt', 'tasks.yaml'))).toEqual(before);
    expect(stepStarts()).toBe(0);
    expect(providerCall).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['accept', 'decline', 'npm failure', 'cancel', 'interrupt install'] as const)('prepares the missing naming SDK before claiming an AI-named task: %s', async (outcome) => {
    const { workflowPath, stepStarts, providerCall } = await prepareNamingWorkflow();
    await writeFile(join(temporaryRoot, '.takt', 'config.yaml'), 'concurrency: 1\nbranch_name_strategy: ai\nauto_pr: false\n');
    const runner = new TaskRunner(temporaryRoot);
    runner.addTask('Task needing an AI name', { workflow: workflowPath, worktree: true, auto_pr: false });
    const tasksPath = join(temporaryRoot, '.takt', 'tasks.yaml');
    const records = parse(await readFile(tasksPath, 'utf8')) as { tasks: Array<Record<string, unknown>> };
    delete records.tasks[0]!.slug;
    await writeFile(tasksPath, stringify(records));
    const before = await readFile(tasksPath);
    const order: string[] = [];
    const originalClaim = TaskRunner.prototype.claimNextTasks;
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks').mockImplementation(function (this: TaskRunner, count) {
      expect(installedGeneration('@deepseek-ai/dsh-sdk-client')).toEqual(expect.any(String));
      order.push('claim');
      return originalClaim.call(this, count);
    });
    const clone = vi.spyOn(taskInfrastructure, 'createSharedCloneAbortable').mockImplementation(async () => {
      order.push('clone');
      return { path: temporaryRoot, branch: 'test-ai-name' } as never;
    });
    vi.spyOn(taskInfrastructure, 'resolveBaseBranch').mockReturnValue({ branch: 'main' } as never);
    providerCall.mockImplementation(async () => {
      order.push('name');
      return { persona: 'namer', status: 'done', content: 'ai-name', timestamp: new Date() };
    });
    const workflowCall = vi.fn().mockResolvedValue({ persona: 'worker', status: 'done', content: '[EXECUTE:1]\nDone', timestamp: new Date() });
    vi.spyOn(getProvider('mock'), 'setup').mockReturnValue({ call: workflowCall });
    await useFakeNpmForCurrentProcess();
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const gate = join(temporaryRoot, 'release-npm');
    const started = join(temporaryRoot, 'npm-started');
    const listenersBefore = process.rawListeners('SIGINT');
    if (outcome === 'npm failure') vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    if (outcome === 'accept' || outcome === 'interrupt install') {
      vi.stubEnv('TAKT_TEST_NPM_GATE', gate);
      vi.stubEnv('TAKT_TEST_NPM_STARTED', started);
    }
    mockConfirm.mockImplementation(async () => {
      expect(await readFile(tasksPath)).toEqual(before);
      expect(claim).not.toHaveBeenCalled();
      if (outcome === 'cancel') { interruptNewHandlers(listenersBefore); return true; }
      return outcome !== 'decline';
    });
    const execution = runAllTasks(temporaryRoot).then(() => undefined, (error: unknown) => error);
    if (outcome === 'interrupt install') {
      await waitForFile(started);
      expect(await readFile(tasksPath)).toEqual(before);
      interruptNewHandlers(listenersBefore);
    }
    if (outcome === 'accept') {
      try {
        await waitForFile(started);
        expect(await readFile(tasksPath)).toEqual(before);
        expect(claim).not.toHaveBeenCalled();
        expect(providerCall).not.toHaveBeenCalled();
        expect(clone).not.toHaveBeenCalled();
        expect(stepStarts()).toBe(0);
      } finally { await writeFile(gate, 'release'); }
      expect(await execution).toBeUndefined();
      expect(order).toEqual(['claim', 'name', 'clone', 'claim']);
      expect(workflowCall).toHaveBeenCalledOnce();
      expect(stepStarts()).toBe(1);
      expect(runner.listTasks()).toHaveLength(0);
    } else {
      expect(await execution).toBeInstanceOf(Error);
      expect(await readFile(tasksPath)).toEqual(before);
      expect(claim).not.toHaveBeenCalled();
      expect(providerCall).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled();
      expect(stepStarts()).toBe(0);
      if (outcome !== 'npm failure' && outcome !== 'interrupt install') expect(existsSync(log)).toBe(false);
    }
    expect(process.rawListeners('SIGINT')).toEqual(listenersBefore);
  });

  it('checks a task added during accepted naming installation before claiming any task', async () => {
    const { workflowPath, providerCall, stepStarts } = await prepareNamingWorkflow();
    await writeFile(join(temporaryRoot, '.takt', 'config.yaml'), 'branch_name_strategy: ai\n');
    const laterWorkflow = join(temporaryRoot, 'later-workflow.yaml');
    await writeFile(laterWorkflow, (await readFile(workflowPath, 'utf8')).replaceAll('execute', 'later'));
    const runner = new TaskRunner(temporaryRoot);
    runner.addTask('Initial AI name', { workflow: workflowPath, worktree: true });
    const path = join(temporaryRoot, '.takt', 'tasks.yaml');
    const records = parse(await readFile(path, 'utf8')) as { tasks: Array<Record<string, unknown>> };
    delete records.tasks[0]!.slug;
    await writeFile(path, stringify(records));
    mockConfirm.mockImplementationOnce(async () => {
      runner.addTask('Arrived during preparation', { workflow: laterWorkflow, worktree: false });
      return true;
    }).mockResolvedValue(false);
    await useFakeNpmForCurrentProcess();
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    await expect(runAllTasks(temporaryRoot)).rejects.toThrow('takt install codex');
    expect(claim).not.toHaveBeenCalled();
    expect(runner.listTasks()).toHaveLength(2);
    expect(runner.listTaskStateItems().every((task) => task.status === 'pending')).toBe(true);
    expect(providerCall).not.toHaveBeenCalled();
    expect(stepStarts()).toBe(0);
    expect(mockConfirm).toHaveBeenCalledTimes(2);
  });

  it.each(['run', 'watch'].flatMap((mode) => [true, false].map((ready) => ({ mode, ready }))))('checks the SDK for a newly arrived naming task without terminal confirmation ($mode, ready=$ready)', async ({ mode, ready }) => {
    const { workflowPath, stepStarts, providerCall } = await prepareNamingWorkflow();
    await writeFile(join(temporaryRoot, '.takt', 'config.yaml'), 'concurrency: 2\ntask_poll_interval_ms: 100\nbranch_name_strategy: ai\n');
    const runner = new TaskRunner(temporaryRoot);
    runner.addTask('Initial task', { workflow: workflowPath, worktree: false });
    if (ready) await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const npmLog = join(temporaryRoot, 'npm-after-arrival.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', npmLog);
    vi.spyOn(taskInfrastructure, 'resolveBaseBranch').mockReturnValue({ branch: 'main' } as never);
    const clone = vi.spyOn(taskInfrastructure, 'createSharedCloneAbortable').mockResolvedValue({ path: temporaryRoot, branch: 'test-ai-name' } as never);
    providerCall.mockResolvedValue({ persona: 'namer', status: 'done', content: 'ai-name', timestamp: new Date() });
    let finish!: () => void;
    const active = new Promise<void>((resolve) => { finish = resolve; });
    let arrival!: () => void;
    const arrived = new Promise<void>((resolve) => { arrival = resolve; });
    let before: Buffer;
    let calls = 0;
    vi.spyOn(getProvider('mock'), 'setup').mockReturnValue({ call: vi.fn(async () => {
      if (calls++ > 0) return { persona: 'worker', status: 'done' as const, content: '[EXECUTE:1]\nDone', timestamp: new Date() };
      runner.addTask('Arriving AI name', { workflow: workflowPath, worktree: true });
      const path = join(temporaryRoot, '.takt', 'tasks.yaml');
      const records = parse(readFileSync(path, 'utf8')) as { tasks: Array<Record<string, unknown>> };
      delete records.tasks.at(-1)!.slug;
      writeFileSync(path, stringify(records));
      before = readFileSync(path);
      arrival();
      await active;
      return { persona: 'worker', status: 'done' as const, content: '[EXECUTE:1]\nDone', timestamp: new Date() };
    }) });
    let finishAll!: () => void;
    const finishedAll = new Promise<void>((resolve) => { finishAll = resolve; });
    const completeTask = TaskRunner.prototype.completeTask;
    vi.spyOn(TaskRunner.prototype, 'completeTask').mockImplementation(function (this: TaskRunner, ...args) {
      const result = completeTask.apply(this, args);
      if (runner.listTaskStateItems().filter((task) => task.status === 'completed').length === 2) finishAll();
      return result;
    });
    const listenersBefore = process.rawListeners('SIGINT');
    const execution = (mode === 'run' ? runAllTasks(temporaryRoot) : watchTasks(temporaryRoot)).catch((error: unknown) => error);
    try {
      expect(await Promise.race([arrived.then(() => true), execution.then(() => false)])).toBe(true);
      await delay(100);
      if (!ready) {
        expect(await readFile(join(temporaryRoot, '.takt', 'tasks.yaml'))).toEqual(before!);
        expect(runner.listTasks()).toHaveLength(1);
      }
      finish();
      if (ready && mode === 'watch') {
        expect(await Promise.race([finishedAll.then(() => true), execution.then(() => false)])).toBe(true);
        interruptNewHandlers(listenersBefore);
      }
      if (ready) expect(await execution).toBeUndefined();
      else expect(await execution).toMatchObject({ message: expect.stringContaining('takt install deepseek-harness') });
    } finally {
      finish();
      if (mode === 'watch' && process.rawListeners('SIGINT').some((listener) => !listenersBefore.includes(listener))) {
        interruptNewHandlers(listenersBefore);
      }
      await execution;
    }
    expect(runner.listTasks()).toHaveLength(ready ? 0 : 1);
    if (!ready) expect(runner.listTasks()[0]!.content).toBe('Arriving AI name');
    expect(runner.listTaskStateItems().find((task) => task.name.startsWith('initial-task'))?.status).toBe('completed');
    expect(stepStarts()).toBe(ready ? 2 : 1);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(providerCall).toHaveBeenCalledTimes(ready ? 1 : 0);
    expect(clone).toHaveBeenCalledTimes(ready ? 1 : 0);
    expect(existsSync(npmLog)).toBe(false);
  });

  it.each(['claude-sdk', 'codex'])('allows a win32 %s installation to reach npm without using the DeepSeek platform restriction', async (provider) => {
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    const result = await runManagedCli(['install', provider], 'win32');
    expect(result.code, result.output).not.toBe(0);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(result.output).not.toMatch(/unsupported.*(?:platform|Windows)|only.*(?:Linux|macOS)/iu);
  });

  it.each(['missing', 'stale'] as const)('waits for an accepted %s installation to finish before the first terminal step', async (state) => {
    const previous = state === 'stale' ? await makeOldDeepSeekInstallation() : undefined;
    const { run, providerCall, stepStarts } = await prepareTerminalManagedTask();
    await useFakeNpmForCurrentProcess();
    const gate = join(temporaryRoot, 'release-npm');
    const started = join(temporaryRoot, 'npm-started');
    vi.stubEnv('TAKT_TEST_NPM_GATE', gate);
    vi.stubEnv('TAKT_TEST_NPM_STARTED', started);
    let accepted!: () => void;
    const confirmation = new Promise<void>((resolve) => { accepted = resolve; });
    mockConfirm.mockImplementation(async () => { accepted(); return true; });
    const execution = run();
    try {
      expect(await Promise.race([confirmation.then(() => true), execution.then(() => false)])).toBe(true);
      await waitForFile(started);
      expect(stepStarts()).toBe(0);
      expect(providerCall).not.toHaveBeenCalled();
      await writeFile(gate, 'release');
      await execution;
      expect(stepStarts()).toBe(1);
      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
    } finally {
      await writeFile(gate, 'release');
      await execution;
    }
  });

  it('warns and runs an intact older SDK in a pipeline without prompting or running npm', async () => {
    const previous = await makeOldDeepSeekInstallation();
    const { workflowPath, providerCall, warning } = await prepareTerminalManagedTask();
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const code = await executePipeline({
      task: 'Run an installed older SDK', workflow: workflowPath, autoPr: false, skipGit: true,
      createWorktree: false, cwd: temporaryRoot, provider: 'deepseek-harness',
    });
    expect(code).toBe(0);
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(warning.mock.calls.flat().join('\n')).toContain('deepseek-harness');
    expect((await loadManagedDeepSeekHarnessModules()).directory).toBe(previous);
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('warns and executes an intact older SDK when its terminal update is declined', async () => {
    const previous = await makeOldDeepSeekInstallation();
    const { run, providerCall, warning } = await prepareTerminalManagedTask();
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    await run();
    expect(mockConfirm).toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect((await loadManagedDeepSeekHarnessModules()).directory).toBe(previous);
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('confirms an older conversational SDK and answers after update acceptance=%s', async (accepted) => {
    const previous = await makeOldDeepSeekInstallation();
    await prepareTerminalManagedTask();
    await useFakeNpmForCurrentProcess();
    mockConfirm.mockResolvedValue(accepted);
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const providerCall = vi.fn().mockResolvedValue({ persona: 'interactive', status: 'done', content: 'Conversation answer', timestamp: new Date() });
    const session = createConversationSession({
      cwd: temporaryRoot, formalSpec: false, modelCheckTimeoutSeconds: 300,
      ctx: makeSessionContext({ providerType: 'deepseek-harness', provider: makeProvider({ setup: () => ({ call: providerCall }) }) }),
      strategy: { systemPrompt: 'system', modelCheckTimeoutSeconds: 300, allowedTools: undefined, transformPrompt: (text) => text },
    });
    const warning = vi.spyOn(ui, 'warn');
    expect(await session.handleUserMessage({ text: 'Use the installed SDK' })).toMatchObject({ kind: 'assistant_response', content: 'Conversation answer' });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(providerCall).toHaveBeenCalledTimes(1);
    const current = (await loadManagedDeepSeekHarnessModules()).directory;
    if (accepted) {
      expect(current).not.toBe(previous);
      expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1);
    } else {
      expect(current).toBe(previous);
      expect(warning).toHaveBeenCalled();
      await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each(['message', 'go'] as const)('keeps the same conversation usable after a declined install during %s and a later approval', async (turn) => {
    for (const { stream } of terminalDescriptors) Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    vi.stubEnv('TAKT_NO_TTY', '0');
    vi.stubEnv('CI', '');
    const providerCall = vi.fn().mockResolvedValue({
      persona: 'interactive', status: 'done', content: 'Answer after installation', timestamp: new Date(),
    });
    const session = createConversationSession({
      cwd: temporaryRoot, formalSpec: false, modelCheckTimeoutSeconds: 300, outputMode: 'terminal', persistSession: false,
      initialUserMessage: 'Keep this task context',
      ctx: makeSessionContext({
        providerType: 'deepseek-harness', model: 'deepseek-v4-flash',
        provider: makeProvider({ setup: () => ({ call: providerCall }) }),
      }),
      strategy: {
        systemPrompt: 'system', modelCheckTimeoutSeconds: 300, allowedTools: undefined,
        transformPrompt: (message) => message,
      },
    });
    const declined = turn === 'go'
      ? await session.createTaskInstruction({ userNote: '' })
      : await session.handleUserMessage({ text: 'First question' });
    expect(declined).toMatchObject({ kind: 'error', message: expect.stringContaining('takt install deepseek-harness') });
    expect(mockConfirm).toHaveBeenCalled();
    expect(providerCall).not.toHaveBeenCalled();
    const declinedAgain = await session.handleUserMessage({ text: 'Another question before installation' });
    expect(declinedAgain).toMatchObject({ kind: 'error', message: expect.stringContaining('takt install deepseek-harness') });
    expect(providerCall).not.toHaveBeenCalled();
    await useFakeNpmForCurrentProcess();
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    mockConfirm.mockResolvedValue(true);
    const answer = await session.handleUserMessage({ text: 'Retry after installation' });
    expect(answer).toMatchObject({ kind: 'assistant_response', content: 'Answer after installation' });
    expect(mockConfirm.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toEqual(expect.any(String));
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(session.snapshotHistory().map((message) => message.content)).toContain('Keep this task context');
    expect(session.snapshotHistory().map((message) => message.content)).toContain('Answer after installation');
  });

  it('returns to the same readline conversation after a declined go and answers after later installation', async () => {
    await prepareTerminalManagedTask();
    await useFakeNpmForCurrentProcess();
    const providerCall = vi.fn().mockResolvedValue({
      persona: 'interactive', status: 'done', content: 'Answer after installation', timestamp: new Date(),
    });
    const ctx = makeSessionContext({
      providerType: 'deepseek-harness', model: 'deepseek-v4-flash',
      provider: makeProvider({ setup: () => ({ call: providerCall }) }),
    });
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const input = vi.spyOn(lineEditor, 'readPipedLine').mockResolvedValue(null);
    for (const text of ['/go', 'Before installation', 'After installation', '/cancel']) input.mockResolvedValueOnce(text);
    const result = await runConversationLoop(temporaryRoot, ctx, {
      systemPrompt: 'system', modelCheckTimeoutSeconds: 300, allowedTools: undefined,
      formalSpec: false, transformPrompt: (message) => message, introMessage: 'Conversation',
      selectGoAction: async () => 'cancel',
    }, undefined, { userMessage: 'Keep this task context' });
    expect(result.action).toBe('cancel');
    expect(mockConfirm).toHaveBeenCalledTimes(3);
    expect(input).toHaveBeenCalledTimes(4);
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(providerCall.mock.calls[0]![0]).toContain('Keep this task context');
    expect(providerCall.mock.calls[0]![0]).toContain('After installation');
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toEqual(expect.any(String));
  });

  it.each(['message', 'go'] as const)('keeps one TUI conversation usable after declining %s and later installing its provider', async (turn) => {
    await prepareTerminalManagedTask();
    const providerCall = vi.fn().mockResolvedValue({
      persona: 'interactive', status: 'done', content: 'Answer after installation', timestamp: new Date(),
    });
    const plan = createAssistantConversationPlan(temporaryRoot, {
      assistantMode: 'assistant', formalSpec: false, formalSpecComments: false, modelCheckTimeoutSeconds: 300,
      resolvedSessionContext: makeSessionContext({
        providerType: 'deepseek-harness', model: 'deepseek-v4-flash',
        provider: makeProvider({ setup: () => ({ call: providerCall }) }),
      }),
    });
    const conversation = createTuiConversation({
      cwd: temporaryRoot, plan, userMessage: 'Keep this task context',
      attachmentStore: createSessionImageAttachmentStore(temporaryRoot),
    });
    const input = (text: string) => ({ text, abortSignal: new AbortController().signal, onAssistantChunk: vi.fn(), confirmManagedProvider: mockConfirm });
    const declined = turn === 'go' ? await conversation.createInstruction(input('')) : await conversation.submit(input('First question'));
    expect(declined).toMatchObject({ kind: 'error', message: expect.stringContaining('takt install deepseek-harness') });
    expect(providerCall).not.toHaveBeenCalled();
    expect(await conversation.submit(input('Another question'))).toMatchObject({ kind: 'error' });
    await useFakeNpmForCurrentProcess();
    mockConfirm.mockResolvedValue(true);
    expect(await conversation.submit(input('After installation'))).toMatchObject({ kind: 'assistant_response', content: 'Answer after installation' });
    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(conversation.snapshotHistory!().map((message) => message.content)).toEqual(expect.arrayContaining(['Keep this task context', 'After installation', 'Answer after installation']));
  });

  it.each(['rule', 'fallback'].flatMap((route) => [true, false].map((accepted) => ({ route, accepted }))))('prepares the $route candidate from public configuration before step start (accepted=$accepted)', async ({ route, accepted }) => {
    const { workflowPath, stepStarts } = await prepareTerminalManagedTask();
    if (route === 'fallback') {
      const installed = await runManagedCli(['install', 'codex']);
      expect(installed.code, installed.output).toBe(0);
    }
    await writeFile(join(temporaryRoot, '.takt', 'config.yaml'), `provider: mock
auto_routing:
  strategy: balanced
  router: { provider: mock, model: mock/default-model }
  candidates:
    - { name: active, provider: mock, model: mock/default-model, routing_tier: low }
    - { name: coding, provider: codex, model: gpt-5, routing_tier: medium }
    - { name: advanced, provider: claude-sdk, model: claude-sonnet-4-5, routing_tier: high }
  default_pool: general
  candidate_pools:
    general: { candidates: ${route === 'rule' ? '[active], fallback: active' : '[coding, advanced], fallback: advanced'} }
  pool_rules:
    steps: { routed: general }
  rules:
    steps: ${route === 'rule' ? '{ routed: coding }' : '{}'}
`);
    await writeFile(workflowPath, `name: public-routing
initial_step: first
max_steps: 3
steps:
  - name: first
    persona: ./.takt/personas/worker.md
    instruction: "{task}"
    rules: [{ condition: 'when(true)', next: COMPLETE }]
  - name: routed
    persona: ./.takt/personas/worker.md
    instruction: "{task}"
    rules: [{ condition: 'when(true)', next: COMPLETE }]
`);
    await useFakeNpmForCurrentProcess();
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    mockConfirm.mockResolvedValue(accepted);
    const packageName = route === 'rule' ? '@openai/codex-sdk' : '@anthropic-ai/claude-agent-sdk';
    const firstCall = vi.fn().mockResolvedValue({ persona: 'worker', status: 'done', content: 'Completed', timestamp: new Date() });
    vi.spyOn(getProvider('mock'), 'setup').mockReturnValue({ call: firstCall });
    const emit = WorkflowEngine.prototype.emit;
    const observations: string[] = [];
    vi.spyOn(WorkflowEngine.prototype, 'emit').mockImplementation(function (this: WorkflowEngine, ...args) {
      if (args[0] === 'step:start') {
        observations.push(installedGeneration(packageName));
        const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { dependencies: Record<string, string> });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.dependencies).toHaveProperty(packageName);
      }
      return emit.apply(this, args);
    });
    const execution = selectAndExecuteTask(temporaryRoot, 'Preflight public routing', { workflow: workflowPath, skipTaskList: true, failureMode: 'return' });
    if (accepted) {
      await execution;
      expect(observations).toHaveLength(1);
      expect(firstCall).toHaveBeenCalledOnce();
    } else {
      await execution;
      expect(observations).toEqual([]);
      expect(stepStarts()).toBe(0);
      expect(firstCall).not.toHaveBeenCalled();
      expect(existsSync(log)).toBe(false);
      expect(() => installedGeneration(packageName)).toThrow('No published installation');
    }
    expect(mockConfirm).toHaveBeenCalledOnce();
  });

  it('installs every selected pool candidate and target before the first terminal step', async () => {
    const originalEmit = WorkflowEngine.prototype.emit;
    const { workflowPath } = await prepareTerminalManagedTask();
    await writeFile(join(temporaryRoot, '.takt', 'runtime.yaml'), `version: 1
provider:
  defaults:
    profile: active
  profiles:
    active: { provider: mock, model: mock/default-model }
    coding: { provider: codex, model: gpt-5 }
    advanced: { provider: claude-sdk, model: claude-sonnet-4-5 }
    pi: { provider: pi, model: openai/gpt-5 }
  targets:
    steps:
      routed: { pool: general }
      alternate: { profile: pi }
  auto_routing:
    strategy: balanced
    router_profile: active
    pools:
      general:
        candidates:
          - { profile: coding, tier: low }
          - { profile: advanced, tier: high }
        fallback_profile: advanced
`);
    await writeFile(workflowPath, `name: all-candidates
initial_step: first
max_steps: 3
steps:
  - name: first
    persona: ./.takt/personas/worker.md
    instruction: "{task}"
    rules: [{ condition: 'when(true)', next: COMPLETE }]
  - name: routed
    persona: ./.takt/personas/worker.md
    instruction: "{task}"
    rules: [{ condition: 'when(true)', next: COMPLETE }]
  - name: alternate
    persona: ./.takt/personas/worker.md
    instruction: "{task}"
    rules: [{ condition: 'when(true)', next: COMPLETE }]
`);
    await useFakeNpmForCurrentProcess();
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    mockConfirm.mockResolvedValue(true);
    const starts: Array<{ packages: string[]; npmCalls: number; confirmations: string }> = [];
    const requiredPackages = managedTargets.filter(({ provider }) => provider !== 'opencode').map(({ packageName }) => packageName);
    vi.spyOn(WorkflowEngine.prototype, 'emit').mockImplementation(function (this: WorkflowEngine, ...args) {
      if (args[0] === 'step:start') {
        const packages = requiredPackages.filter((packageName) => {
          try {
            installedGeneration(packageName);
            return true;
          } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('No published installation')) throw error;
            return false;
          }
        });
        starts.push({ packages,
          npmCalls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0,
          confirmations: mockConfirm.mock.calls.flat().join('\n'),
        });
      }
      return originalEmit.apply(this, args);
    });
    const firstCall = vi.fn(async () => {
      const records = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { dependencies: Record<string, string> });
      expect(records).toHaveLength(3);
      const dependencies = records.flatMap((record) => Object.keys(record.dependencies));
      expect(dependencies).toEqual(expect.arrayContaining(['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', '@earendil-works/pi-coding-agent']));
      const confirmations = mockConfirm.mock.calls.flat().join('\n');
      for (const name of ['codex', 'claude-sdk', 'pi']) expect(confirmations).toContain(name);
      for (const { packageName } of managedTargets.filter(({ provider }) => provider !== 'opencode')) await installedGeneration(packageName);
      return { persona: 'worker', status: 'done' as const, content: 'Completed', timestamp: new Date() };
    });
    vi.spyOn(getProvider('mock'), 'setup').mockReturnValue({ call: firstCall });
    await selectAndExecuteTask(temporaryRoot, 'Install all selected candidates', { workflow: workflowPath, skipTaskList: true, failureMode: 'return' });
    expect(firstCall).toHaveBeenCalledTimes(1);
    await expect(firstCall.mock.results[0]!.value).resolves.toMatchObject({ status: 'done' });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ packages: requiredPackages, npmCalls: 3 });
    for (const provider of ['codex', 'claude-sdk', 'pi']) expect(starts[0]!.confirmations).toContain(provider);
  });

  it('does not prompt or run npm when a running provider encounters a missing SDK', async () => {
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    const response = await callDeepSeekHarness('worker', 'Execute without preflight', { cwd: temporaryRoot });
    expect(response).toMatchObject({ status: 'error', content: expect.stringContaining('takt install deepseek-harness') });
    expect(mockConfirm).not.toHaveBeenCalled();
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['claude-sdk', 'codex', 'opencode', 'pi'])('uses pinned npm ci and reports installation failure for %s', async (provider) => {
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    const result = await runManagedCli(['install', provider]);
    expect(result.code, result.output).not.toBe(0);
    const calls = (await readFile(log, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['ci', '--omit=dev', '--ignore-scripts']));
    expect(calls[0]?.cwd.startsWith(join(temporaryRoot, 'config'))).toBe(true);
    expect(result.output).toMatch(/npm.*(?:9|fail|exit)/iu);
  });

  it('recovers a previously missing managed module in the same process after installation', async () => {
    await expect(loadManagedDeepSeekHarnessModules()).rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const modules = await loadManagedDeepSeekHarnessModules();
    expect(typeof modules.sdk.DeepSeekHarness).toBe('function');
    expect(modules.directory).toBe(await getReadyDeepSeekHarnessPackageDirectory());
  });

  it('loads an intact older SDK generation without reinstalling it', async () => {
    const directory = await makeOldDeepSeekInstallation();
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    const modules = await loadManagedDeepSeekHarnessModules();
    expect(modules.directory).toBe(directory);
    expect(typeof modules.sdk.DeepSeekHarness).toBe('function');
    expect(JSON.parse(await readFile(join(directory, 'node_modules/@deepseek-ai/dsh-sdk-client/package.json'), 'utf8')))
      .toMatchObject({ version: '0.2.0-rc.1' });
  });

  it.each([0, 1].flatMap((repeat) => ['before capture', 'after capture'].map((publication) => ({ repeat, publication }))))('keeps the loaded DeepSeek generation and timeout advice consistent ($publication, repeat=$repeat)', async ({ publication }) => {
    vi.stubEnv('TAKT_TEST_DSH_ERROR', 'timeout');
    vi.stubEnv('DEEPSEEK_API_KEY', 'TAKT_DUMMY_MANAGED_TEST_CREDENTIAL');
    const previous = await makeOldDeepSeekInstallation();
    const log = join(temporaryRoot, 'sdk-calls.log');
    vi.stubEnv('TAKT_TEST_DSH_CALL_LOG', log);
    let captured!: () => void;
    let release!: () => void;
    const capture = new Promise<void>((resolve) => { captured = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const current = getDeepSeekHarnessManagedPackagePaths().current;
    let held = false;
    afterReadlink.mockImplementation(async (path, target) => {
      if (path !== current || held || publication === 'before capture') return;
      held = true;
      expect(join(dirname(current), String(target))).toBe(previous);
      captured();
      await barrier;
    });
    if (publication === 'before capture') await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const events: Array<{ type: string; data: unknown }> = [];
    const call = callDeepSeekHarness('worker', 'Cause the same SDK timeout', {
      cwd: temporaryRoot, onStream: (event) => events.push(event),
    });
    try {
      if (publication === 'after capture') {
        expect(await Promise.race([capture.then(() => true), call.then(() => false)])).toBe(true);
        await installDeepSeekHarness({ npmPath: fakeNpmPath });
      }
    } finally {
      release();
    }
    const response = await call;
    const expectedDirectory = publication === 'after capture' ? previous : await getReadyDeepSeekHarnessPackageDirectory();
    expect((await readFile(log, 'utf8')).trim()).toBe(pathToFileURL(join(expectedDirectory, 'node_modules/@deepseek-ai/dsh-sdk-client/index.js')).href);
    expect(response).toMatchObject({ status: 'error', failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT });
    expect(response.error?.includes('takt update')).toBe(publication === 'after capture');
    expect(events.at(-1)).toMatchObject({ type: 'result', data: { success: false, failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT } });
    expect(JSON.stringify(events.at(-1)).includes('takt update')).toBe(publication === 'after capture');
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('returns the captured directory and stale flag even when current changes before import', async () => {
    const previous = await makeOldDeepSeekInstallation();
    let captured!: () => void;
    let release!: () => void;
    const capture = new Promise<void>((resolve) => { captured = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    afterReadlink.mockImplementation(async (path) => {
      if (held || path !== getDeepSeekHarnessManagedPackagePaths().current) return;
      held = true;
      captured();
      await barrier;
    });
    const loading = loadManagedDeepSeekHarnessModules();
    try {
      expect(await Promise.race([capture.then(() => true), loading.then(() => false)])).toBe(true);
      await installDeepSeekHarness({ npmPath: fakeNpmPath });
    } finally { release(); }
    expect(await loading).toMatchObject({ directory: previous, stale: true });
    expect(await loadManagedDeepSeekHarnessModules()).toMatchObject({ stale: false });
  });

  it.each([true, false])('keeps the loaded SDK state on a continuation after update (old=%s)', async (old) => {
    vi.stubEnv('TAKT_TEST_DSH_ERROR', 'timeout');
    vi.stubEnv('TAKT_TEST_DSH_FIRST_SUCCESS', '1');
    vi.stubEnv('DEEPSEEK_API_KEY', 'TAKT_DUMMY_MANAGED_TEST_CREDENTIAL');
    if (old) await makeOldDeepSeekInstallation();
    else await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const loaded = await getReadyDeepSeekHarnessPackageDirectory();
    const log = join(temporaryRoot, 'sdk-calls.log');
    vi.stubEnv('TAKT_TEST_DSH_CALL_LOG', log);
    const first = await callDeepSeekHarness('worker', 'Create a continuation', { cwd: temporaryRoot });
    expect(first).toMatchObject({ status: 'done', sessionId: 'managed-session' });
    await installDeepSeekHarness({ npmPath: fakeNpmPath, force: true });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(loaded);
    const npmLog = join(temporaryRoot, 'npm-during-call.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', npmLog);
    const events: Array<{ type: string; data: unknown }> = [];
    const continued = await callDeepSeekHarness('worker', 'Same timeout on continuation', {
      cwd: temporaryRoot, sessionId: first.sessionId, onStream: (event) => events.push(event),
    });
    expect(continued).toMatchObject({ status: 'error', failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT });
    expect(continued.error?.includes('takt update')).toBe(old);
    expect(JSON.stringify(events.at(-1)).includes('takt update')).toBe(old);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(Array(2).fill(pathToFileURL(join(loaded, 'node_modules/@deepseek-ai/dsh-sdk-client/index.js')).href));
    expect(existsSync(npmLog)).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('adds update advice to an older SDK error while preserving its timeout classification', async () => {
    vi.stubEnv('TAKT_TEST_DSH_ERROR', 'timeout');
    await makeOldDeepSeekInstallation();
    vi.stubEnv('DEEPSEEK_API_KEY', 'TAKT_DUMMY_MANAGED_TEST_CREDENTIAL');
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const events: Array<{ type: string; data: unknown }> = [];
    const response = await callDeepSeekHarness('worker', 'Cause a timeout in an older SDK', {
      cwd: temporaryRoot, onStream: (event) => events.push(event),
    });
    expect(response).toMatchObject({ status: 'error', failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT });
    expect(response.error).toContain('SDK request timed out');
    expect(response.error).toContain('takt update');
    expect(response.error!.match(/takt update/gu)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'result', data: { success: false, failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT } });
    expect(mockConfirm).not.toHaveBeenCalled();
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects damage in an older SDK instead of treating it as usable version drift', async () => {
    const directory = await makeOldDeepSeekInstallation();
    await writeFile(join(directory, 'node_modules/@deepseek-ai/dsh-sdk-client/index.js'), 'damaged');
    await expect(loadManagedDeepSeekHarnessModules()).rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
  });

  it.each([{ target: [] }, { target: ['deepseek-harness'] }])('updates an installed older DeepSeek SDK through update $target', async ({ target }) => {
    const previous = await makeOldDeepSeekInstallation();
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const result = await runManagedCli(['update', ...target]);
    expect(result.code, result.output).toBe(0);
    const directory = await getReadyDeepSeekHarnessPackageDirectory();
    expect(JSON.parse(await readFile(join(directory, 'node_modules/@deepseek-ai/dsh-sdk-client/package.json'), 'utf8')))
      .toMatchObject({ version: '0.2.0-rc.2' });
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(await readFile(join(previous, 'node_modules/@deepseek-ai/dsh-sdk-client/package.json'), 'utf8')))
      .toMatchObject({ version: '0.2.0-rc.1' });
  });

  it.each(['ready', 'missing'] as const)('does not run npm for an already %s provider during update', async (state) => {
    if (state === 'ready') await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = state === 'ready' ? await getReadyDeepSeekHarnessPackageDirectory() : undefined;
    const log = join(temporaryRoot, 'npm-calls.jsonl');
    vi.stubEnv('TAKT_TEST_NPM_LOG', log);
    const result = await runManagedCli(['update']);
    expect(result.code, result.output).toBe(0);
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
    if (previous !== undefined) expect(await getReadyDeepSeekHarnessPackageDirectory()).toBe(previous);
    else await expect(getReadyDeepSeekHarnessPackageDirectory()).rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
  });

  it('requires installation and leaves a ready install unchanged on repeated invocation', async () => {
    await expect(getReadyDeepSeekHarnessPackageDirectory()).rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    const missing = await callDeepSeekHarness('worker', 'missing install', { cwd: temporaryRoot });
    expect(missing).toMatchObject({ status: 'error', content: expect.stringContaining('takt install deepseek-harness') });

    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const first = await getReadyDeepSeekHarnessPackageDirectory();
    expect((await loadManagedDeepSeekHarnessModules()).directory).toBe(first);
    expect((await readFile(join(first, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))).toContain('0.2.0-rc.2');

    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toBe(first);
  });

  it('replaces a ready generation through the CLI --force option', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const npmExecutable = join(temporaryRoot, 'npm');
    await writeFile(npmExecutable, '#!/bin/sh\nexec node "$TAKT_TEST_FAKE_NPM_SCRIPT" "$@"\n');
    await chmod(npmExecutable, 0o755);
    const child = spawn(process.execPath, ['--import', 'tsx', cliSource, 'install', 'deepseek-harness', '--force'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${temporaryRoot}${delimiter}${process.env.PATH ?? ''}`,
        TAKT_TEST_FAKE_NPM_SCRIPT: fakeNpmPath,
      },
      stdio: 'ignore',
    });
    const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it('keeps a ready generation when --force fails to validate its replacement', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    vi.stubEnv('TAKT_TEST_NPM_MISSING_EXPORT', '1');
    await expect(installDeepSeekHarness({ npmPath: fakeNpmPath, force: true }))
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toBe(previous);
  });

  it.skipIf(process.platform !== 'darwin')('accepts the macOS /var filesystem alias', async () => {
    const aliasRoot = await mkdtemp(join(tmpdir(), 'takt-deepseek-alias-'));
    try {
      vi.stubEnv('TAKT_CONFIG_DIR', join(aliasRoot, 'config'));
      await installDeepSeekHarness({ npmPath: fakeNpmPath });
      await getReadyDeepSeekHarnessPackageDirectory();
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('keeps the previous ready install when a replacement npm ci fails', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const manifestPath = join(temporaryRoot, 'changed-package.json');
    const lockPath = join(temporaryRoot, 'changed-package-lock.json');
    const manifest = JSON.parse(await readFile(manifestSource, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, description: 'new release' })}\n`);
    await copyFile(lockSource, lockPath);
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');

    await expect(installDeepSeekHarness({
      npmPath: fakeNpmPath,
      assetPaths: { manifestPath, lockPath },
    })).rejects.toThrow(/npm ci failed/u);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toBe(previous);
    expect((await readdir(getDeepSeekHarnessManagedPackagePaths().root))
      .filter((name) => name.startsWith('.sdk-stage-') || name.startsWith('.sdk-link-'))).toEqual([]);
  });

  it('replaces a damaged install with a validated one', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    await rm(join(previous, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'index.js'));
    await expect(getReadyDeepSeekHarnessPackageDirectory()).rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);

    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const repaired = await getReadyDeepSeekHarnessPackageDirectory();
    expect(repaired).not.toBe(previous);
  });

  it('repairs a broken SDK entry even after the module was imported', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    await loadManagedDeepSeekHarnessModules();
    await writeFile(join(previous, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'index.js'), 'invalid JavaScript !');
    await expect(getReadyDeepSeekHarnessPackageDirectory()).rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it('does not publish an SDK without its required export', async () => {
    vi.stubEnv('TAKT_TEST_NPM_MISSING_EXPORT', '1');
    await expect(installDeepSeekHarness({ npmPath: fakeNpmPath }))
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
  });

  it('repairs a damaged runtime executable', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const first = await getReadyDeepSeekHarnessPackageDirectory();
    await writeFile(join(first, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'damaged');
    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const second = await getReadyDeepSeekHarnessPackageDirectory();
    expect(second).not.toBe(first);
  });

  const ptyFiles: Array<[string, string]> = [
    ['entry', 'lib/index.js'],
    ['native binary', `prebuilds/${process.platform}-${process.arch}/pty.node`],
    ...(process.platform === 'darwin'
      ? [['spawn-helper', `prebuilds/${process.platform}-${process.arch}/spawn-helper`] as [string, string]]
      : []),
  ];
  it.each(ptyFiles.flatMap(([label, file]) => [
    [label, file, 'changes'] as const,
    [label, file, 'disappears'] as const,
  ]))('repairs node-pty %s (%s) when it %s', async (_label, file, change) => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const target = join(previous, 'node_modules', 'node-pty', file);
    if (change === 'changes') await writeFile(target, 'damaged');
    else await rm(target);
    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it.skipIf(process.platform !== 'darwin')('repairs a spawn-helper without owner execute permission', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    await chmod(join(previous, 'node_modules', 'node-pty', 'prebuilds',
      `${process.platform}-${process.arch}`, 'spawn-helper'), 0o644);
    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it('preserves a damaged generation until its replacement passes validation', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const previousLink = await readlink(getDeepSeekHarnessManagedPackagePaths().current);
    await writeFile(join(previous, 'node_modules', 'node-pty', 'lib', 'index.js'), 'damaged');
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '1');
    await expect(installDeepSeekHarness({ npmPath: fakeNpmPath })).rejects.toThrow(/npm ci failed/u);
    expect(await readlink(getDeepSeekHarnessManagedPackagePaths().current)).toBe(previousLink);
    vi.stubEnv('TAKT_TEST_NPM_FAIL', '0');
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await getReadyDeepSeekHarnessPackageDirectory()).not.toBe(previous);
  });

  it('rejects an unsupported platform before inspecting a managed install', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await expect(getReadyDeepSeekHarnessPackageDirectory())
        .rejects.toThrow(/Windows, macOS x64, and other platforms are not supported/u);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('recovers an old real SDK directory without removing unrelated state', async () => {
    const paths = getDeepSeekHarnessManagedPackagePaths();
    await mkdir(paths.current, { recursive: true });
    await copyFile(manifestSource, join(paths.current, 'package.json'));
    for (const name of ['dsh-home', 'state', 'credentials']) {
      await mkdir(join(paths.root, name));
      await writeFile(join(paths.root, name, 'sentinel'), 'preserve');
    }
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    expect(await readlink(paths.current)).toMatch(/^sdk-[a-f0-9-]+$/u);
    for (const name of ['dsh-home', 'state', 'credentials']) {
      expect(await readFile(join(paths.root, name, 'sentinel'), 'utf8')).toBe('preserve');
    }
    expect((await readdir(paths.root)).some((name) => name.startsWith('sdk-recovered-'))).toBe(true);
  });

  it('restores a displaced directory when publication fails normally', async () => {
    const paths = getDeepSeekHarnessManagedPackagePaths();
    await mkdir(paths.current, { recursive: true });
    await copyFile(manifestSource, join(paths.current, 'package.json'));
    await writeFile(join(paths.current, 'sentinel'), 'original SDK');

    await expect(installDeepSeekHarness({
      npmPath: fakeNpmPath,
      onDisplaced: () => { throw new Error('publication failed'); },
    })).rejects.toThrow('publication failed');
    expect(await readFile(join(paths.current, 'sentinel'), 'utf8')).toBe('original SDK');
    expect((await readdir(paths.root)).filter((name) => name.startsWith('.sdk-stage-')
      || name.startsWith('.sdk-link-') || name === 'sdk-recovered-pending'
      || name === '.sdk-recovery.json')).toEqual([]);
  });

  it('does not move an unrecorded recovery candidate with the same package name', async () => {
    const paths = getDeepSeekHarnessManagedPackagePaths();
    const candidate = join(paths.root, 'sdk-recovered-pending');
    await mkdir(candidate, { recursive: true });
    await copyFile(manifestSource, join(candidate, 'package.json'));
    await writeFile(join(candidate, 'sentinel'), 'unrelated');

    await expect(installDeepSeekHarness({ npmPath: fakeNpmPath }))
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    expect(await readFile(join(candidate, 'sentinel'), 'utf8')).toBe('unrelated');
    await expect(readFile(join(paths.current, 'sentinel'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores a displaced SDK directory after a process is killed before publication', async () => {
    const paths = getDeepSeekHarnessManagedPackagePaths();
    await mkdir(paths.current, { recursive: true });
    await copyFile(manifestSource, join(paths.current, 'package.json'));
    await writeFile(join(paths.current, 'sentinel'), 'original SDK');
    const script = `import { installDeepSeekHarness } from ${JSON.stringify(pathToFileURL(fileURLToPath(installerSource)).href)};
await installDeepSeekHarness({
  npmPath: ${JSON.stringify(fakeNpmPath)},
  onDisplaced: () => process.kill(process.pid, 'SIGKILL'),
});`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'ignore',
    });
    const [, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    expect(signal).toBe('SIGKILL');
    expect((await readdir(paths.root))).toContain('sdk-recovered-pending');
    expect((await readdir(paths.root))).toContain('.sdk-recovery.json');
    await expect(readFile(join(paths.current, 'sentinel'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(getReadyDeepSeekHarnessPackageDirectory())
      .rejects.toBeInstanceOf(DeepSeekHarnessInstallRequiredError);
    expect(await readFile(join(paths.current, 'sentinel'), 'utf8')).toBe('original SDK');
    expect((await readdir(paths.root))).not.toContain('sdk-recovered-pending');
    expect((await readdir(paths.root))).not.toContain('.sdk-recovery.json');

    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    await getReadyDeepSeekHarnessPackageDirectory();
    const recovered = (await readdir(paths.root)).find((name) => name.startsWith('sdk-recovered-'));
    expect(recovered).toBeDefined();
    expect(await readFile(join(paths.root, recovered!, 'sentinel'), 'utf8')).toBe('original SDK');
    expect((await readdir(paths.root))).not.toContain('sdk-recovered-pending');
  });

  it.each([
    ['SIGINT', undefined, 130],
    ['SIGTERM', undefined, 143],
    ['SIGINT', 'SIGTERM', 130],
    ['SIGTERM', 'SIGINT', 143],
  ] as const)('stops npm and permits a new CLI install after %s then %s', async (interrupt, next, expectedCode) => {
    const npmExecutable = join(temporaryRoot, 'npm');
    await writeFile(npmExecutable, '#!/bin/sh\nexec node "$TAKT_TEST_FAKE_NPM_SCRIPT" "$@"\n');
    await chmod(npmExecutable, 0o755);
    const bareNodePath = join(temporaryRoot, 'node-without-npm', 'bin', 'node');
    await mkdir(dirname(bareNodePath), { recursive: true });
    await symlink(process.execPath, bareNodePath);
    const noBundledNpm = join(temporaryRoot, 'no-bundled-npm.cjs');
    await writeFile(noBundledNpm, `process.execPath = ${JSON.stringify(bareNodePath)};\n`);
    const pidFile = join(temporaryRoot, 'npm.pid');
    const signalFile = join(temporaryRoot, 'npm-signal');
    const environment = {
      ...process.env,
      PATH: `${temporaryRoot}${delimiter}${process.env.PATH ?? ''}`,
      TAKT_TEST_NPM_HANG: '1',
      TAKT_TEST_NPM_PID_FILE: pidFile,
      TAKT_TEST_NPM_SIGNAL_FILE: next === undefined ? '' : signalFile,
      TAKT_TEST_FAKE_NPM_SCRIPT: fakeNpmPath,
    };
    const first = spawn(process.execPath, ['--require', noBundledNpm, '--import', 'tsx', cliSource, 'install', 'deepseek-harness'], {
      cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let firstOutput = '';
    first.stdout.on('data', (chunk: Buffer) => { firstOutput += chunk.toString(); });
    first.stderr.on('data', (chunk: Buffer) => { firstOutput += chunk.toString(); });
    const npmPid = Number(await waitForFile(pidFile, first, () => firstOutput));
    first.kill(interrupt);
    if (next !== undefined) {
      await waitForFile(signalFile, first, () => firstOutput);
      expect(first.kill(next)).toBe(true);
    }
    const [code] = await once(first, 'close') as [number | null, NodeJS.Signals | null];
    expect(code).toBe(expectedCode);
    expect(() => process.kill(npmPid, 0)).toThrow();
    const paths = getDeepSeekHarnessManagedPackagePaths();
    expect((await readdir(paths.root)).filter((name) => name.startsWith('.sdk-stage-'))).toEqual([]);
    await expect(readFile(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });

    const second = spawn(process.execPath, ['--require', noBundledNpm, '--import', 'tsx', cliSource, 'install', 'deepseek-harness'], {
      cwd: process.cwd(),
      env: { ...environment, TAKT_TEST_NPM_HANG: '0', TAKT_TEST_NPM_PID_FILE: '' },
      stdio: 'ignore',
    });
    const [secondCode] = await once(second, 'close') as [number | null, NodeJS.Signals | null];
    expect(secondCode).toBe(0);
    await getReadyDeepSeekHarnessPackageDirectory();
  });

  it('stops a hung npm install and removes its staging directory', async () => {
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
    const previous = await getReadyDeepSeekHarnessPackageDirectory();
    const manifestPath = join(temporaryRoot, 'next-package.json');
    const lockPath = join(temporaryRoot, 'next-package-lock.json');
    const manifest = JSON.parse(await readFile(manifestSource, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, description: 'next release' })}\n`);
    await copyFile(lockSource, lockPath);
    vi.stubEnv('TAKT_TEST_NPM_HANG', '1');
    await expect(installDeepSeekHarness({
      npmPath: fakeNpmPath,
      npmTimeoutMs: 100,
      assetPaths: { manifestPath, lockPath },
    }))
      .rejects.toThrow(/timed out/u);
    expect((await readdir(getDeepSeekHarnessManagedPackagePaths().root))
      .filter((name) => name.startsWith('.sdk-stage-') || name.startsWith('.sdk-link-'))).toEqual([]);
    expect(await getReadyDeepSeekHarnessPackageDirectory()).toBe(previous);
    vi.stubEnv('TAKT_TEST_NPM_HANG', '0');
    await installDeepSeekHarness({ npmPath: fakeNpmPath });
  });
});
