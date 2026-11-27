/**
 * Read-deny wiring across the Claude providers.
 *
 * The user's ~/.claude/settings.json is a real file under an isolated HOME.
 * Everything between the provider call and the replaced boundaries below is
 * production code. The test doubles are:
 * - the managed provider loader, replaced by a helper that returns the installed SDK modules
 * - the Claude SDK `query` function
 * - the headless CLI spawn (`runHeadlessCli`)
 * - the Claude CLI skill-disable capability check (`assertClaudeSkillsDisableSupported`)
 * - the SDK runtime check used by preflight (`assertClaudeSdkRuntime`)
 * - the terminal client (`callClaudeTerminal`)
 * - the UI `warn` output, which records import warnings
 * No real Claude process is started, so whether Claude itself refuses a Read
 * is not observed here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));

const { queryMock, runHeadlessCliMock, callClaudeTerminalMock, warnMock, assertSdkRuntimeMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  runHeadlessCliMock: vi.fn(),
  callClaudeTerminalMock: vi.fn(),
  warnMock: vi.fn<(message: string) => void>(),
  assertSdkRuntimeMock: vi.fn(async (_options: Record<string, unknown>) => {}),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: queryMock,
}));

vi.mock('../infra/claude-headless/headless-spawn.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/claude-headless/headless-spawn.js')>(),
  runHeadlessCli: runHeadlessCliMock,
}));

vi.mock('../infra/claude/cli-capability.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/claude/cli-capability.js')>(),
  assertClaudeSkillsDisableSupported: vi.fn(async () => {}),
}));

vi.mock('../infra/claude/sdk-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/claude/sdk-runtime.js')>(),
  assertClaudeSdkRuntime: assertSdkRuntimeMock,
}));

vi.mock('../infra/claude-terminal/client.js', () => ({
  callClaudeTerminal: callClaudeTerminalMock,
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared/ui/index.js')>(),
  warn: warnMock,
}));

import { ClaudeProvider } from '../infra/providers/claude.js';
import { ClaudeHeadlessProvider } from '../infra/providers/claude-headless.js';
import { ClaudeTerminalProvider } from '../infra/providers/claude-terminal.js';
import { getProvider } from '../infra/providers/index.js';
import type { ProviderCallOptions } from '../infra/providers/types.js';

type ClaudePermissions = NonNullable<NonNullable<NonNullable<ProviderCallOptions['providerOptions']>['claude']>['permissions']>;
type LaunchVariant = 'setup' | 'setup with system prompt' | 'isolated structured';

const LAUNCH_VARIANTS: readonly LaunchVariant[] = ['setup', 'setup with system prompt', 'isolated structured'];
const OUTPUT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
const READ_DENY_FROM_FILE = ['Read(./.env)', 'Bash(rm -rf:*)', 'mcp__example'];

interface ClaudeLauncher {
  readonly name: string;
  readonly provider: ClaudeProvider | ClaudeHeadlessProvider;
  expectLaunchedOnce(): void;
  observeSettings(): Record<string, unknown> | undefined;
}

let homeDir: string;
let projectDir: string;
let originalHome: string | undefined;

function settingsPath(): string {
  return join(homeDir, '.claude', 'settings.json');
}

function writeUserSettings(content: string): void {
  mkdirSync(join(homeDir, '.claude'), { recursive: true });
  writeFileSync(settingsPath(), content, 'utf-8');
}

function writeUserDeny(deny: unknown): void {
  writeUserSettings(JSON.stringify({ permissions: { deny } }));
}

function parseInlineSettings(settings: unknown): Record<string, unknown> | undefined {
  if (settings === undefined) {
    return undefined;
  }
  return (typeof settings === 'string' ? JSON.parse(settings) : settings) as Record<string, unknown>;
}

function createSdkQuery() {
  return {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown> {
      yield { type: 'result', subtype: 'success', result: 'done', structured_output: {} };
    },
  };
}

const sdkLauncher: ClaudeLauncher = {
  name: 'claude-sdk',
  provider: new ClaudeProvider(),
  expectLaunchedOnce: () => expect(queryMock).toHaveBeenCalledTimes(1),
  observeSettings: () => parseInlineSettings(queryMock.mock.calls[0]![0].options.settings),
};

const headlessLauncher: ClaudeLauncher = {
  name: 'claude-headless',
  provider: new ClaudeHeadlessProvider(),
  expectLaunchedOnce: () => expect(runHeadlessCliMock).toHaveBeenCalledTimes(1),
  observeSettings: () => {
    const argv = runHeadlessCliMock.mock.calls[0]![0] as string[];
    const settingsIndex = argv.indexOf('--settings');
    return settingsIndex < 0 ? undefined : JSON.parse(argv[settingsIndex + 1]!) as Record<string, unknown>;
  },
};

const LAUNCHERS = [sdkLauncher, headlessLauncher] as const;

async function launch(
  launcher: ClaudeLauncher,
  variant: LaunchVariant,
  permissions: ClaudePermissions | undefined,
): Promise<void> {
  const callOptions: ProviderCallOptions = {
    cwd: projectDir,
    providerOptions: permissions === undefined ? undefined : { claude: { permissions } },
  };
  if (variant === 'isolated structured') {
    await launcher.provider.setupIsolatedStructured({ name: 'judge' }).call('judge this', {
      ...callOptions,
      outputSchema: OUTPUT_SCHEMA,
    });
    return;
  }
  const setup = variant === 'setup'
    ? { name: 'coder' }
    : { name: 'assistant', systemPrompt: 'You are the assistant.' };
  await launcher.provider.setup(setup).call('do the work', callOptions);
}

function observedDeny(launcher: ClaudeLauncher): string[] | undefined {
  const settings = launcher.observeSettings();
  return (settings?.permissions as { deny?: string[] } | undefined)?.deny;
}

function importWarnings(): string[] {
  return warnMock.mock.calls
    .map(([message]) => message)
    .filter((message) => message.includes(settingsPath()));
}

function expectSameRules(actual: readonly string[] | undefined, expected: readonly string[]): void {
  expect(actual).toBeDefined();
  expect(actual).toHaveLength(expected.length);
  expect(new Set(actual)).toEqual(new Set(expected));
}

beforeEach(() => {
  originalHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'takt-read-deny-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'takt-read-deny-project-'));
  process.env.HOME = homeDir;
  queryMock.mockReset();
  queryMock.mockImplementation(() => createSdkQuery());
  runHeadlessCliMock.mockReset();
  runHeadlessCliMock.mockResolvedValue({
    stdout: `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done', structured_output: {} })}\n`,
    stderr: '',
  });
  assertSdkRuntimeMock.mockClear();
  callClaudeTerminalMock.mockReset();
  callClaudeTerminalMock.mockResolvedValue({
    persona: 'coder',
    status: 'done',
    content: 'done',
    timestamp: new Date(),
  });
  warnMock.mockReset();
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe.each(LAUNCHERS)('$name receives the read-deny rules', (launcher) => {
  describe.each(LAUNCH_VARIANTS)('launched through %s', (variant) => {
    it('Given import on and TAKT deny, When the file has Read( and non-Read( rules, Then Claude gets the union of Read( rules only', async () => {
      writeUserDeny(READ_DENY_FROM_FILE);

      await launch(launcher, variant, { deny: ['Read(./.env)', 'Read(~/.ssh/**)'], importUserReadDeny: true });

      launcher.expectLaunchedOnce();
      const deny = observedDeny(launcher);
      expectSameRules(deny, ['Read(./.env)', 'Read(~/.ssh/**)']);
      expect(deny!.every((rule) => rule.startsWith('Read('))).toBe(true);
      expect(Object.keys(launcher.observeSettings()!)).toEqual(['permissions']);
      expect(importWarnings()).toEqual([]);
    });
  });

  it('Given import on and no TAKT deny, When the file has Read( rules, Then Claude gets the imported Read( rules', async () => {
    writeUserDeny(['Read(**/*.pem)', 'Bash(curl:*)']);

    await launch(launcher, 'setup', { importUserReadDeny: true });

    launcher.expectLaunchedOnce();
    expectSameRules(observedDeny(launcher), ['Read(**/*.pem)']);
  });

  it('Given import off, When TAKT deny is set and the file has Read( rules, Then Claude gets only the TAKT deny', async () => {
    writeUserDeny(['Read(./.env)']);

    await launch(launcher, 'setup', { deny: ['Read(~/.ssh/**)'], importUserReadDeny: false });

    launcher.expectLaunchedOnce();
    expectSameRules(observedDeny(launcher), ['Read(~/.ssh/**)']);
    expect(importWarnings()).toEqual([]);
  });

  it.each([
    ['does not exist', undefined],
    ['is not valid JSON', '{ "permissions": '],
  ])('Given import on, When the settings file %s, Then it warns once and Claude still starts with only the TAKT deny', async (_state, content) => {
    if (content !== undefined) {
      writeUserSettings(content);
    }

    await launch(launcher, 'setup', { deny: ['Read(~/.ssh/**)'], importUserReadDeny: true });

    launcher.expectLaunchedOnce();
    expectSameRules(observedDeny(launcher), ['Read(~/.ssh/**)']);
    expect(importWarnings()).toHaveLength(1);
  });

  it('Given import on and no TAKT deny, When the file has no Read( rules, Then Claude starts without deny and without a warning', async () => {
    writeUserDeny(['Bash(rm -rf:*)']);

    await launch(launcher, 'setup', { importUserReadDeny: true });

    launcher.expectLaunchedOnce();
    expect(launcher.observeSettings()).toBeUndefined();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no permissions', undefined],
    ['import explicitly off', { importUserReadDeny: false }],
  ])('Given %s, When the file has Read( rules, Then Claude starts without deny and without a warning', async (_state, permissions) => {
    writeUserDeny(['Read(./.env)']);

    await launch(launcher, 'setup', permissions);

    launcher.expectLaunchedOnce();
    expect(launcher.observeSettings()).toBeUndefined();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('Given import on, When the file changes between two launches, Then each launch reflects the file at that launch', async () => {
    writeUserDeny(['Read(./.env)']);
    await launch(launcher, 'setup', { importUserReadDeny: true });
    const firstDeny = observedDeny(launcher);

    queryMock.mockClear();
    runHeadlessCliMock.mockClear();
    writeUserDeny(['Read(~/.aws/**)']);
    await launch(launcher, 'setup', { importUserReadDeny: true });

    expectSameRules(firstDeny, ['Read(./.env)']);
    expectSameRules(observedDeny(launcher), ['Read(~/.aws/**)']);
  });
});

describe('claude-sdk deny rules next to other launch settings', () => {
  it('Given a sandbox option and deny rules, When launching, Then the SDK receives both', async () => {
    writeUserDeny(['Read(./.env)']);

    await sdkLauncher.provider.setup({ name: 'coder' }).call('do the work', {
      cwd: projectDir,
      providerOptions: {
        claude: {
          sandbox: { allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] },
          permissions: { importUserReadDeny: true },
        },
      },
    });

    const sdkOptions = queryMock.mock.calls[0]![0].options;
    expect(sdkOptions.sandbox).toEqual({ allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] });
    expectSameRules(observedDeny(sdkLauncher), ['Read(./.env)']);
  });

  it('Given deny rules, When launching, Then ambient user settings are not loaded to carry non-Read( rules', async () => {
    writeUserDeny(['Read(./.env)', 'Bash(rm -rf:*)']);

    await launch(sdkLauncher, 'setup', { importUserReadDeny: true });

    expect(queryMock.mock.calls[0]![0].options.settingSources).not.toContain('user');
  });

  it('Given import on and a missing settings file, When running the preflight that does not launch Claude, Then no warning is issued and no deny rule reaches the runtime check', async () => {
    await new ClaudeProvider().preflight({
      cwd: projectDir,
      providerOptions: { claude: { permissions: { deny: ['Read(~/.ssh/**)'], importUserReadDeny: true } } },
    });

    expect(assertSdkRuntimeMock).toHaveBeenCalledTimes(1);
    expect(assertSdkRuntimeMock.mock.calls[0]![0]).not.toHaveProperty('settings');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('Given the claude provider alias, When launching with deny rules, Then the SDK receives them', async () => {
    const provider = getProvider('claude');

    await provider.setup({ name: 'coder' }).call('do the work', {
      cwd: projectDir,
      providerOptions: { claude: { permissions: { deny: ['Read(~/.ssh/**)'] } } },
    });

    expectSameRules(observedDeny(sdkLauncher), ['Read(~/.ssh/**)']);
  });
});

describe('claude-headless deny rules next to other launch settings', () => {
  it('Given a sandbox option and deny rules, When launching, Then --settings carries both', async () => {
    writeUserDeny(['Read(./.env)']);

    await headlessLauncher.provider.setup({ name: 'coder' }).call('do the work', {
      cwd: projectDir,
      providerOptions: {
        claude: {
          sandbox: { allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] },
          permissions: { importUserReadDeny: true },
        },
      },
    });

    expect(headlessLauncher.observeSettings()).toEqual({
      sandbox: { allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] },
      permissions: { deny: ['Read(./.env)'] },
    });
  });

  it('Given deny rules in isolated structured execution, When launching, Then ambient settings stay disabled and the deny rules are passed', async () => {
    writeUserDeny(['Read(./.env)']);

    await launch(headlessLauncher, 'isolated structured', { importUserReadDeny: true });

    const argv = runHeadlessCliMock.mock.calls[0]![0] as string[];
    expect(argv).toEqual(expect.arrayContaining(['--setting-sources', '']));
    expectSameRules(observedDeny(headlessLauncher), ['Read(./.env)']);
  });
});

describe('claude-terminal is out of scope', () => {
  function collectStrings(value: unknown): string[] {
    if (typeof value === 'string') {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.flatMap(collectStrings);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.entries(value).flatMap(([key, child]) => [key, ...collectStrings(child)]);
    }
    return [];
  }

  it('Given deny rules and import on, When launching claude-terminal, Then no deny rule or permissions key reaches the terminal client', async () => {
    writeUserDeny(['Read(~/.aws/**)']);

    await new ClaudeTerminalProvider().setup({ name: 'coder' }).call('do the work', {
      cwd: projectDir,
      providerOptions: {
        claude: { permissions: { deny: ['Read(./.env)'], importUserReadDeny: true } },
      },
    });

    expect(callClaudeTerminalMock).toHaveBeenCalledTimes(1);
    const passed = collectStrings(callClaudeTerminalMock.mock.calls[0]);
    for (const forbidden of ['Read(./.env)', 'Read(~/.aws/**)', 'permissions', 'denyRules']) {
      expect(passed.filter((text) => text.includes(forbidden))).toEqual([]);
    }
  });

  it('Given import on and a missing settings file, When launching claude-terminal, Then no import warning is issued', async () => {
    await new ClaudeTerminalProvider().setup({ name: 'coder' }).call('do the work', {
      cwd: projectDir,
      providerOptions: { claude: { permissions: { importUserReadDeny: true } } },
    });

    expect(callClaudeTerminalMock).toHaveBeenCalledTimes(1);
    expect(importWarnings()).toEqual([]);
  });
});
