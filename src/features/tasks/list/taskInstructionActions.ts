/**
 * Instruction actions for completed/failed tasks.
 *
 * Uses the existing worktree (clone) for conversation and direct re-execution.
 * The worktree is preserved after initial execution, so no clone creation is needed.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  TaskRunner,
  detectDefaultBranch,
} from '../../../infra/task/index.js';
import { resolveWorkflowConfigValues, getWorkflowDescription } from '../../../infra/config/index.js';
import { info, warn, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { runInstructMode } from './instructMode.js';
import { dispatchConversationAction } from '../../interactive/actionDispatcher.js';
import type { WorkflowContext } from '../../interactive/interactive.js';
import { cleanupInteractiveResultAttachments } from '../../interactive/imageAttachments.js';
import { resolveLanguage, findRunForTask, findPreviousOrderContent } from '../../interactive/index.js';
import { type BranchActionTarget, resolveTargetBranch } from './taskActionTarget.js';
import {
  appendRetryNote,
  DEPRECATED_PROVIDER_CONFIG_WARNING,
  hasDeprecatedProviderConfig,
  resolveSelectedWorkflowOverride,
  selectWorkflowWithOptionalReuse,
  selectRunSessionContext,
} from './requeueHelpers.js';
import { executeAndCompleteTask } from '../execute/taskExecution.js';
import { prepareTaskForExecution } from './prepareTaskForExecution.js';
import {
  cleanupPreparedRetryTaskSpec,
  prepareRetryTaskSpecWithAttachments,
} from '../retryTaskSpecAttachments.js';

const log = createLogger('list-tasks');

function collectBranchDiffSection(projectDir: string, defaultBranch: string, branch: string): readonly string[] {
  try {
    const diffStat = execFileSync(
      'git', ['diff', '--stat', `${defaultBranch}...${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    return diffStat
      ? ['## 現在の変更内容（mainからの差分）', '```', diffStat, '```']
      : [];
  } catch (err) {
    log.debug('Failed to collect branch diff stat for instruction context', {
      branch,
      defaultBranch,
      error: getErrorMessage(err),
    });
    return [];
  }
}

function collectBranchCommitSection(projectDir: string, defaultBranch: string, branch: string): readonly string[] {
  try {
    const commitLog = execFileSync(
      'git', ['log', '--oneline', `${defaultBranch}..${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    return commitLog
      ? ['', '## コミット履歴', '```', commitLog, '```']
      : [];
  } catch (err) {
    log.debug('Failed to collect branch commit log for instruction context', {
      branch,
      defaultBranch,
      error: getErrorMessage(err),
    });
    return [];
  }
}

function getBranchContext(projectDir: string, branch: string): string {
  const defaultBranch = detectDefaultBranch(projectDir);
  const lines = [
    ...collectBranchDiffSection(projectDir, defaultBranch, branch),
    ...collectBranchCommitSection(projectDir, defaultBranch, branch),
  ];

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

export async function instructBranch(
  projectDir: string,
  target: BranchActionTarget,
): Promise<boolean> {
  if (!('kind' in target)) {
    throw new Error('Instruct requeue requires a task target.');
  }

  if (!target.worktreePath || !fs.existsSync(target.worktreePath)) {
    logError(`Worktree directory does not exist for task: ${target.name}`);
    return false;
  }
  const worktreePath = target.worktreePath;

  const branch = resolveTargetBranch(target);

  const globalConfig = resolveWorkflowConfigValues(projectDir, ['interactivePreviewSteps', 'language']);
  const lang = resolveLanguage(globalConfig.language);
  const matchedSlug = findRunForTask(worktreePath, target.content);
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
  );
  const workflowContext: WorkflowContext = {
    name: workflowDesc.name,
    description: workflowDesc.description,
    workflowStructure: workflowDesc.workflowStructure,
    stepPreviews: workflowDesc.stepPreviews,
  };

  // Runs data lives in the worktree (written during previous execution)
  const runSessionContext = await selectRunSessionContext(worktreePath, lang);
  const previousOrderContent = findPreviousOrderContent(worktreePath, matchedSlug);
  if (hasDeprecatedProviderConfig(previousOrderContent)) {
    warn(DEPRECATED_PROVIDER_CONFIG_WARNING);
  }

  const branchContext = getBranchContext(projectDir, branch);

  const result = await runInstructMode(
    worktreePath, branchContext, branch,
    target.name, target.content, target.data?.retry_note ?? '',
    workflowContext, runSessionContext, previousOrderContent,
  );

  const executeWithInstruction = async (instruction: string): Promise<boolean> => {
    const retryNote = appendRetryNote(target.data?.retry_note, instruction);
    const preparedSpec = prepareRetryTaskSpecWithAttachments(projectDir, target.content, retryNote, result.attachments, target.taskDir);
    const executionRetryNote = preparedSpec ? preparedSpec.retryNote : retryNote;
    const taskDir = preparedSpec?.taskDirRelative;
    const runner = new TaskRunner(projectDir);
    let taskInfo: ReturnType<TaskRunner['startReExecution']>;
    try {
      taskInfo = runner.startReExecution(
        target.name,
        ['completed', 'failed'],
        undefined,
        executionRetryNote,
        undefined,
        undefined,
        taskDir,
      );
    } catch (error) {
      cleanupPreparedRetryTaskSpec(preparedSpec);
      throw error;
    }
    const taskForExecution = prepareTaskForExecution(taskInfo, selectedWorkflow);

    log.info('Starting re-execution of instructed task', {
      name: target.name,
      worktreePath,
      branch,
      workflow: selectedWorkflow,
    });

    return executeAndCompleteTask(taskForExecution, runner, projectDir);
  };

  try {
    return await dispatchConversationAction(result, {
      cancel: () => {
        info('Cancelled');
        return false;
      },
      execute: async ({ task }) => executeWithInstruction(task),
      save_task: async ({ task }) => {
        const retryNote = appendRetryNote(target.data?.retry_note, task);
        const preparedSpec = prepareRetryTaskSpecWithAttachments(projectDir, target.content, retryNote, result.attachments, target.taskDir);
        const executionRetryNote = preparedSpec ? preparedSpec.retryNote : retryNote;
        const taskDir = preparedSpec?.taskDirRelative;
        const runner = new TaskRunner(projectDir);
        try {
          runner.requeueTask(
            target.name,
            ['completed', 'failed'],
            undefined,
            executionRetryNote,
            undefined,
            resolveSelectedWorkflowOverride(target.data?.workflow, selectedWorkflow),
            taskDir,
          );
        } catch (error) {
          cleanupPreparedRetryTaskSpec(preparedSpec);
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
