/**
 * Workflow YAML parsing and normalization.
 */

import type { WorkflowArpeggioConfig, WorkflowMcpServersConfig, WorkflowOverrides, WorkflowRuntimePrepareConfig } from '../../../core/models/config-types.js';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type { WorkflowConfig, WorkflowStep } from '../../../core/models/index.js';
import { normalizeRuntime } from '../configNormalizers.js';
import type { FacetResolutionContext, WorkflowSections } from './resource-resolver.js';
import { resolveSectionMap } from './resource-resolver.js';
import {
  validateWorkflowRuntimePrepare,
} from './workflowNormalizationPolicies.js';
import { normalizeLoopMonitors } from './workflowLoopMonitorNormalizer.js';
import { normalizeProviderReference, normalizeStepFromRaw } from './workflowStepNormalizer.js';

export function normalizeWorkflowConfig(
  raw: unknown,
  workflowDir: string,
  context?: FacetResolutionContext,
  projectOverrides?: WorkflowOverrides,
  globalOverrides?: WorkflowOverrides,
  workflowRuntimePreparePolicy?: WorkflowRuntimePrepareConfig,
  workflowArpeggioPolicy?: WorkflowArpeggioConfig,
  workflowMcpServersPolicy?: WorkflowMcpServersConfig,
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

  const steps: WorkflowStep[] = parsed.steps.map((step) =>
    normalizeStepFromRaw(
      step,
      workflowDir,
      sections,
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

  return {
    name: parsed.name,
    description: parsed.description,
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
    loopMonitors: normalizeLoopMonitors(parsed.loop_monitors, workflowDir, sections, context),
    interactiveMode: parsed.interactive_mode,
  };
}
