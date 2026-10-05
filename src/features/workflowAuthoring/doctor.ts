import { error, success, warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { warnOnUnproducibleReportReferences } from './report-reference-validation.js';
import { validateWorkflowConfig } from '../../core/workflow/engine/WorkflowValidator.js';
import {
  resolveWorkflowSelector,
  type SelectorProviderOverrides,
} from '../../infra/config/index.js';
import { resolveAuxiliaryRuntimeEnvironment } from '../../infra/config/runtime-provider/provider-environment.js';
import {
  inspectWorkflowFile,
  resolveWorkflowDoctorTargets,
  loadWorkflowForRuntimeValidation,
} from '../../infra/config/loaders/workflowDoctor.js';
import type { CompanionReviewMode } from '../../core/models/companion-types.js';
import type { WorkflowDoctorReport, WorkflowDoctorTarget } from '../../infra/config/loaders/workflowDoctor.js';
import { translateWorkflowConfigError } from '../../shared/workflowConfigMetadata.js';
import { validateWorkflowCallContracts } from '../../infra/config/loaders/workflowResolver.js';
import { resolveWorkflowCompanions } from '../../infra/config/workflowCompanionResolution.js';

export { loadWorkflowForRuntimeValidation } from '../../infra/config/loaders/workflowDoctor.js';

export function reportHasErrors(report: WorkflowDoctorReport): boolean {
  return report.diagnostics.some((diagnostic) => diagnostic.level === 'error');
}

export interface WorkflowRuntimeValidationResult {
  readonly workflow: ReturnType<typeof loadWorkflowForRuntimeValidation>;
  readonly runtimeEnvironment: ReturnType<typeof resolveAuxiliaryRuntimeEnvironment>;
  readonly companionReviewMode: CompanionReviewMode;
}

export function validateWorkflowRuntimeContract(
  report: WorkflowDoctorReport,
  target: WorkflowDoctorTarget,
  projectDir: string,
  selectorOverrides: SelectorProviderOverrides | undefined,
): WorkflowRuntimeValidationResult | undefined {
  if (reportHasErrors(report)) {
    return undefined;
  }

  let workflow: ReturnType<typeof loadWorkflowForRuntimeValidation> | undefined;
  try {
    workflow = loadWorkflowForRuntimeValidation(target, projectDir);
    const runtimeEnvironment = resolveAuxiliaryRuntimeEnvironment(projectDir, workflow);
    const env = runtimeEnvironment.providerEnvironment;
    resolveWorkflowSelector(workflow, {
      projectCwd: projectDir,
      lookupCwd: target.lookupCwd ?? projectDir,
      overrides: selectorOverrides,
      companionEnabled: runtimeEnvironment.companionEnabled,
      providerEnvironment: env,
      providerConfigMode: runtimeEnvironment.providerConfigMode,
    });
    // Validate provider/model/personaProviders/providerRouting/autoRouting through the same
    // compiled bundle as execution and preview, so a runtime-v1 environment validates the
    // runtime.yaml `profiles.default` resolution (and a mixed configuration fails fast here too).
    if (runtimeEnvironment.companionEnabled) {
      resolveWorkflowCompanions(workflow, env, {
        projectCwd: projectDir,
        lookupCwd: target.lookupCwd ?? projectDir,
      });
    }
    validateWorkflowCallContracts(workflow, projectDir, target.lookupCwd ?? projectDir);
    validateWorkflowConfig(workflow, {
      projectCwd: projectDir,
      provider: env.provider,
      model: env.model,
      personaProviders: env.personaProviders,
      providerRouting: env.providerRouting,
      autoRouting: env.autoRouting,
      providerRoutingTagConflictPolicy: env.tagConflictPolicy,
      ...(env.internalAgents === undefined ? {} : { internalAgentSeats: env.internalAgents }),
      workflowCallResolver: () => null,
    });
    warnOnUnproducibleReportReferences(report, workflow, target, projectDir);
    return {
      workflow,
      runtimeEnvironment,
      companionReviewMode: runtimeEnvironment.companionReviewMode,
    };
  } catch (validationError) {
    const translatedError = workflow === undefined
      ? validationError
      : translateWorkflowConfigError(workflow, validationError);
    report.diagnostics.push({
      level: 'error',
      message: getErrorMessage(translatedError),
    });
    return undefined;
  }
}

export async function doctorWorkflowCommand(
  targets: string[],
  projectDir: string,
  selectorOverrides?: SelectorProviderOverrides,
): Promise<void> {
  const resolvedTargets = resolveWorkflowDoctorTargets(targets, projectDir);
  if (resolvedTargets.length === 0) {
    throw new Error('No workflow files found to validate');
  }

  let hasErrors = false;
  for (const target of resolvedTargets) {
    const { filePath, lookupCwd, source } = target;
    const report = inspectWorkflowFile(filePath, projectDir, { lookupCwd, source });
    const validation = validateWorkflowRuntimeContract(report, target, projectDir, selectorOverrides);
    if (validation !== undefined && report.diagnostics.length === 0) {
      success(
        `Workflow OK: ${sanitizeTerminalText(filePath)} `
        + `(Companion review mode: ${validation.companionReviewMode})`,
      );
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
