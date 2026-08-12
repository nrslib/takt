import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepPreview } from '../infra/config/index.js';

const {
  cliState,
  commandActions,
  commandMocks,
  confirmMock,
  instructModeMock,
  retryModeMock,
  rootCommand,
  selectOptionMock,
  selectOptionWithDefaultMock,
} = vi.hoisted(() => {
  const commandActions = new Map<string, (...args: unknown[]) => unknown>();
  const commandMocks = new Map<string, Record<string, unknown>>();

  function createCommandMock(actionKey: string): Record<string, unknown> {
    const command: Record<string, unknown> = {
      description: vi.fn().mockReturnThis(),
      argument: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(),
      opts: vi.fn(() => ({})),
      optsWithGlobals: vi.fn(() => ({})),
    };
    commandMocks.set(actionKey, command);
    command.command = vi.fn((subName: string) => createCommandMock(`${actionKey}.${subName}`));
    command.action = vi.fn((action: (...args: unknown[]) => unknown) => {
      commandActions.set(actionKey, action);
      return command;
    });
    return command;
  }

  return {
    cliState: { cwd: '' },
    commandActions,
    commandMocks,
    confirmMock: vi.fn(),
    instructModeMock: vi.fn(),
    retryModeMock: vi.fn(),
    rootCommand: createCommandMock('root'),
    selectOptionMock: vi.fn(),
    selectOptionWithDefaultMock: vi.fn(),
  };
});

// The traced-config runtime bridge spawns a synchronous node subprocess per
// (uncached) config load, which dominated this file's runtime (~30s of spawnSync).
// Trace entries depend only on schema + parsed file content (env/cli sources are
// disabled in the bridge), so memoizing identical inputs is behavior-preserving.
vi.mock('../infra/config/traced/tracedConfigRuntimeBridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/traced/tracedConfigRuntimeBridge.js')>();
  const cache = new Map<string, Map<string, unknown>>();
  const loadTraceEntriesViaRuntime: typeof actual.loadTraceEntriesViaRuntime = (schema, fileOrigin, parsedConfig) => {
    const key = JSON.stringify([
      fileOrigin,
      parsedConfig,
      Object.entries(schema).map(([name, entry]) => [name, String(entry.format), entry.env, entry.default, entry.sources]),
    ]);
    const hit = cache.get(key);
    if (hit) {
      return new Map(hit) as ReturnType<typeof actual.loadTraceEntriesViaRuntime>;
    }
    const result = actual.loadTraceEntriesViaRuntime(schema, fileOrigin, parsedConfig);
    cache.set(key, new Map(result));
    return result;
  };
  return { ...actual, loadTraceEntriesViaRuntime };
});

vi.mock('../app/cli/program.js', () => ({
  program: rootCommand,
}));

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: () => ({ cwd: cliState.cwd, pipelineMode: false }),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirm: (...args: unknown[]) => confirmMock(...args),
  selectOption: (...args: unknown[]) => selectOptionMock(...args),
  selectOptionWithDefault: (...args: unknown[]) => selectOptionWithDefaultMock(...args),
}));

vi.mock('../features/interactive/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runTaskRetryMode: (...args: unknown[]) => retryModeMock(...args),
}));

vi.mock('../features/tasks/list/instructMode.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runInstructMode: (...args: unknown[]) => instructModeMock(...args),
}));

import '../app/cli/commands.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { TaskRunner, type TaskInfo } from '../infra/task/index.js';

const CLI_MODEL = 'cli-list-selector-model';
const WORKFLOW_NAME = 'dynamic-list-selector';

interface TestEnvironment {
  readonly projectDir: string;
  readonly mockCallLogPath: string;
}

function initializeGitRepository(projectDir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir, stdio: 'pipe' });
  writeFileSync(join(projectDir, 'README.md'), '# selector list integration\n');
  execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial fixture'], { cwd: projectDir, stdio: 'pipe' });
}

function writeWorkflowFixture(projectDir: string): void {
  const workflowDir = join(projectDir, '.takt', 'workflows');
  const personaDir = join(workflowDir, 'personas');
  mkdirSync(personaDir, { recursive: true });
  writeFileSync(join(personaDir, 'architecture.md'), 'Review architecture.\n');
  writeFileSync(join(personaDir, 'frontend.md'), 'Review frontend changes.\n');
  writeFileSync(join(workflowDir, `${WORKFLOW_NAME}.yaml`), [
    `name: ${WORKFLOW_NAME}`,
    'initial_step: reviewers',
    'max_steps: 1',
    'steps:',
    '  - name: reviewers',
    '    parallel:',
    '      fixed:',
    '        - name: architecture',
    '          persona: ./personas/architecture.md',
    '          instruction: Review architecture',
    '          rules:',
    '            - condition: approved',
    '      pool:',
    '        - name: frontend',
    '          persona: ./personas/frontend.md',
    '          description: Review frontend changes',
    '          instruction: Review frontend',
    '          rules:',
    '            - condition: approved',
    '    rules:',
    '      - condition: all("approved")',
    '        next: COMPLETE',
    '',
  ].join('\n'));
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
    'provider: mock',
    'model: project-participant-model',
    'interactive_preview_steps: 5',
    'takt_providers:',
    '  selector:',
    '    provider: opencode',
    '    model: opencode/project-selector',
    '',
  ].join('\n'));
}

function createEnvironment(): TestEnvironment {
  const projectDir = mkdtempSync(join(tmpdir(), 'takt-cli-list-selector-'));
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  writeWorkflowFixture(projectDir);
  initializeGitRepository(projectDir);
  return {
    projectDir,
    mockCallLogPath: join(projectDir, '.takt-mock-calls.ndjson'),
  };
}

function terminalTaskResult(task: TaskInfo, success: boolean, projectDir: string) {
  return {
    task,
    success,
    response: success ? 'completed' : 'failed before retry',
    executionLog: [success ? 'completed' : 'failed before retry'],
    failureStep: success ? undefined : 'reviewers',
    startedAt: '2026-07-31T00:00:00.000Z',
    completedAt: '2026-07-31T00:01:00.000Z',
    branch: 'main',
    worktreePath: projectDir,
  };
}

function createTerminalTask(projectDir: string, status: 'completed' | 'failed'): void {
  const runner = new TaskRunner(projectDir);
  runner.addTask(`Task for ${status} list action`, {
    workflow: WORKFLOW_NAME,
    worktree: false,
    branch: 'main',
    worktree_path: projectDir,
  });
  const runningTask = runner.claimNextTasks(1)[0];
  if (runningTask === undefined) {
    throw new Error('Failed to claim integration task');
  }
  const result = terminalTaskResult(runningTask, status === 'completed', projectDir);
  if (status === 'completed') {
    runner.completeTask(result);
  } else {
    runner.failTask(result);
  }
}

function setSuccessfulDynamicSelectorScenario(): void {
  setMockScenario([
    {
      status: 'done',
      content: '',
      structuredOutput: {
        selected_ids: ['frontend'],
        rationale: 'Frontend review is required.',
      },
    },
    { persona: 'architecture', status: 'done', content: 'approved' },
    { persona: 'frontend', status: 'done', content: 'approved' },
  ]);
}

function flattenStepPreviews(previews: readonly StepPreview[]): StepPreview[] {
  return previews.flatMap((preview) => [
    preview,
    ...flattenStepPreviews(preview.substeps ?? []),
  ]);
}

function expectCliSelectorPreview(previews: readonly StepPreview[]): void {
  const selector = flattenStepPreviews(previews)
    .find((preview) => preview.name === 'dynamic-selector');
  expect(selector).toEqual(expect.objectContaining({
    provider: 'mock',
    model: CLI_MODEL,
    providerSource: 'cli',
    modelSource: 'cli',
  }));
  expect(selector).not.toHaveProperty('permissionMode');
}

function readProviderStarts(mockCallLogPath: string): Array<Record<string, unknown>> {
  return readFileSync(mockCallLogPath, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.event === 'start');
}

async function runListCommand(): Promise<void> {
  const listAction = commandActions.get('root.list');
  const listCommand = commandMocks.get('root.list');
  if (listAction === undefined || listCommand === undefined) {
    throw new Error('List command was not registered');
  }
  await listAction(undefined, listCommand);
}

describe('IT: CLI list selector overrides', () => {
  let environment: TestEnvironment;

  beforeEach(() => {
    vi.clearAllMocks();
    environment = createEnvironment();
    cliState.cwd = environment.projectDir;
    vi.mocked(rootCommand.opts as () => Record<string, unknown>).mockReturnValue({
      provider: 'mock',
      model: CLI_MODEL,
    });
    confirmMock.mockResolvedValue(true);
    selectOptionWithDefaultMock.mockImplementation(async (
      _message: string,
      options: Array<{ value: string }>,
    ) => options[0]?.value ?? null);
    retryModeMock.mockResolvedValue({ action: 'execute', task: 'Retry with the CLI override.' });
    instructModeMock.mockResolvedValue({ action: 'execute', task: 'Instruct with the CLI override.' });
    process.env.TAKT_MOCK_CALL_LOG = environment.mockCallLogPath;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    setSuccessfulDynamicSelectorScenario();
  });

  afterEach(() => {
    resetScenario();
    delete process.env.TAKT_MOCK_CALL_LOG;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(environment.projectDir, { recursive: true, force: true });
  });

  it('should use one CLI override for retry preview, selector, and participants from the list command', async () => {
    createTerminalTask(environment.projectDir, 'failed');
    selectOptionMock
      .mockResolvedValueOnce('failed:0')
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce(null);

    await runListCommand();

    const retryContext = retryModeMock.mock.calls[0]?.[1] as {
      workflowContext: { stepPreviews: StepPreview[] };
    } | undefined;
    expect(retryContext).toBeDefined();
    expectCliSelectorPreview(retryContext!.workflowContext.stepPreviews);
    const starts = readProviderStarts(environment.mockCallLogPath);
    expect(starts).toEqual(expect.arrayContaining([
      expect.objectContaining({ personaName: 'dynamic-parallel-selector', provider: 'mock', model: CLI_MODEL }),
      expect.objectContaining({ personaName: 'architecture', provider: 'mock', model: CLI_MODEL }),
      expect.objectContaining({ personaName: 'frontend', provider: 'mock', model: CLI_MODEL }),
    ]));
  }, 120_000);

  it('should use one CLI override for instruct preview, selector, and participants from the list command', async () => {
    createTerminalTask(environment.projectDir, 'completed');
    selectOptionMock
      .mockResolvedValueOnce('completed:0')
      .mockResolvedValueOnce('instruct')
      .mockResolvedValueOnce(null);

    await runListCommand();

    const instructOptions = instructModeMock.mock.calls[0]?.[0] as {
      workflowContext: { stepPreviews: StepPreview[] };
    } | undefined;
    expect(instructOptions).toBeDefined();
    expectCliSelectorPreview(instructOptions!.workflowContext.stepPreviews);
    const starts = readProviderStarts(environment.mockCallLogPath);
    expect(starts).toEqual(expect.arrayContaining([
      expect.objectContaining({ personaName: 'dynamic-parallel-selector', provider: 'mock', model: CLI_MODEL }),
      expect.objectContaining({ personaName: 'architecture', provider: 'mock', model: CLI_MODEL }),
      expect.objectContaining({ personaName: 'frontend', provider: 'mock', model: CLI_MODEL }),
    ]));
  }, 120_000);
});
