import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { RemoteAssignmentSchema } from '../../core/worker-pool/remoteProtocol.js';
import { RemoteControlSchema } from '../../core/worker-pool/remoteExecutionProtocol.js';
import { buildRunPaths } from '../../core/workflow/run/run-paths.js';
import { goalGitText } from '../../infra/goals/git-command.js';
import { stageAndCommit } from '../../infra/task/git.js';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { LiveInterventionFileStore } from '../../infra/workflow/live-intervention-store.js';
import { setExecutionRuntimeProviderConfiguration } from '../../infra/config/runtime-provider/invocation.js';
import { TaskStoppedError } from '../../infra/task/taskStop.js';
import { GoalAbortedError, GoalPausedError } from '../tasks/execute/goalAbortMonitor.js';
import { executeWorkflowForRun } from '../tasks/execute/workflowExecution.js';
import { resolveWorkflowConfigValues, resolveWorkflowConfigValue } from '../../infra/config/index.js';
import { initGitProvider } from '../../infra/git/index.js';
import { publishTaskPullRequest } from '../tasks/execute/postExecution.js';
import { resolveTaskIssue } from '../tasks/execute/resolveTask.js';
import { loadWorkflowExecutionBundle } from '../tasks/execute/workflowExecutionBundle.js';
import { resolveTaskAttachmentManifest } from '../tasks/attachments.js';
import { RemoteExecutionInputSchema, remoteRuntimeConfiguration, withRemoteExecutionConfig } from './remoteExecutionInput.js';
import { terminateManagedProcesses } from '../../shared/utils/spawn.js';
import { prepareSharedServerPoolForForcedShutdown } from '../../infra/opencode/server-pool.js';
import { RemoteControlReceiver } from '../../infra/task/remoteControlReceiver.js';
import type { GoalTaskResult } from '../../infra/goals/schema.js';

const startSchema = z.object({ kind: z.literal('start'), assignment: RemoteAssignmentSchema,
  inputDirectory: z.string(), cloneDirectory: z.string(), controlDirectory: z.string() }).strict();
const messageSchema = z.discriminatedUnion('kind', [startSchema,
  z.object({ kind: z.literal('control'), control: RemoteControlSchema }).strict(),
  z.object({ kind: z.literal('stop') }).strict()]);
const controller = new AbortController();
let started = false;
let ready: Promise<void> = Promise.resolve();
let controlTail: Promise<void> = Promise.resolve();
let execution: z.infer<typeof startSchema> | undefined;
let goalId: string | undefined;

async function run(input: z.infer<typeof startSchema>): Promise<void> {
  const { assignment, inputDirectory, cloneDirectory, controlDirectory } = input;
  const configuration = RemoteExecutionInputSchema.parse(JSON.parse(readFileSync(join(inputDirectory, 'execution.json'), 'utf8')) as unknown);
  const slug = configuration.runSlug;
  goalId = configuration.taskConfig.goal_id;
  let markReady!: () => void;
  ready = new Promise((resolve) => { markReady = resolve; });
  let publishedSha: string | undefined;
  let workflowResult: GoalTaskResult['workflowResult'] = 'error';
  try {
    await goalGitText(process.cwd(), ['clone', '--no-checkout', '--no-local', '--', assignment.origin, cloneDirectory], controller.signal);
    await goalGitText(cloneDirectory, ['fetch', '--no-tags', 'origin', assignment.originalSha], controller.signal);
    await goalGitText(cloneDirectory, ['checkout', '-b', assignment.branch, assignment.originalSha], controller.signal);
    if (await goalGitText(cloneDirectory, ['rev-parse', 'HEAD'], controller.signal) !== assignment.originalSha) throw new Error('Remote clone does not match its fixed SHA');
    // Runtime state is transferred separately from the task's source changes.
    mkdirSync(join(cloneDirectory, '.git', 'info'), { recursive: true });
    appendFileSync(join(cloneDirectory, '.git', 'info', 'exclude'), '\n/.takt/\n');
    mkdirSync(join(controlDirectory, '.takt', 'runs', slug), { recursive: true, mode: 0o700 });
    const sourcePaths = buildRunPaths(inputDirectory, slug);
    const bundle = loadWorkflowExecutionBundle(sourcePaths);
    setExecutionRuntimeProviderConfiguration(remoteRuntimeConfiguration(configuration));
    const taskSpec = configuration.hasTaskSpec ? {
      runSlug: slug, sourceTaskDir: sourcePaths.contextTaskAbs,
      attachmentManifest: resolveTaskAttachmentManifest(sourcePaths.contextTaskAbs), taskPrompt: configuration.task,
      orderContent: readFileSync(sourcePaths.contextTaskOrderAbs, 'utf8'),
      stagedOrderContent: readFileSync(sourcePaths.contextTaskOrderAbs, 'utf8'),
    } : undefined;
    markReady();
    await withRemoteExecutionConfig(configuration, controlDirectory, cloneDirectory, async () => {
      const config = resolveWorkflowConfigValues(controlDirectory, ['language', 'providerProfiles', 'ignoreExceed']);
      const result = await executeWorkflowForRun(
        bundle.rootWorkflow, configuration.task, cloneDirectory, {
          projectCwd: controlDirectory, reportDirName: slug, preparedWorkflowBundle: bundle.prepared,
          workflowResourceRoot: bundle.resourceRoot, taskSpec,
          language: config.language, providerProfiles: config.providerProfiles,
          startStep: configuration.taskConfig.start_step, retryNote: configuration.taskConfig.retry_note,
          resumePoint: configuration.taskConfig.resume_point, restartPoint: configuration.taskConfig.restart_point,
          sourceResumePoint: configuration.taskConfig.source_resume_point,
          onLiveInterventionDelivery(instructionIds, context) { process.send?.({ kind: 'intervention-delivered', instructionIds, context }); },
          handleSigint: false, abortSignal: controller.signal, outputMode: 'silent',
        }, config.ignoreExceed ? { ignoreIterationLimit: true } : undefined,
      );
      workflowResult = result.setupFailed ? 'error' : result.exceeded ? 'exceeded'
        : result.success && !controller.signal.aborted ? 'completed' : 'aborted';
      await controlTail;
      await stageAndCommit(cloneDirectory, `takt: ${assignment.taskName}`, { allowGitHooks: false, allowGitFilters: false });
      const publicationSignal = AbortSignal.timeout(30_000);
      const sha = await goalGitText(cloneDirectory, ['rev-parse', 'HEAD'], publicationSignal);
      await goalGitText(cloneDirectory, ['push', 'origin', `HEAD:${toLocalBranchRef(assignment.branch)}`], publicationSignal);
      publishedSha = sha;
      const autoPr = configuration.taskConfig.auto_pr ?? resolveWorkflowConfigValue(controlDirectory, 'autoPr') ?? false;
      let prResult: Awaited<ReturnType<typeof publishTaskPullRequest>> = {};
      if (result.success && !controller.signal.aborted && autoPr) {
        initGitProvider(cloneDirectory);
        prResult = await publishTaskPullRequest({ projectCwd: cloneDirectory,
          task: assignment.taskName, branch: assignment.branch, baseBranch: configuration.taskConfig.base_branch,
          draftPr: configuration.taskConfig.draft_pr ?? resolveWorkflowConfigValue(controlDirectory, 'draftPr') ?? false,
          managedPr: configuration.taskConfig.managed_pr === true, goalId,
          workflowIdentifier: configuration.taskConfig.workflow,
          issues: resolveTaskIssue(configuration.taskConfig.issue, cloneDirectory),
          orderContent: taskSpec?.orderContent, abortSignal: controller.signal, outputMode: 'silent' });
      }
      const reason = controller.signal.aborted ? String(controller.signal.reason instanceof Error ? controller.signal.reason.message : controller.signal.reason)
        : result.reason;
      process.send?.({ kind: 'result', success: result.success && !controller.signal.aborted,
        interrupted: result.interrupted === true || controller.signal.aborted,
        retryable: controller.signal.reason instanceof GoalPausedError,
        workflowResult: controller.signal.aborted ? 'aborted' : workflowResult,
        reason, sha, prUrl: prResult.prUrl, prFailed: prResult.prFailed, prError: prResult.prError });
    });
  } catch (error) {
    process.send?.({ kind: 'result', success: false, sha: publishedSha,
      interrupted: controller.signal.aborted, retryable: controller.signal.reason instanceof GoalPausedError,
      workflowResult: controller.signal.aborted ? 'aborted' : workflowResult, reason: error instanceof Error
      ? error.message + ('resource' in error ? ` (${String(error.resource)})` : '') : String(error) });
  } finally {
    markReady();
    await Promise.allSettled([terminateManagedProcesses(), prepareSharedServerPoolForForcedShutdown()]);
    process.disconnect?.();
  }
}

process.on('message', (raw: unknown) => {
  const message = messageSchema.parse(raw);
  if (message.kind === 'stop') { controller.abort(new Error('Worker execution stopped')); return; }
  if (message.kind === 'start') {
    if (started) throw new Error('Remote task process cannot execute twice');
    started = true; execution = message;
    void run(message);
    return;
  }
  const { control } = message;
  controlTail = controlTail.then(async () => {
    await ready;
    if (execution === undefined) throw new Error('Remote control has no execution');
    const current = execution;
    const slug = `remote-${current.assignment.executionId}`;
    const acknowledgedSequence = await new RemoteControlReceiver(current.controlDirectory).apply(control, async () => {
      if (control.kind === 'tell') {
        if (control.content === undefined || control.instructionId === undefined) throw new Error('Remote tell instruction is incomplete');
        const store = new LiveInterventionFileStore(current.controlDirectory, slug);
        const previous = store.read().instructions.find((instruction) => instruction.instructionId === control.instructionId);
        if (previous !== undefined) {
          if (previous.content !== control.content || previous.issuedAt !== control.issuedAt) throw new Error('Remote tell instruction was changed');
        } else if (await store.issue(control.content, control.issuedAt) !== control.instructionId) throw new Error('Remote tell instruction identity does not match');
      } else {
        controller.abort(control.kind === 'stop' ? new TaskStoppedError(current.assignment.taskName, current.assignment.executionId)
          : control.kind === 'pause' ? new GoalPausedError(goalId ?? current.assignment.taskName) : new GoalAbortedError(goalId ?? current.assignment.taskName));
      }
      const directory = join(current.cloneDirectory, '.takt', 'runs', slug);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(join(directory, 'remote-controls.jsonl'), `${JSON.stringify(control)}\n`, { mode: 0o600 });
    });
    process.send?.({ kind: 'control-applied', sequence: acknowledgedSequence });
  });
  void controlTail.catch((error: unknown) => { controller.abort(error); });
});
