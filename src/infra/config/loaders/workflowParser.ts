/**
 * Workflow YAML parsing and normalization.
 */

import type { WorkflowArpeggioConfig, WorkflowMcpServersConfig, WorkflowOverrides, WorkflowRuntimePrepareConfig } from '../../../core/models/config-types.js';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type { WorkflowConfig, WorkflowStep } from '../../../core/models/index.js';
import { resolveLoopMonitorJudgeProviderModel, resolveStepProviderModel } from '../../../core/workflow/provider-resolution.js';
import { validateProviderModelCompatibility } from '../../../core/workflow/provider-model-compatibility.js';
import { isPathSafe } from '../paths.js';
import { normalizeRuntime } from '../configNormalizers.js';
import type { FacetResolutionContext, WorkflowSections } from './resource-resolver.js';
import { resolveSectionMap } from './resource-resolver.js';
import {
  validateWorkflowRuntimePrepare,
} from './workflowNormalizationPolicies.js';
import { normalizeLoopMonitors } from './workflowLoopMonitorNormalizer.js';
import { normalizeProviderReference, normalizeStepFromRaw } from './workflowStepNormalizer.js';
import { validateProjectWorkflowTrustBoundaryForSteps } from './workflowTrustBoundary.js';
import { getWorkflowPathTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';

function validateCallableSubworkflowProviders(
  parsed: ReturnType<typeof WorkflowConfigRawSchema.parse>,
): void {
  if (parsed.subworkflow?.callable !== true) {
    return;
  }

  if (
    parsed.workflow_config?.provider !== undefined
    || parsed.workflow_config?.model !== undefined
    || parsed.workflow_config?.provider_options !== undefined
  ) {
    throw new Error('Callable subworkflow must not declare workflow-level provider settings');
  }

  const stack = [...parsed.steps];
  while (stack.length > 0) {
    const step = stack.pop()!;
    const hasStepProviderSettings = step.provider !== undefined
      || step.model !== undefined
      || step.provider_options !== undefined;
    const hasWorkflowCallOverrides = step.overrides?.provider !== undefined
      || step.overrides?.model !== undefined
      || step.overrides?.provider_options !== undefined;
    if (hasStepProviderSettings || hasWorkflowCallOverrides) {
      throw new Error(`Callable subworkflow step "${step.name}" must not declare provider settings`);
    }
    for (const substep of step.parallel ?? []) {
      stack.push(substep);
    }
  }

  for (const monitor of parsed.loop_monitors ?? []) {
    const hasJudgeProviderSettings = monitor.judge.provider !== undefined
      || monitor.judge.model !== undefined;
    if (hasJudgeProviderSettings) {
      throw new Error(
        `Callable subworkflow loop monitor judge for cycle "${monitor.cycle.join(' -> ')}" must not declare provider settings`,
      );
    }
  }
}

export function normalizeWorkflowConfig(
  raw: unknown,
  workflowDir: string,
  context?: FacetResolutionContext,
  projectOverrides?: WorkflowOverrides,
  globalOverrides?: WorkflowOverrides,
  workflowRuntimePreparePolicy?: WorkflowRuntimePrepareConfig,
  workflowArpeggioPolicy?: WorkflowArpeggioConfig,
  workflowMcpServersPolicy?: WorkflowMcpServersConfig,
  workflowPath = workflowDir,
  trustInfo?: WorkflowTrustInfo,
): WorkflowConfig {
  const parsed = WorkflowConfigRawSchema.parse(raw);
  validateCallableSubworkflowProviders(parsed);
  const sections: WorkflowSections = {
    personas: parsed.personas,
    resolvedPolicies: resolveSectionMap(parsed.policies, workflowDir),
    resolvedKnowledge: resolveSectionMap(parsed.knowledge, workflowDir),
    resolvedInstructions: resolveSectionMap(parsed.instructions, workflowDir),
    resolvedReportFormats: resolveSectionMap(parsed.report_formats, workflowDir),
  };

  const workflowRuntime = normalizeRuntime(parsed.workflow_config?.runtime);
  validateWorkflowRuntimePrepare(workflowRuntime, workflowRuntimePreparePolicy);
  const normalizedWorkflowProvider = normalizeProviderReference(
    parsed.workflow_config?.provider,
    parsed.workflow_config?.model,
    parsed.workflow_config?.provider_options,
  );
  if (trustInfo?.isProjectTrustRoot) {
    validateProjectWorkflowTrustBoundaryForSteps(parsed.steps, workflowPath, trustInfo);
  } else if (context?.projectDir && isPathSafe(context.projectDir, workflowDir)) {
    validateProjectWorkflowTrustBoundaryForSteps(
      parsed.steps,
      workflowPath,
      getWorkflowPathTrustInfo(workflowPath, context.projectDir),
    );
  }

  const steps: WorkflowStep[] = parsed.steps.map((step) =>
    normalizeStepFromRaw(
      step,
      workflowDir,
      sections,
      parsed.schemas,
      normalizedWorkflowProvider.provider,
      normalizedWorkflowProvider.model,
      normalizedWorkflowProvider.providerOptions,
      context,
      projectOverrides,
      globalOverrides,
      workflowArpeggioPolicy,
      workflowMcpServersPolicy,
    ),
  );

  const loopMonitors = normalizeLoopMonitors(parsed.loop_monitors, workflowDir, sections, context);
  for (const monitor of loopMonitors ?? []) {
    const triggeringStep = steps.find((step) => step.name === monitor.cycle[monitor.cycle.length - 1]);
    if (!triggeringStep) {
      continue;
    }
    const triggeringProviderInfo = resolveStepProviderModel({
      step: triggeringStep,
      provider: normalizedWorkflowProvider.provider,
      model: normalizedWorkflowProvider.model,
    });
    const judgeProviderInfo = resolveLoopMonitorJudgeProviderModel({
      judge: monitor.judge,
      triggeringStep,
      provider: triggeringProviderInfo.provider,
      model: triggeringProviderInfo.model,
    });
    validateProviderModelCompatibility(
      judgeProviderInfo.provider,
      judgeProviderInfo.model,
      {
        modelFieldName: 'Configuration error: loop_monitors.judge.model',
      },
    );
  }

  return {
    name: parsed.name,
    description: parsed.description,
    subworkflow: parsed.subworkflow,
    schemas: parsed.schemas,
    provider: normalizedWorkflowProvider.provider,
    model: normalizedWorkflowProvider.model,
    providerOptions: normalizedWorkflowProvider.providerOptions,
    runtime: workflowRuntime,
    personas: parsed.personas,
    policies: sections.resolvedPolicies,
    knowledge: sections.resolvedKnowledge,
    instructions: sections.resolvedInstructions,
    reportFormats: sections.resolvedReportFormats,
    steps,
    initialStep: parsed.initial_step ?? steps[0]!.name,
    maxSteps: parsed.max_steps,
    loopMonitors,
    interactiveMode: parsed.interactive_mode,
  };
}
