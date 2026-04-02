import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  playWarningSound: vi.fn(),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { runAgent } from '../agents/runner.js';
import { executeTask } from '../features/tasks/execute/taskExecution.js';
import { invalidateGlobalConfigCache } from '../infra/config/index.js';

interface TestEnv {
  projectDir: string;
  globalDir: string;
}

function createEnv(pieceBody: string): TestEnv {
  const root = join(tmpdir(), `takt-it-provider-block-${randomUUID()}`);
  const projectDir = join(root, 'project');
  const globalDir = join(root, 'global');

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, '.takt', 'pieces', 'personas'), { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  writeFileSync(
    join(projectDir, '.takt', 'pieces', 'provider-block-it.yaml'),
    pieceBody,
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

describe('IT: provider block reflection', () => {
  let env: TestEnv;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeDoneResponse();
    });
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    invalidateGlobalConfigCache();
    if (env) {
      rmSync(join(env.projectDir, '..'), { recursive: true, force: true });
    }
  });

  it('movement provider block should override global/project provider options when origin is local', async () => {
    // Given
    env = createEnv([
      'name: provider-block-it',
      'description: movement provider block integration test',
      'max_movements: 3',
      'initial_movement: plan',
      'movements:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    provider:',
      '      type: codex',
      '      model: gpt-5.3',
      '      network_access: false',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));
    process.env.TAKT_CONFIG_DIR = env.globalDir;
    setGlobalConfig(env.globalDir, [
      'provider:',
      '  type: codex',
      '  model: global-model',
      '  network_access: true',
    ].join('\n'));
    setProjectConfig(env.projectDir, [
      'provider:',
      '  type: codex',
      '  model: project-model',
      '  network_access: true',
    ].join('\n'));
    invalidateGlobalConfigCache();

    // When
    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      pieceIdentifier: 'provider-block-it',
    });

    // Then
    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.stepProvider).toBe('codex');
    expect(options?.stepModel).toBe('gpt-5.3');
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });

  it('piece_config provider block should be inherited by movement without provider', async () => {
    // Given
    env = createEnv([
      'name: provider-block-it',
      'description: piece_config provider block integration test',
      'max_movements: 3',
      'initial_movement: plan',
      'piece_config:',
      '  provider:',
      '    type: codex',
      '    model: piece-model',
      '    network_access: true',
      'movements:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));
    process.env.TAKT_CONFIG_DIR = env.globalDir;
    setGlobalConfig(env.globalDir, 'provider: claude');
    invalidateGlobalConfigCache();

    // When
    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      pieceIdentifier: 'provider-block-it',
    });

    // Then
    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.stepProvider).toBe('codex');
    expect(options?.stepModel).toBe('piece-model');
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('project provider block should provide providerOptions when movement and piece_config do not specify provider', async () => {
    // Given
    env = createEnv([
      'name: provider-block-it',
      'description: project provider block integration test',
      'max_movements: 3',
      'initial_movement: plan',
      'movements:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));
    process.env.TAKT_CONFIG_DIR = env.globalDir;
    setGlobalConfig(env.globalDir, 'provider: claude');
    setProjectConfig(env.projectDir, [
      'provider:',
      '  type: codex',
      '  model: project-model',
      '  network_access: false',
    ].join('\n'));
    invalidateGlobalConfigCache();

    // When
    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      pieceIdentifier: 'provider-block-it',
    });

    // Then
    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.stepProvider).toBe('codex');
    expect(options?.stepModel).toBe('project-model');
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });
});
