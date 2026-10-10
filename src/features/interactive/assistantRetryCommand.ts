import {
  TaskRunner,
  buildAutoRequeueNote,
  resolveTaskWorkflowValue,
  type TaskListItem,
} from '../../infra/task/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { confirmWithCancel } from '../../shared/prompt/index.js';
import { resolveTtyPolicy } from '../../shared/prompt/tty.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import {
  getErrorMessage,
  hasInteractiveTerminal,
  sanitizeTerminalText,
  truncateText,
} from '../../shared/utils/index.js';
import { buildOrderRevisionPrompt } from './orderRevisionMode.js';
import { formatInlineUtteranceSection } from './promptSections.js';
import { createSelectActionWithoutExecute } from './interactive-summary.js';
import type { ActionWithoutExecuteUIText } from './interactive-summary-types.js';
import type { ConversationMessage, WorkflowContext } from './interactive-summary-types.js';
import type { SummaryPromptOptions } from './conversationLoop.js';
import { callAIWithRetry, type SessionContext } from './aiCaller.js';
import { withHandoffProgress } from './handoffProgress.js';
import { loadWorkflowByIdentifier } from '../../infra/config/index.js';
import { assertReusableWorktreePath } from '../tasks/execute/reusedWorktree.js';
import { formatTaskRetryPath } from '../tasks/taskRetryStartPath.js';
import {
  buildTaskRetryStartOptions,
  resolveTaskRetryStartOption,
  resolveTaskRetryStartOwnership,
  type TaskRetryStartOwnership,
} from '../tasks/list/taskRetryStartSelection.js';
import {
  buildFailedTaskRetryStartContext,
  prepareFailedTaskRetry,
  resolveFailedTaskRetryStart,
} from '../tasks/taskRetryPreparation.js';
import {
  appendRetryNote,
  persistFailedTaskRetry,
} from '../tasks/taskRetryPersistence.js';

export interface AssistantRetryCommandOptions {
  readonly showProgress?: boolean;
  readonly cwd: string;
  readonly lang: 'en' | 'ja';
  readonly command: 'retry' | 'requeue';
  readonly inlineText: string;
  readonly history: readonly ConversationMessage[];
  readonly sessionContext: SessionContext;
  readonly workflowContext?: WorkflowContext;
  readonly sourceContext?: string;
  readonly promptContext?: string;
  readonly formalSpec: boolean;
  readonly formalSpecComments?: boolean;
  readonly conversationLabel?: string;
  readonly noTranscriptNote?: string;
}

type ChoiceField = 'taskName' | 'startOptionId';

type ParsedChoice =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed'; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseChoice(content: string, field: ChoiceField): ParsedChoice {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: 'invalid' };
  }

  if (!isRecord(parsed)) {
    return { kind: 'invalid' };
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== field) {
    return { kind: 'invalid' };
  }

  const value = parsed[field];
  if (value === null) {
    return { kind: 'unresolved' };
  }
  if (typeof value !== 'string' || value.length === 0) {
    return { kind: 'invalid' };
  }
  return { kind: 'value', value };
}

function generationPrompt(
  options: AssistantRetryCommandOptions,
  stage: 'task' | 'start',
  payload: Record<string, unknown>,
): string {
  const conversation = options.history.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  return JSON.stringify({
    stage,
    command: options.command,
    conversation,
    ...(conversation.length === 0 && options.sessionContext.sessionId !== undefined
      ? { noTranscriptNote: options.noTranscriptNote ?? getLabel('interactive.noTranscript', options.lang) }
      : {}),
    ...payload,
  });
}

async function generateChoice(
  options: AssistantRetryCommandOptions,
  stage: 'task' | 'start',
  field: ChoiceField,
  payload: Record<string, unknown>,
): Promise<ParsedChoice> {
  const systemPrompt = loadTemplate('score_assistant_retry_system_prompt', options.lang, {
    taskSelection: stage === 'task',
    startSelection: stage === 'start',
    choiceField: field,
    inlineUtterance: formatInlineUtteranceSection(options.lang, options.command, options.inlineText),
  });
  const context: SessionContext = {
    ...options.sessionContext,
    sessionId: options.sessionContext.sessionId,
    mcpServers: undefined,
    taskStateMcpServers: undefined,
    disableSessionRetry: true,
  };
  try {
    const { result, error } = await withHandoffProgress(
      options.showProgress === true,
      stage === 'task' ? 'selectTask' : 'selectStart',
      options.lang,
      () => callAIWithRetry(
        generationPrompt(options, stage, payload),
        systemPrompt,
        [],
        options.cwd,
        context,
        {
          outputMode: 'silent',
          persistSession: false,
          permissionMode: 'readonly',
          internalAgentIsolation: 'strict-readonly',
        },
      ),
    );
    if (result === null) {
      return { kind: 'failed', message: error ?? 'The assistant returned no result.' };
    }
    if (!result.success) {
      return { kind: 'failed', message: result.content.trim() || 'The assistant could not make a selection.' };
    }
    return parseChoice(result.content, field);
  } catch (error) {
    return { kind: 'failed', message: getErrorMessage(error) };
  }
}

function candidateData(task: TaskListItem): Record<string, unknown> {
  return {
    name: task.name,
    status: task.kind,
    summary: task.summary ?? null,
    workflow: task.data
      ? resolveTaskWorkflowValue(task.data as Record<string, unknown>) ?? null
      : null,
    ...(task.failure === undefined
      ? {}
      : {
        failure: {
          step: task.failure.step ?? null,
          error: task.failure.error,
          lastMessage: task.failure.last_message ?? null,
        },
      }),
    ...(task.kind === 'exceeded'
      ? {
        stoppingPosition: task.data?.start_step ?? null,
        iteration: task.exceededCurrentIteration ?? null,
      }
      : {}),
  };
}

function taskCandidates(
  tasks: readonly TaskListItem[],
  command: AssistantRetryCommandOptions['command'],
): TaskListItem[] {
  return tasks.filter((task) =>
    task.kind === 'failed' || (command === 'requeue' && task.kind === 'exceeded'));
}

function displayValue(value: string | undefined): string {
  return value?.trim() ? sanitizeTerminalText(value) : '—';
}

function displayTaskName(task: TaskListItem): string {
  return sanitizeTerminalText(task.name);
}

function displayTaskSummary(task: TaskListItem): string {
  const summary = task.summary?.trim() || task.content.trim();
  return sanitizeTerminalText(truncateText(summary, 160));
}

function workflowFor(task: TaskListItem): string | undefined {
  return task.data
    ? resolveTaskWorkflowValue(task.data as Record<string, unknown>)
    : undefined;
}

function withResumeFailureReason(
  message: string,
  reason: string | undefined,
  options: AssistantRetryCommandOptions,
): string {
  if (reason === undefined) {
    return message;
  }
  const explanation = getLabel('tui.assistantRetry.resumeUnavailable', options.lang, {
    reason: sanitizeTerminalText(reason),
  });
  return `${explanation}\n\n${message}`;
}

function formatNotice(
  key: string,
  options: AssistantRetryCommandOptions,
  error?: unknown,
  resumeFailureReason?: string,
): string {
  const message = getLabel(key, options.lang, error === undefined
    ? undefined
    : { error: sanitizeTerminalText(getErrorMessage(error)) });
  return withResumeFailureReason(message, resumeFailureReason, options);
}

function buildSummaryPromptOptions(
  options: AssistantRetryCommandOptions,
): SummaryPromptOptions {
  return {
    history: [...options.history],
    hasSession: options.sessionContext.sessionId !== undefined,
    lang: options.lang,
    noTranscriptNote: options.noTranscriptNote ?? getLabel('interactive.noTranscript', options.lang),
    conversationLabel: options.conversationLabel ?? getLabel('interactive.conversationLabel', options.lang),
    ...(options.workflowContext === undefined ? {} : { workflowContext: options.workflowContext }),
    ...(options.sourceContext === undefined ? {} : { sourceContext: options.sourceContext }),
    ...(options.promptContext === undefined ? {} : { promptContext: options.promptContext }),
    formalSpec: options.formalSpec,
    ...(options.formalSpecComments === undefined
      ? {}
      : { formalSpecComments: options.formalSpecComments }),
    userNote: options.inlineText.trim(),
  };
}

function choiceNotice(choice: Exclude<ParsedChoice, { kind: 'value' }>, options: AssistantRetryCommandOptions): string {
  switch (choice.kind) {
    case 'unresolved':
      return formatNotice('tui.errors.assistantRetryUnresolved', options);
    case 'invalid':
      return formatNotice('tui.errors.assistantRetryInvalidResult', options);
    case 'failed':
      return formatNotice('tui.errors.assistantRetryGenerationFailed', options, choice.message);
  }
}

function resolveSelectedTask(
  candidates: readonly TaskListItem[],
  selectedName: string,
): TaskListItem | undefined {
  const matches = candidates.filter((task) => task.name === selectedName);
  return matches.length === 1 ? matches[0] : undefined;
}

async function selectTask(
  options: AssistantRetryCommandOptions,
  candidates: readonly TaskListItem[],
): Promise<TaskListItem | string> {
  if (candidates.length === 1) {
    return candidates[0]!;
  }

  const choice = await generateChoice(options, 'task', 'taskName', {
    candidates: candidates.map(candidateData),
  });
  if (choice.kind !== 'value') {
    return choiceNotice(choice, options);
  }

  const task = resolveSelectedTask(candidates, choice.value);
  return task ?? formatNotice('tui.errors.assistantRetryInvalidResult', options);
}

async function resolveFailedStart(
  options: AssistantRetryCommandOptions,
  task: TaskListItem,
  projectDir: string,
): Promise<
  | { readonly kind: 'resolved'; readonly preparation: ReturnType<typeof prepareFailedTaskRetry>; readonly start: ReturnType<typeof resolveFailedTaskRetryStart>; readonly workflowOverride: string | undefined; readonly resumeFailureReason: string | undefined }
  | { readonly kind: 'notice'; readonly message: string }
> {
  let resumeFailureReason: string | undefined;
  try {
    const preparation = prepareFailedTaskRetry(task, projectDir);
    if (!preparation.previousWorkflow?.trim()) {
      return {
        kind: 'notice',
        message: formatNotice('tui.errors.assistantRetryGenerationFailed', options, 'The task has no previous workflow.'),
      };
    }
    const startContext = buildFailedTaskRetryStartContext(
      preparation,
      projectDir,
      preparation.previousWorkflow,
    );
    resumeFailureReason = startContext.startOptions.resumeFailureReason;
    const selectableOptions = startContext.startOptions.options.filter((option) => option.selectable);
    if (selectableOptions.length === 0) {
      return { kind: 'notice', message: formatNotice('tui.errors.assistantRetryUnresolved', options, undefined, resumeFailureReason) };
    }

    const choice = await generateChoice(options, 'start', 'startOptionId', {
      task: candidateData(task),
      ...(resumeFailureReason === undefined ? {} : { resumeFailureReason }),
      startOptions: selectableOptions.map(({ id, label, description }) => ({
        id,
        label,
        ...(description === undefined ? {} : { description }),
      })),
    });
    if (choice.kind !== 'value') {
      return { kind: 'notice', message: withResumeFailureReason(choiceNotice(choice, options), resumeFailureReason, options) };
    }
    if (!selectableOptions.some((option) => option.id === choice.value)) {
      return { kind: 'notice', message: formatNotice('tui.errors.assistantRetryInvalidResult', options, undefined, resumeFailureReason) };
    }

    const start = resolveFailedTaskRetryStart(startContext, choice.value);
    return {
      kind: 'resolved',
      preparation,
      start,
      workflowOverride: startContext.workflowOverride,
      resumeFailureReason,
    };
  } catch (error) {
    return {
      kind: 'notice',
      message: formatNotice('tui.errors.assistantRetryGenerationFailed', options, error, resumeFailureReason),
    };
  }
}

function buildTaskDetails(
  task: TaskListItem,
  workflow: string | undefined,
  start: string,
  options: AssistantRetryCommandOptions,
  resumeFailureReason: string | undefined,
): string {
  const details = getLabel('tui.assistantRetry.retryDetails', options.lang, {
    task: displayTaskName(task),
    summary: displayTaskSummary(task),
    workflow: displayValue(workflow),
    start: sanitizeTerminalText(start),
  });
  return withResumeFailureReason(details, resumeFailureReason, options);
}

async function confirmRequeue(
  task: TaskListItem,
  workflow: string | undefined,
  start: string,
  options: AssistantRetryCommandOptions,
  resumeFailureReason: string | undefined,
): Promise<boolean> {
  const message = getLabel('tui.assistantRetry.requeueConfirm', options.lang, {
    task: displayTaskName(task),
    summary: displayTaskSummary(task),
    workflow: displayValue(workflow),
    start: sanitizeTerminalText(start),
  });
  const confirmed = await confirmWithCancel(withResumeFailureReason(message, resumeFailureReason, options), false);
  return confirmed.kind === 'value' && confirmed.value;
}

async function requeueFailedTask(
  task: TaskListItem,
  options: AssistantRetryCommandOptions,
  projectDir: string,
): Promise<string> {
  const resolved = await resolveFailedStart(options, task, projectDir);
  if (resolved.kind === 'notice') {
    return resolved.message;
  }
  const start = resolved.start.label;
  if (!await confirmRequeue(task, resolved.preparation.previousWorkflow, start, options, resolved.resumeFailureReason)) {
    return formatNotice('tui.errors.assistantRetryCancelled', options, undefined, resolved.resumeFailureReason);
  }

  const retryNote = appendRetryNote(
    task.data?.retry_note,
    buildAutoRequeueNote({
      ...resolved.preparation.failure,
      step: resolved.preparation.failedStep,
    }),
  );
  persistFailedTaskRetry({
    task,
    projectDir,
    worktreePath: resolved.preparation.worktreePath,
    startStep: resolved.start.startStep,
    retryNote,
    resumePoint: resolved.start.resumePoint,
    workflow: resolved.workflowOverride,
    taskDir: undefined,
    sourceRunSlug: resolved.preparation.matchedRunSlug,
    restartPoint: resolved.start.restartPoint,
  });
  return getLabel('tui.errors.assistantRetryRequeued', options.lang, {
    task: displayTaskName(task),
  });
}

async function requeueExceededTask(
  task: TaskListItem,
  options: AssistantRetryCommandOptions,
): Promise<string> {
  if (options.inlineText.trim()) {
    const resolved = await resolveExceededStart(task, options);
    if (resolved.kind === 'notice') {
      return resolved.message;
    }
    if (!await confirmRequeue(task, workflowFor(task), resolved.label, options, resolved.resumeFailureReason)) {
      return formatNotice('tui.errors.assistantRetryCancelled', options, undefined, resolved.resumeFailureReason);
    }
    const runner = new TaskRunner(options.cwd);
    if (resolved.operation.kind === 'saved') {
      runner.requeueExceededTask(task.name);
    } else {
      runner.requeueTask(task.name, ['exceeded'], {
        ...resolved.operation.ownership,
        retryNote: task.data?.retry_note,
      });
    }
    return getLabel('tui.errors.assistantRetryRequeued', options.lang, {
      task: displayTaskName(task),
    });
  }
  const startStep = task.data?.start_step?.trim();
  if (!startStep) {
    return formatNotice('tui.errors.assistantRetryGenerationFailed', options, 'The exceeded task has no saved stopping position.');
  }
  const start = getLabel('tui.assistantRetry.exceededStart', options.lang, {
    start: sanitizeTerminalText(startStep),
    iteration: String(task.exceededCurrentIteration ?? '—'),
  });
  if (!await confirmRequeue(task, workflowFor(task), start, options, undefined)) {
    return formatNotice('tui.errors.assistantRetryCancelled', options);
  }
  new TaskRunner(options.cwd).requeueExceededTask(task.name);
  return getLabel('tui.errors.assistantRetryRequeued', options.lang, {
    task: displayTaskName(task),
  });
}

type ExceededStartOperation =
  | { readonly kind: 'saved' }
  | { readonly kind: 'retry'; readonly ownership: TaskRetryStartOwnership };

async function resolveExceededStart(
  task: TaskListItem,
  options: AssistantRetryCommandOptions,
): Promise<
  | { readonly kind: 'resolved'; readonly label: string; readonly operation: ExceededStartOperation; readonly resumeFailureReason: string | undefined }
  | { readonly kind: 'notice'; readonly message: string }
> {
  let resumeFailureReason: string | undefined;
  try {
    const workflow = workflowFor(task);
    if (!workflow?.trim()) {
      throw new Error('The exceeded task has no saved workflow.');
    }
    const lookupCwd = task.worktreePath ?? options.cwd;
    if (task.worktreePath !== undefined) {
      assertReusableWorktreePath(options.cwd, task.worktreePath);
    }
    const workflowConfig = loadWorkflowByIdentifier(workflow, options.cwd, { lookupCwd });
    if (!workflowConfig) {
      throw new Error(`Workflow "${workflow}" not found.`);
    }
    const startOptions = {
      projectCwd: options.cwd,
      lookupCwd,
      resumePoint: task.data?.resume_point,
      preferredRootStep: task.data?.start_step,
    };
    const catalog = buildTaskRetryStartOptions(workflowConfig, startOptions);
    resumeFailureReason = catalog.resumeFailureReason;
    const choices = catalog.options.filter((option) => option.selectable).map<{
      id: string;
      label: string;
      description: string | undefined;
      operation: ExceededStartOperation;
    }>((option) => {
      const selected = resolveTaskRetryStartOption(workflowConfig, startOptions, option.id);
      const continuing = selected.selection.kind === 'resume';
      const operationLabel = options.lang === 'ja'
        ? continuing ? '継続' : '再実行'
        : continuing ? 'Continue' : 'Restart';
      const position = selected.selection.kind === 'restart' && selected.selection.restartPoint.stack.length > 1
        ? formatTaskRetryPath(selected.selection.restartPoint.stack.flatMap((entry) => [entry.workflow, entry.step]))
        : selected.label;
      const operation: ExceededStartOperation = {
        kind: 'retry', ownership: resolveTaskRetryStartOwnership(selected.selection, workflowConfig),
      };
      return {
        id: option.id,
        label: `${operationLabel}: ${position}`,
        description: option.description,
        operation,
      };
    });
    const savedPositionId = 'continue-saved-position';
    const savedStep = task.data?.start_step;
    const savedLabel = getLabel('tui.assistantRetry.exceededStart', options.lang, {
      start: sanitizeTerminalText(savedStep ?? '—'),
      iteration: String(task.exceededCurrentIteration ?? '—'),
    });
    if (task.data?.resume_point === undefined && workflowConfig.steps.some((step) => step.name === savedStep)) {
      choices.unshift({ id: savedPositionId, label: `${options.lang === 'ja' ? '継続' : 'Continue'}: ${savedLabel}`, description: undefined, operation: { kind: 'saved' } });
    }
    const choice = await generateChoice(options, 'start', 'startOptionId', {
      task: candidateData(task),
      ...(resumeFailureReason === undefined ? {} : { resumeFailureReason }),
      startOptions: choices.map(({ id, label, description, operation }) => ({
        id, label, description,
        operation: operation.kind === 'saved' || operation.ownership.resumePoint !== undefined ? 'continue' : 'restart',
      })),
    });
    if (choice.kind !== 'value') {
      return { kind: 'notice', message: withResumeFailureReason(choiceNotice(choice, options), resumeFailureReason, options) };
    }
    const selected = choices.find((option) => option.id === choice.value);
    if (selected === undefined) {
      return { kind: 'notice', message: formatNotice('tui.errors.assistantRetryInvalidResult', options, undefined, resumeFailureReason) };
    }
    return {
      kind: 'resolved',
      label: selected.label,
      operation: selected.operation,
      resumeFailureReason,
    };
  } catch (error) {
    return { kind: 'notice', message: formatNotice('tui.errors.assistantRetryGenerationFailed', options, error, resumeFailureReason) };
  }
}

async function retryFailedTask(
  task: TaskListItem,
  options: AssistantRetryCommandOptions,
  projectDir: string,
): Promise<string> {
  const resolved = await resolveFailedStart(options, task, projectDir);
  if (resolved.kind === 'notice') {
    return resolved.message;
  }

  const promptOptions = buildSummaryPromptOptions(options);
  const revisionPrompt = buildOrderRevisionPrompt(
    promptOptions,
    resolved.preparation.previousOrderContent,
    'retry',
  );
  if (!revisionPrompt.trim()) {
    return formatNotice('tui.errors.assistantRetryUnresolved', options, undefined, resolved.resumeFailureReason);
  }

  const context: SessionContext = {
    ...options.sessionContext,
    sessionId: options.sessionContext.sessionId,
    mcpServers: undefined,
    taskStateMcpServers: undefined,
    disableSessionRetry: true,
  };
  let revisedOrder: string;
  try {
    const { result, error } = await withHandoffProgress(
      options.showProgress === true,
      'reviseInstruction',
      options.lang,
      (onStream) => callAIWithRetry(
        revisionPrompt,
        revisionPrompt,
        [],
        options.cwd,
        context,
        {
          outputMode: 'silent',
          persistSession: false,
          permissionMode: 'readonly',
          internalAgentIsolation: 'strict-readonly',
          ...(onStream === undefined ? {} : { onStream }),
        },
      ),
    );
    if (result === null || !result.success) {
      return formatNotice(
        'tui.errors.assistantRetryGenerationFailed',
        options,
        error ?? result?.content.trim() ?? 'The revised order could not be generated.',
        resolved.resumeFailureReason,
      );
    }
    revisedOrder = result.content;
  } catch (error) {
    return formatNotice('tui.errors.assistantRetryGenerationFailed', options, error, resolved.resumeFailureReason);
  }
  if (!revisedOrder.trim()) {
    return formatNotice('tui.errors.assistantRetryGenerationFailed', options, 'The revised order was empty.', resolved.resumeFailureReason);
  }

  const ui = getLabelObject<ActionWithoutExecuteUIText>('retry.ui', options.lang);
  const selectAction = createSelectActionWithoutExecute(ui);
  const details = buildTaskDetails(
    task,
    resolved.preparation.previousWorkflow,
    resolved.start.label,
    options,
    resolved.resumeFailureReason,
  );
  const displayOrder = revisedOrder
    .split('\n')
    .map((line) => sanitizeTerminalText(line))
    .join('\n');
  const action = await selectAction(`${details}\n\n${ui.proposed}\n${displayOrder}`, options.lang);
  if (action !== 'save_task') {
    return formatNotice('tui.errors.assistantRetryCancelled', options, undefined, resolved.resumeFailureReason);
  }

  try {
    persistFailedTaskRetry({
      task,
      projectDir,
      worktreePath: resolved.preparation.worktreePath,
      startStep: resolved.start.startStep,
      retryNote: undefined,
      resumePoint: resolved.start.resumePoint,
      workflow: resolved.workflowOverride,
      taskDir: task.taskDir,
      sourceRunSlug: resolved.preparation.matchedRunSlug,
      restartPoint: resolved.start.restartPoint,
      revisedOrder: {
        content: revisedOrder,
        lang: options.lang,
      },
    });
  } catch (error) {
    return formatNotice('tui.errors.assistantRetryGenerationFailed', options, error, resolved.resumeFailureReason);
  }

  return getLabel('tui.errors.assistantRetrySaved', options.lang, {
    task: displayTaskName(task),
  });
}

/** Resolve, confirm, and queue a failed task without starting its workflow. */
export async function runAssistantRetryCommand(
  options: AssistantRetryCommandOptions,
): Promise<string> {
  if (!hasInteractiveTerminal() || !resolveTtyPolicy().useTty) {
    return formatNotice('tui.errors.assistantRetryRequiresTty', options);
  }

  try {
    const candidates = taskCandidates(new TaskRunner(options.cwd).listAllTaskItems(), options.command);
    if (candidates.length === 0) {
      return formatNotice('tui.errors.assistantRetryNoCandidates', options);
    }
    const selectedTask = await selectTask(options, candidates);
    if (typeof selectedTask === 'string') {
      return selectedTask;
    }

    if (selectedTask.kind === 'exceeded') {
      return await requeueExceededTask(selectedTask, options);
    }
    return options.command === 'requeue'
      ? await requeueFailedTask(selectedTask, options, options.cwd)
      : await retryFailedTask(selectedTask, options, options.cwd);
  } catch (error) {
    return formatNotice('tui.errors.assistantRetryGenerationFailed', options, error);
  }
}
