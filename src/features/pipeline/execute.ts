/**
 * Pipeline orchestration
 *
 * Thin orchestrator that coordinates pipeline steps:
 *   1. Resolve task content
 *   2. Prepare execution environment
 *   3. Run piece
 *   4. Commit & push
 *   5. Create PR
 *
 * Each step is implemented in steps.ts.
 */

import { resolveConfigValues } from '../../infra/config/index.js';
import { info, error, status, blankLine } from '../../shared/ui/index.js';
import { createLogger, getErrorMessage, getSlackWebhookUrl, sendSlackNotification, buildSlackRunSummary } from '../../shared/utils/index.js';
import type { SlackTaskDetail } from '../../shared/utils/index.js';
import { generateRunId } from '../tasks/execute/slackSummaryAdapter.js';
import type { PipelineExecutionOptions } from '../tasks/index.js';
import {
  EXIT_ISSUE_FETCH_FAILED,
  EXIT_PIECE_FAILED,
  EXIT_GIT_OPERATION_FAILED,
  EXIT_PR_CREATION_FAILED,
} from '../../shared/exitCodes.js';
import {
  resolveTaskContent,
  resolveExecutionContext,
  runPiece,
  commitAndPush,
  submitPullRequest,
  buildCommitMessage,
  type ExecutionContext,
} from './steps.js';

export type { PipelineExecutionOptions };

const log = createLogger('pipeline');

// ---- Pipeline orchestration ----

interface PipelineOutcome {
  exitCode: number;
  result: PipelineResult;
}

async function runPipeline(options: PipelineExecutionOptions): Promise<PipelineOutcome> {
  const { cwd, piece, autoPr, skipGit } = options;
  const pipelineConfig = resolveConfigValues(cwd, ['pipeline']).pipeline;

  const buildResult = (overrides: Partial<PipelineResult> = {}): PipelineResult => ({
    success: false, piece, issueNumber: options.issueNumber, ...overrides,
  });

  // Step 1: Resolve task content
  const taskContent = resolveTaskContent(options);
  if (!taskContent) return { exitCode: EXIT_ISSUE_FETCH_FAILED, result: buildResult() };

  // Step 2: Prepare execution environment
  let context: ExecutionContext;
  try {
    context = await resolveExecutionContext(cwd, taskContent.task, options, pipelineConfig);
  } catch (err) {
    error(`Failed to prepare execution environment: ${getErrorMessage(err)}`);
    return { exitCode: EXIT_GIT_OPERATION_FAILED, result: buildResult() };
  }

  // Step 3: Run piece
  log.info('Pipeline piece execution starting', { piece, branch: context.branch, skipGit, issueNumber: options.issueNumber });
  const pieceOk = await runPiece(cwd, piece, taskContent.task, context.execCwd, options);
  if (!pieceOk) return { exitCode: EXIT_PIECE_FAILED, result: buildResult({ branch: context.branch }) };

  // Step 4: Commit & push
  if (!skipGit && context.branch) {
    const commitMessage = buildCommitMessage(pipelineConfig, taskContent.issue, options.task);
    if (!commitAndPush(context.execCwd, cwd, context.branch, commitMessage, context.isWorktree)) {
      return { exitCode: EXIT_GIT_OPERATION_FAILED, result: buildResult({ branch: context.branch }) };
    }
  }

  // Step 5: Create PR
  let prUrl: string | undefined;
  if (autoPr && !skipGit && context.branch) {
    prUrl = submitPullRequest(cwd, context.branch, context.baseBranch, taskContent, piece, pipelineConfig, options);
    if (!prUrl) return { exitCode: EXIT_PR_CREATION_FAILED, result: buildResult({ branch: context.branch }) };
  } else if (autoPr && skipGit) {
    info('--auto-pr is ignored when --skip-git is specified (no push was performed)');
  }

  // Summary
  blankLine();
  status('Issue', taskContent.issue ? `#${taskContent.issue.number} "${taskContent.issue.title}"` : 'N/A');
  status('Branch', context.branch ?? '(current)');
  status('Piece', piece);
  status('Result', 'Success', 'green');

  return { exitCode: 0, result: buildResult({ success: true, branch: context.branch, prUrl }) };
}

// ---- Public API ----

/**
 * Execute the full pipeline.
 *
 * Returns a process exit code (0 on success, 2-5 on specific failures).
 */
export async function executePipeline(options: PipelineExecutionOptions): Promise<number> {
  const startTime = Date.now();
  const runId = generateRunId();
  let pipelineResult: PipelineResult = { success: false, piece: options.piece, issueNumber: options.issueNumber };

  try {
    const outcome = await runPipeline(options);
    pipelineResult = outcome.result;
    return outcome.exitCode;
  } finally {
    await notifySlack(runId, startTime, pipelineResult);
  }
}

// ---- Slack notification ----

interface PipelineResult {
  success: boolean;
  piece: string;
  issueNumber?: number;
  branch?: string;
  prUrl?: string;
}

/** Send Slack notification if webhook is configured. Never throws. */
async function notifySlack(runId: string, startTime: number, result: PipelineResult): Promise<void> {
  const webhookUrl = getSlackWebhookUrl();
  if (!webhookUrl) return;

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  const task: SlackTaskDetail = {
    name: 'pipeline',
    success: result.success,
    piece: result.piece,
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
