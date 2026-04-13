import type { InteractiveMode, WorkflowConfig, WorkflowStep } from '../../../core/models/index.js';
import type { PersonaProviderEntry } from '../../../core/models/config-types.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import { resolveStepProviderModel } from '../../../core/workflow/provider-resolution.js';
import {
  assertProviderResolvedForCapabilitySensitiveOptions,
  assertProviderSupportsClaudeAllowedTools,
  resolveAllowedToolsForProvider,
} from '../../../core/workflow/engine/engine-provider-options.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import { resolveProviderOptionsWithTrace } from '../resolveConfigValue.js';
import { resolveEffectiveProviderOptions } from '../providerOptions.js';
import { loadPersonaPromptFromPath } from './agentLoader.js';
import { loadWorkflowByIdentifier } from './workflowResolver.js';

const log = createLogger('workflow-preview');

export interface StepPreview {
  name: string;
  personaDisplayName: string;
  personaContent: string;
  instructionContent: string;
  allowedTools: string[];
  canEdit: boolean;
}

export interface FirstStepInfo {
  personaContent: string;
  personaDisplayName: string;
  allowedTools: string[];
}

interface PreviewProviderResolution {
  provider: WorkflowStep['provider'];
  model: WorkflowStep['model'];
  personaProviders: Record<string, PersonaProviderEntry> | undefined;
  providerOptions: StepProviderOptions | undefined;
  providerOptionsSource: ReturnType<typeof resolveProviderOptionsWithTrace>['source'];
  providerOptionsOriginResolver: ReturnType<typeof resolveProviderOptionsWithTrace>['originResolver'];
}

function buildWorkflowString(steps: WorkflowStep[]): string {
  const lines: string[] = [];
  let index = 1;
  for (const step of steps) {
    lines.push(`${index}. ${step.name}${step.description ? ` (${step.description})` : ''}`);
    for (const sub of step.parallel ?? []) {
      lines.push(`   - ${sub.name}${sub.description ? ` (${sub.description})` : ''}`);
    }
    index++;
  }
  return lines.join('\n');
}

function readStepPersona(step: WorkflowStep, projectCwd: string): string {
  if (!step.personaPath) {
    return step.persona ?? '';
  }
  try {
    return loadPersonaPromptFromPath(step.personaPath, projectCwd);
  } catch (error) {
    log.debug('Failed to read persona file', { path: step.personaPath, error: getErrorMessage(error) });
    return '';
  }
}

function resolvePreviewProviderResolution(projectCwd: string): PreviewProviderResolution {
  const {
    provider,
    model,
    personaProviders,
  } = resolveWorkflowConfigValues(projectCwd, ['provider', 'model', 'personaProviders']);
  const {
    value: providerOptions,
    source: providerOptionsSource,
    originResolver: providerOptionsOriginResolver,
  } = resolveProviderOptionsWithTrace(projectCwd);

  return {
    provider,
    model,
    personaProviders,
    providerOptions,
    providerOptionsSource,
    providerOptionsOriginResolver,
  };
}

function resolvePreviewAllowedTools(
  step: WorkflowStep,
  resolution: PreviewProviderResolution,
): string[] {
  const mergedProviderOptions = resolveEffectiveProviderOptions(
    resolution.providerOptionsSource,
    resolution.providerOptionsOriginResolver,
    resolution.providerOptions,
    step.providerOptions,
  );
  const resolvedProvider = resolveStepProviderModel({
    step,
    provider: resolution.provider,
    model: resolution.model,
    personaProviders: resolution.personaProviders,
  }).provider;
  const usesClaudeAllowedTools = (mergedProviderOptions?.claude?.allowedTools?.length ?? 0) > 0;

  assertProviderResolvedForCapabilitySensitiveOptions(resolvedProvider, {
    stepName: step.name,
    usesStructuredOutput: false,
    usesMcpServers: false,
    usesClaudeAllowedTools,
  });
  assertProviderSupportsClaudeAllowedTools(resolvedProvider, mergedProviderOptions);

  return resolveAllowedToolsForProvider(
    mergedProviderOptions,
    step.outputContracts !== undefined && step.outputContracts.length > 0,
    step.edit,
  ) ?? [];
}

function buildStepPreviews(
  workflow: WorkflowConfig,
  maxCount: number,
  projectCwd: string,
  resolution: PreviewProviderResolution,
): StepPreview[] {
  if (maxCount <= 0 || workflow.steps.length === 0) return [];
  const stepMap = new Map(workflow.steps.map((step) => [step.name, step]));
  const previews: StepPreview[] = [];
  const visited = new Set<string>();
  let currentName: string | undefined = workflow.initialStep;

  while (currentName && previews.length < maxCount) {
    if (currentName === 'COMPLETE' || currentName === 'ABORT' || visited.has(currentName)) break;
    visited.add(currentName);
    const step = stepMap.get(currentName);
    if (!step) break;
    previews.push({
      name: step.name,
      personaDisplayName: step.personaDisplayName,
      personaContent: readStepPersona(step, projectCwd),
      instructionContent: step.instruction,
      allowedTools: resolvePreviewAllowedTools(step, resolution),
      canEdit: step.edit === true,
    });
    currentName = step.rules?.[0]?.next;
  }

  return previews;
}

function buildFirstStepInfo(
  workflow: WorkflowConfig,
  projectCwd: string,
  resolution: PreviewProviderResolution,
): FirstStepInfo | undefined {
  const step = workflow.steps.find((candidate) => candidate.name === workflow.initialStep);
  if (!step) return undefined;
  return {
    personaContent: readStepPersona(step, projectCwd),
    personaDisplayName: step.personaDisplayName,
    allowedTools: resolvePreviewAllowedTools(step, resolution),
  };
}

export function getWorkflowDescription(
  identifier: string,
  projectCwd: string,
  previewCount?: number,
  lookupCwd = projectCwd,
): {
  name: string;
  description: string;
  workflowStructure: string;
  stepPreviews: StepPreview[];
  interactiveMode?: InteractiveMode;
  firstStep?: FirstStepInfo;
} {
  const workflow = loadWorkflowByIdentifier(identifier, projectCwd, { lookupCwd });
  if (!workflow) {
    return { name: identifier, description: '', workflowStructure: '', stepPreviews: [] };
  }
  const resolution = resolvePreviewProviderResolution(projectCwd);
  return {
    name: workflow.name,
    description: workflow.description ?? '',
    workflowStructure: buildWorkflowString(workflow.steps),
    stepPreviews: previewCount && previewCount > 0
      ? buildStepPreviews(workflow, previewCount, projectCwd, resolution)
      : [],
    interactiveMode: workflow.interactiveMode,
    firstStep: buildFirstStepInfo(workflow, projectCwd, resolution),
  };
}
