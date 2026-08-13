import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const { selectorDebug } = vi.hoisted(() => ({
  selectorDebug: vi.fn(),
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  playWarningSound: vi.fn(),
  sendSlackNotification: vi.fn(),
  getSlackWebhookUrl: vi.fn(() => undefined),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  createLogger: () => ({
    trace: vi.fn(),
    debug: selectorDebug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  }),
}));

import { runAgent } from '../agents/runner.js';
import { executeTask } from '../features/tasks/execute/taskExecution.js';
import { runAllTasks } from '../features/tasks/index.js';
import { TaskRunner } from '../infra/task/index.js';
import { invalidateGlobalConfigCache } from '../infra/config/index.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

const runAllTasksNoWorkflow = runAllTasks as (projectCwd: string) => ReturnType<typeof runAllTasks>;
const defaultCodexSkills = { repo: false, user: false } as const;
const defaultClaudeSkills = { enabled: false } as const;

interface TestEnv {
  projectDir: string;
  globalDir: string;
}

function createEnv(): TestEnv {
  const root = join(tmpdir(), `takt-it-config-${randomUUID()}`);
  const projectDir = join(root, 'project');
  const globalDir = join(root, 'global');

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, '.takt', 'workflows', 'personas'), { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  writeFileSync(
    join(projectDir, '.takt', 'workflows', 'config-it.yaml'),
    [
      'name: config-it',
      'description: config provider options integration test',
      'max_steps: 3',
      'initial_step: plan',
      'steps:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    instruction: "{task}"',
      '    provider_options:',
      '      codex:',
      '        network_access: true',
      '      claude:',
      '        sandbox:',
      '          allow_unsandboxed_commands: false',
      '    rules:',
      '      - condition: when(true)',
      '        next: COMPLETE',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(join(projectDir, '.takt', 'workflows', 'personas', 'planner.md'), 'You are planner.', 'utf-8');
  writeFileSync(
    join(projectDir, '.takt', 'workflows', 'selector-it.yaml'),
    [
      'name: selector-it',
      'max_steps: 1',
      'initial_step: reviewers',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      fixed:',
      '        - name: architecture',
      '          persona: architecture',
      '          provider: claude',
      '          model: claude/fixed-model',
      '          provider_options:',
      '            claude:',
      '              effort: high',
      '          instruction: Review architecture',
      '          rules:',
      '            - condition: approved',
      '      pool:',
      '        - name: frontend',
      '          persona: frontend',
      '          provider: opencode',
      '          model: opencode/pool-model',
      '          provider_options:',
      '            opencode:',
      '              variant: pool-variant',
      '          description: Review frontend changes',
      '          instruction: Review frontend',
      '          rules:',
      '            - condition: approved',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'),
    'utf-8',
  );
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'fixture.ts'), 'export {};\n', 'utf-8');
  initializeGitFixture(projectDir, ['src/fixture.ts']);

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
  let originalProvider: string | undefined;
  let originalModel: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    selectorDebug.mockClear();
    env = createEnv();
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    originalEnvCodex = process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    originalProvider = process.env.TAKT_PROVIDER;
    originalModel = process.env.TAKT_MODEL;

    process.env.TAKT_CONFIG_DIR = env.globalDir;
    delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    delete process.env.TAKT_PROVIDER;
    delete process.env.TAKT_MODEL;
    invalidateGlobalConfigCache();

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
    if (originalEnvCodex === undefined) {
      delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    } else {
      process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = originalEnvCodex;
    }
    if (originalProvider === undefined) {
      delete process.env.TAKT_PROVIDER;
    } else {
      process.env.TAKT_PROVIDER = originalProvider;
    }
    if (originalModel === undefined) {
      delete process.env.TAKT_MODEL;
    } else {
      process.env.TAKT_MODEL = originalModel;
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
      workflowIdentifier: 'config-it',
    });

    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toMatchObject({
      codex: { networkAccess: true },
      claude: {
        sandbox: { allowUnsandboxedCommands: false },
      },
    });
  });

  it('project provider_options should override global provider_options', async () => {
    setGlobalConfig(
      env.globalDir,
      [
        'provider_options:',
        '  opencode:',
        '    network_access: true',
      ].join('\n'),
    );
    setProjectConfig(
      env.projectDir,
      [
        'provider_options:',
        '  opencode:',
        '    network_access: false',
      ].join('\n'),
    );

    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      workflowIdentifier: 'config-it',
    });

    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toMatchObject({
      opencode: { networkAccess: false },
      claude: {
        sandbox: { allowUnsandboxedCommands: false },
      },
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
      workflowIdentifier: 'config-it',
    });

    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toMatchObject({
      codex: { networkAccess: false },
      claude: {
        sandbox: { allowUnsandboxedCommands: false },
      },
    });
  });

  it('should preserve provider options origin precedence through executeTask to WorkflowEngine', async () => {
    setGlobalConfig(
      env.globalDir,
      [
        'provider_options:',
        '  codex:',
        '    network_access: false',
        '  claude:',
        '    sandbox:',
        '      allow_unsandboxed_commands: true',
      ].join('\n'),
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'true';
    invalidateGlobalConfigCache();

    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      workflowIdentifier: 'config-it',
    });

    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toMatchObject({
      codex: { networkAccess: true },
      claude: {
        sandbox: { allowUnsandboxedCommands: false },
      },
    });
  });

  it.each([
    {
      label: 'global selector configuration',
      expectedModel: 'global-model',
      expectedSource: 'global',
      expectedOptions: { claude: { effort: 'low' as const } },
    },
    {
      label: 'project selector configuration',
      projectConfig: [
        'takt_providers:',
        '  selector:',
        '    provider_options:',
        '      claude:',
        '        effort: medium',
      ].join('\n'),
      expectedModel: 'global-model',
      expectedSource: 'global',
      expectedOptions: { claude: { effort: 'medium' as const } },
    },
    {
      label: 'CLI selector override',
      agentOverrides: {
        provider: 'claude' as const,
        providerSource: 'cli' as const,
        model: 'cli-selector-model',
        modelSource: 'cli' as const,
      },
      expectedModel: 'cli-selector-model',
      expectedSource: 'cli',
      expectedOptions: { claude: { effort: 'low' as const } },
    },
    {
      label: 'environment selector override',
      environment: { provider: 'claude', model: 'env-selector-model' },
      expectedModel: 'env-selector-model',
      expectedSource: 'env',
      expectedOptions: { claude: { effort: 'low' as const } },
    },
  ])('should apply $label to the selector without propagating it to dynamic parallel participants', async (testCase) => {
    setGlobalConfig(env.globalDir, [
      'provider: claude',
      'model: global-model',
      'takt_providers:',
      '  selector:',
      '    provider_options:',
      '      claude:',
      '        effort: low',
    ].join('\n'));
    if (testCase.projectConfig) {
      setProjectConfig(env.projectDir, testCase.projectConfig);
    }
    if (testCase.environment) {
      process.env.TAKT_PROVIDER = testCase.environment.provider;
      process.env.TAKT_MODEL = testCase.environment.model;
    }
    invalidateGlobalConfigCache();
    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      if (options?.outputSchema) {
        return {
          ...makeDoneResponse(),
          persona: 'selector',
          structuredOutput: { selected_ids: ['frontend'], rationale: '界'.repeat(1_000) },
        };
      }
      return makeDoneResponse();
    });

    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      workflowIdentifier: 'selector-it',
      outputMode: 'silent',
      agentOverrides: testCase.agentOverrides,
    });
    const selectorOptions = vi.mocked(runAgent).mock.calls.find(([, , options]) => options?.outputSchema)?.[2];
    const participantOptions = vi.mocked(runAgent).mock.calls
      .filter(([, , options]) => options?.outputSchema === undefined)
      .map(([, , options]) => options);
    const selectorLog = selectorDebug.mock.calls.find(([message]) => message === 'Dynamic parallel selection resolved')?.[1];

    expect(ok).toBe(true);
    expect(selectorOptions).toMatchObject({
      resolvedExecution: {
        provider: 'claude',
        model: testCase.expectedModel,
        providerOptions: testCase.expectedOptions,
        permissionMode: 'readonly',
      },
    });
    expect(selectorLog).toMatchObject({
      step: 'reviewers',
      round: 1,
      mode: 'replace',
      selectorProvider: 'claude',
      selectorProviderSource: testCase.expectedSource,
      fixed: ['architecture'],
      selected: ['frontend'],
      unselected: [],
    });
    expect(JSON.parse(String((selectorLog as { identity?: unknown }).identity))).toEqual({
      workflow: expect.stringMatching(/^project:sha256:[0-9a-f]{64}$/),
      step: 'reviewers',
      calls: [],
    });
    expect(Buffer.byteLength(String((selectorLog as { rationale?: unknown }).rationale), 'utf-8'))
      .toBeLessThanOrEqual(1_024);
    expect((selectorLog as { rationale?: string }).rationale).not.toContain('\uFFFD');
    expect(participantOptions).toHaveLength(2);
    const participantByStep = new Map(participantOptions.map((options) => [options?.workflowMeta?.currentStep, options]));
    if (testCase.expectedSource === 'global' || testCase.expectedSource === 'project') {
      expect(participantByStep.get('architecture')).toMatchObject({
        resolvedProvider: 'claude',
        resolvedModel: 'claude/fixed-model',
      });
      expect(participantByStep.get('frontend')).toMatchObject({
        resolvedProvider: 'opencode',
        resolvedModel: 'opencode/pool-model',
      });
    } else {
      for (const options of participantOptions) {
        expect(options).toMatchObject({
          resolvedProvider: 'claude',
          resolvedModel: testCase.expectedModel,
        });
      }
    }
    expect(participantByStep.get('architecture')?.resolvedProviderOptions).toMatchObject({
      claude: { effort: 'high' },
    });
    expect(participantByStep.get('frontend')?.resolvedProviderOptions).toMatchObject({
      opencode: { variant: 'pool-variant' },
    });
    for (const options of participantOptions) {
      expect(options?.resolvedProviderOptions?.claude?.effort).not.toBe('low');
      expect(options?.resolvedProviderOptions?.claude?.effort).not.toBe('medium');
    }
  });

  it('should reject a blank TAKT_MODEL before selector or participants start', async () => {
    setGlobalConfig(env.globalDir, 'provider: claude\nmodel: global-model\n');
    process.env.TAKT_MODEL = '   ';
    invalidateGlobalConfigCache();

    await expect(executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      workflowIdentifier: 'selector-it',
      outputMode: 'silent',
    })).rejects.toThrow(/model must not be empty/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('should ignore an invalid unused selector configuration for an ordinary workflow', async () => {
    setGlobalConfig(env.globalDir, 'provider: mock\n');
    setProjectConfig(env.projectDir, [
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
    ].join('\n'));
    invalidateGlobalConfigCache();

    const ok = await executeTask({
      task: 'test task',
      cwd: env.projectDir,
      projectCwd: env.projectDir,
      workflowIdentifier: 'config-it',
      outputMode: 'silent',
    });

    expect(ok).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.outputSchema).toBeUndefined();
  });
});

describe('IT: runAllTasks provider_options reflection', () => {
  let root: string;
  let projectDir: string;
  let globalDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    root = join(tmpdir(), `takt-it-run-config-${randomUUID()}`);
    projectDir = join(root, 'project');
    globalDir = join(root, 'global');
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

    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalDir;
    invalidateGlobalConfigCache();

    vi.mocked(runAgent).mockResolvedValue(makeDoneResponse());

    const runner = new TaskRunner(projectDir);
    runner.addTask('test task', { workflow: 'run-config-it' });
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    invalidateGlobalConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('project provider_options should override global in runAllTasks flow', async () => {
    setGlobalConfig(globalDir, [
      'provider_options:',
      '  codex:',
      '    network_access: true',
    ].join('\n'));
    setProjectConfig(projectDir, [
      'provider_options:',
      '  codex:',
      '    network_access: false',
    ].join('\n'));

    await runAllTasksNoWorkflow(projectDir);

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: false, skills: defaultCodexSkills },
      claude: { skills: defaultClaudeSkills },
    });
  });

  it('project persona_providers provider_options should override project provider_options in runAllTasks flow', async () => {
    setProjectConfig(projectDir, [
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

    await runAllTasksNoWorkflow(projectDir);

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { skills: defaultCodexSkills },
      claude: {
        allowedTools: ['Read', 'Edit'],
        skills: defaultClaudeSkills,
      },
    });
    expect(options?.allowedTools).toEqual(['Read', 'Edit']);
  });

  it('project persona_providers opencode variant should override project provider_options in runAllTasks flow', async () => {
    setProjectConfig(projectDir, [
      'provider: opencode',
      'model: opencode/big-pickle',
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

    await runAllTasksNoWorkflow(projectDir);

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { skills: defaultCodexSkills },
      claude: { skills: defaultClaudeSkills },
      opencode: {
        networkAccess: true,
        variant: 'high',
      },
    });
  });
});

describe('IT: provider block reflection', () => {
  let projectDir: string;
  let globalDir: string;
  let originalConfigDir: string | undefined;

  function createProviderBlockEnv(workflowBody: string): void {
    const root = join(tmpdir(), `takt-it-provider-block-${randomUUID()}`);
    projectDir = join(root, 'project');
    globalDir = join(root, 'global');

    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'workflows', 'personas'), { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    writeFileSync(
      join(projectDir, '.takt', 'workflows', 'provider-block-it.yaml'),
      workflowBody,
      'utf-8',
    );
    writeFileSync(join(projectDir, '.takt', 'workflows', 'personas', 'planner.md'), 'You are planner.', 'utf-8');
    process.env.TAKT_CONFIG_DIR = globalDir;
  }

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
    if (projectDir) {
      rmSync(join(projectDir, '..'), { recursive: true, force: true });
    }
  });

  it('step provider block should override global/project provider options when origin is local', async () => {
    // Given
    createProviderBlockEnv([
      'name: provider-block-it',
      'description: step provider block integration test',
      'max_steps: 3',
      'initial_step: plan',
      'steps:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    provider:',
      '      type: codex',
      '      model: gpt-5.3',
      '      network_access: false',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: when(true)',
      '        next: COMPLETE',
    ].join('\n'));
    setGlobalConfig(globalDir, [
      'provider:',
      '  type: codex',
      '  model: global-model',
      '  network_access: true',
    ].join('\n'));
    setProjectConfig(projectDir, [
      'provider:',
      '  type: codex',
      '  model: project-model',
      '  network_access: true',
    ].join('\n'));
    invalidateGlobalConfigCache();

    // When
    const ok = await executeTask({
      task: 'test task',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'provider-block-it',
    });

    // Then
    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBe('gpt-5.3');
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: false, skills: defaultCodexSkills },
      claude: { skills: defaultClaudeSkills },
    });
  });

  it('workflow_config provider block should be inherited by step without provider', async () => {
    // Given
    createProviderBlockEnv([
      'name: provider-block-it',
      'description: workflow_config provider block integration test',
      'max_steps: 3',
      'initial_step: plan',
      'workflow_config:',
      '  provider:',
      '    type: codex',
      '    model: workflow-model',
      '    network_access: true',
      'steps:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: when(true)',
      '        next: COMPLETE',
    ].join('\n'));
    setGlobalConfig(globalDir, 'provider: claude');
    invalidateGlobalConfigCache();

    // When
    const ok = await executeTask({
      task: 'test task',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'provider-block-it',
    });

    // Then
    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBe('workflow-model');
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: true, skills: defaultCodexSkills },
      claude: { skills: defaultClaudeSkills },
    });
  });

  it('project provider block should provide providerOptions when step and workflow_config do not specify provider', async () => {
    // Given
    createProviderBlockEnv([
      'name: provider-block-it',
      'description: project provider block integration test',
      'max_steps: 3',
      'initial_step: plan',
      'steps:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: when(true)',
      '        next: COMPLETE',
    ].join('\n'));
    setGlobalConfig(globalDir, 'provider: claude');
    setProjectConfig(projectDir, [
      'provider:',
      '  type: codex',
      '  model: project-model',
      '  network_access: false',
    ].join('\n'));
    invalidateGlobalConfigCache();

    // When
    const ok = await executeTask({
      task: 'test task',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'provider-block-it',
    });

    // Then
    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBe('project-model');
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: false, skills: defaultCodexSkills },
      claude: { skills: defaultClaudeSkills },
    });
  });

  it('project claude provider block sandbox should reach runAgent providerOptions', async () => {
    createProviderBlockEnv([
      'name: provider-block-it',
      'description: project claude sandbox provider block integration test',
      'max_steps: 3',
      'initial_step: plan',
      'steps:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: when(true)',
      '        next: COMPLETE',
    ].join('\n'));
    setGlobalConfig(globalDir, 'provider: codex');
    setProjectConfig(projectDir, [
      'provider:',
      '  type: claude',
      '  model: sonnet',
      '  sandbox:',
      '    allow_unsandboxed_commands: true',
      '    excluded_commands:',
      '      - ./gradlew',
    ].join('\n'));
    invalidateGlobalConfigCache();

    const ok = await executeTask({
      task: 'test task',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'provider-block-it',
    });

    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('sonnet');
    expect(options?.providerOptions).toEqual({
      codex: { skills: defaultCodexSkills },
      claude: {
        skills: defaultClaudeSkills,
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('workflow step claude_terminal provider_options should reach runAgent from YAML', async () => {
    createProviderBlockEnv([
      'name: provider-block-it',
      'description: claude terminal provider options integration test',
      'max_steps: 3',
      'initial_step: plan',
      'steps:',
      '  - name: plan',
      '    persona: ./personas/planner.md',
      '    provider: claude-terminal',
      '    provider_options:',
      '      claude:',
      '        effort: high',
      '        allowed_tools:',
      '          - Read',
      '          - Edit',
      '      claude_terminal:',
      '        backend: tmux',
      '        timeout_ms: 900000',
      '        keep_session: false',
      '        transcript_poll_interval_ms: 500',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: when(true)',
      '        next: COMPLETE',
    ].join('\n'));
    setGlobalConfig(globalDir, 'provider: claude');
    invalidateGlobalConfigCache();

    const ok = await executeTask({
      task: 'test task',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'provider-block-it',
    });

    expect(ok).toBe(true);
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedProvider).toBe('claude-terminal');
    expect(options?.allowedTools).toEqual(['Read', 'Edit']);
    expect(options?.providerOptions).toEqual({
      codex: { skills: defaultCodexSkills },
      claude: {
        effort: 'high',
        skills: defaultClaudeSkills,
        allowedTools: ['Read', 'Edit'],
      },
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 900000,
        keepSession: false,
        transcriptPollIntervalMs: 500,
      },
    });
  });
});
