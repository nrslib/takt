import { error, success, warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { validateWorkflowConfig } from '../../core/workflow/engine/WorkflowValidator.js';
import { resolveWorkflowConfigValues } from '../../infra/config/index.js';
import { inspectWorkflowFile, resolveWorkflowDoctorTargets } from '../../infra/config/loaders/workflowDoctor.js';
import { isMissingWorkflowCallArgError } from '../../infra/config/loaders/workflowCallableArgResolver.js';
import { loadWorkflowFileWithResolutionOptions } from '../../infra/config/loaders/workflowResolvedLoader.js';
import type { WorkflowDoctorReport, WorkflowDoctorTarget } from '../../infra/config/loaders/workflowDoctor.js';

function reportHasErrors(report: WorkflowDoctorReport): boolean {
  return report.diagnostics.some((diagnostic) => diagnostic.level === 'error');
}

function loadWorkflowForRuntimeValidation(
  target: WorkflowDoctorTarget,
  projectDir: string,
) {
  const lookupCwd = target.lookupCwd ?? projectDir;
  try {
    return loadWorkflowFileWithResolutionOptions(target.filePath, {
      projectCwd: projectDir,
      lookupCwd,
      source: target.source,
    });
  } catch (error) {
    if (!isMissingWorkflowCallArgError(error)) {
      throw error;
    }
    return loadWorkflowFileWithResolutionOptions(target.filePath, {
      projectCwd: projectDir,
      lookupCwd,
      source: target.source,
      loadMode: 'discovery',
    });
  }
}

function validateWorkflowRuntimeContract(
  report: WorkflowDoctorReport,
  target: WorkflowDoctorTarget,
  projectDir: string,
): void {
  if (reportHasErrors(report)) {
    return;
  }

  try {
    const workflow = loadWorkflowForRuntimeValidation(target, projectDir);
    const config = resolveWorkflowConfigValues(
      projectDir,
      ['provider', 'model', 'personaProviders', 'providerRouting', 'autoRouting'],
    );
    validateWorkflowConfig(workflow, {
      projectCwd: projectDir,
      provider: workflow.provider ?? config.provider,
      model: workflow.model ?? config.model,
      personaProviders: config.personaProviders,
      providerRouting: config.providerRouting,
      autoRouting: workflow.autoRouting ?? config.autoRouting,
      workflowCallResolver: () => null,
    });
  } catch (validationError) {
    report.diagnostics.push({
      level: 'error',
      message: getErrorMessage(validationError),
    });
  }
}

export async function doctorWorkflowCommand(
  targets: string[],
  projectDir: string,
): Promise<void> {
  const resolvedTargets = resolveWorkflowDoctorTargets(targets, projectDir);
  if (resolvedTargets.length === 0) {
    throw new Error('No workflow files found to validate');
  }

  let hasErrors = false;
  for (const target of resolvedTargets) {
    const { filePath, lookupCwd, source } = target;
    const report = inspectWorkflowFile(filePath, projectDir, { lookupCwd, source });
    validateWorkflowRuntimeContract(report, target, projectDir);
    if (report.diagnostics.length === 0) {
      success(`Workflow OK: ${sanitizeTerminalText(filePath)}`);
      continue;
    }

    for (const diagnostic of report.diagnostics) {
      const message = sanitizeTerminalText(diagnostic.message);
      if (diagnostic.level === 'error') {
        hasErrors = true;
        error(`${sanitizeTerminalText(filePath)}: ${message}`);
      } else {
        warn(`${sanitizeTerminalText(filePath)}: ${message}`);
      }
    }
  }

  if (hasErrors) {
    throw new Error('Workflow validation failed');
  }
}
