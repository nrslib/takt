import { TaskRunner, type TaskListItem } from '../../infra/task/index.js';
import type { WorkflowRestartPoint, WorkflowResumePoint } from '../../core/models/index.js';
import type { InteractiveImageAttachment } from '../interactive/imageAttachments.js';
import {
  cleanupPersistedTaskOrderRevision,
  persistTaskOrderRevision,
  type PersistedTaskOrderRevision,
} from './orderRevision.js';
import { assertReusableWorktreePath } from './execute/reusedWorktree.js';
import { checkTaskProviders, terminalProviderConfirmation } from './execute/providerPreflight.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';

export interface FailedTaskRetryPersistenceOptions {
  readonly task: TaskListItem;
  readonly projectDir: string;
  readonly worktreePath: string;
  readonly startStep: string | undefined;
  readonly retryNote: string | undefined;
  readonly resumePoint: WorkflowResumePoint | undefined;
  readonly workflow: string | undefined;
  readonly taskDir: string | undefined;
  readonly sourceRunSlug: string | null;
  readonly restartPoint: WorkflowRestartPoint | undefined;
  readonly revisedOrder?: {
    readonly content: string;
    readonly lang: 'en' | 'ja';
    readonly attachments?: readonly InteractiveImageAttachment[];
  };
}

export function appendRetryNote(existing: string | undefined, additional: string): string {
  const trimmedAdditional = additional.trim();
  if (trimmedAdditional === '') {
    throw new Error('Additional instruction is empty.');
  }
  if (!existing || existing.trim() === '') {
    return trimmedAdditional;
  }
  return `${existing}\n\n${trimmedAdditional}`;
}

/** Persist an approved failed-task retry and return the task to pending. */
export async function persistFailedTaskRetry(options: FailedTaskRetryPersistenceOptions): Promise<void> {
  if (options.task.kind !== 'failed') {
    throw new Error(`Failed task retry persistence requires failed task. received: ${options.task.kind}`);
  }

  assertReusableWorktreePath(options.projectDir, options.worktreePath);
  await checkTaskProviders(options.projectDir, options.workflow ?? options.task.data?.workflow ?? DEFAULT_WORKFLOW_NAME, {}, terminalProviderConfirmation(), undefined, options.worktreePath);
  let revision: PersistedTaskOrderRevision | undefined;
  try {
    if (options.revisedOrder !== undefined) {
      revision = persistTaskOrderRevision(
        options.projectDir,
        options.task.taskDir,
        options.revisedOrder.content,
        options.revisedOrder.lang,
        options.revisedOrder.attachments,
      );
    }

    assertReusableWorktreePath(options.projectDir, options.worktreePath);
    new TaskRunner(options.projectDir).requeueTask(
      options.task.name,
      ['failed'],
      {
        startStep: options.startStep,
        retryNote: options.retryNote,
        resumePoint: options.resumePoint,
        workflow: options.workflow,
        taskDir: revision?.taskDirRelative ?? options.taskDir,
        sourceRunSlug: options.sourceRunSlug ?? undefined,
        restartPoint: options.restartPoint,
      },
    );
  } catch (error) {
    cleanupPersistedTaskOrderRevision(revision);
    throw error;
  }
}
