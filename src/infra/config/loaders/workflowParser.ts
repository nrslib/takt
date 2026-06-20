/**
 * Workflow YAML parsing and normalization.
 */

import type { WorkflowArpeggioConfig, WorkflowCommandGatesConfig, WorkflowMcpServersConfig, WorkflowOverrides, WorkflowRuntimePrepareConfig } from '../../../core/models/config-types.js';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type {
  FindingContractConfig,
  LoopMonitorConfig,
  WorkflowConfig,
  WorkflowStep,
  WorkflowSubworkflowConfig,
} from '../../../core/models/index.js';
import { resolveLoopMonitorJudgeProviderModel, resolveStepProviderModel } from '../../../core/workflow/provider-resolution.js';
import { validateProviderModelCompatibility } from '../../../core/workflow/provider-model-compatibility.js';
import { isFindingsCondition } from '../../../core/workflow/evaluation/rule-utils.js';
import { normalizeRateLimitFallback, normalizeRuntime } from '../configNormalizers.js';
import type { FacetResolutionContext, WorkflowSections } from './resource-resolver.js';
import {
  extractPersonaDisplayName,
  resolvePersona,
  resolveRefToContent,
  resolveSectionMapWithSource,
  unwrapResolvedSectionMap,
} from './resource-resolver.js';
import {
  validateWorkflowRuntimePrepare,
  validateWorkflowCommandGates,
} from './workflowNormalizationPolicies.js';
import { normalizeLoopMonitors } from './workflowLoopMonitorNormalizer.js';
import { normalizeProviderReference, normalizeStepFromRaw } from './workflowStepNormalizer.js';
import {
  expandCallableSubworkflowRaw,
  type WorkflowCallArgResolutionPolicy,
} from './workflowCallableArgResolver.js';
import { prepareCallableSubworkflowDiscoveryArgs } from './workflowCallableDiscoveryArgs.js';

function normalizeSubworkflowConfig(
  raw: ReturnType<typeof WorkflowConfigRawSchema.parse>['subworkflow'],
): WorkflowSubworkflowConfig | undefined {
  if (!raw) {
    return undefined;
  }

  return {
    callable: raw.callable,
    visibility: raw.visibility,
    returns: raw.returns,
    params: raw.params
      ? Object.fromEntries(
        Object.entries(raw.params).map(([name, param]) => [
          name,
          {
            type: param.type,
            facetKind: param.facet_kind,
            default: param.default,
          },
        ]),
      )
      : undefined,
  };
}

function normalizeFindingContractConfig(
  raw: ReturnType<typeof WorkflowConfigRawSchema.parse>['finding_contract'],
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
): FindingContractConfig | undefined {
  if (!raw) {
    return undefined;
  }

  const { personaSpec, personaPath } = resolvePersona(raw.manager.persona, sections, workflowDir, context);
  const instruction = resolveRefToContent(
    raw.manager.instruction,
    sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
    workflowDir,
    'instructions',
    context,
  );
  const outputContract = resolveRefToContent(
    raw.manager.output_contract,
    sections.resolvedReportFormatsWithSource ?? sections.resolvedReportFormats,
    workflowDir,
    'output-contracts',
    context,
  );
  if (!personaSpec) {
    throw new Error('Configuration error: finding_contract.manager.persona is required');
  }
  if (!instruction) {
    throw new Error(`Configuration error: failed to resolve finding_contract.manager.instruction "${raw.manager.instruction}"`);
  }
  if (!outputContract) {
    throw new Error(`Configuration error: failed to resolve finding_contract.manager.output_contract "${raw.manager.output_contract}"`);
  }

  return {
    ledgerPath: raw.ledger_path,
    rawFindingsPath: raw.raw_findings_path,
    manager: {
      persona: personaSpec,
      personaDisplayName: personaPath ? extractPersonaDisplayName(personaPath) : personaSpec,
      ...(personaPath ? { personaPath } : {}),
      instruction,
      outputContract,
    },
  };
}

function validateFindingsRulesRequireContract(
  steps: readonly WorkflowStep[],
  loopMonitors: readonly LoopMonitorConfig[] | undefined,
  findingContract: FindingContractConfig | undefined,
): void {
  if (findingContract) {
    return;
  }

  for (const step of steps) {
    for (const rule of step.rules ?? []) {
      if (rule.isAiCondition || !isFindingsCondition(rule.condition)) {
        continue;
      }
      throw new Error(`Configuration error: step "${step.name}" uses findings.* rule but finding_contract is not configured`);
    }
    for (const subStep of step.parallel ?? []) {
      for (const rule of subStep.rules ?? []) {
        if (rule.isAiCondition || !isFindingsCondition(rule.condition)) {
          continue;
        }
        throw new Error(
          `Configuration error: parallel sub-step "${subStep.name}" in step "${step.name}" uses findings.* rule but finding_contract is not configured`,
        );
      }
    }
  }

  for (const monitor of loopMonitors ?? []) {
    for (const rule of monitor.judge.rules) {
      if (!isFindingsCondition(rule.condition)) {
        continue;
      }
      throw new Error('Configuration error: loop_monitor judge uses findings.* rule but finding_contract is not configured');
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
  callableArgs?: Record<string, string | string[]>,
  callableArgPolicy?: WorkflowCallArgResolutionPolicy,
  callableArgMode: 'runtime' | 'discovery' = 'runtime',
  workflowCommandGatesPolicy?: WorkflowCommandGatesConfig,
): WorkflowConfig {
  const parsedRaw = WorkflowConfigRawSchema.parse(raw);
  const callableDiscovery = callableArgMode === 'discovery'
    ? prepareCallableSubworkflowDiscoveryArgs(parsedRaw)
    : { raw: parsedRaw, callableArgs };
  const parsed = expandCallableSubworkflowRaw(
    callableDiscovery.raw,
    {
      args: callableDiscovery.callableArgs ?? callableArgs,
      argPolicy: callableArgPolicy,
      workflowDir,
      context,
    },
  );
  const resolvedPoliciesWithSource = resolveSectionMapWithSource(parsed.policies, workflowDir, 'policies');
  const resolvedKnowledgeWithSource = resolveSectionMapWithSource(parsed.knowledge, workflowDir, 'knowledge');
  const resolvedInstructionsWithSource = resolveSectionMapWithSource(parsed.instructions, workflowDir, 'instructions');
  const resolvedReportFormatsWithSource = resolveSectionMapWithSource(parsed.report_formats, workflowDir, 'output-contracts');
  const sections: WorkflowSections = {
    personas: parsed.personas,
    resolvedPolicies: unwrapResolvedSectionMap(resolvedPoliciesWithSource),
    resolvedPoliciesWithSource,
    resolvedKnowledge: unwrapResolvedSectionMap(resolvedKnowledgeWithSource),
    resolvedKnowledgeWithSource,
    resolvedInstructions: unwrapResolvedSectionMap(resolvedInstructionsWithSource),
    resolvedInstructionsWithSource,
    resolvedReportFormats: unwrapResolvedSectionMap(resolvedReportFormatsWithSource),
    resolvedReportFormatsWithSource,
  };

  const workflowRuntime = normalizeRuntime(parsed.workflow_config?.runtime);
  validateWorkflowRuntimePrepare(workflowRuntime, workflowRuntimePreparePolicy);
  validateWorkflowCommandGates(parsed.steps, workflowCommandGatesPolicy);
  const normalizedWorkflowProvider = normalizeProviderReference(
    parsed.workflow_config?.provider,
    parsed.workflow_config?.model,
    parsed.workflow_config?.provider_options,
    workflowDir,
    context,
  );
  const steps: WorkflowStep[] = parsed.steps.map((step) =>
    normalizeStepFromRaw(
      step,
      workflowDir,
      sections,
      parsed.schemas,
      normalizedWorkflowProvider.provider,
      normalizedWorkflowProvider.model,
      undefined,
      normalizedWorkflowProvider.providerOptions,
      undefined,
      true,
      true,
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

  const findingContract = normalizeFindingContractConfig(parsed.finding_contract, workflowDir, sections, context);
  validateFindingsRulesRequireContract(steps, loopMonitors, findingContract);

  return {
    name: parsed.name,
    description: parsed.description,
    subworkflow: normalizeSubworkflowConfig(parsed.subworkflow),
    findingContract,
    schemas: parsed.schemas,
    provider: normalizedWorkflowProvider.provider,
    model: normalizedWorkflowProvider.model,
    providerOptions: normalizedWorkflowProvider.providerOptions,
    rateLimitFallback: normalizeRateLimitFallback(parsed.rate_limit_fallback),
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
