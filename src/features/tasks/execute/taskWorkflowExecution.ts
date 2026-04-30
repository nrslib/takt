import type { WorkflowConfig } from '../../../core/models/index.js';
import { loadWorkflowByIdentifier, isWorkflowPath, resolveWorkflowConfigValues } from '../../../infra/config/index.js';
import { resolveProviderOptionsWithTrace } from '../../../infra/config/resolveConfigValue.js';
import { info, error } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import type { ExecuteTaskOptions, WorkflowExecutionOptions, WorkflowExecutionResult } from './types.js';

const log = createLogger('task');

type WorkflowExecutor = (
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
) => Promise<WorkflowExecutionResult>;

export async function executeTaskWorkflow(
  options: ExecuteTaskOptions,
  workflowExecutor: WorkflowExecutor,
): Promise<WorkflowExecutionResult> {
  const {
    task,
    cwd,
    workflowIdentifier,
    projectCwd,
    agentOverrides,
    interactiveUserInput,
    interactiveMetadata,
    startStep,
    retryNote,
    resumePoint,
    reportDirName,
    abortSignal,
    taskPrefix,
    taskColorIndex,
    taskDisplayLabel,
    maxStepsOverride,
    initialIterationOverride,
    currentTaskIssueNumber,
  } = options;
  const workflowConfig = loadWorkflowByIdentifier(workflowIdentifier, projectCwd, { lookupCwd: cwd });
  const safeWorkflowIdentifier = sanitizeTerminalText(workflowIdentifier);

  if (!workflowConfig) {
    if (isWorkflowPath(workflowIdentifier)) {
      error(`Workflow file not found: ${safeWorkflowIdentifier}`);
      return { success: false, reason: `Workflow file not found: ${safeWorkflowIdentifier}` };
    }

    error(`Workflow "${safeWorkflowIdentifier}" not found.`);
    info('Available workflows are searched in .takt/workflows/ and ~/.takt/workflows/.');
    info('If the same workflow name exists in multiple locations, project workflows/ take priority over user workflows/.');
    info('Specify a valid workflow when creating tasks (e.g., via "takt add").');
    return { success: false, reason: `Workflow "${safeWorkflowIdentifier}" not found.` };
  }
  log.debug('Running workflow', {
    name: workflowConfig.name,
    steps: workflowConfig.steps.map((s: { name: string }) => s.name),
  });

  const config = resolveWorkflowConfigValues(projectCwd, ['language', 'personaProviders', 'providerProfiles']);
  const providerOptions = resolveProviderOptionsWithTrace(projectCwd);
  return workflowExecutor(workflowConfig, task, cwd, {
    projectCwd,
    language: config.language,
    provider: agentOverrides?.provider,
    model: agentOverrides?.model,
    providerOptions: providerOptions.value,
    providerOptionsSource: providerOptions.source,
    providerOptionsOriginResolver: providerOptions.originResolver,
    personaProviders: config.personaProviders,
    providerProfiles: config.providerProfiles,
    interactiveUserInput,
    interactiveMetadata,
    startStep,
    retryNote,
    resumePoint,
    reportDirName,
    abortSignal,
    taskPrefix,
    taskColorIndex,
    taskDisplayLabel,
    maxStepsOverride,
    initialIterationOverride,
    currentTaskIssueNumber,
  });
}
