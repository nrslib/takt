import { describe, expect, it } from 'vitest';
import type { PartDefinition, PieceMovement } from '../core/models/types.js';
import { createPartMovement } from '../core/piece/engine/team-leader-common.js';

describe('createPartMovement', () => {
  it('uses step.providerOptions.claude.allowedTools when part_allowed_tools is omitted', () => {
    // Given
    const step: PieceMovement = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'Coder',
      instructionTemplate: 'do work',
      passPreviousResponse: false,
      providerOptions: {
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash'],
        },
      },
      teamLeader: {
        persona: 'leader',
        maxParts: 3,
        refillThreshold: 0,
        timeoutMs: 600000,
      },
    };
    const part: PartDefinition = {
      id: 'part-1',
      title: 'API',
      instruction: 'implement api',
    };

    // When
    const partMovement = createPartMovement(step, part);

    // Then
    expect(partMovement.providerOptions?.claude?.allowedTools).toEqual(['Read', 'Edit', 'Bash']);
  });
});
