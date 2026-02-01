/**
 * add command implementation
 *
 * Starts an AI conversation to refine task requirements,
 * then creates a task file in .takt/tasks/ with YAML format.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { promptInput, confirm, selectOption } from '../prompt/index.js';
import { success, info } from '../utils/ui.js';
import { summarizeTaskName } from '../task/summarize.js';
import { loadGlobalConfig } from '../config/globalConfig.js';
import { getProvider, type ProviderType } from '../providers/index.js';
import { createLogger } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';
import { listWorkflows } from '../config/workflowLoader.js';
import { getCurrentWorkflow } from '../config/paths.js';
import { interactiveMode } from './interactive.js';
import { isIssueReference, resolveIssueTask, parseIssueNumbers } from '../github/issue.js';
import type { TaskFileData } from '../task/schema.js';

const log = createLogger('add-task');

const SUMMARIZE_SYSTEM_PROMPT = `会話履歴からタスクの要件をまとめてください。
タスク実行エージェントへの指示として使われます。
具体的・簡潔に、必要な情報をすべて含めてください。
マークダウン形式で出力してください。`;

/**
 * Summarize conversation history into a task description using AI.
 */
export async function summarizeConversation(cwd: string, conversationText: string): Promise<string> {
  const globalConfig = loadGlobalConfig();
  const providerType = (globalConfig.provider as ProviderType) ?? 'claude';
  const provider = getProvider(providerType);

  info('Summarizing task from conversation...');

  const response = await provider.call('task-summarizer', conversationText, {
    cwd,
    maxTurns: 1,
    allowedTools: [],
    systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
  });

  return response.content;
}

/**
 * Generate a unique task filename with AI-summarized slug
 */
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
 *   1. AI対話モードでタスクを詰める
 *   2. 会話履歴からAIがタスク要約を生成
 *   3. 要約からファイル名をAIで生成
 *   4. ワークツリー/ブランチ/ワークフロー設定
 *   5. YAMLファイル作成
 */
export async function addTask(cwd: string, task?: string): Promise<void> {
  const tasksDir = path.join(cwd, '.takt', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  let taskContent: string;
  let issueNumber: number | undefined;

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
    // Interactive mode: AI conversation to refine task
    const result = await interactiveMode(cwd);
    if (!result.confirmed) {
      info('Cancelled.');
      return;
    }

    // 会話履歴からタスク要約を生成
    taskContent = await summarizeConversation(cwd, result.task);
  }

  // 3. 要約からファイル名生成
  const firstLine = taskContent.split('\n')[0] || taskContent;
  const filename = await generateFilename(tasksDir, firstLine, cwd);

  // 4. ワークツリー/ブランチ/ワークフロー設定
  let worktree: boolean | string | undefined;
  let branch: string | undefined;
  let workflow: string | undefined;

  const useWorktree = await confirm('Create worktree?', true);
  if (useWorktree) {
    const customPath = await promptInput('Worktree path (Enter for auto)');
    worktree = customPath || true;

    const customBranch = await promptInput('Branch name (Enter for auto)');
    if (customBranch) {
      branch = customBranch;
    }
  }

  const availableWorkflows = listWorkflows(cwd);
  if (availableWorkflows.length > 0) {
    const currentWorkflow = getCurrentWorkflow(cwd);
    const defaultWorkflow = availableWorkflows.includes(currentWorkflow)
      ? currentWorkflow
      : availableWorkflows[0]!;
    const options = availableWorkflows.map((name) => ({
      label: name === currentWorkflow ? `${name} (current)` : name,
      value: name,
    }));
    const selected = await selectOption('Select workflow:', options);
    if (selected === null) {
      info('Cancelled.');
      return;
    }
    if (selected !== defaultWorkflow) {
      workflow = selected;
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
