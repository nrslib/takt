/**
 * Instruction actions for completed and PR-failed tasks.
 *
 * Uses the existing worktree (clone) for conversation and direct re-execution.
 * The worktree is preserved after initial execution, so no clone creation is needed.
 */

import { execFileSync } from 'node:child_process';
import {
  TaskRunner,
  detectDefaultBranch,
} from '../../../infra/task/index.js';
import { resolveWorkflowConfigValues, getWorkflowDescription } from '../../../infra/config/index.js';
import { info, warn } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { runInstructMode } from './instructMode.js';
import { dispatchConversationAction } from '../../interactive/actionDispatcher.js';
import type { WorkflowContext } from '../../interactive/interactive.js';
import { cleanupInteractiveResultAttachments } from '../../interactive/imageAttachments.js';
import {
  resolveLanguage,
  findRunForTask,
} from '../../interactive/index.js';
import { type BranchActionTarget, resolveTargetBranch } from './taskActionTarget.js';
import {
  DEPRECATED_PROVIDER_CONFIG_WARNING,
  hasDeprecatedProviderConfig,
  resolveSelectedWorkflowOverride,
  selectWorkflowWithOptionalReuse,
  selectRunSessionContext,
} from './requeueHelpers.js';
import { executeAndCompleteTask } from '../execute/taskExecution.js';
import { prepareTaskForExecution } from './prepareTaskForExecution.js';
import {
  cleanupPersistedTaskOrderRevision,
  persistTaskOrderRevision,
  resolveTaskOrderContent,
  type PersistedTaskOrderRevision,
} from '../orderRevision.js';
import { resolveTaskPullRequestWorktreeContext } from '../pullRequestWorktreeContext.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import { assertReusableWorktreePath } from '../execute/reusedWorktree.js';

const log = createLogger('list-tasks');

function collectBranchDiffSection(
  cwd: string,
  baseRef: string,
  headRef: string,
  baseBranchLabel: string,
  requirePrDiff: boolean,
): readonly string[] {
  try {
    const diffStat = execFileSync(
      'git', ['diff', '--stat', `${baseRef}...${headRef}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    return diffStat
      ? [`## 現在の変更内容（${baseBranchLabel}からの差分）`, '```', diffStat, '```']
      : [];
  } catch (err) {
    if (requirePrDiff) {
      throw new Error(`Failed to collect PR diff ${baseRef}...${headRef}: ${getErrorMessage(err)}`);
    }
    log.debug('Failed to collect branch diff stat for instruction context', {
      branch: headRef,
      baseBranch: baseRef,
      error: getErrorMessage(err),
    });
    return [];
  }
}

function collectBranchCommitSection(
  cwd: string,
  baseRef: string,
  headRef: string,
  requirePrDiff: boolean,
): readonly string[] {
  try {
    const commitLog = execFileSync(
      'git', ['log', '--oneline', `${baseRef}..${headRef}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    return commitLog
      ? ['', '## コミット履歴', '```', commitLog, '```']
      : [];
  } catch (err) {
    if (requirePrDiff) {
      throw new Error(`Failed to collect PR commit log ${baseRef}..${headRef}: ${getErrorMessage(err)}`);
    }
    log.debug('Failed to collect branch commit log for instruction context', {
      branch: headRef,
      baseBranch: baseRef,
      error: getErrorMessage(err),
    });
    return [];
  }
}

function getBranchContext(
  cwd: string,
  headRef: string,
  baseRef: string,
  requirePrDiff: boolean,
  baseBranchLabel: string = baseRef,
): string {
  const lines = [
    ...collectBranchDiffSection(cwd, baseRef, headRef, baseBranchLabel, requirePrDiff),
    ...collectBranchCommitSection(cwd, baseRef, headRef, requirePrDiff),
  ];

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

export async function instructBranch(
  projectDir: string,
  target: BranchActionTarget,
  agentOverrides?: TaskExecutionOptions,
): Promise<boolean> {
  if (!('kind' in target)) {
    throw new Error('Instruct requeue requires a task target.');
  }
  if (target.kind === 'failed') {
    throw new Error('Failed tasks do not support Instruct; use Retry instead.');
  }

  if (!target.worktreePath) {
    throw new Error(`Worktree path is not set for task: ${target.name}`);
  }
  assertReusableWorktreePath(projectDir, target.worktreePath);
  const worktreePath = target.worktreePath;
  const previousOrderContent = resolveTaskOrderContent(
    projectDir,
    target.taskDir,
    target.data?.task ?? target.content,
  );

  const branch = resolveTargetBranch(target);

  const globalConfig = resolveWorkflowConfigValues(projectDir, ['interactivePreviewSteps', 'language']);
  const lang = resolveLanguage(globalConfig.language);
  const matchedSlug = target.runSlug ?? findRunForTask(worktreePath, target.content);
  const selectedWorkflow = await selectWorkflowWithOptionalReuse(projectDir, target.data?.workflow, worktreePath, lang);
  if (!selectedWorkflow) {
    info('Cancelled');
    return false;
  }

  const workflowDesc = getWorkflowDescription(
    selectedWorkflow,
    projectDir,
    globalConfig.interactivePreviewSteps,
    worktreePath,
    agentOverrides,
  );
  const workflowContext: WorkflowContext = {
    name: workflowDesc.name,
    description: workflowDesc.description,
    workflowStructure: workflowDesc.workflowStructure,
    stepPreviews: workflowDesc.stepPreviews,
  };

  // Runs data lives in the worktree (written during previous execution)
  const runSessionContext = await selectRunSessionContext(worktreePath, lang);
  if (hasDeprecatedProviderConfig(previousOrderContent)) {
    warn(DEPRECATED_PROVIDER_CONFIG_WARNING);
  }

  const prNumber = target.data?.source === 'pr_review' ? target.data.pr_number : undefined;
  const isPrReviewTask = prNumber !== undefined;
  const prContext = isPrReviewTask
    ? resolveTaskPullRequestWorktreeContext({
      projectDir,
      worktreePath,
      taskName: target.name,
      prNumber,
      headBranch: branch,
      ...(target.data?.base_branch === undefined
        ? {}
        : { savedBaseBranch: target.data.base_branch }),
    })
    : undefined;
  const baseBranch = prContext?.baseBranch ?? detectDefaultBranch(projectDir);
  const branchContext = getBranchContext(
    prContext ? worktreePath : projectDir,
    prContext?.headDiffRef ?? branch,
    prContext?.baseDiffRef ?? baseBranch,
    prContext !== undefined,
    baseBranch,
  );

  const result = await runInstructMode({
    cwd: worktreePath,
    branchContext,
    branchName: branch,
    taskName: target.name,
    taskContent: target.content,
    retryNote: target.data?.retry_note ?? '',
    workflowContext,
    runSessionContext,
    previousOrderContent,
    ...(prContext === undefined ? {} : { prContext }),
  });

  const executeWithInstruction = async (): Promise<boolean> => {
    let revision: PersistedTaskOrderRevision | undefined;
    let taskInfo: ReturnType<TaskRunner['startReExecution']>;
    const runner = new TaskRunner(projectDir);
    try {
      assertReusableWorktreePath(projectDir, worktreePath);
      if (result.source === 'go') {
        revision = persistTaskOrderRevision(
          projectDir,
          target.taskDir,
          result.task,
          lang,
          result.attachments,
        );
      }
      const taskDir = revision?.taskDirRelative ?? target.taskDir;
      const executionRetryNote = result.source === 'go'
        ? undefined
        : target.data?.retry_note;
      assertReusableWorktreePath(projectDir, worktreePath);
      taskInfo = runner.startReExecution(
        target.name,
        ['completed', 'pr_failed'],
        'instruct',
        {
          startStep: undefined,
          retryNote: executionRetryNote,
          resumePoint: undefined,
          workflow: undefined,
          taskDir,
          sourceRunSlug: matchedSlug ?? undefined,
          restartPoint: undefined,
        },
      );
    } catch (error) {
      cleanupPersistedTaskOrderRevision(revision);
      throw error;
    }
    const taskForExecution = prepareTaskForExecution(taskInfo, selectedWorkflow);

    log.info('Starting re-execution of instructed task', {
      name: target.name,
      worktreePath,
      branch,
      workflow: selectedWorkflow,
    });

    return executeAndCompleteTask(taskForExecution, runner, projectDir, agentOverrides);
  };

  try {
    return await dispatchConversationAction(result, {
      cancel: () => {
        info('Cancelled');
        return false;
      },
      execute: async () => executeWithInstruction(),
      save_task: async () => {
        let revision: PersistedTaskOrderRevision | undefined;
        const runner = new TaskRunner(projectDir);
        try {
          assertReusableWorktreePath(projectDir, worktreePath);
          if (result.source === 'go') {
            revision = persistTaskOrderRevision(
              projectDir,
              target.taskDir,
              result.task,
              lang,
              result.attachments,
            );
          }
          const taskDir = revision?.taskDirRelative ?? target.taskDir;
          const executionRetryNote = result.source === 'go'
            ? undefined
            : target.data?.retry_note;
          assertReusableWorktreePath(projectDir, worktreePath);
          runner.requeueTask(
            target.name,
            ['completed', 'pr_failed'],
            {
              startStep: undefined,
              retryNote: executionRetryNote,
              resumePoint: undefined,
              workflow: resolveSelectedWorkflowOverride(target.data?.workflow, selectedWorkflow),
              taskDir,
              sourceRunSlug: matchedSlug ?? undefined,
              restartPoint: undefined,
            },
          );
        } catch (error) {
          cleanupPersistedTaskOrderRevision(revision);
          throw error;
        }
        info(`Task "${target.name}" has been requeued.`);
        return true;
      },
    });
  } finally {
    cleanupInteractiveResultAttachments(result);
  }
}
