import { join } from 'node:path';
import { debugLog } from '../../shared/utils/index.js';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import type { PermissionMode } from '../../core/models/status.js';
import { generateExecutionReportDir } from '../../core/workflow/run/run-slug.js';
import type { ConversationMessage } from '../interactive/interactive.js';
import { loadRunSessionContext } from '../interactive/runSessionReader.js';
import { selectAndExecuteTask, type TaskExecutionOptions } from '../tasks/index.js';
import { EXEC_PROVIDERS } from './configValidation.js';
import { saveLastUsedExecConfig } from './presetStore.js';
import { writeProjectLocalTextFile } from './projectLocalFiles.js';
import type { ExecConfig } from './types.js';
import { buildExecWorkflowYaml, buildJudgeReportName } from './workflowTemplate.js';

const READONLY_PERMISSION_MODE: PermissionMode = 'readonly';

function buildReadonlyStepPermissionOverrides(config: ExecConfig): Record<string, PermissionMode> {
  return Object.fromEntries([
    ...config.judges.map((judge) => judge.name),
    'replan',
    '_loop_judge_execute_judge',
    '_loop_judge_replan_execute_judge',
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

async function generateWorkflowFile(cwd: string, config: ExecConfig, task: string, workflowName: string): Promise<string> {
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
  expectedJudgeReportNames: string[],
): ReturnType<typeof loadRunSessionContext> {
  const context = loadRunSessionContext(cwd, runSlug, { reportNames: expectedJudgeReportNames });
  const actualReportNames = new Set(context.reports.map((report) => report.filename));
  const missingReportNames = expectedJudgeReportNames.filter((name) => !actualReportNames.has(name));
  if (missingReportNames.length > 0) {
    throw new Error(`Exec judge result report was not found: ${missingReportNames.join(', ')}`);
  }
  return {
    ...context,
    reports: expectedJudgeReportNames.map((name) => {
      const report = context.reports.find((entry) => entry.filename === name);
      if (report === undefined) {
        throw new Error(`Exec judge result report was not found: ${name}`);
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
  if (history.length === 0 && !hasSessionContext && inlineTaskText.length === 0) {
    return null;
  }

  const lines = ['Create a concise executable task instruction for TAKT exec.'];
  if (history.length > 0) {
    lines.push('', 'Conversation:');
    for (const message of history) {
      lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`);
    }
  } else if (hasSessionContext) {
    lines.push('', 'Use the active exec assistant session context as the conversation.');
  }
  if (inlineTaskText.length > 0) {
    lines.push('', 'Additional user note:', inlineTaskText);
  }
  return lines.join('\n');
}

export async function runGeneratedWorkflow(
  cwd: string,
  config: ExecConfig,
  task: string,
  agentOverrides: TaskExecutionOptions | undefined,
): Promise<ReturnType<typeof loadRunSessionContext>> {
  const runSlug = generateExecutionReportDir(cwd, task);
  const workflowPath = await generateWorkflowFile(cwd, config, task, `exec-${runSlug}`);
  await selectAndExecuteTask(cwd, task, {
    workflow: workflowPath,
    skipTaskList: true,
    interactiveUserInput: true,
    interactiveMetadata: { confirmed: true, task },
    reportDirName: runSlug,
    providerProfileOverrides: buildExecReadonlyProviderProfileOverrides(config),
  }, agentOverrides);
  const context = loadCompletedExecRun(cwd, runSlug, config.judges.map((judge) => buildJudgeReportName(judge.name)));
  try {
    saveLastUsedExecConfig(config);
  } catch (error) {
    debugLog('exec', 'Failed to save last-used exec config', error instanceof Error ? error.message : String(error));
  }
  return context;
}
