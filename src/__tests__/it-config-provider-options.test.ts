import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../agents/ai-judge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agents/ai-judge.js')>();
  return {
    ...original,
    callAiJudge: vi.fn().mockResolvedValue(-1),
  };
});

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { runAgent } from '../agents/runner.js';
import { executeTask } from '../features/tasks/execute/taskExecution.js';
import { invalidateGlobalConfigCache } from '../infra/config/index.js';

interface TestEnv {
  projectDir: string;
  globalDir: string;
}

function createEnv(): TestEnv {
  const root = join(tmpdir(), `takt-it-config-${randomUUID()}`);
  const projectDir = join(root, 'project');
  const globalDir = join(root, 'global');

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, '.takt', 'pieces', 'personas'), { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  writeFileSync(
    join(projectDir, '.takt', 'pieces', 'config-it.yaml'),
    [
      'name: config-it',
      'description: config provider options integration test',
      'max_movements: 3',
      'initial_movement: plan',
      'movements:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(join(projectDir, '.takt', 'pieces', 'personas', 'planner.md'), 'You are planner.', 'utf-8');

  return { projectDir, globalDir };
}

function setGlobalConfig(globalDir: string, body: string): void {
  writeFileSync(join(globalDir, 'config.yaml'), body, 'utf-8');
}

function setProjectConfig(projectDir: string, body: string): void {
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), body, 'utf-8');
}

function makeDoneResponse() {
  return {
    persona: 'planner',
    status: 'done',
    content: '[PLAN:1]\ndone',
    timestamp: new Date(),
    sessionId: 'session-it',
  };
}

describe('IT: config provider_options reflection', () => {
  let env: TestEnv;
  let originalConfigDir: string | undefined;
  let originalEnvCodex: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createEnv();
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    originalEnvCodex = process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;

    process.env.TAKT_CONFIG_DIR = env.globalDir;
    delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    invalidateGlobalConfigCache();

    vi.mocked(runAgent).mockResolvedValue(makeDoneResponse());
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
    invalidateGlobalConfigCache();
    rmSync(join(env.projectDir, '..'), { recursive: true, force: true });
  });

  it('global provider_options should be passed to runAgent', async () => {
    setGlobalConfig(
      env.globalDir,
      [
        'provider_options:',
        '  codex:',
        '    network_access: true',
      ].join('\n'),
    );

    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      pieceIdentifier: 'config-it',
    });

    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('project provider_options should override global provider_options', async () => {
    setGlobalConfig(
      env.globalDir,
      [
        'provider_options:',
        '  codex:',
        '    network_access: true',
      ].join('\n'),
    );
    setProjectConfig(
      env.projectDir,
      [
        'provider_options:',
        '  codex:',
        '    network_access: false',
      ].join('\n'),
    );

    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      pieceIdentifier: 'config-it',
    });

    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });

  it('env provider_options should override yaml provider_options', async () => {
    setGlobalConfig(
      env.globalDir,
      [
        'provider_options:',
        '  codex:',
        '    network_access: true',
      ].join('\n'),
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'false';
    invalidateGlobalConfigCache();

    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      pieceIdentifier: 'config-it',
    });

    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });
});

