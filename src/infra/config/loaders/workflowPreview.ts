import type { InteractiveMode, WorkflowConfig, WorkflowStep } from '../../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
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

function buildStepPreviews(workflow: WorkflowConfig, maxCount: number, projectCwd: string): StepPreview[] {
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
      allowedTools: step.providerOptions?.claude?.allowedTools ?? [],
      canEdit: step.edit === true,
    });
    currentName = step.rules?.[0]?.next;
  }

  return previews;
}

function buildFirstStepInfo(workflow: WorkflowConfig, projectCwd: string): FirstStepInfo | undefined {
  const step = workflow.steps.find((candidate) => candidate.name === workflow.initialStep);
  if (!step) return undefined;
  return {
    personaContent: readStepPersona(step, projectCwd),
    personaDisplayName: step.personaDisplayName,
    allowedTools: step.providerOptions?.claude?.allowedTools ?? [],
  };
}

export function getWorkflowDescription(
  identifier: string,
  projectCwd: string,
  previewCount?: number,
): {
  name: string;
  description: string;
  workflowStructure: string;
  stepPreviews: StepPreview[];
  interactiveMode?: InteractiveMode;
  firstStep?: FirstStepInfo;
} {
  const workflow = loadWorkflowByIdentifier(identifier, projectCwd);
  if (!workflow) {
    return { name: identifier, description: '', workflowStructure: '', stepPreviews: [] };
  }
  return {
    name: workflow.name,
    description: workflow.description ?? '',
    workflowStructure: buildWorkflowString(workflow.steps),
    stepPreviews: previewCount && previewCount > 0 ? buildStepPreviews(workflow, previewCount, projectCwd) : [],
    interactiveMode: workflow.interactiveMode,
    firstStep: buildFirstStepInfo(workflow, projectCwd),
  };
}
