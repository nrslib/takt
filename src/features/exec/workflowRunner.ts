import { join } from 'node:path';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import type { PermissionMode } from '../../core/models/status.js';
import { generateExecutionReportDir } from '../../core/workflow/run/run-slug.js';
import type { ConversationMessage } from '../interactive/interactive.js';
import { loadRunSessionContext } from '../interactive/runSessionReader.js';
import { selectAndExecuteTask, type TaskExecutionOptions } from '../tasks/index.js';
import { EXEC_PROVIDERS } from './configValidation.js';
import { writeProjectLocalTextFile } from './projectLocalFiles.js';
import type { ExecConfig, ResolvedExecConfig } from './types.js';
import { buildExecWorkflowYaml, buildReviewReportName } from './workflowTemplate.js';

const READONLY_PERMISSION_MODE: PermissionMode = 'readonly';

function buildReadonlyStepPermissionOverrides(config: ExecConfig): Record<string, PermissionMode> {
  return Object.fromEntries([
    ...config.reviews.map((review) => review.name),
    'replan',
    '_loop_judge_execute_review',
    '_loop_judge_replan_execute_review',
  ].map((stepName) => [stepName, READONLY_PERMISSION_MODE]));
}

export function buildExecReadonlyProviderProfileOverrides(config: ExecConfig): ProviderPermissionProfiles {
  const stepPermissionOverrides = buildReadonlyStepPermissionOverrides(config);
  return Object.fromEntries(EXEC_PROVIDERS.map((provider) => [
    provider,
    {
      defaultPermissionMode: 'edit',
      stepPermissionOverrides,
    },
  ])) as ProviderPermissionProfiles;
}

async function generateWorkflowFile(cwd: string, config: ResolvedExecConfig, task: string, workflowName: string): Promise<string> {
  const workflowDir = join(cwd, '.takt', 'exec');
  const workflowPath = join(workflowDir, 'workflow.yaml');
  const yaml = buildExecWorkflowYaml(config, {
    workflowName,
    taskDescription: task,
  });
  writeProjectLocalTextFile(cwd, workflowPath, yaml, 'exec workflow');
  return workflowPath;
}

function loadCompletedExecRun(
  cwd: string,
  runSlug: string,
  expectedReviewReportNames: string[],
): ReturnType<typeof loadRunSessionContext> {
  const context = loadRunSessionContext(cwd, runSlug, { reportNames: expectedReviewReportNames });
  const actualReportNames = new Set(context.reports.map((report) => report.filename));
  const missingReportNames = expectedReviewReportNames.filter((name) => !actualReportNames.has(name));
  if (missingReportNames.length > 0) {
    throw new Error(`Exec review result report was not found: ${missingReportNames.join(', ')}`);
  }
  return {
    ...context,
    reports: expectedReviewReportNames.map((name) => {
      const report = context.reports.find((entry) => entry.filename === name);
      if (report === undefined) {
        throw new Error(`Exec review result report was not found: ${name}`);
      }
      return report;
    }),
  };
}

export function buildTaskInstructionPrompt(
  history: ConversationMessage[],
  hasSessionContext: boolean,
  inlineTaskText: string,
): string | null {
  const normalizedInlineTaskText = inlineTaskText.trim();
  if (history.length === 0 && !hasSessionContext && normalizedInlineTaskText.length === 0) {
    return null;
  }

  const lines = [
    'Create a concise executable task instruction for TAKT exec.',
    '',
    'TAKT is a CLI workflow runner for executing a user task with coordinated AI agents.',
    '`takt exec` is the interactive task-entry mode that turns this conversation into a generated workflow and then runs it.',
    'The generated workflow uses Worker agent(s) to implement the task, Review agent(s) to review the result, a Replanning agent only when user-level replanning is needed, and loop detection to prevent repeated unproductive cycles.',
  ];
  if (history.length > 0) {
    lines.push('', 'Conversation:');
    for (const message of history) {
      lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`);
    }
  } else if (hasSessionContext) {
    lines.push('', 'Use the active exec assistant session context as the conversation.');
  }
  if (normalizedInlineTaskText.length > 0) {
    lines.push('', 'Additional user note:', normalizedInlineTaskText);
  }
  return lines.join('\n');
}

export async function runGeneratedWorkflow(
  cwd: string,
  runtimeConfig: ResolvedExecConfig,
  task: string,
  agentOverrides: TaskExecutionOptions | undefined,
): Promise<ReturnType<typeof loadRunSessionContext>> {
  const runSlug = generateExecutionReportDir(cwd, task);
  const workflowPath = await generateWorkflowFile(cwd, runtimeConfig, task, `exec-${runSlug}`);
  await selectAndExecuteTask(cwd, task, {
    workflow: workflowPath,
    skipTaskList: true,
    interactiveUserInput: true,
    interactiveMetadata: { confirmed: true, task },
    reportDirName: runSlug,
    providerProfileOverrides: buildExecReadonlyProviderProfileOverrides(runtimeConfig),
    exitOnFailure: false,
  }, agentOverrides);
  const context = loadCompletedExecRun(cwd, runSlug, runtimeConfig.reviews.map((review) => buildReviewReportName(review.name)));
  return context;
}
