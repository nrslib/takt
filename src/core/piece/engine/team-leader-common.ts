import type {
  PartDefinition,
  PartResult,
  PieceMovement,
} from '../../models/types.js';

export function summarizeParts(parts: PartDefinition[]): Array<{ id: string; title: string }> {
  return parts.map((part) => ({ id: part.id, title: part.title }));
}

export function resolvePartErrorDetail(partResult: PartResult): string {
  const detail = partResult.response.error ?? partResult.response.content;
  if (!detail) {
    throw new Error(`Part "${partResult.part.id}" failed without error detail`);
  }
  return detail;
}

export function createPartMovement(step: PieceMovement, part: PartDefinition): PieceMovement {
  if (!step.teamLeader) {
    throw new Error(`Movement "${step.name}" has no teamLeader configuration`);
  }

  const partPersona = step.teamLeader.partPersona ?? step.persona;
  const partPersonaPath = step.teamLeader.partPersonaPath ?? step.personaPath;
  const partPersonaDisplayName = partPersona ?? step.personaDisplayName ?? `${step.name}:${part.id}`;
  const partAllowedTools = step.teamLeader.partAllowedTools ?? step.providerOptions?.claude?.allowedTools;
  const partProviderOptions = partAllowedTools
    ? {
        ...step.providerOptions,
        claude: {
          ...step.providerOptions?.claude,
          allowedTools: partAllowedTools,
        },
      }
    : step.providerOptions;

  return {
    name: `${step.name}.${part.id}`,
    description: part.title,
    persona: partPersona,
    personaPath: partPersonaPath,
    personaDisplayName: partPersonaDisplayName,
    session: 'refresh',
    providerOptions: partProviderOptions,
    mcpServers: step.mcpServers,
    provider: step.provider,
    model: step.model,
    requiredPermissionMode: step.teamLeader.partPermissionMode ?? step.requiredPermissionMode,
    edit: step.teamLeader.partEdit ?? step.edit,
    allowGitCommit: step.allowGitCommit,
    instruction: part.instruction,
    passPreviousResponse: false,
  };
}
