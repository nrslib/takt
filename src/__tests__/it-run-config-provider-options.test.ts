import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  sendSlackNotification: vi.fn(),
  getSlackWebhookUrl: vi.fn(() => undefined),
}));

import { runAllTasks } from '../features/tasks/index.js';
import { TaskRunner } from '../infra/task/index.js';
import { runAgent } from '../agents/runner.js';
import { invalidateGlobalConfigCache } from '../infra/config/index.js';

const runAllTasksNoWorkflow = runAllTasks as (projectCwd: string) => ReturnType<typeof runAllTasks>;

interface TestEnv {
  root: string;
  projectDir: string;
  globalDir: string;
}

function createEnv(): TestEnv {
  const root = join(tmpdir(), `takt-it-run-config-${randomUUID()}`);
  const projectDir = join(root, 'project');
  const globalDir = join(root, 'global');

  mkdirSync(join(projectDir, '.takt', 'workflows', 'personas'), { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  writeFileSync(
    join(projectDir, '.takt', 'workflows', 'run-config-it.yaml'),
    [
      'name: run-config-it',
      'description: run config provider options integration test',
      'max_steps: 3',
      'initial_step: plan',
      'steps:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(join(projectDir, '.takt', 'workflows', 'personas', 'planner.md'), 'You are planner.', 'utf-8');

  return { root, projectDir, globalDir };
}

function setGlobalConfig(globalDir: string, body: string): void {
  writeFileSync(join(globalDir, 'config.yaml'), body, 'utf-8');
}

function setProjectConfig(projectDir: string, body: string): void {
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), body, 'utf-8');
}

function mockDoneResponse() {
  return {
    persona: 'planner',
    status: 'done',
    content: '[PLAN:1]\ndone',
    timestamp: new Date(),
    sessionId: 'session-it',
  };
}

describe('IT: runAllTasks provider_options reflection', () => {
  let env: TestEnv;
  let originalConfigDir: string | undefined;
  let originalEnvCodex: string | undefined;
  let originalEnvOpencodeVariant: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createEnv();
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    originalEnvCodex = process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    originalEnvOpencodeVariant = process.env.TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT;
    process.env.TAKT_CONFIG_DIR = env.globalDir;
    delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    delete process.env.TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT;
    invalidateGlobalConfigCache();

    vi.mocked(runAgent).mockResolvedValue(mockDoneResponse());

    const runner = new TaskRunner(env.projectDir);
    runner.addTask('test task', { workflow: 'run-config-it' });
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    if (originalEnvCodex === undefined) {
      delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    } else {
      process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = originalEnvCodex;
    }
    if (originalEnvOpencodeVariant === undefined) {
      delete process.env.TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT;
    } else {
      process.env.TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT = originalEnvOpencodeVariant;
    }
    invalidateGlobalConfigCache();
    rmSync(env.root, { recursive: true, force: true });
  });

  it('global opencode variant should be passed in runAllTasks flow', async () => {
    setGlobalConfig(env.globalDir, [
      'provider_options:',
      '  opencode:',
      '    variant: high',
    ].join('\n'));

    await runAllTasksNoWorkflow(env.projectDir);

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      opencode: { variant: 'high' },
    });
  });

  it('project opencode variant should be passed in runAllTasks flow', async () => {
    setProjectConfig(env.projectDir, [
      'provider_options:',
      '  opencode:',
      '    variant: high',
    ].join('\n'));

    await runAllTasksNoWorkflow(env.projectDir);

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      opencode: { variant: 'high' },
    });
  });

  it('project provider_options should override global in runAllTasks flow', async () => {
    setGlobalConfig(env.globalDir, [
      'provider_options:',
      '  codex:',
      '    network_access: true',
    ].join('\n'));
    setProjectConfig(env.projectDir, [
      'provider_options:',
      '  codex:',
      '    network_access: false',
    ].join('\n'));

    await runAllTasksNoWorkflow(env.projectDir);

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });

  it('project persona_providers provider_options should override project provider_options in runAllTasks flow', async () => {
    setProjectConfig(env.projectDir, [
      'provider: claude',
      'provider_options:',
      '  claude:',
      '    allowed_tools:',
      '      - Read',
      'persona_providers:',
      '  planner:',
      '    provider_options:',
      '      claude:',
      '        allowed_tools:',
      '          - Read',
      '          - Edit',
    ].join('\n'));

    await runAllTasksNoWorkflow(env.projectDir);

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Edit'] },
    });
    expect(options?.allowedTools).toEqual(['Read', 'Edit']);
  });

  it('project persona_providers opencode variant should override project provider_options in runAllTasks flow', async () => {
    setProjectConfig(env.projectDir, [
      'provider: opencode',
      'provider_options:',
      '  opencode:',
      '    network_access: true',
      '    variant: low',
      'persona_providers:',
      '  planner:',
      '    provider_options:',
      '      opencode:',
      '        variant: high',
    ].join('\n'));

    await runAllTasksNoWorkflow(env.projectDir);

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      opencode: {
        networkAccess: true,
        variant: 'high',
      },
    });
  });

  it('env provider_options should override yaml in runAllTasks flow', async () => {
    setGlobalConfig(env.globalDir, [
      'provider_options:',
      '  codex:',
      '    network_access: false',
    ].join('\n'));
    setProjectConfig(env.projectDir, [
      'provider_options:',
      '  codex:',
      '    network_access: false',
    ].join('\n'));
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'true';
    invalidateGlobalConfigCache();

    await runAllTasksNoWorkflow(env.projectDir);

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });
});
