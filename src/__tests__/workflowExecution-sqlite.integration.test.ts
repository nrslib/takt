import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { createBootstrapRecoverySeed } from '../core/workflow/run/bootstrap-recovery-seed.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import type { WorkflowExecutionEvent } from '../features/tasks/execute/types.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import {
  resolveTaskSpecForExecution,
} from '../features/tasks/execute/taskSpecContext.js';

const terminal = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue({
    id: 'tmux-session',
    name: 'takt-sqlite-integration',
  }),
  pasteText: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  readBaseline: vi.fn().mockResolvedValue({
    byteOffset: 0,
    lineNumberOffset: 0,
  }),
  findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
  waitForAssistantResponse: vi.fn().mockResolvedValue({
    sessionId: 'claude-session-1',
    assistantText: 'done',
    events: [],
  }),
}));

const storageFault = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'terminalize' | 'heartbeat' | 'close' | 'setup',
}));

const directResumePrompt = vi.hoisted(() => ({
  selectOption: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  selectOption: directResumePrompt.selectOption,
}));

vi.mock('../infra/claude-terminal/tmux-backend.js', () => ({
  TmuxTerminalBackend: vi.fn().mockImplementation(() => ({
    start: terminal.start,
    pasteText: terminal.pasteText,
    stop: terminal.stop,
  })),
}));

vi.mock('../infra/claude-terminal/transcript-reader.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../infra/claude-terminal/transcript-reader.js')
  >();
  return {
    ...actual,
    ProjectClaudeTranscriptReader: vi.fn().mockImplementation(() => ({
      readBaseline: terminal.readBaseline,
      findSession: terminal.findSession,
      waitForAssistantResponse: terminal.waitForAssistantResponse,
    })),
  };
});

vi.mock('../infra/run-storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../infra/run-storage/index.js')
  >();
  return {
    ...actual,
    createRunStorage: (
      options: Parameters<typeof actual.createRunStorage>[0],
    ) => {
      const root = actual.createRunStorage(options);
      return new Proxy(root, {
        get(target, property) {
          if (
            property === 'finishRun'
            && storageFault.mode === 'terminalize'
          ) {
            return () => {
              throw new Error('injected terminalize failure');
            };
          }
          if (
            property === 'heartbeatLease'
            && storageFault.mode === 'heartbeat'
          ) {
            return () => {
              throw new Error('injected heartbeat failure');
            };
          }
          if (property === 'close' && storageFault.mode === 'close') {
            return () => {
              target.close();
              throw new Error('injected close failure');
            };
          }
          if (property === 'runtime' && storageFault.mode === 'setup') {
            return (...args: Parameters<typeof target.runtime>) => {
              const runtime = target.runtime(...args);
              return {
                ...runtime,
                execution: new Proxy(runtime.execution, {
                  get(executionTarget, executionProperty) {
                    if (executionProperty === 'startStep') {
                      return () => {
                        throw new Error('injected setup failure');
                      };
                    }
                    const executionValue = Reflect.get(
                      executionTarget,
                      executionProperty,
                    );
                    return typeof executionValue === 'function'
                      ? executionValue.bind(executionTarget)
                      : executionValue;
                  },
                }),
              };
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

function simpleWorkflow(): WorkflowConfig {
  return {
    name: 'sqlite-integration',
    maxSteps: 3,
    initialStep: 'implement',
    steps: [{
      name: 'implement',
      personaDisplayName: 'implement',
      instruction: 'Implement {task}',
      provider: 'claude-terminal',
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
    }],
  };
}

function configureRunStorage(
  projectDir: string,
  backend: 'file' | 'sqlite',
): void {
  const configDir = join(projectDir, '.takt');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.yaml'),
    [
      'run_storage:',
      `  backend: ${backend}`,
      '',
    ].join('\n'),
  );
}

function runDirectory(projectDir: string): string {
  const runsDir = join(projectDir, '.takt', 'runs');
  const runs = readdirSync(runsDir);
  expect(runs).toHaveLength(1);
  return join(runsDir, runs[0]!);
}

function readMeta(directory: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(directory, 'meta.json'), 'utf-8'),
  ) as Record<string, unknown>;
}

function completedEvents(
  events: readonly WorkflowExecutionEvent[],
): Array<Extract<WorkflowExecutionEvent, { type: 'completed' }>> {
  return events.filter(
    (event): event is Extract<WorkflowExecutionEvent, { type: 'completed' }> =>
      event.type === 'completed',
  );
}

function readSessionRecords(directory: string): Array<Record<string, unknown>> {
  const logsDirectory = join(directory, 'logs');
  const logFiles = readdirSync(logsDirectory);
  expect(logFiles).toHaveLength(1);
  return readFileSync(join(logsDirectory, logFiles[0]!), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type ResolvedAttachmentMutation = '削除' | '内容変更' | '追加';

const attachmentStageFailureCases = (
  ['file', 'sqlite'] as const
).flatMap((backend) => (
  ['削除', '内容変更', '追加'] as const
).map((mutation) => ({ backend, mutation })));

function mutateResolvedAttachment(
  mutation: ResolvedAttachmentMutation,
  attachmentsDir: string,
): void {
  const sourceAttachmentPath = join(attachmentsDir, 'input.txt');
  switch (mutation) {
    case '削除':
      rmSync(sourceAttachmentPath);
      return;
    case '内容変更':
      writeFileSync(sourceAttachmentPath, 'changed');
      return;
    case '追加':
      writeFileSync(join(attachmentsDir, 'added.txt'), 'added');
  }
}

function attachmentMutationSlug(
  mutation: ResolvedAttachmentMutation,
): string {
  switch (mutation) {
    case '削除':
      return 'deleted';
    case '内容変更':
      return 'changed';
    case '追加':
      return 'added';
  }
}

describe('executeWorkflow SQLite integration', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    storageFault.mode = 'none';
    terminal.start.mockResolvedValue({
      id: 'tmux-session',
      name: 'takt-sqlite-integration',
    });
    terminal.pasteText.mockResolvedValue(undefined);
    terminal.stop.mockResolvedValue(undefined);
    terminal.readBaseline.mockResolvedValue({
      byteOffset: 0,
      lineNumberOffset: 0,
    });
    terminal.findSession.mockResolvedValue({ sessionId: 'claude-session-1' });
    terminal.waitForAssistantResponse.mockResolvedValue({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });
    directResumePrompt.selectOption.mockReset();
    directResumePrompt.selectOption.mockResolvedValue(null);
    projectDir = mkdtempSync(join(tmpdir(), 'takt-sqlite-execution-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-sqlite-global-'));
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    configureRunStorage(projectDir, 'sqlite');
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
  });

  it('direct CLI resume loads the target meta workflow and inherits SQLite Finding state', async () => {
    const sourceSlug = 'direct-resume-source';
    const sourcePaths = buildRunPaths(projectDir, sourceSlug);
    const sourceStartedAt = '2026-07-30T00:00:00.000Z';
    mkdirSync(sourcePaths.runRootAbs, { recursive: true });
    const { RunMetaManager } = await import(
      '../features/tasks/execute/runMeta.js'
    );
    new RunMetaManager(
      sourcePaths,
      'Resume the source task.',
      'source-workflow',
      'sqlite',
      undefined,
      { startTime: sourceStartedAt },
    );
    const {
      createSessionLog,
      initNdjsonLog,
    } = await import('../infra/fs/index.js');
    const ndjsonLogPath = initNdjsonLog(
      'direct-resume-source-session',
      'Resume the source task.',
      'source-workflow',
      { logsDir: sourcePaths.logsAbs, startTime: sourceStartedAt },
    );
    const {
      createWorkflowTerminalPayloadFactory,
      serializeWorkflowTerminalPublication,
    } = await import(
      '../features/tasks/execute/workflowTerminalPayload.js'
    );
    const terminalPayload = createWorkflowTerminalPayloadFactory({
      runSlug: sourceSlug,
      projectCwd: projectDir,
      task: 'Resume the source task.',
      workflowName: 'source-workflow',
      sessionLog: createSessionLog(
        'Resume the source task.',
        projectDir,
        'source-workflow',
        { startTime: sourceStartedAt },
      ),
      sessionId: 'direct-resume-source-session',
      ndjsonLogPath,
      traceReportMode: 'redacted',
      metaSeed: {
        backend: 'sqlite',
        startedAt: sourceStartedAt,
        resumeSource: null,
      },
    }).create({
      status: 'failed',
      reason: 'resume integration source',
      iterations: 1,
      lastStepContent: 'implementation stopped',
      lastStepName: 'implement',
      endTime: '2026-07-30T00:01:00.000Z',
    });
    const { createRunStorage, openRunStorage } = await import(
      '../infra/run-storage/index.js'
    );
    const source = createRunStorage({
      databasePath: sourcePaths.databaseAbs,
      bootstrapSeed: createBootstrapRecoverySeed({
        task: 'Resume the source task.',
        workflowName: 'source-workflow',
        projectCwd: projectDir,
        backend: 'sqlite',
        startedAt: sourceStartedAt,
        sessionId: 'direct-resume-source-session',
      }),
      run: {
        runId: sourceSlug,
        workflowName: 'source-workflow',
        findingContractEnabled: true,
      },
    });
    const sourceLease = source.claimLease({
      ownerKey: 'direct-resume-source-owner',
      leaseDurationMs: 10_000,
    });
    const sourceRuntime = source.runtime({ lease: sourceLease });
    const sourceExecution = sourceRuntime.execution.startStep({
      stepKey: 'implement',
      expectedScopeRevision: 0,
    });
    const sourceFindings = sourceRuntime.findingManager({
      workflowName: 'source-workflow',
      producer: sourceExecution.handle,
    });
    await sourceFindings.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 7 },
      result: undefined,
    }));
    source.finishRun(sourceLease, {
      status: 'failed',
      failureReason: 'resume integration source',
      publication: {
        status: 'failed',
        iteration: 1,
        reason: 'resume integration source',
        payload: serializeWorkflowTerminalPublication(terminalPayload),
      },
    });
    source.close();

    const { reconcileWorkflowTerminalPublication } = await import(
      '../features/tasks/execute/workflowTerminalPublication.js'
    );
    await expect(reconcileWorkflowTerminalPublication({
      databasePath: sourcePaths.databaseAbs,
      expectedRunId: sourceSlug,
    })).resolves.toEqual({ issues: [] });
    const sourceMeta = readMeta(sourcePaths.runRootAbs);
    writeFileSync(sourcePaths.metaAbs, JSON.stringify({
      ...sourceMeta,
      workflow: 'target-workflow',
      operation_journal_run_slug: sourceSlug,
      operation_claim_token: 'direct-resume-source-claim',
    }));
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'target-workflow.yaml'), [
      'name: target-workflow',
      'finding_contract:',
      '  ledger_path: .takt/findings/target-workflow.json',
      '  raw_findings_path: .takt/findings/target-workflow/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
      'max_steps: 1',
      'initial_step: implement',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    instruction: implement',
      '    provider: claude-terminal',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const { loadWorkflowByIdentifier } = await import('../infra/config/index.js');
    const bundledWorkflow = loadWorkflowByIdentifier(
      'target-workflow',
      projectDir,
      { lookupCwd: projectDir },
    )!;
    const {
      prepareWorkflowExecutionBundle,
      publishWorkflowExecutionBundle,
    } = await import('../features/tasks/execute/workflowExecutionBundle.js');
    const {
      createWorkflowCallResolver,
      createWorkflowExecutionContext,
    } = await import('../features/tasks/execute/workflowExecutionContext.js');
    publishWorkflowExecutionBundle(sourcePaths, prepareWorkflowExecutionBundle({
      rootWorkflow: bundledWorkflow,
      workflowCallResolver: createWorkflowCallResolver(
        createWorkflowExecutionContext(bundledWorkflow, projectDir),
      ),
      projectCwd: projectDir,
      lookupCwd: projectDir,
    }));
    directResumePrompt.selectOption.mockResolvedValueOnce('requeue');

    const { resumeDirectRun } = await import('../features/tasks/resume/index.js');
    await expect(resumeDirectRun(projectDir)).resolves.toBe(true);

    const runSlugs = readdirSync(join(projectDir, '.takt', 'runs'))
      .filter((slug) => slug !== sourceSlug);
    expect(runSlugs).toHaveLength(1);
    const targetPaths = buildRunPaths(projectDir, runSlugs[0]!);
    expect(readMeta(targetPaths.runRootAbs).workflow).toBe('target-workflow');
    const target = openRunStorage({ databasePath: targetPaths.databaseAbs });
    expect(target.readResumeSnapshot().findingRevisions).toEqual([
      expect.objectContaining({ next_id: 7 }),
    ]);
    target.close();
  });

  it.each(['file', 'sqlite'] as const)(
    '%s backendはrun予約後にtask contextを配置する',
    async (backend) => {
      configureRunStorage(projectDir, backend);
      const taskDir = '.takt/tasks/pending-task';
      const sourceTaskDir = join(projectDir, taskDir);
      const runSlug = `${backend}-pending-task-run`;
      mkdirSync(join(sourceTaskDir, 'attachments'), { recursive: true });
      writeFileSync(
        join(sourceTaskDir, 'order.md'),
        'Use `attachments/input.txt`.',
      );
      writeFileSync(
        join(sourceTaskDir, 'attachments', 'input.txt'),
        'input',
      );
      const taskSpec = resolveTaskSpecForExecution(
        projectDir,
        projectDir,
        taskDir,
        runSlug,
      );
      const runRoot = join(projectDir, '.takt', 'runs', runSlug);
      expect(existsSync(runRoot)).toBe(false);
      const { executeWorkflow } = await import(
        '../features/tasks/execute/workflowExecution.js'
      );

      const result = await executeWorkflow(
        simpleWorkflow(),
        taskSpec.taskPrompt,
        projectDir,
        {
          projectCwd: projectDir,
          provider: 'claude-terminal',
          reportDirName: runSlug,
          taskSpec,
        },
      );

      expect(result.success).toBe(true);
      expect(readFileSync(
        join(runRoot, 'context', 'task', 'order.md'),
        'utf-8',
      )).toContain(
        `.takt/runs/${runSlug}/context/task/attachments/input.txt`,
      );
      expect(readFileSync(
        join(runRoot, 'context', 'task', 'attachments', 'input.txt'),
        'utf-8',
      )).toBe('input');
      expect(existsSync(join(runRoot, 'run.sqlite'))).toBe(
        backend === 'sqlite',
      );
    },
  );

  it.each(attachmentStageFailureCases)(
    '$backend backendはtask spec解決後のsource添付の$mutationをfailed terminal化する',
    async ({ backend, mutation }) => {
      configureRunStorage(projectDir, backend);
      const mutationSlug = attachmentMutationSlug(mutation);
      const taskDir = `.takt/tasks/${backend}-${mutationSlug}-task`;
      const sourceTaskDir = join(projectDir, taskDir);
      const attachmentsDir = join(sourceTaskDir, 'attachments');
      const runSlug = `${backend}-${mutationSlug}-attachment-run`;
      mkdirSync(attachmentsDir, { recursive: true });
      writeFileSync(
        join(sourceTaskDir, 'order.md'),
        'Use `attachments/input.txt`.',
      );
      writeFileSync(join(attachmentsDir, 'input.txt'), 'original');
      const taskSpec = resolveTaskSpecForExecution(
        projectDir,
        projectDir,
        taskDir,
        runSlug,
      );
      mutateResolvedAttachment(mutation, attachmentsDir);
      const { executeWorkflow } = await import(
        '../features/tasks/execute/workflowExecution.js'
      );

      await expect(executeWorkflow(
        simpleWorkflow(),
        taskSpec.taskPrompt,
        projectDir,
        {
          projectCwd: projectDir,
          provider: 'claude-terminal',
          reportDirName: runSlug,
          taskSpec,
        },
      )).rejects.toThrow(/Task attachment/);

      const runRoot = join(projectDir, '.takt', 'runs', runSlug);
      expect(readMeta(runRoot)).toMatchObject({
        status: 'failed',
        iterations: 0,
        reason: expect.stringMatching(/Task attachment/),
      });
      expect(existsSync(join(runRoot, 'context', 'task'))).toBe(false);
      expect(terminal.start).not.toHaveBeenCalled();

      if (backend === 'sqlite') {
        const { openRunStorage } = await import('../infra/run-storage/index.js');
        const root = openRunStorage({
          databasePath: join(runRoot, 'run.sqlite'),
        });
        expect(root.readResumeSnapshot().run.status).toBe('failed');
        expect(root.readTerminalPublication()).toMatchObject({
          status: 'failed',
          iteration: 0,
          reason: expect.stringMatching(/Task attachment/),
        });
        root.close();
      }
    },
  );

  it(
    'SQLite backendは予約前から存在するtask contextを予約済みとは扱わない',
    async () => {
      const taskDir = '.takt/tasks/colliding-task';
      const sourceTaskDir = join(projectDir, taskDir);
      const runSlug = 'sqlite-colliding-task-run';
      mkdirSync(sourceTaskDir, { recursive: true });
      writeFileSync(join(sourceTaskDir, 'order.md'), 'new task');
      const taskSpec = resolveTaskSpecForExecution(
        projectDir,
        projectDir,
        taskDir,
        runSlug,
      );
      const runContextTaskDir = join(
        projectDir,
        '.takt',
        'runs',
        runSlug,
        'context',
        'task',
      );
      mkdirSync(runContextTaskDir, { recursive: true });
      writeFileSync(join(runContextTaskDir, 'order.md'), 'existing task');
      const { executeWorkflow } = await import(
        '../features/tasks/execute/workflowExecution.js'
      );

      await expect(executeWorkflow(
        simpleWorkflow(),
        taskSpec.taskPrompt,
        projectDir,
        {
          projectCwd: projectDir,
          provider: 'claude-terminal',
          reportDirName: runSlug,
          taskSpec,
        },
      )).rejects.toThrow('Run directory already exists');

      expect(readFileSync(
        join(runContextTaskDir, 'order.md'),
        'utf-8',
      )).toBe('existing task');
      expect(existsSync(
        join(projectDir, '.takt', 'runs', runSlug, 'run.sqlite'),
      )).toBe(false);
      expect(terminal.start).not.toHaveBeenCalled();
    },
  );

  it(
    'SQLite bootstrap失敗をbeginRunで確保済みのauthorityへfailed commitする',
    async () => {
      configureRunStorage(projectDir, 'sqlite');
      const { executeWorkflow } = await import(
        '../features/tasks/execute/workflowExecution.js'
      );

      await expect(executeWorkflow(
        simpleWorkflow(),
        'bootstrap failure task',
        projectDir,
        {
          projectCwd: projectDir,
          provider: 'claude-terminal',
          taskPrefix: 'missing-color-pair',
        },
      )).rejects.toThrow(/taskPrefix|color/i);

      const directory = runDirectory(projectDir);
      const { openRunStorage } = await import('../infra/run-storage/index.js');
      const root = openRunStorage({
        databasePath: join(directory, 'run.sqlite'),
      });
      expect(root.readResumeSnapshot().run.status).toBe('failed');
      expect(root.readTerminalPublication()).toMatchObject({
        status: 'failed',
        iteration: 0,
        reason: expect.stringMatching(/taskPrefix|color/i),
      });
      root.close();
    },
  );

  it('publishes success once after SQLite closes and creates a real child authority', async () => {
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'parent.yaml'), `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeFileSync(join(workflowsDir, 'child.yaml'), `name: child
subworkflow:
  callable: true
finding_contract:
  ledger_path: .takt/findings/child.json
  raw_findings_path: .takt/findings/raw
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
initial_step: review
max_steps: 2
steps:
  - name: review
    persona: reviewer
    persona_display_name: reviewer
    provider: claude-terminal
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`);
    const { loadWorkflowByIdentifier } = await import(
      '../infra/config/loaders/workflowLoader.js'
    );
    const parent = loadWorkflowByIdentifier('parent', projectDir);
    if (parent === null) {
      throw new Error('Parent workflow was not loaded');
    }
    const events: WorkflowExecutionEvent[] = [];
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(parent, 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      eventSink: (event) => {
        events.push(event);
      },
    });

    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    const snapshot = root.readResumeSnapshot();
    const terminalPublication = root.readTerminalPublication();
    root.close();

    expect(result.success).toBe(true);
    expect(readMeta(directory)).toMatchObject({ status: 'completed' });
    expect(snapshot.run.status).toBe('completed');
    expect(terminalPublication).toEqual(expect.objectContaining({
      status: 'completed',
      iteration: 2,
      publishedAt: expect.any(Number),
    }));
    expect(snapshot.findingHeads).toHaveLength(1);
    expect(snapshot.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'workflow_call',
        runtime: expect.objectContaining({ status: 'completed' }),
      }),
    ]));
    expect(completedEvents(events)).toEqual([
      expect.objectContaining({ success: true }),
    ]);
  });

  it.each(['file', 'sqlite'] as const)(
    'does not resolve a broken unreachable workflow_call before the root starts with %s storage',
    async (backend) => {
      configureRunStorage(projectDir, backend);
      const workflowsDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(
        join(workflowsDir, 'broken-child.yaml'),
        'name: broken-child\nsteps: [\n',
      );
      const root: WorkflowConfig = {
        ...simpleWorkflow(),
        steps: [
          ...simpleWorkflow().steps,
          {
            name: 'unreachable-child',
            kind: 'workflow_call',
            call: 'broken-child',
            rules: [
              normalizeRule({
                condition: 'COMPLETE',
                next: 'COMPLETE',
              }),
            ],
          },
        ],
      };
      const { executeWorkflow } = await import(
        '../features/tasks/execute/workflowExecution.js'
      );

      const result = await executeWorkflow(root, 'task', projectDir, {
        projectCwd: projectDir,
        provider: 'claude-terminal',
      });

      expect(result.success).toBe(true);
      expect(terminal.start).toHaveBeenCalledOnce();
    },
  );

  it('correlates reversed parallel workflow_call completions with their originating resume stacks', async () => {
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'parent.yaml'), `name: parent
initial_step: reviewers
max_steps: 3
steps:
  - name: reviewers
    instruction: Run reviewers
    parallel:
      - name: slow-delegate
        kind: workflow_call
        call: slow-child
        rules:
          - condition: COMPLETE
            next: COMPLETE
          - condition: ABORT
            next: ABORT
      - name: fast-delegate
        kind: workflow_call
        call: fast-child
        rules:
          - condition: COMPLETE
            next: COMPLETE
          - condition: ABORT
            next: ABORT
    rules:
      - condition: all("COMPLETE")
        next: COMPLETE
`);
    writeFileSync(join(workflowsDir, 'slow-child.yaml'), `name: slow-child
subworkflow:
  callable: true
finding_contract:
  ledger_path: .takt/findings/slow-child.json
  raw_findings_path: .takt/findings/slow-child-raw
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
initial_step: child-review
max_steps: 2
steps:
  - name: child-review
    persona: reviewer
    persona_display_name: reviewer
    provider: claude-terminal
    instruction: Slow review
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFileSync(join(workflowsDir, 'fast-child.yaml'), `name: fast-child
subworkflow:
  callable: true
finding_contract:
  ledger_path: .takt/findings/fast-child.json
  raw_findings_path: .takt/findings/fast-child-raw
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
initial_step: child-review
max_steps: 2
steps:
  - name: child-review
    persona: reviewer
    persona_display_name: reviewer
    provider: claude-terminal
    instruction: Fast review
    rules:
      - condition: done
        next: COMPLETE
`);
    let responseSequence = 0;
    terminal.waitForAssistantResponse.mockImplementation(async () => {
      const currentResponse = responseSequence + 1;
      responseSequence = currentResponse;
      if (currentResponse === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return {
        sessionId: `claude-session-${currentResponse}`,
        assistantText: 'done',
        events: [],
      };
    });
    const { loadWorkflowByIdentifier } = await import(
      '../infra/config/loaders/workflowLoader.js'
    );
    const parent = loadWorkflowByIdentifier('parent', projectDir);
    if (parent === null) {
      throw new Error('Parent workflow was not loaded');
    }
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(parent, 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
    });

    expect(result.success).toBe(true);
    const sessionRecords = readSessionRecords(runDirectory(projectDir));
    const childStarts = sessionRecords
      .filter((record) => (
        record.type === 'step_start'
        && record.step === 'child-review'
      ));
    const childCompletions = sessionRecords
      .filter((record) => (
        record.type === 'step_complete'
        && record.step === 'child-review'
      ));
    expect(childStarts.map((record) => record.workflow)).toEqual([
      'slow-child',
      'fast-child',
    ]);
    expect(childCompletions.map((record) => ({
      step: record.step,
      workflow: record.workflow,
    }))).toEqual([
      { step: 'child-review', workflow: 'fast-child' },
      { step: 'child-review', workflow: 'slow-child' },
    ]);
    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    const snapshot = root.readResumeSnapshot();
    root.close();
    expect(snapshot.findingHeads).toHaveLength(2);
    const workflowCallScopes = snapshot.scopes.filter(
      (scope) => scope.kind === 'workflow_call',
    );
    expect(workflowCallScopes).toEqual([
      expect.objectContaining({ findingContractEnabled: 1 }),
      expect.objectContaining({ findingContractEnabled: 1 }),
    ]);
  });

  it('同名workflow_callを持つ異なるparallel親をrun path・Finding・SQLite scopeで分離する', async () => {
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'parent.yaml'), `name: parent
initial_step: first-reviewers
max_steps: 8
steps:
  - name: first-reviewers
    instruction: Run first reviewers
    parallel:
      - name: delegate
        kind: workflow_call
        call: shared-child
        rules:
          - condition: COMPLETE
            next: COMPLETE
          - condition: ABORT
            next: ABORT
    rules:
      - condition: all("COMPLETE")
        next: second-reviewers
  - name: second-reviewers
    instruction: Run second reviewers
    parallel:
      - name: delegate
        kind: workflow_call
        call: shared-child
        rules:
          - condition: COMPLETE
            next: COMPLETE
          - condition: ABORT
            next: ABORT
    rules:
      - condition: all("COMPLETE")
        next: COMPLETE
`);
    writeFileSync(join(workflowsDir, 'shared-child.yaml'), `name: shared-child
subworkflow:
  callable: true
finding_contract:
  ledger_path: .takt/findings/shared-child.json
  raw_findings_path: .takt/findings/shared-child-raw
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
initial_step: child-review
max_steps: 2
steps:
  - name: child-review
    persona: reviewer
    persona_display_name: reviewer
    provider: claude-terminal
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`);
    const { loadWorkflowByIdentifier } = await import(
      '../infra/config/loaders/workflowLoader.js'
    );
    const parent = loadWorkflowByIdentifier('parent', projectDir);
    if (parent === null) {
      throw new Error('Parent workflow was not loaded');
    }
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(parent, 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
    });

    expect(result.success).toBe(true);
    const directory = runDirectory(projectDir);
    const childReportDirectories = readdirSync(
      join(directory, 'reports', 'subworkflows'),
    );
    expect(childReportDirectories).toHaveLength(2);
    expect(new Set(childReportDirectories).size).toBe(2);

    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    const snapshot = root.readResumeSnapshot();
    root.close();
    expect(snapshot.findingHeads).toHaveLength(2);
    expect(new Set(snapshot.findingHeads.map((head) => head.scope_id)).size).toBe(2);
    const workflowCallScopes = snapshot.scopes.filter(
      (scope) => scope.kind === 'workflow_call',
    );
    expect(workflowCallScopes).toHaveLength(2);
    expect(new Set(workflowCallScopes.map((scope) => scope.scopeId)).size).toBe(2);
  });

  it('does not publish a terminal result when SQLite terminalization fails', async () => {
    storageFault.mode = 'terminalize';
    const events: WorkflowExecutionEvent[] = [];
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    await expect(executeWorkflow(
      simpleWorkflow(),
      'task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        eventSink: (event) => {
          events.push(event);
        },
      },
    )).rejects.toThrow('injected terminalize failure');

    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    const snapshot = root.readResumeSnapshot();
    const terminalPublication = root.readTerminalPublication();
    root.close();

    expect(readMeta(directory)).toMatchObject({ status: 'running' });
    expect(snapshot.run.status).toBe('running');
    expect(terminalPublication).toBeUndefined();
    expect(snapshot.scopes[0]?.stepExecutions).toEqual([
      expect.objectContaining({ status: 'running' }),
    ]);
    expect(completedEvents(events)).toEqual([]);
    expect(existsSync(join(directory, 'trace.md'))).toBe(false);
  });

  it('publishes the committed success once even when close fails afterward', async () => {
    storageFault.mode = 'close';
    const events: WorkflowExecutionEvent[] = [];
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(
      simpleWorkflow(),
      'task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        eventSink: (event) => {
          events.push(event);
        },
      },
    );
    expect(result).toMatchObject({ success: true });
    expect(result.finalizationIssues).toEqual([
      expect.objectContaining({
        name: 'RunCleanupError',
        cause: expect.objectContaining({
          message: 'injected close failure',
        }),
      }),
    ]);

    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    expect(root.readResumeSnapshot().run.status).toBe('completed');
    root.close();
    expect(readMeta(directory)).toMatchObject({ status: 'completed' });
    expect(completedEvents(events)).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    expect(readFileSync(join(directory, 'trace.md'), 'utf-8'))
      .toContain('- Status: ✅ completed');
  });

  it('publishes SQLite setup failure as failed before the event bridge exists', async () => {
    storageFault.mode = 'setup';
    const events: WorkflowExecutionEvent[] = [];
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    await expect(executeWorkflow(
      simpleWorkflow(),
      'task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        eventSink: (event) => {
          events.push(event);
        },
      },
    )).rejects.toThrow('injected setup failure');

    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    expect(root.readResumeSnapshot().run.status).toBe('failed');
    root.close();
    expect(readMeta(directory)).toMatchObject({
      status: 'failed',
      reason: 'injected setup failure',
    });
    expect(completedEvents(events)).toEqual([]);
    expect(readFileSync(join(directory, 'trace.md'), 'utf-8'))
      .toContain('- Status: ❌ failed');
  });

  it('publishes a provider exception with the same failed status in SQLite and its outbox', async () => {
    terminal.waitForAssistantResponse.mockRejectedValue(
      new Error('injected provider failure'),
    );
    const events: WorkflowExecutionEvent[] = [];
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(
      simpleWorkflow(),
      'task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        eventSink: (event) => {
          events.push(event);
        },
      },
    );
    expect(result).toMatchObject({
      success: false,
      reason: 'Step "implement" failed: injected provider failure',
    });
    const reason = result.reason!;

    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    const snapshot = root.readResumeSnapshot();
    const terminalPublication = root.readTerminalPublication();
    root.close();

    expect(snapshot.run.status).toBe('failed');
    expect(terminalPublication).toMatchObject({
      status: 'failed',
      reason,
      stages: [],
      publishedAt: expect.any(Number),
    });
    expect(readMeta(directory)).toMatchObject({
      status: 'failed',
      reason,
    });
    expect(completedEvents(events)).toEqual([
      expect.objectContaining({
        success: false,
        reason,
      }),
    ]);
  });

  it('publishes heartbeat failure as failed with one consistent reason', async () => {
    vi.useFakeTimers();
    storageFault.mode = 'heartbeat';
    let releaseResponse: ((value: {
      sessionId: string;
      assistantText: string;
      events: never[];
    }) => void) | undefined;
    terminal.waitForAssistantResponse.mockImplementation(() => (
      new Promise((resolve) => {
        releaseResponse = resolve;
      })
    ));
    const events: WorkflowExecutionEvent[] = [];
    const flushError = new Error('terminal event flush failed');
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );
    const execution = executeWorkflow(
      simpleWorkflow(),
      'task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        eventSink: async (event) => {
          events.push(event);
          if (event.type === 'completed') {
            throw flushError;
          }
        },
      },
    );
    const executionFailure = execution.then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    if (releaseResponse === undefined) {
      throw new Error('Terminal response waiter was not installed');
    }
    releaseResponse({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });
    const failure = await executionFailure;
    expect(failure).toEqual(
      expect.objectContaining({ message: 'injected heartbeat failure' }),
    );

    const reason = 'injected heartbeat failure';
    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    const snapshot = root.readResumeSnapshot();
    const terminalPublication = root.readTerminalPublication();
    root.close();

    expect(readMeta(directory)).toMatchObject({
      status: 'failed',
      reason,
    });
    expect(snapshot.run.status).toBe('failed');
    expect(terminalPublication).toMatchObject({
      status: 'failed',
      iteration: expect.any(Number),
      reason,
      terminalAt: expect.any(Number),
      eventId: expect.any(String),
      stages: [],
      publishedAt: expect.any(Number),
    });
    expect(snapshot.scopes[0]?.events).toEqual([
      expect.objectContaining({
        eventType: 'workflow_failed',
        payload: JSON.stringify({ reason }),
      }),
    ]);
    expect(snapshot.scopes[0]?.stepExecutions).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
    expect(existsSync(join(directory, 'trace.md'))).toBe(true);
    expect(completedEvents(events)).toEqual([
      expect.objectContaining({
        success: false,
        reason,
      }),
    ]);
  });

  it('meta投影失敗後も一次causeを保持してSQLite terminal/outboxを確定しheartbeatを停止する', async () => {
    vi.useFakeTimers();
    const primaryFailure = new Error('injected workflow primary failure');
    const projectionFailure = new Error('injected resume-point projection failure');
    const { WorkflowEngine } = await import('../core/workflow/index.js');
    const { RunMetaManager } = await import(
      '../features/tasks/execute/runMeta.js'
    );
    const runSpy = vi.spyOn(WorkflowEngine.prototype, 'run')
      .mockRejectedValueOnce(primaryFailure);
    const projectionSpy = vi.spyOn(
      RunMetaManager.prototype,
      'updateResumePoint',
    ).mockImplementation(() => {
      throw projectionFailure;
    });
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const failure = await executeWorkflow(
      simpleWorkflow(),
      'task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    runSpy.mockRestore();
    projectionSpy.mockRestore();

    expect(failure).toBe(primaryFailure);
    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    const snapshot = root.readResumeSnapshot();
    const publication = root.readTerminalPublication();
    root.close();
    expect(snapshot.run.status).toBe('failed');
    expect(snapshot.leases).toEqual([
      expect.objectContaining({
        terminal_status: 'failed',
        terminalized_at: expect.any(Number),
      }),
    ]);
    expect(publication).toMatchObject({
      status: 'failed',
      reason: primaryFailure.message,
      stages: [],
      publishedAt: expect.any(Number),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('workflow abort確定後のmeta投影失敗をoutcome非変更のissueにする', async () => {
    const providerFailure = new Error('injected provider failure before abort projection');
    const abortReason = 'Step "implement" failed: injected provider failure before abort projection';
    const projectionFailure = new Error(
      'injected abort resume-point projection failure',
    );
    const { RunMetaManager } = await import(
      '../features/tasks/execute/runMeta.js'
    );
    terminal.waitForAssistantResponse.mockRejectedValueOnce(providerFailure);
    let resumePointProjectionCount = 0;
    const projectionSpy = vi.spyOn(
      RunMetaManager.prototype,
      'updateResumePoint',
    ).mockImplementation(() => {
      resumePointProjectionCount += 1;
      if (resumePointProjectionCount === 2) {
        throw projectionFailure;
      }
    });
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    let result: Awaited<ReturnType<typeof executeWorkflow>>;
    try {
      result = await executeWorkflow(
        simpleWorkflow(),
        'task',
        projectDir,
        {
          projectCwd: projectDir,
          provider: 'claude-terminal',
        },
      );
    } finally {
      projectionSpy.mockRestore();
    }

    expect(resumePointProjectionCount).toBe(2);
    expect(result).toMatchObject({
      success: false,
      reason: abortReason,
    });
    expect(result.finalizationIssues).toEqual([
      expect.objectContaining({
        name: 'RunProjectionError',
        cause: projectionFailure,
      }),
    ]);
    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    const publication = root.readTerminalPublication();
    root.close();
    expect(publication).toMatchObject({
      status: 'failed',
      reason: abortReason,
      stages: [],
      publishedAt: expect.any(Number),
    });
    expect(readMeta(directory)).toMatchObject({
      status: 'failed',
      reason: abortReason,
    });
  });

  it('clean abort後のlive event失敗は元のoutcomeを維持する', async () => {
    const providerFailure = new Error(
      'injected provider failure before terminal publication',
    );
    const abortReason =
      'Step "implement" failed: injected provider failure before terminal publication';
    const publicationFailure = new Error(
      'injected terminal publication failure',
    );
    terminal.waitForAssistantResponse.mockRejectedValueOnce(providerFailure);
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(
      simpleWorkflow(),
      'task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        eventSink: (event) => {
          if (event.type === 'completed') {
            throw publicationFailure;
          }
        },
      },
    );

    expect(result).toMatchObject({
      success: false,
      reason: abortReason,
    });
    expect(result.finalizationIssues).toEqual([
      expect.objectContaining({
        name: 'RunLiveDeliveryError',
        cause: publicationFailure,
      }),
    ]);
  });

  it('complete後の遅延event sink失敗でもcompleted outcomeとtraceを維持する', async () => {
    vi.useFakeTimers();
    const sinkFailure = new Error('delayed nonterminal event delivery failed');
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(
      simpleWorkflow(),
      'task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        eventSink: async (event) => {
          if (event.type === 'step_completed') {
            await Promise.resolve();
            throw sinkFailure;
          }
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.finalizationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'RunLiveDeliveryError',
          cause: sinkFailure,
        }),
      ]),
    );
    const directory = runDirectory(projectDir);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const root = openRunStorage({
      databasePath: join(directory, 'run.sqlite'),
    });
    const snapshot = root.readResumeSnapshot();
    const publication = root.readTerminalPublication();
    root.close();

    expect(snapshot.run.status).toBe('completed');
    expect(publication).toMatchObject({
      status: 'completed',
      stages: [],
      publishedAt: expect.any(Number),
    });
    expect(readMeta(directory)).toMatchObject({
      status: 'completed',
    });
    expect(readFileSync(join(directory, 'trace.md'), 'utf-8'))
      .toContain('sqlite-integration');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['file', 'sqlite'] as const)(
    '%sはlive event sink失敗をoutcomeへ混在させずdurable publicationを完了する',
    async (backend) => {
      configureRunStorage(projectDir, backend);
      const { executeWorkflow } = await import(
        '../features/tasks/execute/workflowExecution.js'
      );

      const result = await executeWorkflow(
        simpleWorkflow(),
        'task',
        projectDir,
        {
          projectCwd: projectDir,
          provider: 'claude-terminal',
          eventSink: async () => {
            throw new Error('injected live delivery failure');
          },
        },
      );

      expect(result).toMatchObject({
        success: true,
        finalizationIssues: expect.arrayContaining([
          expect.objectContaining({
            name: 'RunLiveDeliveryError',
          }),
        ]),
      });
      const directory = runDirectory(projectDir);
      expect(readMeta(directory)).toMatchObject({ status: 'completed' });
      expect(existsSync(join(directory, 'trace.md'))).toBe(true);
      if (backend === 'sqlite') {
        const { openRunStorage } = await import(
          '../infra/run-storage/index.js'
        );
        const root = openRunStorage({
          databasePath: join(directory, 'run.sqlite'),
        });
        expect(root.readTerminalPublication()).toMatchObject({
          status: 'completed',
          stages: [],
          publishedAt: expect.any(Number),
        });
        root.close();
      }
    },
  );

  it('pending recovery失敗時は新run artifactsを一切生成しない', async () => {
    const failedRunSlug = '20260728-invalid-recovery';
    const { buildRunPaths } = await import(
      '../core/workflow/run/run-paths.js'
    );
    const failedPaths = buildRunPaths(projectDir, failedRunSlug);
    const { RunMetaManager } = await import(
      '../features/tasks/execute/runMeta.js'
    );
    new RunMetaManager(
      failedPaths,
      'invalid recovery task',
      'invalid-recovery-workflow',
      'sqlite',
    );
    writeFileSync(failedPaths.databaseAbs, 'not a sqlite database');
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    await expect(executeWorkflow(
      simpleWorkflow(),
      'must not create a run',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
      },
    )).rejects.toThrow();

    expect(readdirSync(join(projectDir, '.takt', 'runs'))).toEqual([
      failedRunSlug,
    ]);
  });

  it('resume source検証前にpending terminal projectionを回収する', async () => {
    const pendingRunSlug = '20260727-pending-session-a';
    const { buildRunPaths } = await import(
      '../core/workflow/run/run-paths.js'
    );
    const pendingPaths = buildRunPaths(projectDir, pendingRunSlug);
    mkdirSync(pendingPaths.runRootAbs, { recursive: true });
    const { RunMetaManager } = await import(
      '../features/tasks/execute/runMeta.js'
    );
    const startedAt = '2026-07-27T09:00:00.000Z';
    new RunMetaManager(
      pendingPaths,
      'pending task',
      'pending-workflow',
      'sqlite',
      undefined,
      {
        startTime: startedAt,
        operationJournalRunSlug: pendingRunSlug,
        operationClaimToken: 'pending-source-claim',
      },
    );
    const pendingWorkflow = simpleWorkflow();
    const {
      prepareWorkflowExecutionBundle,
      publishWorkflowExecutionBundle,
    } = await import('../features/tasks/execute/workflowExecutionBundle.js');
    const {
      createWorkflowCallResolver,
      createWorkflowExecutionContext,
    } = await import('../features/tasks/execute/workflowExecutionContext.js');
    publishWorkflowExecutionBundle(
      pendingPaths,
      prepareWorkflowExecutionBundle({
        rootWorkflow: pendingWorkflow,
        workflowCallResolver: createWorkflowCallResolver(
          createWorkflowExecutionContext(pendingWorkflow, projectDir),
        ),
        projectCwd: projectDir,
        lookupCwd: projectDir,
      }),
    );
    const {
      createSessionLog,
      initNdjsonLog,
    } = await import('../infra/fs/index.js');
    const ndjsonLogPath = initNdjsonLog(
      'pending-session-a',
      'pending task',
      'pending-workflow',
      { logsDir: pendingPaths.logsAbs, startTime: startedAt },
    );
    const {
      createWorkflowTerminalPayloadFactory,
      serializeWorkflowTerminalPublication,
    } = await import(
      '../features/tasks/execute/workflowTerminalPayload.js'
    );
    const sessionLog = createSessionLog(
      'pending task',
      projectDir,
      'pending-workflow',
      { startTime: startedAt },
    );
    const payload = createWorkflowTerminalPayloadFactory({
      runSlug: pendingRunSlug,
      projectCwd: projectDir,
      task: 'pending task',
      workflowName: 'pending-workflow',
      sessionLog,
      sessionId: 'pending-session-a',
      ndjsonLogPath,
      traceReportMode: 'redacted',
      metaSeed: {
        backend: 'sqlite',
        startedAt,
        resumeSource: null,
      },
    }).create({
      status: 'failed',
      iterations: 1,
      reason: 'pending source failed',
      lastStepContent: 'done',
      lastStepName: 'done',
      endTime: '2026-07-27T10:00:00.000Z',
    });
    const { createRunStorage, openRunStorage } = await import(
      '../infra/run-storage/index.js'
    );
    const pendingRoot = createRunStorage({
      databasePath: pendingPaths.databaseAbs,
      bootstrapSeed: createBootstrapRecoverySeed({
        task: 'pending task',
        workflowName: 'pending-workflow',
        projectCwd: projectDir,
        backend: 'sqlite',
        startedAt,
        sessionId: 'pending-session-a',
      }),
      run: {
        runId: pendingRunSlug,
        workflowName: 'pending-workflow',
        findingContractEnabled: false,
      },
    });
    const lease = pendingRoot.claimLease({
      ownerKey: 'pending-session-a',
      leaseDurationMs: 30_000,
    });
    pendingRoot.finishRun(lease, {
      status: 'failed',
      failureReason: 'pending source failed',
      publication: {
        status: 'failed',
        iteration: 1,
        reason: 'pending source failed',
        payload: serializeWorkflowTerminalPublication(payload),
      },
    });
    pendingRoot.close();

    const deliveredEvents: WorkflowExecutionEvent[] = [];
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );
    await executeWorkflow(
      simpleWorkflow(),
      'current task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: '20260727-pending-resumed-target',
        resumeSource: {
          sourceRunSlug: pendingRunSlug,
          resumeMode: 'requeue',
        },
        eventSink: async (event) => {
          deliveredEvents.push(event);
        },
      },
    );

    const recovered = openRunStorage({
      databasePath: pendingPaths.databaseAbs,
    });
    expect(recovered.readTerminalPublication()).toMatchObject({
      stages: [],
      publishedAt: expect.any(Number),
    });
    recovered.close();
    expect(deliveredEvents.filter(
      (event) => event.type === 'completed',
    )).toHaveLength(1);
  });

});
