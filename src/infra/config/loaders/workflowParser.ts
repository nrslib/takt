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
): WorkflowConfig {
  const parsed = WorkflowConfigRawSchema.parse(raw);
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
    undefined,
    parsed.workflow_config?.provider_options,
  );
  if (context?.projectDir && isPathSafe(context.projectDir, workflowDir)) {
    validateProjectWorkflowTrustBoundaryForSteps(parsed.steps, workflowPath, context.projectDir);
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
    schemas: parsed.schemas,
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
