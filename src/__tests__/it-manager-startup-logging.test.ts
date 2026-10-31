import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ReactElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { program } from '../app/cli/program.js';
import '../app/cli/commands.js';
import type { ConversationClientSnapshot } from '../features/manager/conversationIpcClient.js';
import { ensureDaemon } from '../features/daemon/lifecycle.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { isVerboseMode } from '../infra/config/project/resolvedSettings.js';
import { invalidateResolvedConfigCache, resolveConfigValue } from '../infra/config/resolveConfigValue.js';
import type { DaemonOwner } from '../infra/daemon/owner.js';
import { packageVersion } from '../shared/package-info.js';
import { setQuietMode } from '../shared/context.js';
import { setLogLevel } from '../shared/ui/LogManager.js';
import { resetDebugLogger } from '../shared/utils/debug.js';

const doubles = vi.hoisted(() => ({
  spawn: vi.fn(), readOwner: vi.fn(), startup: vi.fn(), session: vi.fn(),
  mount: vi.fn(), list: vi.fn(), ready: vi.fn(),
}));

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: doubles.spawn,
}));
vi.mock('../infra/daemon/owner.js', () => ({
  readDaemonOwner: doubles.readOwner, isDaemonOwnerRunning: () => true, removeDaemonOwner: vi.fn(),
}));
vi.mock('../features/daemon/conversationReadiness.js', () => ({ isConversationIpcReady: doubles.ready }));
vi.mock('../shared/utils/cli-invocation.js', () => ({
  resolveCliInvocation: () => ({ cliPath: '/test/cli.js', args: ['/test/cli.js', 'daemon'] }),
}));
vi.mock('../app/cli/updateCheck.js', () => ({ runUpdateCheck: vi.fn() }));
vi.mock('../infra/git/index.js', () => ({ initGitProvider: vi.fn() }));
vi.mock('../infra/config/global/projectRegistry.js', () => ({ registerProject: vi.fn() }));
vi.mock('../features/manager/startupResolution.js', () => ({ resolveManagerStartup: doubles.startup }));
vi.mock('../features/manager/conversationIpcClient.js', () => ({
  ConversationIpcClient: class {
    constructor() { Object.assign(this, doubles.session()); }
  },
}));
vi.mock('../features/tui/inkMount.js', () => ({ mountInk: doubles.mount }));
vi.mock('../features/tasks/list/index.js', () => ({ listTasks: doubles.list }));

describe('manager startup logging with global debug configuration', () => {
  let cwd: string;
  let app: ReturnType<typeof render> | undefined;
  let stdout: string[];
  let stderr: string[];
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  beforeEach(() => {
    vi.clearAllMocks();
    program.setOptionValue('model', undefined);
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'takt-manager-logging-')));
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  auto_run: false\n');
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), 'language: en\nlogging:\n  level: debug\n');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    invalidateGlobalConfigCache();
    invalidateResolvedConfigCache(cwd);
    resetDebugLogger();
    expect(resolveConfigValue(cwd, 'logging')?.level).toBe('debug');
    expect(isVerboseMode(cwd)).toBe(true);

    const assignment = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
    doubles.startup.mockResolvedValue({ kind: 'ready', context: { cwd, assignment } });
    const snapshot: ConversationClientSnapshot = { connection: 'connected', readStatus: 'complete', state: null, items: [], error: null };
    doubles.session.mockReturnValue({
      connect: async () => { await ensureDaemon(); },
      getSnapshot: () => snapshot, subscribe: () => () => {}, onOutput: () => () => {},
      submit: vi.fn(), refresh: async () => {}, close: () => {},
    });
    const owner: DaemonOwner = {
      pid: 4321, identity: { startTime: 'darwin-start-v2:12345' },
      version: packageVersion, cliPath: '/test/cli.js',
    };
    doubles.readOwner.mockReset().mockReturnValue(undefined);
    doubles.ready.mockReset().mockResolvedValue(true);
    doubles.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: owner.pid, exitCode: null, signalCode: null, unref: vi.fn(),
      });
      queueMicrotask(() => { doubles.readOwner.mockReturnValue(owner); child.emit('spawn'); });
      return child;
    });
    doubles.mount.mockImplementation(async (buildTree: (handlers: { settle: () => void; fail: (error: unknown) => void }) => ReactElement) => {
      let startupFailure: unknown;
      app = render(buildTree({ settle: () => {}, fail: (error) => { startupFailure = error; } }));
      await vi.waitFor(() => {
        expect(startupFailure).toBeUndefined();
        expect(app!.lastFrame()).toContain(`Assignment: ${basename(cwd)}`);
        expect(app!.lastFrame()).toContain('Discuss your goal');
        expect(app!.lastFrame()).not.toContain('Working');
      });
      app.unmount();
    });
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
  });

  afterEach(() => {
    app?.unmount();
    app = undefined;
    cleanup();
    resetDebugLogger();
    setLogLevel('info');
    setQuietMode(false);
    invalidateGlobalConfigCache();
    invalidateResolvedConfigCache(cwd);
    vi.restoreAllMocks();
    for (const [stream, descriptor] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else Reflect.deleteProperty(stream, 'isTTY');
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  async function parse(args: string[]): Promise<void> {
    await program.parseAsync(['node', 'takt', ...args]);
  }

  function readDebugLog(): string {
    const runs = join(cwd, '.takt', 'runs');
    const debugRuns = readdirSync(runs).filter((name) => name.startsWith('debug-'));
    expect(debugRuns.length).toBeGreaterThan(0);
    return debugRuns.flatMap((run) => {
      const logs = join(runs, run, 'logs');
      return readdirSync(logs).filter((name) => name.endsWith('.log'))
        .map((name) => readFileSync(join(logs, name), 'utf8'));
    }).join('\n');
  }

  it('keeps CLI and daemon startup logs out of all screen output while rendering the initial manager view', async () => {
    await parse(['manager']);

    expect(doubles.mount).toHaveBeenCalledOnce();
    expect(doubles.spawn).toHaveBeenCalledOnce();
    expect(readDebugLog()).toContain('[INFO] [daemon] Daemon startup confirmed');
    const screenLines = [stdout.join(''), stderr.join(''), ...app!.frames].join('\n').split(/\r?\n/u)
      .map((line) => stripVTControlCharacters(line));
    const startupLogLines = screenLines.filter((line) =>
      /\[(?:TRACE|DEBUG|INFO|WARN|ERROR)\]\s*\[(?:cli|daemon)\]/iu.test(line)
      || /TAKT\s+CLI\s+starting|Daemon\s+startup\s+confirmed/iu.test(line));
    expect(startupLogLines).toEqual([]);
  });

  it('retains the CLI startup entry in the project debug log after opening the manager', async () => {
    await parse(['manager']);

    expect(doubles.mount).toHaveBeenCalledOnce();
    const persisted = readDebugLog();
    expect(persisted).toContain('[INFO] [cli] TAKT CLI starting');
    expect(persisted).toContain('"verbose": true');
  });

  it.each([
    { args: ['list'] }, { args: ['--model', 'manager', 'list'] }, { args: ['--model=manager', 'list'] },
  ])('preserves CLI startup output on stderr for $args', async ({ args }) => {
    await parse(args);

    expect(doubles.list).toHaveBeenCalledOnce();
    expect(stderr.join('')).toContain('[INFO] [cli] TAKT CLI starting');
    expect(doubles.mount).not.toHaveBeenCalled();
  });
});
