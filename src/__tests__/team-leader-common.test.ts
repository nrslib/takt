import { describe, expect, it } from 'vitest';
import type { PartDefinition, WorkflowStep } from '../core/models/types.js';
import { createPartStep } from '../core/workflow/engine/team-leader-common.js';

describe('createPartStep', () => {
  it('uses step.providerOptions.claude.allowedTools when part_allowed_tools is omitted', () => {
    // Given
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'Coder',
      instruction: 'do work',
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
        timeoutMs: 900000,
      },
    };
    const part: PartDefinition = {
      id: 'part-1',
      title: 'API',
      instruction: 'implement api',
    };

    // When
    const partStep = createPartStep(step, part);

    // Then
    expect(partStep.providerOptions?.claude?.allowedTools).toEqual(['Read', 'Edit', 'Bash']);
  });

  it('keeps part personaDisplayName aligned with the part persona for personaProviders lookup', () => {
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'do work',
      passPreviousResponse: false,
      teamLeader: {
        persona: 'leader',
        maxParts: 3,
        refillThreshold: 0,
        timeoutMs: 600000,
        partPersona: 'coder',
      },
    };
    const part: PartDefinition = {
      id: 'part-1',
      title: 'API',
      instruction: 'implement api',
    };

    const partStep = createPartStep(step, part);

    expect(partStep.name).toBe('implement.part-1');
    expect(partStep.persona).toBe('coder');
    expect(partStep.personaDisplayName).toBe('coder');
  });
});
