import type {
  PartDefinition,
  PartResult,
  WorkflowStep,
} from '../../models/types.js';
import { formatAgentFailure } from '../../../shared/types/agent-failure.js';

export function summarizeParts(parts: PartDefinition[]): Array<{ id: string; title: string }> {
  return parts.map((part) => ({ id: part.id, title: part.title }));
}

export function resolvePartErrorDetail(partResult: PartResult): string {
  const detail = partResult.response.error ?? partResult.response.content;
  if (!detail) {
    throw new Error(`Part "${partResult.part.id}" failed without error detail`);
  }
  if (partResult.response.failureCategory) {
    return formatAgentFailure({
      category: partResult.response.failureCategory,
      reason: detail,
    }, { includeCategoryPrefix: true });
  }
  return detail;
}

export function createPartStep(step: WorkflowStep, part: PartDefinition): WorkflowStep {
  if (!step.teamLeader) {
    throw new Error(`Step "${step.name}" has no teamLeader configuration`);
  }

  const partPersona = step.teamLeader.partPersona ?? step.persona;
  const partPersonaPath = step.teamLeader.partPersonaPath ?? step.personaPath;
  const partPersonaDisplayName = partPersona ?? step.personaDisplayName ?? `${step.name}:${part.id}`;
  const providerRoutingPersonaKey = step.teamLeader.partPersona
    ? step.teamLeader.partPersona
    : step.providerRoutingPersonaKey;

  return {
    name: `${step.name}.${part.id}`,
    description: part.title,
    persona: partPersona,
    personaPath: partPersonaPath,
    personaDisplayName: partPersonaDisplayName,
    providerRoutingPersonaKey,
    tags: step.tags,
    session: 'refresh',
    providerOptions: step.providerOptions,
    ...('directProviderOptions' in step || 'workflowProviderOptions' in step
      ? { directProviderOptions: step.directProviderOptions }
      : {}),
    ...('workflowProviderOptions' in step ? { workflowProviderOptions: step.workflowProviderOptions } : {}),
    mcpServers: step.mcpServers,
    provider: step.provider,
    providerSpecified: step.providerSpecified,
    model: step.model,
    modelSpecified: step.modelSpecified,
    requiredPermissionMode: step.teamLeader.partPermissionMode ?? step.requiredPermissionMode,
    edit: step.teamLeader.partEdit ?? step.edit,
    allowGitCommit: step.allowGitCommit,
    instruction: part.instruction,
    passPreviousResponse: false,
  };
}
