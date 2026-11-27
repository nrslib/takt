import type { WorkflowConfig } from '../../core/models/types.js';
import { collectWorkflowCallSteps, hasCacciaEffect } from '../../core/workflow/workflow-step-traversal.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import { loadWorkflowByIdentifier } from '../../infra/config/loaders/workflowResolver.js';
import { resolveWorkflowCallTarget } from '../../infra/config/loaders/workflowCallResolver.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { resolveMergeSettings } from '../merge/settings.js';
import { resolveCacciaSettings, runCaccia, type CacciaInput } from './index.js';

const log = createLogger('caccia-linked');

function workflowHasCacciaEffect(workflow: WorkflowConfig, projectCwd: string): boolean {
  if (hasCacciaEffect(workflow.steps)) return true;
  for (const step of collectWorkflowCallSteps(workflow.steps)) {
    const child = resolveWorkflowCallTarget(workflow, step, projectCwd);
    if (child === null) throw new Error(`Cannot resolve workflow_call: ${step.call}`);
    if (workflowHasCacciaEffect(child, projectCwd)) return true;
  }
  return false;
}

export async function runLinkedCacciaSafely(
  projectCwd: string,
  prUrl: string,
  workflowHasCaccia: boolean | undefined,
  abortSignal?: AbortSignal,
  display?: Pick<CacciaInput, 'outputMode' | 'taskPrefix' | 'taskColorIndex' | 'taskDisplayLabel'>,
): Promise<void> {
  try {
    const settings = resolveCacciaSettings(resolveConfigValue(projectCwd, 'caccia'));
    if (!settings.enabled || workflowHasCaccia === true) return;
    if (workflowHasCaccia === undefined) throw new Error('Executed workflow Caccia decision is missing');
    const merge = resolveMergeSettings(resolveConfigValue(projectCwd, 'merge'));
    if (merge.autoStart) {
      const workflow = loadWorkflowByIdentifier(merge.workflow, projectCwd);
      if (workflow === null) throw new Error(`Cannot resolve merge workflow: ${merge.workflow}`);
      if (workflowHasCacciaEffect(workflow, projectCwd)) return;
    }
    await runCaccia({ entry: 'linked', projectCwd, prUrl,
      settings, abortSignal, ...display });
  } catch (error) {
    log.error('Linked Caccia failed', { prUrl, error: getErrorMessage(error) });
  }
}
