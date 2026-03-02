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

  return {
    name: `${step.name}.${part.id}`,
    description: part.title,
    persona: step.teamLeader.partPersona ?? step.persona,
    personaPath: step.teamLeader.partPersonaPath ?? step.personaPath,
    personaDisplayName: `${step.name}:${part.id}`,
    session: 'refresh',
    allowedTools: step.teamLeader.partAllowedTools ?? step.allowedTools,
    mcpServers: step.mcpServers,
    provider: step.provider,
    model: step.model,
    requiredPermissionMode: step.teamLeader.partPermissionMode ?? step.requiredPermissionMode,
    edit: step.teamLeader.partEdit ?? step.edit,
    instructionTemplate: part.instruction,
    passPreviousResponse: false,
  };
}
