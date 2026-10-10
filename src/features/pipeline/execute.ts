import { resolveConfigValues } from '../../infra/config/index.js';
import { info, error, status, blankLine } from '../../shared/ui/index.js';
import { createLogger, getErrorMessage, getSlackWebhookUrl, sendSlackNotification, buildSlackRunSummary, generateRunId } from '../../shared/utils/index.js';
import type { SlackTaskDetail } from '../../shared/utils/index.js';
import type { PipelineExecutionOptions } from '../tasks/index.js';
import {
  EXIT_ISSUE_FETCH_FAILED,
  EXIT_WORKFLOW_FAILED,
  EXIT_GIT_OPERATION_FAILED,
  EXIT_PR_CREATION_FAILED,
} from '../../shared/exitCodes.js';
import {
  resolveTaskContent,
  resolveExecutionContext,
  runWorkflow,
  commitAndPush,
  buildCommitMessage,
  type ExecutionContext,
  type TaskContent,
} from './steps.js';
import { GitHubProvider } from '../../infra/github/GitHubProvider.js';
import { prepareGithubTaskImages } from '../tasks/githubImages.js';
import { prepareTaskSpecDirectory, cleanupPreparedTaskSpec } from '../tasks/attachments.js';
import { resolveTaskSpecForExecution, type ResolvedTaskSpec } from '../tasks/execute/taskSpecContext.js';
import { generateExecutionReportDir } from '../../core/workflow/run/run-slug.js';
import { submitPullRequest } from './prSubmission.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import {
  createLoopAnalysisPublicationCoordinator,
  settleLoopAnalysisPublication,
} from '../tasks/execute/loopAnalysisPublication.js';
import { runLinkedCacciaSafely } from '../caccia/index.js';
import { runLinkedMergeSafely } from '../merge/index.js';

export type { PipelineExecutionOptions };

const log = createLogger('pipeline');

interface PipelineOutcome {
  exitCode: number;
  result: PipelineResult;
}

async function preparePipelineTaskSpec(
  cwd: string,
  execCwd: string,
  taskContent: TaskContent,
): Promise<{ task: string; taskSpec?: ResolvedTaskSpec; cleanup?: () => void }> {
  const source = taskContent.prReview !== undefined ? { prReview: taskContent.prReview }
    : taskContent.issue !== undefined ? { issue: taskContent.issue } : undefined;
  if (!(taskContent.gitProvider instanceof GitHubProvider) || source === undefined) {
    return { task: taskContent.task };
  }
  const images = await prepareGithubTaskImages(cwd, source);
  let preparedSpec: ReturnType<typeof prepareTaskSpecDirectory> | undefined;
  const cleanup = (): void => {
    process.off('exit', cleanup);
    if (preparedSpec !== undefined) {
      cleanupPreparedTaskSpec(preparedSpec.taskDir);
      preparedSpec = undefined;
    }
  };
  try {
    if (images.attachments.length === 0) return { task: images.task };
    preparedSpec = prepareTaskSpecDirectory(cwd, images.task, images.attachments);
    process.once('exit', cleanup);
    const reportDirName = generateExecutionReportDir(execCwd, images.task);
    const taskSpec = resolveTaskSpecForExecution(cwd, execCwd, preparedSpec.taskDirRelative, reportDirName);
    return { task: taskSpec.taskPrompt, taskSpec, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    images.cleanup();
  }
}

async function runPipeline(options: PipelineExecutionOptions): Promise<PipelineOutcome> {
  const { cwd, workflow, autoPr, skipGit } = options;
  const pipelineConfig = resolveConfigValues(cwd, ['pipeline']).pipeline;

  const buildResult = (overrides: Partial<PipelineResult> = {}): PipelineResult => ({
    success: false, workflow, issueNumber: options.issueNumber, ...overrides,
  });

  const taskContent = resolveTaskContent(options);
  if (!taskContent) return { exitCode: EXIT_ISSUE_FETCH_FAILED, result: buildResult() };

  let context: ExecutionContext;
  try {
    context = await resolveExecutionContext(
      cwd,
      taskContent.task,
      options,
      pipelineConfig,
      taskContent.prBranch,
      taskContent.prBaseBranch,
    );
  } catch (err) {
    error(`Failed to prepare execution environment: ${getErrorMessage(err)}`);
    return { exitCode: EXIT_GIT_OPERATION_FAILED, result: buildResult() };
  }

  const loopAnalysisPublication = autoPr && !skipGit && context.branch
    ? createLoopAnalysisPublicationCoordinator(context.branch)
    : undefined;
  const preparedTask = await preparePipelineTaskSpec(cwd, context.execCwd, taskContent);
  try {
    log.info('Pipeline workflow execution starting', { workflow, branch: context.branch, skipGit, issueNumber: options.issueNumber });
    const workflowOk = await runWorkflow(
      cwd,
      workflow,
      preparedTask.task,
      context.execCwd,
      options,
      context,
      loopAnalysisPublication,
      preparedTask.taskSpec,
    );
    if (!workflowOk) return { exitCode: EXIT_WORKFLOW_FAILED, result: buildResult({ branch: context.branch }) };

    if (!skipGit && context.branch) {
      const commitMessage = buildCommitMessage(pipelineConfig, taskContent.issue, options.task);
      if (!await commitAndPush(context.execCwd, cwd, context.branch, commitMessage, context.isWorktree)) {
        return { exitCode: EXIT_GIT_OPERATION_FAILED, result: buildResult({ branch: context.branch }) };
      }
    }

    let prUrl: string | undefined;
    if (autoPr && !skipGit && context.branch) {
      prUrl = submitPullRequest(cwd, context.branch, context.baseBranch, taskContent, workflow, pipelineConfig, options);
      if (!prUrl) return { exitCode: EXIT_PR_CREATION_FAILED, result: buildResult({ branch: context.branch }) };
      await runLinkedCacciaSafely(cwd, prUrl, undefined, {
        outputMode: options.outputMode ?? 'terminal',
        taskPrefix: options.taskPrefix,
        taskColorIndex: options.taskColorIndex,
        taskDisplayLabel: options.taskDisplayLabel,
      });
      await runLinkedMergeSafely(cwd, prUrl);
    } else if (autoPr && skipGit) {
      info('--auto-pr is ignored when --skip-git is specified (no push was performed)');
    }

    blankLine();
    const safeWorkflow = sanitizeTerminalText(workflow);
    const issueStatus = taskContent.issue
      ? `#${taskContent.issue.number} "${sanitizeTerminalText(taskContent.issue.title)}"`
      : 'N/A';
    const branchStatus = context.branch ? sanitizeTerminalText(context.branch) : '(current)';
    status('Issue', issueStatus);
    status('Branch', branchStatus);
    status('Workflow', safeWorkflow);
    status('Result', 'Success', 'green');

    return { exitCode: 0, result: buildResult({ success: true, branch: context.branch, prUrl }) };
  } finally {
    try {
      preparedTask.cleanup?.();
    } finally {
      settleLoopAnalysisPublication(loopAnalysisPublication);
    }
  }
}
export async function executePipeline(options: PipelineExecutionOptions): Promise<number> {
  const startTime = Date.now();
  const runId = generateRunId();
  let pipelineResult: PipelineResult = { success: false, workflow: options.workflow, issueNumber: options.issueNumber };

  try {
    const outcome = await runPipeline(options);
    pipelineResult = outcome.result;
    return outcome.exitCode;
  } finally {
    await notifySlack(runId, startTime, pipelineResult);
  }
}

interface PipelineResult {
  success: boolean;
  workflow: string;
  issueNumber?: number;
  branch?: string;
  prUrl?: string;
}

async function notifySlack(runId: string, startTime: number, result: PipelineResult): Promise<void> {
  const webhookUrl = getSlackWebhookUrl();
  if (!webhookUrl) return;

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  const task: SlackTaskDetail = {
    name: 'pipeline',
    success: result.success,
    workflow: result.workflow,
    issueNumber: result.issueNumber,
    durationSec,
    branch: result.branch,
    prUrl: result.prUrl,
  };
  const message = buildSlackRunSummary({
    runId,
    total: 1,
    success: result.success ? 1 : 0,
    failed: result.success ? 0 : 1,
    durationSec,
    concurrency: 1,
    tasks: [task],
  });

  await sendSlackNotification(webhookUrl, message);
}
