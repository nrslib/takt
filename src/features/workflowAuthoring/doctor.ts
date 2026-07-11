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
    warnOnMissingProvisionalRouting(report, workflow);
  } catch (validationError) {
    report.diagnostics.push({
      level: 'error',
      message: getErrorMessage(validationError),
    });
  }
}

/**
 * v2 梯子設計への移行警告: run-level の invalid_manager_output（旧: 迂回ルールの
 * 自動選択）は廃止され、manager の壊れた応答・意味不明な raw は gate-blocking な
 * provisional finding として台帳に着地する。finding_contract を使う workflow が
 * findings.provisional.count を一切参照していない場合、provisional 残存時に
 * COMPLETE がエンジン最終不変条件で abort する（旧 rules 構成のままだと
 * needs_fix 等の自動迂回は発火しない）ため、移行を促す警告を出す。
 */
function warnOnMissingProvisionalRouting(
  report: WorkflowDoctorReport,
  workflow: ReturnType<typeof loadWorkflowForRuntimeValidation>,
): void {
  if (workflow.findingContract === undefined) {
    return;
  }
  const referencesProvisional = workflow.steps.some((step) => (
    (step.rules ?? []).some((rule) => rule.condition.includes('findings.provisional'))
  ));
  if (referencesProvisional) {
    return;
  }
  report.diagnostics.push({
    level: 'warning',
    message: 'finding_contract workflow has no rule routing on findings.provisional.count. '
      + 'In the v2 raw-finding ladder, invalid manager output no longer auto-selects a needs_fix/need_replan detour rule; '
      + 'undeterminable observations land as gate-blocking provisional findings instead, and a transition to COMPLETE '
      + 'while any provisional finding is open aborts the workflow. '
      + 'Add a rule such as `when(findings.provisional.count > 0 && findings.conflicts.count == 0) -> <replan step>` before your COMPLETE rule.',
  });
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
