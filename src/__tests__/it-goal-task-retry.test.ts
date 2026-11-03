import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { buildWorkflowResumePointEntry,getWorkflowReference } from '../core/workflow/workflow-reference.js';
import type { WorkflowResumePoint } from '../core/models/index.js';
import { WorkflowCallInvocationIndex } from '../core/workflow/workflow-call-invocation-index.js';
import { WorkflowStepParticipationIndex } from '../core/workflow/workflow-step-participation-index.js';
import { buildWorkflowCallSiteIdentity } from '../core/workflow/workflow-call-site-identity.js';
import { resolveTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';
import { runAssistantRetryCommand } from '../features/interactive/assistantRetryCommand.js';
import * as managerMcp from '../features/manager/managerMcp.js';
import { createRunEventManager } from '../features/manager/runEventManager.js';
import { ManagerEventSchema, type ManagerEvent } from '../infra/goals/events.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { executeAndCompleteTask,executeTaskAndCompleteWithResult } from '../features/tasks/execute/taskExecution.js';
import { persistFailedTaskRetry } from '../features/tasks/taskRetryPersistence.js';
import { buildFailedTaskRetryStartContext,prepareFailedTaskRetry,resolveFailedTaskRetryStart } from '../features/tasks/taskRetryPreparation.js';
import * as retryPreparation from '../features/tasks/taskRetryPreparation.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache,loadWorkflowByIdentifier } from '../infra/config/index.js';
import { readManagerEvents } from '../infra/goals/events.js';
import { GoalStore } from '../infra/goals/store.js';
import { resetScenario,setMockScenario } from '../infra/mock/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { confirm } from '../shared/prompt/index.js';
import { DebugLogger } from '../shared/utils/debug.js';
import { createMockProvider } from './helpers/stdinSimulator.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { goalId } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';

const { mockRetryTty } = vi.hoisted(() => ({ mockRetryTty: vi.fn(() => false) }));

vi.mock('../shared/prompt/index.js', async (original) => ({
  ...await original<typeof import('../shared/prompt/index.js')>(), confirm: vi.fn().mockResolvedValue(true),
  confirmWithCancel: vi.fn(async () => ({ kind: 'value', value: true })),
  selectOption: vi.fn(async (_message: string, choices: Array<{ value: string }>) =>
    choices.find((choice) => choice.value === 'save_task')?.value ?? null),
}));

vi.mock('../shared/utils/index.js', async (original) => ({
  ...await original<typeof import('../shared/utils/index.js')>(),
  hasInteractiveTerminal: () => mockRetryTty(),
}));

vi.mock('../shared/prompt/tty.js', async (original) => ({
  ...await original<typeof import('../shared/prompt/tty.js')>(),
  resolveTtyPolicy: () => ({ useTty: mockRetryTty(), forceTouchTty: false }),
}));

vi.mock('node:child_process', async (original) => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, execFileSync: vi.fn(module.execFileSync) };
});

vi.mock('node:fs', async (original) => {
  const module = await original<typeof import('node:fs')>();
  return { ...module, rmSync: vi.fn(module.rmSync), unlinkSync: vi.fn(module.unlinkSync) };
});

const taskName = 'goal-work';
const branch = 'takt/goal-work';
const taskDir = '.takt/tasks/goal-work';
const originalOrder = '# Original canonical order\n\nApply the original requirements.';
const revisedOrder = '# Revised canonical order\n\nApply the corrected requirements.';
const note = 'Resume after provider capacity recovers.';
const workflowName = 'goal-retry-fixture';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('goal task retry through manager MCP and persistent task execution', () => {
  let root: string;
  let cwd: string;
  let clone: string;
  let goalBranch: string;
  let initialSha: string;
  let resultSha: string;
  let runner: TaskRunner;
  let store: GoalStore;

  beforeEach(async () => {
    mockRetryTty.mockReturnValue(false);
    vi.mocked(confirm).mockReset().mockResolvedValue(true);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-retry-')));
    cwd = join(root, 'project');
    vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
    clone = join(cwd, '.takt', 'worktrees', 'goal-work');
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'README.md'), 'fixture\n');
    initializeGitFixture(cwd, ['README.md']);
    git(cwd, ['branch', '-M', 'main']);
    git(cwd, ['config', 'user.name', 'TAKT test']);
    git(cwd, ['config', 'user.email', 'takt-test@example.invalid']);
    initialSha = git(cwd, ['rev-parse', 'HEAD']);
    mkdirSync(join(cwd, '.takt', 'workflows', 'personas'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nauto_pr: false\nmanager:\n  auto_run: false\n');
    writeFileSync(join(cwd, '.takt', 'workflows', `${workflowName}.yaml`), [
      `name: ${workflowName}`, 'max_steps: 10', 'initial_step: plan', 'steps:',
      '  - name: plan', '    persona: ./personas/planner.md', '    instruction: "{task}"',
      '    rules:', '      - condition: when(true)', '        next: review',
      '  - name: review', '    persona: ./personas/reviewer.md', '    instruction: "{task}"',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    writeFileSync(join(cwd, '.takt', 'workflows', 'personas', 'planner.md'), 'Plan the fixture task.');
    writeFileSync(join(cwd, '.takt', 'workflows', 'personas', 'reviewer.md'), 'Review the fixture task.');
    invalidateGlobalConfigCache();
    resetScenario();
    goalBranch = (await registerFixtureGoal(cwd)).branch;
    git(cwd, ['branch', branch, goalBranch]);
    mkdirSync(join(cwd, '.takt', 'worktrees'), { recursive: true });
    git(root, ['clone', '--quiet', cwd, clone]);
    git(clone, ['config', 'user.name', 'TAKT test']);
    git(clone, ['config', 'user.email', 'takt-test@example.invalid']);
    git(clone, ['checkout', '--quiet', branch]);
    cpSync(join(cwd, '.takt', 'workflows'), join(clone, '.takt', 'workflows'), { recursive: true });
    cpSync(join(cwd, '.takt', 'config.yaml'), join(clone, '.takt', 'config.yaml'));
    writeFileSync(join(clone, 'result.txt'), 'reviewed fixture result\n');
    git(clone, ['add', 'result.txt']);
    git(clone, ['commit', '--quiet', '-m', 'fixture result']);
    resultSha = git(clone, ['rev-parse', 'HEAD']);
    git(cwd, ['fetch', '--quiet', clone, `${branch}:${branch}`]);
    mkdirSync(join(cwd, taskDir), { recursive: true });
    writeFileSync(join(cwd, taskDir, 'order.md'), originalOrder);
    runner = new TaskRunner(cwd);
    runner.addTask(taskName, { task_dir: taskDir, workflow: workflowName, worktree: true,
      worktree_path: clone, branch, goal_id: goalId, goal_purpose: '入力検証', goal_work_key: 'validation' });
    const claimed = runner.claimNextTasks(1)[0]!;
    const running = runner.updateRunningTaskExecution(claimed.name, { runSlug: 'failed-run', worktreePath: clone, branch });
    runner.failTask({ task: running, success: false, response: 'provider unavailable', executionLog: [],
      failureStep: 'review', branch, worktreePath: clone,
      startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:01:00Z',
      completion: { success: false, interrupted: false, branch, sha: resultSha, workflowResult: 'error' } });
    const workflow = loadWorkflowByIdentifier(workflowName, cwd, { lookupCwd: clone })!;
    for (const runSlug of ['failed-run', 'exceeded-run']) {
      const runDir = join(clone, '.takt', 'runs', runSlug);
      for (const directory of ['logs', 'reports', 'context']) mkdirSync(join(runDir, directory), { recursive: true });
      writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
        task: taskName, workflow: workflowName, status: 'failed', runSlug,
        runRoot: `.takt/runs/${runSlug}`, reportDirectory: `.takt/runs/${runSlug}/reports`,
        contextDirectory: `.takt/runs/${runSlug}/context`, logsDirectory: `.takt/runs/${runSlug}/logs`,
        startTime: '2026-10-08T00:00:00Z', endTime: '2026-10-08T00:01:00Z', currentStep: 'review',
        resume_point: {
          version: 2, stack: [buildWorkflowResumePointEntry(workflow, 'review', 'agent', 1)],
          iteration: 1, elapsed_ms: 0, workflow_call_invocations: {}, workflow_step_participations: {},
        },
      }));
    }
    store = new GoalStore(cwd);

  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); resetScenario(); invalidateGlobalConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  async function withClient<T>(action: (client: Client) => Promise<T>, toolSet: 'manager' | 'read-only' = 'manager'): Promise<T> {
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd, toolSet });
    const client = new Client({ name: 'goal-retry-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      return await action(client);
    } finally { await client.close(); await server.close(); }
  }

  async function call(kind: 'requeue' | 'retry', extra: Record<string, unknown> = {}) {
    return withClient(async (client) => {
      const name = kind === 'requeue' ? 'takt_requeue_goal_task' : 'takt_retry_goal_task';
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain(name);
      return client.callTool({ name, arguments: { cwd, goalId, taskName,
        ...(kind === 'retry' ? { task: revisedOrder } : { retryNote: note }), ...extra } });
    });
  }

  describe('retry selection after a run stops before execution', () => {
    const previousSlug = '20261101-previous';
    const latestSlug = '20261102-startup-failed';
    const entrances = ['takt_requeue_goal_task', 'takt_retry_goal_task', '/requeue', '/retry'] as const;
    type Entrance = typeof entrances[number];

    function installNestedWorkflow() {
      const rootYaml = [
        `name: ${workflowName}`, 'initial_step: develop', 'max_steps: 10', 'steps:',
        '  - name: decoy', '    persona: ./personas/reviewer.md', '    instruction: Wrong root start',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        '  - name: develop', '    kind: workflow_call', '    call: retry-child',
        '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
      ].join('\n');
      const childYaml = [
        'name: retry-child', 'subworkflow:', '  callable: true', 'initial_step: plan', 'max_steps: 10', 'steps:',
        '  - name: wrong-first', '    persona: ./personas/reviewer.md', '    instruction: Wrong child start',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        '  - name: plan', '    persona: ./personas/planner.md', '    instruction: Start planning',
        '    output_contracts:', '      report:', '        - name: progress.md', '          format: "# Progress"',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        '  - name: implement', '    persona: ./personas/implementer.md',
        '    input_reports:', '      from_step: plan', '      reports: all',
        '    instruction: "Continue using {report:progress.md}"',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        '  - name: fix-verifier', '    persona: ./personas/verifier.md',
        '    input_reports:', '      from_step: plan', '      reports: all',
        '    instruction: "Verify using {report:progress.md}"',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      ].join('\n');
      for (const directory of [cwd, clone]) {
        writeFileSync(join(directory, '.takt', 'workflows', `${workflowName}.yaml`), rootYaml);
        writeFileSync(join(directory, '.takt', 'workflows', 'retry-child.yaml'), childYaml);
        for (const name of ['implementer', 'verifier']) {
          writeFileSync(join(directory, '.takt', 'workflows', 'personas', `${name}.md`), `You are ${name}.`);
        }
      }
      invalidateAllResolvedConfigCache();
      const parent = loadWorkflowByIdentifier(workflowName, cwd, { lookupCwd: clone })!;
      const child = loadWorkflowByIdentifier('retry-child', cwd, { lookupCwd: clone })!;
      const rootEntry = buildWorkflowResumePointEntry(parent, 'develop', 'workflow_call', 1, undefined, 1);
      const namespace = buildWorkflowCallSiteIdentity({ stack: [rootEntry], childWorkflow: child }).runPathSegment;
      const invocations = new WorkflowCallInvocationIndex(new Map());
      invocations.record(parent, 'develop', [], { call_instance: 1, report_namespace_segment: namespace });
      const participations = new WorkflowStepParticipationIndex(new Map());
      participations.record(child, 'plan', [rootEntry], ['progress.md']);
      const point = (step: string): WorkflowResumePoint => ({
        version: 2,
        stack: [rootEntry, buildWorkflowResumePointEntry(child, step, 'agent', 1, new Map([['plan', 1]]))],
        iteration: 2, elapsed_ms: 100,
        workflow_call_invocations: invocations.serialized(), workflow_step_participations: participations.serialized(),
      });
      for (const slug of ['failed-run', 'exceeded-run']) {
        rmSync(join(clone, '.takt', 'runs', slug), { recursive: true, force: true });
      }
      new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({
        ...task, run_slug: latestSlug, resume_point: undefined,
        failure: { step: 'implement', error: 'ENOSPC before workflow execution' },
      })) }));
      return { point, namespace };
    }

    function writeHistoryRun(slug: string, startTime: string, options: {
      point?: WorkflowResumePoint; reports?: boolean; prompt?: string;
    } = {}) {
      const directory = join(clone, '.takt', 'runs', slug);
      mkdirSync(directory, { recursive: true });
      if (options.reports !== false) mkdirSync(join(directory, 'reports'), { recursive: true });
      writeFileSync(join(directory, 'meta.json'), JSON.stringify({
        task: options.prompt ?? resolveTaskSpecForExecution(cwd, clone, taskDir, slug).taskPrompt,
        workflow: workflowName, status: 'failed', runSlug: slug, startTime,
        runRoot: `.takt/runs/${slug}`, reportDirectory: `.takt/runs/${slug}/reports`,
        contextDirectory: `.takt/runs/${slug}/context`, logsDirectory: `.takt/runs/${slug}/logs`,
        ...(options.point === undefined ? {} : { resume_point: options.point }),
      }));
    }

    function writeProgress(slug: string, namespace: string, content: string) {
      const directory = join(clone, '.takt', 'runs', slug, 'reports', 'subworkflows', namespace);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'progress.md'), content);
    }

    async function queueThrough(entrance: Entrance) {
      if (entrance === 'takt_requeue_goal_task' || entrance === 'takt_retry_goal_task') {
        const result = await call(entrance === 'takt_requeue_goal_task' ? 'requeue' : 'retry');
        expect(result.isError, firstTextContent(result.content)).toBeUndefined();
        return firstTextContent(result.content);
      }
      const failed = runner.listFailedTasks()[0]!;
      const preparation = prepareFailedTaskRetry(failed, cwd);
      const context = buildFailedTaskRetryStartContext(preparation, cwd, workflowName, true);
      const { provider } = createMockProvider([
        'Use the proposed default start position.',
        JSON.stringify({ startOptionId: context.startOptions.defaultId }),
        ...(entrance === '/retry' ? [revisedOrder] : []),
      ]);
      mockRetryTty.mockReturnValue(true);
      return runAssistantRetryCommand({
        cwd, lang: 'en', command: entrance === '/retry' ? 'retry' : 'requeue',
        inlineText: '', history: [{ role: 'user', content: 'Continue this task.' }], formalSpec: false, showProgress: false,
        sessionContext: { provider, providerType: 'mock', model: undefined, lang: 'en',
          personaName: 'assistant', sessionId: undefined },
      });
    }

    async function executeQueued(expectedPersona: string, inherited?: { namespace: string; content: string }) {
      const started: Array<{ persona: string; prompt: string; cwd: string | undefined }> = [];
      const setup = MockProvider.prototype.setup;
      vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
        const agent = setup.call(this, config);
        return { call: async (prompt, options) => {
          started.push({ persona: config.name, prompt, cwd: options?.cwd });
          setMockScenario([{ persona: config.name, status: 'done', content: 'Complete.' }]);
          return agent.call(prompt, options);
        } };
      });
      const claimed = new TaskRunner(cwd).claimNextTasks(1)[0]!;
      expect(await executeAndCompleteTask(claimed, runner, cwd, { provider: 'mock' }, { outputMode: 'silent' }),
        JSON.stringify(runner.listAllTaskItems().map((task) => task.failure))).toBe(true);
      expect(started[0]?.persona).toBe(expectedPersona);
      expect(started.every((entry) => entry.cwd === clone)).toBe(true);
      expect(git(clone, ['branch', '--show-current'])).toBe(branch);
      if (inherited !== undefined) {
        expect(started[0]?.prompt).toContain(inherited.content);
        const completed = runner.listTaskStateItems()[0]!;
        expect(readFileSync(join(clone, '.takt', 'runs', completed.runSlug!, 'reports',
          'subworkflows', inherited.namespace, 'progress.md'), 'utf8')).toBe(inherited.content);
      }
    }

    async function failRetryBeforeRunMetadata(saved: WorkflowResumePoint): Promise<string> {
      const failed = new TaskRunner(cwd).listFailedTasks()[0]!;
      await persistFailedTaskRetry({
        task: failed, projectDir: cwd, worktreePath: clone, taskDir: failed.taskDir,
        sourceRunSlug: previousSlug, resumePoint: saved, startStep: undefined,
        retryNote: undefined, restartPoint: undefined, workflow: undefined,
      });
      const pending = new TaskRunner(cwd).listPendingTaskItems()[0]!;
      expect(pending).toMatchObject({ sourceRunSlug: previousSlug, data: { resume_point: saved } });
      const claimed = runner.claimNextTasks(1)[0]!;
      expect(claimed).toMatchObject({ sourceRunSlug: previousSlug, data: { resume_point: saved } });
      const setup = vi.spyOn(MockProvider.prototype, 'setup');

      const success = await executeTaskAndCompleteWithResult(
        claimed, runner, cwd, async (options) => {
          expect(options.resumeSource?.sourceRunSlug).toBe(previousSlug);
          expect(options.resumePoint).toEqual(saved);
          expect(new TaskRunner(cwd).listTaskStateItems()[0]?.runSlug).toBe(options.reportDirName);
          throw Object.assign(new Error('ENOSPC before run metadata was written'), { code: 'ENOSPC' });
        }, { provider: 'mock' }, { outputMode: 'silent' },
      );

      expect(success).toBe(false);
      expect(setup).not.toHaveBeenCalled();
      setup.mockRestore();
      const stopped = new TaskRunner(cwd).listFailedTasks()[0]!;
      expect(stopped).toMatchObject({
        sourceRunSlug: previousSlug, worktreePath: clone, branch,
        data: { resume_point: saved }, failure: { error: expect.stringContaining('ENOSPC') },
      });
      expect(stopped.runSlug).toBeDefined();
      expect(stopped.runSlug).not.toBe(previousSlug);
      expect(existsSync(join(clone, '.takt', 'runs', stopped.runSlug!, 'meta.json'))).toBe(false);
      expect(existsSync(join(clone, '.takt', 'runs', stopped.runSlug!, 'reports'))).toBe(false);
      return stopped.runSlug!;
    }

    it('selects the newest usable task run beyond startup failures and a run with missing reports', () => {
      const { point } = installNestedWorkflow();
      writeHistoryRun('z-oldest', '2026-10-28T00:00:00Z', { point: point('fix-verifier') });
      writeHistoryRun('a-newest-usable', '2026-10-29T00:00:00Z', { point: point('implement') });
      writeHistoryRun('missing-reports', '2026-10-30T00:00:00Z', { point: point('fix-verifier'), reports: false });
      for (let index = 0; index < 11; index += 1) {
        writeHistoryRun(`startup-${index}`, `2026-11-01T${String(index).padStart(2, '0')}:00:00Z`, { reports: false });
      }
      writeHistoryRun(latestSlug, '2026-11-02T00:00:00Z', { reports: false });

      const selected = prepareFailedTaskRetry(runner.listFailedTasks()[0]!, cwd);

      expect(selected.matchedRunSlug).toBe('a-newest-usable');
      expect(selected.runMeta?.runSlug).toBe('a-newest-usable');
      expect(selected.resumePoint).toEqual(point('implement'));
      expect(selected.worktreePath).toBe(clone);
      expect(selected.freshStart).toBe(false);
    });

    it('matches the generated task header without accepting task directory mentions in another task body', () => {
      const { point } = installNestedWorkflow();
      writeHistoryRun(previousSlug, '2026-11-01T00:00:00Z', { point: point('implement') });
      const mention = 'Task directory: goal-work';
      const bodies = [mention, `> ${mention}`, `\`\`\`\n${mention}\n\`\`\``,
        `~~~\n${mention}\n~~~`, `\`\`\`\n~~~\n${mention}\n~~~\n\`\`\``, `\`\`\`\n${mention}`];
      for (const [index, body] of bodies.entries()) {
        writeHistoryRun(`unrelated-${index}`, '2026-11-01T12:00:00Z', {
          point: point('fix-verifier'), prompt: `Task: Another task\nTask directory: other-task\n\n${body}`,
        });
      }
      writeHistoryRun('missing-header', '2026-11-01T13:00:00Z', {
        point: point('fix-verifier'), prompt: `Task: Another task\n\n\`\`\`\nTask: Example\n${mention}\n\`\`\``,
      });
      writeHistoryRun(latestSlug, '2026-11-02T00:00:00Z', { reports: false });

      const selected = prepareFailedTaskRetry(runner.listFailedTasks()[0]!, cwd);

      expect(selected.matchedRunSlug).toBe(previousSlug);
      expect(selected.runMeta?.runSlug).toBe(previousSlug);
      expect(selected.resumePoint).toEqual(point('implement'));
    });

    it('finds the previous saved position when the latest run directory was never created', () => {
      const { point } = installNestedWorkflow();
      const saved = point('implement');
      writeHistoryRun(previousSlug, '2026-11-01T00:00:00Z', { point: saved });

      const selected = prepareFailedTaskRetry(runner.listFailedTasks()[0]!, cwd);

      expect(selected.matchedRunSlug).toBe(previousSlug);
      expect(selected.resumePoint).toEqual(saved);
    });

    it('preserves a task-owned saved position when the latest metadata has no position', () => {
      const { point } = installNestedWorkflow();
      const saved = point('fix-verifier');
      writeHistoryRun(previousSlug, '2026-11-01T00:00:00Z', { point: point('implement') });
      writeHistoryRun(latestSlug, '2026-11-02T00:00:00Z');
      new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, resume_point: saved })) }));

      const selected = prepareFailedTaskRetry(runner.listFailedTasks()[0]!, cwd);

      expect(selected.matchedRunSlug).toBe(latestSlug);
      expect(selected.resumePoint).toEqual(saved);
    });

    it.each(['requeue', 'retry'] as const)('rejects fallback for an invalid latest saved position through MCP %s', async (command) => {
      const { point } = installNestedWorkflow();
      writeHistoryRun(previousSlug, '2026-11-01T00:00:00Z', { point: point('implement') });
      const invalid = point('fix-verifier');
      invalid.stack = invalid.stack.map((entry, index) => index === 1 ? { ...entry, step: 'removed-step' } : entry);
      writeHistoryRun(latestSlug, '2026-11-02T00:00:00Z', { point: invalid });

      const result = await call(command);

      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toMatch(/removed-step|saved resume position/i);
      expect(new TaskRunner(cwd).listPendingTaskItems()).toEqual([]);
      expect(runner.listFailedTasks()[0]).toMatchObject({ runSlug: latestSlug, worktreePath: clone, branch });
      expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(originalOrder);
    });

    // SCN-TL-RESUME-P1
    it.each(entrances)('resumes the previous nested position and reports the skipped startup run via %s', async (entrance) => {
      const { point, namespace } = installNestedWorkflow();
      const saved = point('implement');
      writeHistoryRun(previousSlug, '2026-11-01T00:00:00Z', { point: saved });
      writeProgress(previousSlug, namespace, 'Previously completed planning');
      writeHistoryRun(latestSlug, '2026-11-02T00:00:00Z', { reports: false });
      const prepare = vi.spyOn(retryPreparation, 'prepareFailedTaskRetry');
      const log = vi.spyOn(DebugLogger.prototype, 'writeLog');

      const response = await queueThrough(entrance);

      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ runSlug: latestSlug }), cwd);
      expect(prepare).toHaveBeenCalledTimes(entrance.startsWith('/') ? 2 : 1);
      const pending = new TaskRunner(cwd).listPendingTaskItems()[0]!;
      expect(pending).toMatchObject({ sourceRunSlug: previousSlug, worktreePath: clone, branch });
      expect(pending.data?.resume_point).toEqual(saved);
      expect(pending.data?.restart_point).toBeUndefined();
      for (const output of [response, entrance.startsWith('/')
        ? JSON.stringify(log.mock.calls) : JSON.stringify((await store.get(goalId)).workLog)]) {
        expect(output).toContain(previousSlug);
        expect(output).toContain(latestSlug);
        expect(output).toMatch(/develop[\s\S]*implement/);
        expect(output).toMatch(/(?:no|missing|without|unavailable)[\s\S]*(?:resume|checkpoint|position)|(?:resume|checkpoint|position)[\s\S]*(?:missing|absent|not found)/i);
      }
      await executeQueued('implementer', { namespace, content: 'Previously completed planning' });
    });

    // Scenario: 所有元が不明な checkpoint を別の run の report と組み合わせない
    // Given: run slug 未記録のタスクと同じ位置を持つ最新 run に report がない
    // When: requeue / retry する
    // Then: 古い run 自身の位置から再開し、その位置もなければ初期段階から始める
    it.each(entrances.flatMap((entrance) => [false, true].map((hasOlderPoint) => ({ entrance, hasOlderPoint }))))(
      'keeps an unowned checkpoint out of older reports via $entrance with older checkpoint=$hasOlderPoint',
      async ({ entrance, hasOlderPoint }) => {
        const { point, namespace } = installNestedWorkflow();
        const saved = point('fix-verifier');
        const olderPoint = hasOlderPoint ? point('implement') : undefined;
        writeHistoryRun(previousSlug, '2026-11-01T00:00:00Z', { point: olderPoint });
        writeProgress(previousSlug, namespace, 'Older planning report');
        writeHistoryRun(latestSlug, '2026-11-02T00:00:00Z', { point: saved, reports: false });
        new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({
          ...task, run_slug: undefined, source_run_slug: undefined, resume_point: saved,
        })) }));

        await queueThrough(entrance);

        const pending = new TaskRunner(cwd).listPendingTaskItems()[0]!;
        expect(pending).toMatchObject({ worktreePath: clone, branch });
        expect(pending.sourceRunSlug).toBe(hasOlderPoint ? previousSlug : undefined);
        expect(pending.data?.resume_point).toEqual(olderPoint);
        expect(pending.data?.start_step).toBeUndefined();
        expect(pending.data?.restart_point).toBeUndefined();
        await executeQueued(hasOlderPoint ? 'implementer' : 'planner',
          hasOlderPoint ? { namespace, content: 'Older planning report' } : undefined);
      },
    );

    // SCN-TL-RESUME-P2
    it.each(entrances)('starts at the configured initial call in the same worktree when no run has a position via %s', async (entrance) => {
      installNestedWorkflow();
      writeHistoryRun(previousSlug, '2026-11-01T00:00:00Z');
      writeHistoryRun(latestSlug, '2026-11-02T00:00:00Z', { reports: false });
      const log = vi.spyOn(DebugLogger.prototype, 'writeLog');

      const response = await queueThrough(entrance);

      const pending = new TaskRunner(cwd).listPendingTaskItems()[0]!;
      expect(pending).toMatchObject({ worktreePath: clone, branch });
      expect(pending.sourceRunSlug).toBeUndefined();
      expect(pending.data?.start_step).toBeUndefined();
      expect(pending.data?.resume_point).toBeUndefined();
      expect(pending.data?.restart_point).toBeUndefined();
      for (const output of [response, entrance.startsWith('/')
        ? JSON.stringify(log.mock.calls) : JSON.stringify((await store.get(goalId)).workLog)]) {
        expect(output).toMatch(/initial|beginning|workflow[^\n]*start|start[^\n]*workflow/i);
        expect(output).toMatch(/(?:no|without|none|null)[\s\S]*source|source[\s\S]*(?:none|null|absent)/i);
      }
      await executeQueued('planner');
    });

    // SCN-TL-RESUME-P1 / SCN-RESUME-01-P1
    it.each(entrances)('resumes the inherited source after a persisted retry fails before metadata via %s', async (entrance) => {
      const { point, namespace } = installNestedWorkflow();
      const saved = point('implement');
      writeHistoryRun(previousSlug, '2026-11-01T00:00:00Z', { point: saved });
      writeProgress(previousSlug, namespace, 'Planning retained through a startup failure');
      const failedSlug = await failRetryBeforeRunMetadata(saved);
      const prepare = vi.spyOn(retryPreparation, 'prepareFailedTaskRetry');
      const log = vi.spyOn(DebugLogger.prototype, 'writeLog');

      const response = await queueThrough(entrance);

      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
        runSlug: failedSlug, sourceRunSlug: previousSlug, data: expect.objectContaining({ resume_point: saved }),
      }), cwd);
      const pending = new TaskRunner(cwd).listPendingTaskItems()[0]!;
      expect(pending).toMatchObject({ sourceRunSlug: previousSlug, worktreePath: clone, branch });
      expect(pending.data?.resume_point).toEqual(saved);
      expect(pending.data?.restart_point).toBeUndefined();
      for (const output of [response, entrance.startsWith('/')
        ? JSON.stringify(log.mock.calls) : JSON.stringify((await store.get(goalId)).workLog)]) {
        expect(output).toContain(previousSlug);
        expect(output).toContain(failedSlug);
        expect(output).toMatch(/develop[\s\S]*implement/);
        expect(output).toMatch(/metadata[\s\S]*(?:missing|not found|unavailable)|(?:missing|not found|unavailable)[\s\S]*metadata/i);
      }
      await executeQueued('implementer', { namespace, content: 'Planning retained through a startup failure' });
    });

    // SCN-TL-RESUME-N1 / SCN-RESUME-01-N1
    it.each(entrances)('preserves the latest verifier position instead of the older implement position via %s', async (entrance) => {
      const { point, namespace } = installNestedWorkflow();
      writeHistoryRun(previousSlug, '2026-11-01T00:00:00Z', { point: point('implement') });
      writeProgress(previousSlug, namespace, 'Old planning report');
      const failedSlug = await failRetryBeforeRunMetadata(point('implement'));
      const latest = point('fix-verifier');
      writeHistoryRun(failedSlug, '2026-11-02T00:00:00Z', { point: latest });
      writeProgress(failedSlug, namespace, 'Latest planning report');

      await queueThrough(entrance);

      const pending = new TaskRunner(cwd).listPendingTaskItems()[0]!;
      expect(pending.sourceRunSlug).toBe(failedSlug);
      expect(pending.data?.resume_point).toEqual(latest);
      expect(pending.data?.restart_point).toBeUndefined();
      await executeQueued('verifier', { namespace, content: 'Latest planning report' });
    });
  });

  async function exceed() {
    runner.requeueFailedTask(taskName, 'review');
    const running = runner.claimNextTasks(1)[0]!;
    runner.updateRunningTaskExecution(running.name, { runSlug: 'exceeded-run', branch, worktreePath: clone });
    const workflow = loadWorkflowByIdentifier(workflowName, cwd, { lookupCwd: clone })!;
    runner.exceedTask(taskName, { currentStep: 'review', currentIteration: 4, newMaxSteps: 10,
      branch, worktreePath: clone, resumePoint: {
        version: 2, stack: [{ workflow: workflowName, workflow_ref: getWorkflowReference(workflow), step: 'review', kind: 'agent', occurrence: 2,
          step_iterations: { plan: 1, review: 2 } }], iteration: 4, elapsed_ms: 1000,
        workflow_call_invocations: {}, workflow_step_participations: {},
      } });
  }

  async function runAndMerge(expectedPersona: 'planner' | 'reviewer', expectedOrder: string, expectedNote?: string) {
    const originalSetup = MockProvider.prototype.setup;
    const started: string[] = [];
    const processed: ManagerEvent[] = [];
    vi.spyOn(managerMcp, 'connectManagerMcp').mockResolvedValue({ client: new Client({ name: 'run-fixture', version: '1' }), servers: {}, dispose: async () => {} });
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = originalSetup.call(this, config);
      return { call: async (prompt, options) => {
        if (config.name === 'manager') {
          processed.push(ManagerEventSchema.parse((JSON.parse(prompt.split('\n\nGoal memory')[0]!) as { event: unknown }).event));
          return { persona: 'manager', status: 'done', timestamp: new Date(), content: '', structuredOutput: { message: 'Retry result inspected', summary: null }, sessionId: 'run-manager' };
        }
        started.push(config.name);
        if (expectedNote !== undefined) expect(prompt).toContain(expectedNote);
        setMockScenario([{ persona: config.name, status: 'done', content: 'Complete.' }]);
        return agent.call(prompt, options);
      } };
    });
    const pending = runner.listTasks()[0]!;
    const resolved = await resolveTaskExecution(pending, cwd, undefined, { outputMode: 'silent' });
    expect(resolved.startStep).toBe(expectedPersona === 'planner' ? 'plan' : 'review');
    const result = await runWithWorkerPool(runner, runner.claimNextTasks(1), 1, cwd, { provider: 'mock' }, undefined, 10);
    expect(result).toMatchObject({ success: 1, fail: 0, executedTaskNames: [taskName] });
    expect(started).toEqual(expectedPersona === 'planner' ? ['planner', 'reviewer'] : ['reviewer']);
    const completed = new TaskRunner(cwd).listTaskStateItems()[0]!;
    expect(completed).toMatchObject({ name: taskName, goalId, branch, status: 'completed',
      completion: { success: true, branch, sha: resultSha } });
    expect(completed.runSlug).toBeDefined();
    expect(completed.runSlug).not.toBe('failed-run');
    const saved = readManagerEvents(cwd).map(({ event }) => event);
    expect(saved).toEqual([
      { kind: 'registered', goalId, createdAt: expect.any(String) },
      { kind: 'completion', goalId, taskName, runSlug: completed.runSlug,
        result: completed.completion, createdAt: expect.any(String) },
    ]);
    expect(processed).toEqual([]);
    expect((await store.get(goalId)).workLog.filter(({ summary }) => summary === 'Retry result inspected')).toEqual([]);
    const manager = createRunEventManager(cwd);
    try {
      expect(await manager.processPending(new AbortController().signal, 10)).toBe(true);
    } finally { await manager.close(); }
    expect(processed).toEqual(saved);
    const event = processed.find((event) => event.kind === 'completion' && event.runSlug === completed.runSlug);
    expect(readManagerEvents(cwd)).toEqual([]);
    expect((await store.get(goalId)).workLog).toContainEqual(expect.objectContaining({ summary: 'Retry result inspected' }));
    expect(event).toMatchObject({ taskName, runSlug: completed.runSlug, result: { success: true, branch } });
    const stagedOrder = join(clone, '.takt', 'runs', completed.runSlug!, 'context', 'task', 'order.md');
    expect(readFileSync(stagedOrder, 'utf8')).toBe(expectedOrder);
    const merged = await withClient((client) => client.callTool({ name: 'takt_merge_goal_task', arguments: {
      cwd, goalId, taskName, expectedSha: resultSha,
    } }));
    expect(merged.isError, firstTextContent(merged.content)).toBeUndefined();
    expect(JSON.parse(firstTextContent(merged.content))).toMatchObject({ status: 'merged', expectedSha: resultSha, sourceBranch: branch });
    expect(git(cwd, ['merge-base', '--is-ancestor', resultSha, goalBranch])).toBe('');
    expect((await store.get(goalId)).workLog).toContainEqual(expect.objectContaining({ summary: expect.stringContaining(taskName) }));
  }

  it('registers both retry tools for manager use while keeping read-only tools unchanged', async () => {
    await withClient(async (client) => {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(expect.arrayContaining(['takt_requeue_goal_task', 'takt_retry_goal_task']));
    });
    await withClient(async (client) => {
      const names = (await client.listTools()).tools.map(({ name }) => name);
      expect(names).not.toContain('takt_requeue_goal_task');
      expect(names).not.toContain('takt_retry_goal_task');
    }, 'read-only');
  });

  it.each(['requeue', 'retry', 'remove'] as const)('retrieves saved %s results through task and work-log read tools', async (kind) => {
    await withClient(async (client) => {
      const read = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: { cwd, goalId, ...args } });
        expect(result.isError, firstTextContent(result.content)).toBeUndefined();
        return JSON.parse(firstTextContent(result.content));
      };
      await read('takt_record_goal_work_log', { summary: '操作前' });
      const reason = '別の方法に変更'.repeat(3000);
      const result = await read(`takt_${kind}_goal_task`, { taskName,
        ...(kind === 'retry' ? { task: revisedOrder } : kind === 'remove' ? { reason } : { retryNote: note }),
      });
      expect(result.status).toBe(kind === 'remove' ? 'removed' : 'pending');
      await read('takt_record_goal_work_log', { summary: '操作後' });
      const latest = await read('takt_list_goal_work_log', { limit: 1 });
      expect(latest).toMatchObject({ totalCount: 3, returnedCount: 1, nextOffset: 1, truncated: true });
      expect(latest.workLog[0].summary).toBe('操作後');
      const page = await read('takt_list_goal_work_log', { limit: 1, offset: latest.nextOffset });
      const recordId = page.workLog[0].id;
      let summary = '';
      let textOffset = 0;
      for (;;) {
        const text = await read('takt_get_goal', { path: 'workLog.summary', recordId, textOffset });
        summary += text.content;
        if (text.nextOffset === null) break;
        textOffset = text.nextOffset;
      }
      if (kind === 'remove') expect(summary).toBe(`Removed ${taskName}: ${reason}`);
      else expect(summary).toContain(`${kind === 'retry' ? 'Retried with corrected instructions' : 'Requeued'} ${taskName}`);
      const tasks = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd, limit: 1 } });
      expect(tasks.isError).toBeUndefined();
      const savedTasks = JSON.parse(firstTextContent(tasks.content)).tasks;
      expect(savedTasks).toEqual(kind === 'remove' ? [] : [expect.objectContaining({ name: taskName, status: 'pending' })]);
    });
  });

  it('preserves the existing human Requeue path for an ordinary failed task', async () => {
    new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({
      ...task, goal_id: undefined, goal_purpose: undefined, goal_work_key: undefined,
    })) }));
    const failed = runner.listFailedTasks()[0]!;
    const preparation = prepareFailedTaskRetry(failed, cwd);
    const context = buildFailedTaskRetryStartContext(preparation, cwd, workflowName);
    const start = resolveFailedTaskRetryStart(context, context.startOptions.defaultId);
    await persistFailedTaskRetry({ task: failed, projectDir: cwd, worktreePath: clone,
      startStep: start.startStep, retryNote: note, resumePoint: start.resumePoint,
      restartPoint: start.restartPoint, workflow: context.workflowOverride,
      taskDir: failed.taskDir, sourceRunSlug: preparation.matchedRunSlug });
    const pending = runner.listTasks()[0]!;
    expect(pending.status).toBe('pending');
    expect(pending.data?.goal_id).toBeUndefined();
    const resolved = await resolveTaskExecution(pending, cwd, undefined, { outputMode: 'silent' });
    expect(resolved.startStep).toBe('review');
    const setup = vi.spyOn(MockProvider.prototype, 'setup');
    setMockScenario([{ persona: 'reviewer', status: 'done', content: 'Complete.' }]);
    expect(await executeAndCompleteTask(runner.claimNextTasks(1)[0]!, runner, cwd,
      { provider: 'mock' }, { outputMode: 'silent' })).toBe(true);
    expect(setup.mock.calls.map(([config]) => config.name)).toEqual(['reviewer']);
    expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(originalOrder);
    expect(runner.listTaskStateItems()[0]!.status).toBe('completed');
  });

  it('requeues exceeded work with the saved checkpoint, iteration, limit and note', async () => {
    await exceed();
    const stopped = runner.listAllTaskItems()[0]!;
    const result = await call('requeue');
    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    const pending = runner.listTasks()[0]!;
    expect(pending.data).toMatchObject({ goal_id: goalId, branch, start_step: 'review',
      exceeded_current_iteration: 4, exceeded_max_steps: 10, resume_point: stopped.data!.resume_point });
    expect(pending.data!.retry_note).toContain(note);
    const resolved = await resolveTaskExecution(pending, cwd, undefined, { outputMode: 'silent' });
    expect(resolved).toMatchObject({ startStep: 'review', initialIterationOverride: 4, maxStepsOverride: 10 });
    await runAndMerge('reviewer', originalOrder, note);
  });

  it.each(['plan', undefined])('retries corrected instructions from the requested or default start (%s)', async (startStep) => {
    const result = await call('retry', startStep === undefined ? {} : { startStep });
    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    const pending = runner.listPendingTaskItems()[0]!;
    expect(pending).toMatchObject({ name: taskName, kind: 'pending', branch, worktreePath: clone });
    expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(revisedOrder);
    expect(pending.data?.retry_note?.includes(revisedOrder)).not.toBe(true);
    const archives = readdirSync(join(cwd, taskDir)).filter((name) => name.startsWith('order.md.'));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(cwd, taskDir, archives[0]!), 'utf8')).toBe(originalOrder);
    await runAndMerge(startStep === 'plan' ? 'planner' : 'reviewer', revisedOrder);
  });

  it('continues to skip automatic retries for failed goal-owned work', () => {
    const before = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
    expect(runner.autoRequeueFailedTask(taskName, { maxAttempts: 3 })).toMatchObject({ requeued: false, reason: 'goal_owned' });
    expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(before);
  });


});
