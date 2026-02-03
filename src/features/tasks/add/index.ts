/**
 * add command implementation
 *
 * Starts an AI conversation to refine task requirements,
 * then creates a task file in .takt/tasks/ with YAML format.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { promptInput, confirm } from '../../../shared/prompt/index.js';
import { success, info } from '../../../shared/ui/index.js';
import { summarizeTaskName, type TaskFileData } from '../../../infra/task/index.js';
import { loadGlobalConfig, getWorkflowDescription } from '../../../infra/config/index.js';
import { determineWorkflow } from '../execute/selectAndExecute.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { isIssueReference, resolveIssueTask, parseIssueNumbers } from '../../../infra/github/index.js';
import { interactiveMode } from '../../interactive/index.js';

const log = createLogger('add-task');

async function generateFilename(tasksDir: string, taskContent: string, cwd: string): Promise<string> {
  info('Generating task filename...');
  const slug = await summarizeTaskName(taskContent, { cwd });
  const base = slug || 'task';
  let filename = `${base}.yaml`;
  let counter = 1;

  while (fs.existsSync(path.join(tasksDir, filename))) {
    filename = `${base}-${counter}.yaml`;
    counter++;
  }

  return filename;
}

/**
 * add command handler
 *
 * Flow:
 *   1. ワークフロー選択
 *   2. AI対話モードでタスクを詰める
 *   3. 会話履歴からAIがタスク要約を生成
 *   4. 要約からファイル名をAIで生成
 *   5. ワークツリー/ブランチ設定
 *   6. YAMLファイル作成
 */
export async function addTask(cwd: string, task?: string): Promise<void> {
  const tasksDir = path.join(cwd, '.takt', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  // 1. ワークフロー選択（Issue参照以外の場合、対話モードの前に実施）
  let taskContent: string;
  let issueNumber: number | undefined;
  let workflow: string | undefined;

  if (task && isIssueReference(task)) {
    // Issue reference: fetch issue and use directly as task content
    info('Fetching GitHub Issue...');
    try {
      taskContent = resolveIssueTask(task);
      const numbers = parseIssueNumbers([task]);
      if (numbers.length > 0) {
        issueNumber = numbers[0];
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      log.error('Failed to fetch GitHub Issue', { task, error: msg });
      info(`Failed to fetch issue ${task}: ${msg}`);
      return;
    }
  } else {
    // ワークフロー選択を先に行い、結果を対話モードに渡す
    const workflowId = await determineWorkflow(cwd);
    if (workflowId === null) {
      info('Cancelled.');
      return;
    }
    workflow = workflowId;

    const workflowContext = getWorkflowDescription(workflowId, cwd);

    // Interactive mode: AI conversation to refine task
    const result = await interactiveMode(cwd, undefined, workflowContext);
    if (!result.confirmed) {
      info('Cancelled.');
      return;
    }

    // interactiveMode already returns a summarized task from conversation
    taskContent = result.task;
  }

  // 3. 要約からファイル名生成
  const firstLine = taskContent.split('\n')[0] || taskContent;
  const filename = await generateFilename(tasksDir, firstLine, cwd);

  // 4. ワークツリー/ブランチ設定
  let worktree: boolean | string | undefined;
  let branch: string | undefined;

  const useWorktree = await confirm('Create worktree?', true);
  if (useWorktree) {
    const customPath = await promptInput('Worktree path (Enter for auto)');
    worktree = customPath || true;

    const customBranch = await promptInput('Branch name (Enter for auto)');
    if (customBranch) {
      branch = customBranch;
    }
  }

  // 5. YAMLファイル作成
  const taskData: TaskFileData = { task: taskContent };
  if (worktree !== undefined) {
    taskData.worktree = worktree;
  }
  if (branch) {
    taskData.branch = branch;
  }
  if (workflow) {
    taskData.workflow = workflow;
  }
  if (issueNumber !== undefined) {
    taskData.issue = issueNumber;
  }

  const filePath = path.join(tasksDir, filename);
  const yamlContent = stringifyYaml(taskData);
  fs.writeFileSync(filePath, yamlContent, 'utf-8');

  log.info('Task created', { filePath, taskData });

  success(`Task created: ${filename}`);
  info(`  Path: ${filePath}`);
  if (worktree) {
    info(`  Worktree: ${typeof worktree === 'string' ? worktree : 'auto'}`);
  }
  if (branch) {
    info(`  Branch: ${branch}`);
  }
  if (workflow) {
    info(`  Workflow: ${workflow}`);
  }
}
