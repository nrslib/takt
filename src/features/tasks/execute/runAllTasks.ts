import { TaskRunner } from '../../../infra/task/index.js';
import { resolveWorkflowConfigValues } from '../../../infra/config/index.js';
import { header, info, status, blankLine, warn } from '../../../shared/ui/index.js';
import { statusLine } from '../../../shared/ui/StatusLine.js';
import {
  getErrorMessage,
  getSlackWebhookUrl,
  notifyError,
  notifySuccess,
  sendSlackNotification,
  buildSlackRunSummary,
  generateRunId,
} from '../../../shared/utils/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import type { RunAllTasksOptions, TaskExecutionOptions } from './types.js';
import { attemptAutoRequeueTask, runWithWorkerPool } from './parallelExecution.js';
import { toSlackTaskDetail } from './slackSummaryAdapter.js';

function requeueExistingFailedTasks(taskRunner: TaskRunner, maxAttempts: number | undefined): number {
  if (maxAttempts === undefined || maxAttempts <= 0) {
    return 0;
  }

  let requeuedCount = 0;
  for (const task of taskRunner.listFailedTasks()) {
    if (attemptAutoRequeueTask(taskRunner, task.name, maxAttempts)) {
      requeuedCount++;
    }
  }
  return requeuedCount;
}

export async function runAllTasks(
  cwd: string,
  options?: RunAllTasksOptions,
): Promise<void> {
  const agentOverrides: TaskExecutionOptions | undefined = options
    ? {
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.providerSource !== undefined ? { providerSource: options.providerSource } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.modelSource !== undefined ? { modelSource: options.modelSource } : {}),
        ...(options.autoStrategy !== undefined ? { autoStrategy: options.autoStrategy } : {}),
      }
    : undefined;
  const taskRunner = new TaskRunner(cwd, { onWarning: warn });
  const globalConfig = resolveWorkflowConfigValues(
    cwd,
    [
      'notificationSound',
      'notificationSoundEvents',
      'concurrency',
      'taskPollIntervalMs',
      'ignoreExceed',
      'autoRequeueMaxAttempts',
    ],
  );
  const runOptions = {
    ...(options?.ignoreExceed === true || globalConfig.ignoreExceed === true
      ? { ignoreIterationLimit: true }
      : {}),
    autoRequeueMaxAttempts: globalConfig.autoRequeueMaxAttempts,
  };
  const shouldNotifyRunComplete = globalConfig.notificationSound !== false
    && globalConfig.notificationSoundEvents?.runComplete !== false;
  const shouldNotifyRunAbort = globalConfig.notificationSound !== false
    && globalConfig.notificationSoundEvents?.runAbort !== false;
  const concurrency = globalConfig.concurrency;
  const slackWebhookUrl = getSlackWebhookUrl();
  const failedInterrupted = taskRunner.failInterruptedRunningTasks();
  if (failedInterrupted > 0) {
    info(`Marked ${failedInterrupted} interrupted running task(s) as failed.`);
  }
  const requeuedExistingFailed = requeueExistingFailedTasks(taskRunner, runOptions.autoRequeueMaxAttempts);
  if (requeuedExistingFailed > 0) {
    info(`Auto-requeued ${requeuedExistingFailed} existing failed task(s).`);
  }

  const initialTasks = taskRunner.claimNextTasks(concurrency);
  if (initialTasks.length === 0) {
    info('No pending tasks in .takt/tasks.yaml');
    info('Use takt add to append tasks.');
    return;
  }

  const runId = generateRunId();
  const startTime = Date.now();

  header('Running tasks');
  if (concurrency > 1) {
    info(`Concurrency: ${concurrency}`);
  }
  statusLine.start('Running tasks...');

  const sendSlackSummary = async (executedTaskNames: string[]): Promise<void> => {
    if (!slackWebhookUrl) return;
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const executedSet = new Set(executedTaskNames);
    const tasks = taskRunner.listAllTaskItems()
      .filter((item) => executedSet.has(item.name))
      .map(toSlackTaskDetail);
    const successCount = tasks.filter((task) => task.success).length;
    const message = buildSlackRunSummary({
      runId,
      total: tasks.length,
      success: successCount,
      failed: tasks.length - successCount,
      durationSec,
      concurrency,
      tasks,
    });
    await sendSlackNotification(slackWebhookUrl, message);
  };

  try {
    const result = await runWithWorkerPool(
      taskRunner,
      initialTasks,
      concurrency,
      cwd,
      agentOverrides,
      runOptions,
      globalConfig.taskPollIntervalMs,
    );

    const totalCount = result.success + result.fail;
    blankLine();
    header('Tasks Summary');
    status('Total', String(totalCount));
    status('Success', String(result.success), result.success === totalCount ? 'green' : undefined);
    if (result.fail > 0) {
      status('Failed', String(result.fail), 'red');
      if (shouldNotifyRunAbort) {
        notifyError('TAKT', getLabel('run.notifyAbort', undefined, { failed: String(result.fail) }));
      }
      await sendSlackSummary(result.executedTaskNames);
      return;
    }

    if (shouldNotifyRunComplete) {
      notifySuccess('TAKT', getLabel('run.notifyComplete', undefined, { total: String(totalCount) }));
    }
    await sendSlackSummary(result.executedTaskNames);
  } catch (error) {
    if (shouldNotifyRunAbort) {
      notifyError('TAKT', getLabel('run.notifyAbort', undefined, { failed: getErrorMessage(error) }));
    }
    await sendSlackSummary([]);
    throw error;
  } finally {
    statusLine.stop();
  }
}
