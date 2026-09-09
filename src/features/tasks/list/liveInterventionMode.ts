import { join } from 'node:path';
import { SlashCommand } from '../../../shared/constants.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { createAssistantConversationPlan, type ConversationPlan } from '../../interactive/conversationPlan.js';
import { loadRunSessionContext, type RunSessionContext } from '../../interactive/runSessionReader.js';
import { runTuiTaskConversation } from '../../tui/runTuiTask.js';
import type { TuiHandoffOutcome } from '../../tui/conversationRunner.js';
import type { TaskListItem } from '../../../infra/task/types.js';
import { providerSupportsPermissionControls } from '../../../infra/providers/provider-capabilities.js';
import { LiveInterventionFileStore } from '../../../infra/workflow/live-intervention-store.js';
import { readRunMetaBySlug } from '../../../core/workflow/run/run-meta.js';
import { assertReusableWorktreePath } from '../execute/reusedWorktree.js';
import {
  assertPathSegmentsAreSafe,
  isValidReportDirName,
} from '../../../shared/utils/index.js';
import { openLiveRunDirectory } from './liveInterventionOpen.js';

const LIVE_INTERVENTION_TOOLS = ['Read', 'Glob', 'Grep'];
const LIVE_INTERVENTION_COMMANDS = [
  SlashCommand.Go,
  SlashCommand.Cancel,
  SlashCommand.Open,
] as const;

interface LiveRunTarget {
  readonly runSlug: string;
  readonly worktreePath: string;
  readonly runDirectory: string;
}

function restrictLiveInterventionProviderOptions(
  ctx: ConversationPlan['ctx'],
): ConversationPlan['ctx'] {
  if (ctx.providerType !== 'pi') {
    return ctx;
  }

  return {
    ...ctx,
    providerOptions: {
      ...ctx.providerOptions,
      pi: {
        ...ctx.providerOptions?.pi,
        extensions: [],
        noExtensions: true,
        noContextFiles: true,
      },
    },
  };
}

function requireLiveTask(projectCwd: string, task: TaskListItem): LiveRunTarget {
  if (task.kind !== 'running' || task.runSlug === undefined || task.worktreePath === undefined) {
    throw new Error('Live intervention requires a running task with a run identity and worktree');
  }
  return resolveLiveRunTarget(projectCwd, task.worktreePath, task.runSlug);
}

function resolveLiveRunTarget(
  projectCwd: string,
  worktreePath: string,
  runSlug: string,
): LiveRunTarget {
  if (!isValidReportDirName(runSlug)) {
    throw new Error('Live run slug is invalid');
  }
  assertReusableWorktreePath(projectCwd, worktreePath);
  const directory = join(worktreePath, '.takt', 'runs', runSlug);
  const stats = assertPathSegmentsAreSafe(
    worktreePath,
    directory,
    (violation, segmentPath) => {
      switch (violation) {
        case 'outside':
          return new Error(`Live run directory is outside the worktree: ${directory}`);
        case 'symlink':
          return new Error(`Live run directory must not contain a symlink: ${segmentPath}`);
        case 'not_directory':
          return new Error(`Live run directory contains a non-directory segment: ${segmentPath}`);
      }
    },
  );
  if (stats === null) {
    throw new Error(`Live run directory does not exist: ${directory}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Live run directory is not a regular directory: ${directory}`);
  }
  return { runSlug, worktreePath, runDirectory: directory };
}

function requireRunningLiveRun(target: LiveRunTarget): void {
  const meta = readRunMetaBySlug(target.worktreePath, target.runSlug);
  if (meta?.status !== 'running') {
    throw new Error(`Live intervention requires a running clone run: ${target.runSlug}`);
  }
}

function buildLiveStatusReader(
  worktreePath: string,
  runSlug: string,
  store: LiveInterventionFileStore,
): () => string {
  return () => {
    const meta = readRunMetaBySlug(worktreePath, runSlug);
    const state = store.read();
    const delivery = state.pending > 0
      ? 'pending'
      : state.lastDelivery?.mode ?? 'none';
    const parts = [
      `step=${meta?.currentStep ?? 'unknown'}`,
      `phase=${meta?.phase ?? 'unknown'}`,
      `pending=${state.pending}`,
      `deliveredSameSession=${state.deliveredSameSession}`,
      `deliveredNextStep=${state.deliveredNextStep}`,
      `unconsumedWarned=${state.unconsumedWarned}`,
      `delivery=${delivery}`,
    ];
    if (state.lastDelivery?.processedBatchCount !== undefined) {
      parts.push(`processed=${state.lastDelivery.processedBatchCount}`);
    }
    if (state.lastDelivery?.appliesToBatchIndexes !== undefined) {
      parts.push(`applies=${state.lastDelivery.appliesToBatchIndexes.join(',')}`);
    }
    return parts.join(' ');
  };
}

function buildLivePlan(
  worktreePath: string,
  runSlug: string,
  projectCwd: string,
): ConversationPlan {
  let stableReports: RunSessionContext['reports'] = [];
  const resolveLiveRunSessionContext = (): RunSessionContext => {
    let usedStableReportFallback = false;
    const context = loadRunSessionContext(worktreePath, runSlug, {
      liveInterventionProjectCwd: projectCwd,
      liveInterventionReportFallback: {
        reports: stableReports,
        onFallback: () => {
          usedStableReportFallback = true;
        },
      },
    });
    if (!usedStableReportFallback) {
      stableReports = context.reports;
    }
    return context;
  };
  const runSessionContext = resolveLiveRunSessionContext();
  const basePlan = createAssistantConversationPlan(projectCwd, {
    assistantMode: 'assistant',
    formalSpec: false,
    formalSpecComments: true,
    runSessionContext,
    resolveRunSessionContext: resolveLiveRunSessionContext,
  });
  return {
    ctx: restrictLiveInterventionProviderOptions(basePlan.ctx),
    strategy: {
      ...basePlan.strategy,
      allowedTools: LIVE_INTERVENTION_TOOLS,
      permissionMode: 'readonly',
      enableOpenCommand: true,
      enabledCommands: LIVE_INTERVENTION_COMMANDS,
      trackResultSource: true,
      selectGoAction: async () => 'execute',
      useCurrentSystemPromptForSummary: true,
    },
  };
}

async function handleLiveHandoff(
  id: string,
  projectCwd: string,
  worktreePath: string,
  runSlug: string,
  lang: ConversationPlan['ctx']['lang'],
): Promise<TuiHandoffOutcome> {
  if (id !== 'open') {
    throw new Error(`Unsupported live intervention hand-off: ${id}`);
  }
  const target = resolveLiveRunTarget(projectCwd, worktreePath, runSlug);
  await openLiveRunDirectory({ directory: target.runDirectory });
  return {
    kind: 'continue',
    notice: getLabel('interactive.commands.open', lang),
  };
}

async function dispatchLiveIntervention(
  result: { readonly action: string; readonly task: string; readonly source?: string },
  projectCwd: string,
  worktreePath: string,
  runSlug: string,
  store: LiveInterventionFileStore,
): Promise<string | null> {
  if (result.action !== 'execute' || result.source !== 'go') {
    return null;
  }
  const target = resolveLiveRunTarget(projectCwd, worktreePath, runSlug);
  requireRunningLiveRun(target);
  await store.issue(result.task);
  return null;
}

export async function runLiveInterventionMode(
  projectCwd: string,
  task: TaskListItem,
): Promise<void> {
  const target = requireLiveTask(projectCwd, task);
  requireRunningLiveRun(target);
  const { runSlug, worktreePath } = target;
  const store = new LiveInterventionFileStore(projectCwd, runSlug);
  const plan = buildLivePlan(worktreePath, runSlug, projectCwd);
  if (providerSupportsPermissionControls(plan.ctx.providerType) === false) {
    throw new Error(
      `Provider "${plan.ctx.providerType}" does not support live intervention permission controls`,
    );
  }
  await runTuiTaskConversation({
    cwd: worktreePath,
    plan,
    liveStatusReader: buildLiveStatusReader(worktreePath, runSlug, store),
    liveStatusRefreshIntervalMs: 500,
    onHandoff: (id) => handleLiveHandoff(id, projectCwd, worktreePath, runSlug, plan.ctx.lang),
    dispatch: (result) => dispatchLiveIntervention(
      result,
      projectCwd,
      worktreePath,
      runSlug,
      store,
    ),
  });
}
