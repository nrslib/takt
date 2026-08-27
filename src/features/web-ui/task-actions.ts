import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  detectDefaultBranch,
  getCurrentBranch,
  publishTaskBranch,
  resolveAutoCommitOptions,
  stageAndCommit,
  assertCentralWorktreeOwnership as assertOwnedCentralWorktree,
  CentralWorktreeOwnershipError,
  type CentralWorktreeOwnership,
} from '../../infra/task/index.js';
import { getWorkflowDescription, loadWorkflowByIdentifier } from '../../infra/config/index.js';
import { createPullRequestSafely, getGitProvider } from '../../infra/git/index.js';
import type {
  CentralTaskRecord,
  CentralTaskRepository,
  CentralTaskLaunchDecision,
  CentralExecutionRequest,
} from '../../infra/task/centralStateRepository.js';
import { removeCloneMeta } from '../../infra/task/clone.js';
import {
  pullFromRemote,
  syncBranchWithRoot,
} from '../tasks/list/taskActions.js';
import { collectTaskWorktreeSummary } from '../tasks/list/taskWorktreeSummary.js';
import { buildTaskPullRequestBody } from '../tasks/list/taskPullRequestActions.js';
import { summarizeRunReports, type RunReportSummary } from '../tasks/list/runReportSummary.js';
import { readRunDetail } from './run-store.js';
import type { TaskListItem } from '../../infra/task/types.js';
import { assertValidLocalBranchName } from '../../shared/utils/gitBranchValidation.js';
import type {
  WebChatSessionDescription,
  WebTaskActionClaim,
  WebTaskActionContext,
  WebTaskActionKind,
} from './chat.js';
import {
  formatRunSessionForPrompt,
  type RunSessionContext,
} from '../interactive/runSessionReader.js';
import type { RetryRunInfo } from '../interactive/retryMode.js';
import {
  buildTaskRetryStartOptions,
  resolveTaskRetryStartOption,
  resolveTaskRetryStartOwnership,
  type SelectTaskRetryStartOptions,
} from '../tasks/list/taskRetryStartSelection.js';

export const CENTRAL_TASK_ACTIONS = [
  'diff',
  'instruct',
  'create_pr',
  'sync',
  'pull',
  'try',
  'merge',
  'delete',
  'requeue',
  'retry',
  'force_fail',
] as const;

export type CentralTaskAction = typeof CENTRAL_TASK_ACTIONS[number];

export type CentralTaskDisplayStatus =
  | 'pending'
  | 'running'
  | 'failed'
  | 'exceeded'
  | 'completed'
  | 'pr_failed';

export interface CentralTaskActionResult {
  readonly action: CentralTaskAction;
  readonly taskId: string;
  readonly status: 'completed' | 'accepted' | 'conversation';
  readonly taskStatus?: CentralTaskDisplayStatus;
  readonly pid?: number;
  readonly disposition?: 'started' | 'reused';
  readonly mode?: 'run' | 'watch';
  readonly diff?: string;
  readonly prUrl?: string;
  readonly chatSession?: WebChatSessionDescription;
}

export class CentralTaskActionError extends Error {
  readonly code = 'CENTRAL_TASK_ACTION_INVALID';
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

function isMissing(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT';
}

export function parseCentralTaskAction(value: string): CentralTaskAction {
  if ((CENTRAL_TASK_ACTIONS as readonly string[]).includes(value)) {
    return value as CentralTaskAction;
  }
  throw new CentralTaskActionError(`Unknown task action: ${value}`, 400);
}

export function projectCentralTaskStatus(task: Pick<CentralTaskRecord, 'status' | 'failure'>): CentralTaskDisplayStatus {
  if (task.status === 'starting') return 'running';
  if (task.status !== 'failed') return task.status;
  if (task.failure?.code === 'iteration_exceeded') return 'exceeded';
  if (task.failure?.code === 'pr_failed') return 'pr_failed';
  return 'failed';
}

function hasWorktree(task: Pick<CentralTaskRecord, 'worktreePath'>): task is Pick<CentralTaskRecord, 'worktreePath'> & { worktreePath: string } {
  return typeof task.worktreePath === 'string' && task.worktreePath.length > 0;
}

function hasBranchOperations(task: Pick<CentralTaskRecord, 'worktree' | 'worktreePath' | 'branch'>): boolean {
  return task.worktree !== false
    && hasWorktree(task)
    && typeof task.branch === 'string'
    && task.branch.length > 0;
}

/** Compute the server-authoritative action matrix for one central task. */
export function getCentralTaskActions(task: CentralTaskRecord): readonly CentralTaskAction[] {
  if (task.drainingExecution !== undefined) {
    return task.requeueAfterDrain === undefined ? ['requeue'] : [];
  }
  const status = projectCentralTaskStatus(task);
  const branchOperations = hasBranchOperations(task);
  switch (status) {
    case 'pending':
      return ['delete'];
    case 'running':
      return ['force_fail'];
    case 'failed':
      return branchOperations ? ['requeue', 'retry', 'create_pr', 'delete'] : ['requeue', 'delete'];
    case 'exceeded':
      return ['requeue', 'delete'];
    case 'completed':
      return branchOperations
        ? ['diff', 'instruct', 'create_pr', 'sync', 'pull', 'try', 'merge', 'delete']
        : ['delete'];
    case 'pr_failed':
      return branchOperations
        ? ['diff', 'instruct', 'sync', 'pull', 'try', 'merge', 'delete']
        : ['delete'];
  }
}

export function centralTaskActionMap(task: CentralTaskRecord): Readonly<Record<CentralTaskAction, boolean>> {
  const available = new Set(getCentralTaskActions(task));
  return Object.fromEntries(CENTRAL_TASK_ACTIONS.map((action) => [action, available.has(action)])) as Record<CentralTaskAction, boolean>;
}

export function buildTaskActionConversationContext(
  task: CentralTaskRecord,
  action: WebTaskActionKind,
): WebTaskActionContext {
  if (action !== 'retry' && action !== 'instruct') {
    throw new CentralTaskActionError('Unsupported task action conversation', 400);
  }
  const status = projectCentralTaskStatus(task);
  if (!getCentralTaskActions(task).includes(action)) {
    throw new CentralTaskActionError(`Action ${action} is not available for task ${task.taskId}`);
  }
  return {
    taskId: task.taskId,
    action,
    task: task.task,
    workflow: task.workflow,
    status,
    attempt: task.attempt,
    runIds: [...task.runIds],
    ...(task.runId === undefined ? {} : { runId: task.runId }),
    ...(task.branch === undefined ? {} : { branch: task.branch }),
    ...(task.worktreePath === undefined ? {} : { worktreePath: task.worktreePath }),
    ...(task.failure === undefined ? {} : {
      failure: { code: task.failure.code, message: task.failure.message },
    }),
  };
}

const TASK_ACTION_CONTEXT_LIMIT = 24 * 1024;

function boundTaskActionContext(value: string, limit = TASK_ACTION_CONTEXT_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function buildRunSessionContextFromDetail(detail: Awaited<ReturnType<typeof readRunDetail>>): RunSessionContext {
  const stepLogs = detail.history.map((event) => ({
    step: event.step ?? event.type,
    persona: event.persona ?? 'system',
    status: event.status ?? event.type,
    content: boundTaskActionContext(event.content ?? event.error ?? event.reason ?? ''),
    ...(event.workflow === undefined ? {} : { workflow: event.workflow }),
    ...(event.stack === undefined ? {} : { stack: [...event.stack] }),
  }));
  const reports = detail.reports.map((report) => ({
    filename: report.filename,
    content: boundTaskActionContext(report.content),
  }));
  return {
    task: detail.meta.task,
    workflow: detail.meta.workflow,
    status: detail.meta.status,
    stepLogs,
    reports,
  };
}

function buildBranchContext(
  projectDirectory: string,
  task: CentralTaskRecord,
  ownership: CentralWorktreeOwnership,
): string {
  const base = task.baseBranch ?? detectDefaultBranch(projectDirectory);
  try {
    const stat = execFileSync(
      'git',
      ['diff', '--stat', '--no-ext-diff', `${base}...${ownership.branch}`],
      { cwd: projectDirectory, encoding: 'utf8', stdio: 'pipe' },
    );
    const commits = execFileSync(
      'git',
      ['log', '--oneline', '--decorate', '-20', ownership.branch],
      { cwd: projectDirectory, encoding: 'utf8', stdio: 'pipe' },
    );
    return boundTaskActionContext([
      `Base: ${base}`,
      `Branch: ${ownership.branch}`,
      '',
      'Diff stat:',
      stat,
      'Recent commits:',
      commits,
    ].join('\n'));
  } catch (error) {
    return boundTaskActionContext([
      `Base: ${base}`,
      `Branch: ${ownership.branch}`,
      `Git context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n'));
  }
}

/** Add bounded central run/worktree data to the shared task-action plan. */
export async function enrichTaskActionConversationContext(
  task: CentralTaskRecord,
  action: WebTaskActionKind,
  projectDirectory: string,
  repository: CentralTaskRepository,
): Promise<WebTaskActionContext> {
  const base = buildTaskActionConversationContext(task, action);
  const workflowDescription = getWorkflowDescription(
    task.workflow,
    projectDirectory,
    undefined,
    task.worktreePath ?? projectDirectory,
  );
  const workflowContext = {
    name: workflowDescription.name,
    description: workflowDescription.description,
    workflowStructure: workflowDescription.workflowStructure,
    stepPreviews: workflowDescription.stepPreviews,
    taskHistory: [],
  };
  let runContext: RetryRunInfo | null = null;
  let runSessionContext: RunSessionContext | undefined;
  let resumePoint = undefined;
  let failedStep = base.failure?.step ?? '';
  let lastMessage = base.failure?.lastMessage ?? '';
  if (task.runId !== undefined) {
    try {
      const detail = await readRunDetail(repository.paths, task.runId);
      const sessionContext = buildRunSessionContextFromDetail(detail);
      const formatted = formatRunSessionForPrompt(sessionContext);
      runSessionContext = sessionContext;
      runContext = {
        logsDir: detail.meta.logsDirectory,
        reportsDir: detail.meta.reportDirectory,
        task: formatted.runTask,
        workflow: formatted.runWorkflow,
        status: formatted.runStatus,
        stepLogs: boundTaskActionContext(formatted.runStepLogs),
        reports: boundTaskActionContext(formatted.runReports),
      };
      resumePoint = detail.meta.resumePoint;
      failedStep = detail.meta.failure?.step ?? failedStep;
      lastMessage = detail.history.find((event) => event.content)?.content ?? lastMessage;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const ownership = task.worktree !== false && task.worktreePath !== undefined
    ? assertCentralWorktreeOwnership(
      projectDirectory,
      repository.globalConfigDirectory,
      repository.state.stateId,
      task,
    )
    : undefined;
  let retryStartOptions: WebTaskActionContext['retryStartOptions'];
  let retryStartSelections: WebTaskActionContext['retryStartSelections'];
  let workflowInitialStep: string | undefined;
  if (action === 'retry') {
    if (ownership === undefined) {
      throw new CentralTaskActionError('Retry requires an owned central worktree', 409);
    }
    const workflowConfig = loadWorkflowByIdentifier(task.workflow, projectDirectory, {
      lookupCwd: ownership.worktreePath,
    });
    if (workflowConfig === null) {
      throw new CentralTaskActionError(`Workflow "${task.workflow}" is unavailable for retry`, 409);
    }
    workflowInitialStep = workflowConfig.initialStep;
    const selectionContext: SelectTaskRetryStartOptions = {
      projectCwd: projectDirectory,
      lookupCwd: ownership.worktreePath,
      ...(resumePoint === undefined ? {} : { resumePoint }),
      ...(failedStep.length === 0 ? {} : { preferredRootStep: failedStep }),
    };
    const model = buildTaskRetryStartOptions(workflowConfig, selectionContext);
    retryStartOptions = model;
    retryStartSelections = model.options
      .filter((option) => option.selectable)
      .map((option) => ({
        id: option.id,
        selection: resolveTaskRetryStartOption(workflowConfig, selectionContext, option.id).selection,
      }));
    if (retryStartSelections.length === 0) {
      throw new CentralTaskActionError('Retry has no valid start option', 409);
    }
  }
  const failure = base.failure === undefined
    ? undefined
    : {
        ...base.failure,
        ...(failedStep.length === 0 ? {} : { step: failedStep }),
        ...(lastMessage.length === 0 ? {} : { lastMessage }),
      };
  return {
    ...base,
    generation: task.generation,
    ...(task.runId === undefined ? {} : { sourceRunId: task.runId }),
    ...(task.baseBranch === undefined ? {} : { baseBranch: task.baseBranch }),
    workflowContext,
    ...(runContext === null ? {} : { runContext }),
    ...(runSessionContext === undefined ? {} : { runSessionContext }),
    previousOrderContent: task.task,
    ...(ownership === undefined ? {} : { branchContext: buildBranchContext(projectDirectory, task, ownership) }),
    ...(failure === undefined ? {} : { failure }),
    ...(retryStartOptions === undefined ? {} : { retryStartOptions }),
    ...(retryStartSelections === undefined ? {} : { retryStartSelections }),
    ...(workflowInitialStep === undefined ? {} : { workflowInitialStep }),
  };
}

function asTaskListItem(task: CentralTaskRecord, repository: CentralTaskRepository): TaskListItem {
  const status = projectCentralTaskStatus(task);
  return {
    kind: status,
    name: task.taskId,
    createdAt: task.createdAt,
    filePath: repository.paths.tasksFile,
    content: task.task,
    summary: task.task.split(/\r?\n/u, 1)[0]?.trim(),
    runSlug: task.runId,
    branch: task.branch,
    worktreePath: task.worktreePath,
    prUrl: task.prUrl,
    data: {
      task: task.task,
      worktree: task.worktree,
      branch: task.branch,
      base_branch: task.baseBranch,
      workflow: task.workflow,
      auto_pr: task.autoPr,
      draft_pr: task.draftPr,
    },
  };
}

function requireBranch(task: CentralTaskRecord): string {
  const branch = task.branch;
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new CentralTaskActionError('This task has no branch target', 409);
  }
  try {
    assertValidLocalBranchName(branch);
  } catch {
    throw new CentralTaskActionError('This task has an invalid branch target', 409);
  }
  return branch;
}

function requireWorktree(task: CentralTaskRecord): string {
  if (task.worktree === false || !hasWorktree(task) || !existsSync(task.worktreePath)) {
    throw new CentralTaskActionError('This task worktree is unavailable', 409);
  }
  return task.worktreePath;
}

function baseBranch(projectDirectory: string, task: CentralTaskRecord): string {
  return task.baseBranch ?? detectDefaultBranch(projectDirectory);
}

function readDiff(projectDirectory: string, task: CentralTaskRecord, repository: CentralTaskRepository): string {
  const branch = requireBranch(task);
  const worktreePath = requireWorktree(task);
  assertCentralWorktreeOwnership(
    projectDirectory,
    repository.globalConfigDirectory,
    repository.state.stateId,
    task,
  );
  const target = asTaskListItem(task, repository);
  // Keep the same restoration contract as CLI list actions. This may create a
  // root branch from the owned worktree, never from project-local task state.
  if (!ensureRootBranchReadyForBrowser(projectDirectory, { ...target, worktreePath })) {
    throw new CentralTaskActionError('The task branch is unavailable', 409);
  }
  return execFileSync(
    'git',
    ['diff', '--no-color', '--no-ext-diff', '--unified=80', `${baseBranch(projectDirectory, task)}...${branch}`],
    { cwd: projectDirectory, encoding: 'utf8', stdio: 'pipe' },
  );
}

function ensureRootBranchReadyForBrowser(projectDirectory: string, target: TaskListItem): boolean {
  // `diff` is intentionally browser-readable and does not invoke the pager;
  // the existing helper is also the CLI's branch restoration guard.
  const branch = target.branch;
  if (branch === undefined) return false;
  try {
    return existsSync(join(projectDirectory, '.git'))
      && (execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: projectDirectory,
        stdio: 'pipe',
      }), true);
  } catch {
    if (!target.worktreePath || !existsSync(target.worktreePath)) return false;
    try {
      execFileSync('git', ['fetch', target.worktreePath, `HEAD:refs/heads/${branch}`], {
        cwd: projectDirectory,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }
}

function pullRequestTitle(task: CentralTaskRecord): string {
  const firstLine = task.task.split(/\r?\n/u, 1)[0]?.trim() ?? 'TAKT task';
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

async function readCentralReportSummary(
  repository: CentralTaskRepository,
  task: CentralTaskRecord,
): Promise<RunReportSummary | null> {
  const runId = task.runId;
  if (runId === undefined) return null;
  try {
    const detail = await readRunDetail(repository.paths, runId);
    return summarizeRunReports(detail.reports);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function createPullRequest(
  projectDirectory: string,
  task: CentralTaskRecord,
  repository: CentralTaskRepository,
): Promise<string> {
  const branch = requireBranch(task);
  const worktreePath = requireWorktree(task);
  assertCentralWorktreeOwnership(
    projectDirectory,
    repository.globalConfigDirectory,
    repository.state.stateId,
    task,
  );
  if (getCurrentBranch(worktreePath) !== branch) {
    throw new CentralTaskActionError('The task worktree is not checked out at its recorded branch', 409);
  }
  const base = baseBranch(projectDirectory, task);
  const summary = collectTaskWorktreeSummary(worktreePath, base, branch);
  const reportSummary = await readCentralReportSummary(repository, task);
  const body = buildTaskPullRequestBody({
    taskKind: projectCentralTaskStatus(task),
    reportSummary,
    worktreeSummary: summary.text,
  });
  await stageAndCommit(worktreePath, `takt: ${pullRequestTitle(task)}`, resolveAutoCommitOptions(projectDirectory));
  publishTaskBranch(worktreePath, projectDirectory, branch);
  const result = createPullRequestSafely(getGitProvider(), {
    branch,
    title: pullRequestTitle(task),
    body,
    base,
    draft: task.draftPr,
  }, projectDirectory);
  if (!result.success) throw new CentralTaskActionError(result.error ?? 'Pull request creation failed', 502);
  const prUrl = result.url;
  if (prUrl === undefined || prUrl.length === 0) {
    throw new CentralTaskActionError('Pull request creation returned no URL', 502);
  }
  await repository.setPullRequestUrl(task.taskId, prUrl);
  return prUrl;
}

function assertCentralWorktreeOwnership(
  projectDirectory: string,
  globalConfigDirectory: string,
  stateId: string,
  task: CentralTaskRecord,
): CentralWorktreeOwnership {
  try {
    return assertOwnedCentralWorktree(projectDirectory, globalConfigDirectory, stateId, task);
  } catch (error) {
    if (error instanceof CentralWorktreeOwnershipError) {
      throw new CentralTaskActionError(error.message, 409);
    }
    throw error;
  }
}

async function cleanupCentralResources(
  projectDirectory: string,
  globalConfigDirectory: string,
  stateId: string,
  task: CentralTaskRecord,
): Promise<void> {
  if (task.worktree === false || task.worktreePath === undefined) return;
  const ownership = assertCentralWorktreeOwnership(
    projectDirectory,
    globalConfigDirectory,
    stateId,
    task,
  );
  const { branch, worktreePath, metadataDirectory } = ownership;
  assertDeletableCentralBranch(projectDirectory, task, branch);
  if (existsSync(worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true });
  }
  removeCloneMeta(projectDirectory, branch, metadataDirectory);
  if (localBranchExists(projectDirectory, branch)) {
    runCentralGit(projectDirectory, ['branch', '-D', branch], 'Task branch cleanup failed');
  }
}

function gitErrorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'stderr' in error) {
    const stderr = error.stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.toString('utf8').trim().length > 0) return stderr.toString('utf8').trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function runCentralGit(
  projectDirectory: string,
  args: readonly string[],
  label: string,
): void {
  try {
    execFileSync('git', args, {
      cwd: projectDirectory,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_EDITOR: 'true',
        GIT_MERGE_AUTOEDIT: 'no',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  } catch (error) {
    throw new CentralTaskActionError(`${label}: ${gitErrorMessage(error)}`, 409);
  }
}

function assertCleanCentralRoot(
  projectDirectory: string,
  task: CentralTaskRecord,
): void {
  const expectedBranch = baseBranch(projectDirectory, task);
  let currentBranch: string;
  try {
    currentBranch = getCurrentBranch(projectDirectory);
  } catch (error) {
    throw new CentralTaskActionError(`Unable to inspect the project branch: ${gitErrorMessage(error)}`, 409);
  }
  if (currentBranch !== expectedBranch) {
    throw new CentralTaskActionError(
      `The project must be checked out at its base branch (${expectedBranch})`,
      409,
    );
  }
  let status: string;
  try {
    status = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      {
        cwd: projectDirectory,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
  } catch (error) {
    throw new CentralTaskActionError(`Unable to inspect the project worktree: ${gitErrorMessage(error)}`, 409);
  }
  if (status.trim().length > 0) {
    throw new CentralTaskActionError('The project worktree has uncommitted changes', 409);
  }
}

function localBranchExists(projectDirectory: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: projectDirectory,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function assertDeletableCentralBranch(
  projectDirectory: string,
  task: CentralTaskRecord,
  branch: string,
): void {
  let currentBranch: string;
  try {
    currentBranch = getCurrentBranch(projectDirectory);
  } catch (error) {
    throw new CentralTaskActionError(`Unable to inspect the project branch: ${gitErrorMessage(error)}`, 409);
  }
  const expectedBase = baseBranch(projectDirectory, task);
  if (branch === currentBranch) {
    throw new CentralTaskActionError('Refusing to delete the project current branch', 409);
  }
  if (branch === expectedBase) {
    throw new CentralTaskActionError('Refusing to delete the project base branch', 409);
  }
}

function ensureCentralRootBranch(
  projectDirectory: string,
  task: CentralTaskRecord,
  repository: CentralTaskRepository,
): string {
  const branch = requireBranch(task);
  assertCleanCentralRoot(projectDirectory, task);
  assertCentralWorktreeOwnership(
    projectDirectory,
    repository.globalConfigDirectory,
    repository.state.stateId,
    task,
  );
  if (!ensureRootBranchReadyForBrowser(projectDirectory, asTaskListItem(task, repository))) {
    throw new CentralTaskActionError('The task branch is unavailable', 409);
  }
  return branch;
}

function tryCentralMerge(
  projectDirectory: string,
  task: CentralTaskRecord,
  repository: CentralTaskRepository,
): void {
  const branch = ensureCentralRootBranch(projectDirectory, task, repository);
  runCentralGit(projectDirectory, ['merge', '--squash', branch], 'Try merge failed');
}

async function mergeCentralTask(
  projectDirectory: string,
  globalConfigDirectory: string,
  task: CentralTaskRecord,
  repository: CentralTaskRepository,
): Promise<void> {
  const branch = ensureCentralRootBranch(projectDirectory, task, repository);
  if (branch === baseBranch(projectDirectory, task)) {
    throw new CentralTaskActionError('Refusing to merge the project base branch', 409);
  }
  runCentralGit(projectDirectory, ['merge', '--no-edit', branch], 'Merge failed');
  await repository.deleteTask(task.taskId, task.generation, {
    cleanup: () => cleanupCentralResources(
      projectDirectory,
      globalConfigDirectory,
      repository.state.stateId,
      task,
    ),
  });
}

export function requireActionInput(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length === 0 || input.includes('\0') || input.length > 64 * 1024) {
    throw new CentralTaskActionError('This action requires additional instruction text', 400);
  }
  return input.trim();
}

export interface ExecuteCentralTaskActionOptions {
  readonly globalConfigDirectory: string;
  readonly projectDirectory: string;
  readonly projectId?: string;
  readonly repository: CentralTaskRepository;
  readonly task: CentralTaskRecord;
  readonly action: CentralTaskAction;
  readonly input?: string;
  readonly conversationId?: string;
  /** Process-local server claim created by the task-action /go endpoint. */
  readonly taskActionClaim?: WebTaskActionClaim;
  readonly spawnDecision: (decision: CentralTaskLaunchDecision, repository: CentralTaskRepository) => Promise<{
    readonly pid: number;
    readonly disposition: 'started' | 'reused';
    readonly mode: 'run' | 'watch';
  }>;
}

function assertTaskActionClaim(
  options: ExecuteCentralTaskActionOptions,
  task: CentralTaskRecord,
): WebTaskActionClaim {
  const claim = options.taskActionClaim;
  if (claim === undefined) {
    throw new CentralTaskActionError('Task action conversation claim is required', 409);
  }
  const context = claim.context;
  if (
    context.taskId !== task.taskId
    || context.action !== options.action
    || context.projectDirectory !== options.projectDirectory
    || context.stateId !== options.repository.state.stateId
    || context.projectId === undefined
    || options.projectId !== undefined && context.projectId !== options.projectId
    || context.generation !== task.generation
    || context.sourceRunId !== task.runId
    || context.runId !== task.runId
    || context.worktreePath !== task.worktreePath
    || context.runIds.length !== task.runIds.length
    || context.runIds.some((runId, index) => runId !== task.runIds[index])
    || !getCentralTaskActions(task).includes(options.action)
  ) {
    throw new CentralTaskActionError('Task action conversation is stale', 409);
  }
  return claim;
}

function executionRequestForTaskAction(
  action: 'retry' | 'instruct',
  task: CentralTaskRecord,
  input: string,
  claim: WebTaskActionClaim,
): CentralExecutionRequest {
  const sourceRunSlug = task.runId;
  if (sourceRunSlug === undefined) {
    throw new CentralTaskActionError('Task action requires an existing source run', 409);
  }
  if (action === 'instruct') {
    return { resumeMode: 'instruct', sourceRunSlug };
  }
  const selection = claim.retrySelection;
  if (selection === undefined) {
    throw new CentralTaskActionError('Retry start option is required', 409);
  }
  const workflowInitialStep = claim.context.workflowInitialStep;
  if (workflowInitialStep === undefined) {
    throw new CentralTaskActionError('Retry workflow snapshot is incomplete', 409);
  }
  const retryStartOwnership = resolveTaskRetryStartOwnership(selection, {
    initialStep: workflowInitialStep,
  });
  return {
    resumeMode: 'retry',
    sourceRunSlug,
    ...retryStartOwnership,
    retryNote: input,
  };
}

async function readTaskStatusAfterSpawn(
  repository: CentralTaskRepository,
  taskId: string,
): Promise<CentralTaskDisplayStatus> {
  // requeueTask may start an older pending task first. The launch decision is
  // about that worker, so the response must report the requested task itself.
  const currentTask = await repository.readTask(taskId);
  if (currentTask === undefined) {
    throw new CentralTaskActionError('Central task disappeared after launch', 409);
  }
  return projectCentralTaskStatus(currentTask);
}

export async function executeCentralTaskAction(
  options: ExecuteCentralTaskActionOptions,
): Promise<CentralTaskActionResult> {
  const { action, repository } = options;
  const task = await repository.readTask(options.task.taskId);
  if (task === undefined) {
    throw new CentralTaskActionError('Central task was not found', 404);
  }
  if (!getCentralTaskActions(task).includes(action)) {
    throw new CentralTaskActionError(`Action ${action} is not available for task ${task.taskId}`);
  }
  switch (action) {
    case 'diff':
      return { action, taskId: task.taskId, status: 'completed', taskStatus: projectCentralTaskStatus(task), diff: readDiff(options.projectDirectory, task, repository) };
    case 'create_pr': {
      const prUrl = await createPullRequest(options.projectDirectory, task, repository);
      return { action, taskId: task.taskId, status: 'completed', taskStatus: projectCentralTaskStatus(task), prUrl };
    }
    case 'sync': {
      requireWorktree(task);
      assertCentralWorktreeOwnership(
        options.projectDirectory,
        repository.globalConfigDirectory,
        repository.state.stateId,
        task,
      );
      const target = asTaskListItem(task, repository);
      if (!await syncBranchWithRoot(options.projectDirectory, target)) throw new CentralTaskActionError('Sync failed', 409);
      return { action, taskId: task.taskId, status: 'completed', taskStatus: projectCentralTaskStatus(task) };
    }
    case 'pull': {
      requireWorktree(task);
      assertCentralWorktreeOwnership(
        options.projectDirectory,
        repository.globalConfigDirectory,
        repository.state.stateId,
        task,
      );
      const target = asTaskListItem(task, repository);
      if (!pullFromRemote(options.projectDirectory, target)) throw new CentralTaskActionError('Pull failed', 409);
      return { action, taskId: task.taskId, status: 'completed', taskStatus: projectCentralTaskStatus(task) };
    }
    case 'try': {
      tryCentralMerge(options.projectDirectory, task, repository);
      return { action, taskId: task.taskId, status: 'completed', taskStatus: projectCentralTaskStatus(task) };
    }
    case 'merge': {
      await mergeCentralTask(
        options.projectDirectory,
        options.globalConfigDirectory,
        task,
        repository,
      );
      return { action, taskId: task.taskId, status: 'completed' };
    }
    case 'delete':
      await repository.deleteTask(task.taskId, task.generation, {
        cleanup: () => cleanupCentralResources(
          options.projectDirectory,
          options.globalConfigDirectory,
          repository.state.stateId,
          task,
        ),
      });
      return { action, taskId: task.taskId, status: 'completed' };
    case 'force_fail': {
      const failed = await repository.forceFailTask(task.taskId);
      return { action, taskId: task.taskId, status: 'completed', taskStatus: projectCentralTaskStatus(failed) };
    }
    case 'requeue': {
      const decision = await repository.requeueTask(task.taskId);
      const launch = await options.spawnDecision(decision, repository);
      return {
        action,
        taskId: task.taskId,
        status: 'accepted',
        taskStatus: await readTaskStatusAfterSpawn(repository, task.taskId),
        ...launch,
      };
    }
    case 'retry':
    case 'instruct': {
      if (options.conversationId === undefined || options.conversationId.trim().length === 0) {
        throw new CentralTaskActionError(`${action} must be completed from its task conversation`, 409);
      }
      const input = requireActionInput(options.input);
      const claim = assertTaskActionClaim(options, task);
      const executionRequest = executionRequestForTaskAction(action, task, input, claim);
      const decision = await repository.requeueTask(task.taskId, {
        task: input,
        executionRequest,
      });
      const launch = await options.spawnDecision(decision, repository);
      return {
        action,
        taskId: task.taskId,
        status: 'accepted',
        taskStatus: await readTaskStatusAfterSpawn(repository, task.taskId),
        ...launch,
      };
    }
  }
}
