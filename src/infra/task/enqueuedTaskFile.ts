import * as path from 'node:path';
import * as fs from 'node:fs';
import { createLogger, generateReportDir } from '../../shared/utils/index.js';
import { TaskRunner } from './runner.js';
import { TaskExecutionConfigSchema, type TaskFileData, resolveTaskWorkflowValue } from './schema.js';
import { summarizeTaskName } from './summarize.js';
import { firstLine } from './naming.js';
import type {
  PreparedEnqueuedTaskSpec,
  PrepareEnqueuedTaskSpec,
  SaveEnqueuedTaskFileOptions,
} from './enqueueService.js';

const log = createLogger('task-enqueue');

function resolveUniqueTaskSpecSlug(cwd: string, taskContent: string): string {
  const baseSlug = generateReportDir(taskContent);
  let sequence = 1;
  let slug = baseSlug;
  let taskDir = path.join(cwd, '.takt', 'tasks', slug);
  while (fs.existsSync(taskDir)) {
    sequence += 1;
    slug = `${baseSlug}-${sequence}`;
    taskDir = path.join(cwd, '.takt', 'tasks', slug);
  }
  return slug;
}

function prepareTaskSpecDirectory(cwd: string, taskContent: string): PreparedEnqueuedTaskSpec {
  const taskDirSlug = resolveUniqueTaskSpecSlug(cwd, taskContent);
  const taskDir = path.join(cwd, '.takt', 'tasks', taskDirSlug);
  const taskDirRelative = `.takt/tasks/${taskDirSlug}`;
  fs.mkdirSync(taskDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(taskDir, 'order.md'), taskContent, 'utf-8');
  } catch (error) {
    cleanupPreparedTaskSpec(taskDir);
    throw error;
  }
  return { taskDir, taskDirRelative };
}

function cleanupPreparedTaskSpec(taskDir: string): void {
  fs.rmSync(taskDir, { recursive: true, force: true });
  const tasksDir = path.dirname(taskDir);
  if (fs.existsSync(tasksDir) && fs.readdirSync(tasksDir).length === 0) {
    fs.rmdirSync(tasksDir);
  }
}

function buildValidatedTaskConfig(options?: SaveEnqueuedTaskFileOptions): Omit<TaskFileData, 'task'> {
  const resolvedWorkflow = options ? resolveTaskWorkflowValue(options) : undefined;
  return TaskExecutionConfigSchema.parse({
    ...(options?.worktree !== undefined && { worktree: options.worktree }),
    ...(options?.branch && { branch: options.branch }),
    ...(options?.baseBranch && { base_branch: options.baseBranch }),
    ...(resolvedWorkflow && { workflow: resolvedWorkflow }),
    ...(options?.issue !== undefined && { issue: options.issue }),
    ...(options?.autoPr !== undefined && { auto_pr: options.autoPr }),
    ...(options?.draftPr !== undefined && { draft_pr: options.draftPr }),
    ...(options?.managedPr !== undefined && { managed_pr: options.managedPr }),
    ...(options?.shouldPublishBranchToOrigin !== undefined && {
      should_publish_branch_to_origin: options.shouldPublishBranchToOrigin,
    }),
    ...(options?.prNumber !== undefined && {
      source: 'pr_review' as const,
      pr_number: options.prNumber,
    }),
    ...(options?.contextPrNumber !== undefined && {
      context_pr_number: options.contextPrNumber,
    }),
  });
}

export async function saveEnqueuedTaskFile(
  cwd: string,
  taskContent: string,
  options?: SaveEnqueuedTaskFileOptions,
  prepareTaskSpec: PrepareEnqueuedTaskSpec = prepareTaskSpecDirectory,
): Promise<{ taskName: string; tasksFile: string }> {
  const runner = new TaskRunner(cwd);
  const config = buildValidatedTaskConfig(options);
  const slug = await summarizeTaskName(taskContent, { cwd });
  const summary = firstLine(taskContent);
  const preparedSpec = prepareTaskSpec(cwd, taskContent);
  let created;
  try {
    created = runner.addTask(taskContent, {
      ...config,
      task_dir: preparedSpec.taskDirRelative,
      slug,
      summary,
    });
  } catch (error) {
    cleanupPreparedTaskSpec(preparedSpec.taskDir);
    throw error;
  }
  const tasksFile = path.join(cwd, '.takt', 'tasks.yaml');
  log.info('Task created', { taskName: created.name, tasksFile, config });
  return { taskName: created.name, tasksFile };
}
