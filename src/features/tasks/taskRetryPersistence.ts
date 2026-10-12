import { TaskRunner, type TaskListItem } from '../../infra/task/index.js';
import type { WorkflowRestartPoint, WorkflowResumePoint } from '../../core/models/index.js';
import type { InteractiveImageAttachment } from '../interactive/imageAttachments.js';
import {
  cleanupPersistedTaskOrderRevision,
  persistTaskOrderRevision,
  type PersistedTaskOrderRevision,
} from './orderRevision.js';
import { assertPrMergeRetryWorktreePath, assertReusableWorktreePath } from './execute/reusedWorktree.js';
import { checkQueuedTaskProviders, terminalProviderConfirmation } from './execute/providerPreflight.js';

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
  readonly goalOperationId?: string;
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

  const assertWorktree = (): void => {
    if (options.task.data?.merge_task === true) {
      assertPrMergeRetryWorktreePath(options.projectDir, options.worktreePath,
        options.task.data.merge_clone_prepared === true);
    } else {
      assertReusableWorktreePath(options.projectDir, options.worktreePath);
    }
  };
  assertWorktree();
  await checkQueuedTaskProviders(options.projectDir, options.task, {}, terminalProviderConfirmation(), undefined, {
    workflow: options.workflow,
    worktreePath: options.worktreePath,
  });
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

    assertWorktree();
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
        ...(options.goalOperationId === undefined ? {} : { goalOperationId: options.goalOperationId }),
      },
    );
  } catch (error) {
    cleanupPersistedTaskOrderRevision(revision);
    throw error;
  }
}
