/**
 * provider_options.claude.permissions.deny, from the project config file to the Claude launch arguments.
 *
 * Each caller below starts from a real `.takt/config.yaml` and goes through its own production code up to
 * the provider. The test doubles are the Claude SDK `query` function, the headless CLI spawn
 * (`runHeadlessCli`), the managed provider loader, and the two Claude preflight checks. No real Claude
 * process is started, so whether Claude itself refuses a Read is not observed here.
 *
 * Callers: a workflow step (Phase 1), the internal status judgment (Phase 3, isolated structured call),
 * and the interactive assistant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/managed-providers/loader.js')>(),
  ...await import('./helpers/managed-sdk.js'),
  inspectProviderInstallation: vi.fn(async () => ({ state: 'ready' as const, directory: '/test/managed-sdk' })),
  requireProviderInstallation: vi.fn(async () => ({ state: 'ready' as const, directory: '/test/managed-sdk' })),
}));

const { queryMock, runHeadlessCliMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  runHeadlessCliMock: vi.fn(),
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
  assertClaudeSdkRuntime: vi.fn(async () => {}),
}));

import { executeTask } from '../features/tasks/execute/taskExecution.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { initializeSession } from '../features/interactive/sessionInitialization.js';
import { invalidateGlobalConfigCache } from '../infra/config/index.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

type ClaudeProviderName = 'claude-sdk' | 'claude-headless';

interface ClaudeLaunch {
  /** The isolated structured call used by the status judgment carries an output schema. */
  readonly structured: boolean;
  readonly deny: readonly string[] | undefined;
}

const CONFIGURED_DENY = ['Read(./.env)', 'Read(~/.ssh/**)'];
const JUDGMENT_OUTPUT = { step: 1, reason: 'approved' };
const PROVIDERS: readonly ClaudeProviderName[] = ['claude-sdk', 'claude-headless'];

let homeDir: string;
let projectDir: string;
let originalHome: string | undefined;

function denyOf(settings: unknown): readonly string[] | undefined {
  if (settings === undefined) {
    return undefined;
  }
  const parsed = (typeof settings === 'string' ? JSON.parse(settings) : settings) as {
    permissions?: { deny?: string[] };
  };
  return parsed.permissions?.deny;
}

function sdkLaunches(): ClaudeLaunch[] {
  return queryMock.mock.calls.map(([params]) => ({
    structured: params.options.outputFormat !== undefined,
    deny: denyOf(params.options.settings),
  }));
}

function headlessLaunches(): ClaudeLaunch[] {
  return runHeadlessCliMock.mock.calls.map(([argv]) => {
    const args = argv as string[];
    const settingsIndex = args.indexOf('--settings');
    return {
      structured: args.includes('--json-schema'),
      deny: settingsIndex < 0 ? undefined : denyOf(args[settingsIndex + 1]),
    };
  });
}

function observedLaunches(provider: ClaudeProviderName): ClaudeLaunch[] {
  return provider === 'claude-sdk' ? sdkLaunches() : headlessLaunches();
}

function expectEveryLaunchHasConfiguredDeny(launches: readonly ClaudeLaunch[]): void {
  for (const launch of launches) {
    expect(launch.deny).toBeDefined();
    expect([...launch.deny!].sort()).toEqual([...CONFIGURED_DENY].sort());
  }
}

function writeProjectConfig(provider: ClaudeProviderName): void {
  writeFileSync(
    join(projectDir, '.takt', 'config.yaml'),
    [
      `provider: ${provider}`,
      'provider_options:',
      '  claude:',
      '    permissions:',
      '      deny:',
      ...CONFIGURED_DENY.map((rule) => `        - "${rule}"`),
    ].join('\n'),
    'utf-8',
  );
  invalidateGlobalConfigCache();
}

function writeWorkflowWithSemanticRules(): void {
  mkdirSync(join(projectDir, '.takt', 'workflows', 'personas'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'workflows', 'personas', 'planner.md'), 'You are planner.', 'utf-8');
  writeFileSync(
    join(projectDir, '.takt', 'workflows', 'permissions-wiring.yaml'),
    [
      'name: permissions-wiring',
      'max_steps: 3',
      'initial_step: plan',
      'steps:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: approved',
      '        next: COMPLETE',
      '      - condition: rejected',
      '        next: ABORT',
    ].join('\n'),
    'utf-8',
  );
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'fixture.ts'), 'export {};\n', 'utf-8');
  initializeGitFixture(projectDir, ['src/fixture.ts']);
}

function createSdkQuery() {
  return {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown> {
      yield { type: 'result', subtype: 'success', result: '[PLAN:1]\ndone', structured_output: JUDGMENT_OUTPUT };
    },
  };
}

beforeEach(() => {
  originalHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'takt-permissions-wiring-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'takt-permissions-wiring-project-'));
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  process.env.HOME = homeDir;
  queryMock.mockReset();
  queryMock.mockImplementation(() => createSdkQuery());
  runHeadlessCliMock.mockReset();
  runHeadlessCliMock.mockResolvedValue({
    stdout: `${JSON.stringify({ type: 'result', subtype: 'success', result: '[PLAN:1]\ndone', structured_output: JUDGMENT_OUTPUT })}\n`,
    stderr: '',
  });
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  invalidateGlobalConfigCache();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe.each(PROVIDERS)('%s receives the configured read-deny rules', (provider) => {
  it('Given deny rules in the project config, When a workflow step runs, Then the step launch and the status judgment launch both carry them', async () => {
    writeWorkflowWithSemanticRules();
    writeProjectConfig(provider);

    const ok = await executeTask({
      task: 'test task',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'permissions-wiring',
    });

    expect(ok).toBe(true);
    const launches = observedLaunches(provider);
    expect(launches.filter((launch) => !launch.structured)).not.toHaveLength(0);
    expect(launches.filter((launch) => launch.structured)).not.toHaveLength(0);
    expectEveryLaunchHasConfiguredDeny(launches);
  });

  it('Given deny rules in the project config, When the interactive assistant calls the provider, Then the launch carries them', async () => {
    writeProjectConfig(provider);

    const ctx = initializeSession(projectDir, 'interactive');
    const { result, error } = await callAIWithRetry('hello', 'You are the assistant.', undefined, projectDir, ctx, {
      outputMode: 'silent',
    });

    expect(error).toBeUndefined();
    expect(result).not.toBeNull();
    const launches = observedLaunches(provider);
    expect(launches).toHaveLength(1);
    expectEveryLaunchHasConfiguredDeny(launches);
  });
});
