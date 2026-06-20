import { describe, expect, it } from 'vitest';
import type { PartDefinition, WorkflowStep } from '../core/models/types.js';
import { createPartStep, createTeamLeaderPlanningStep } from '../core/workflow/engine/team-leader-common.js';

describe('createPartStep', () => {
  it('Given teamLeader.partTags, When creating a part step, Then part tags replace parent tags', () => {
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'leader',
      personaDisplayName: 'leader',
      tags: ['leader'],
      instruction: 'decompose work',
      passPreviousResponse: false,
      teamLeader: {
        persona: 'leader',
        maxConcurrency: 3,
        maxTotalParts: 20,
        refillThreshold: 0,
        timeoutMs: 900000,
        partTags: ['coding'],
      },
    };
    const part: PartDefinition = {
      id: 'part-1',
      title: 'API',
      instruction: 'implement api',
    };

    const partStep = createPartStep(step, part);

    expect(partStep.tags).toEqual(['coding']);
  });

  it('Given no teamLeader.partTags, When creating a part step, Then parent tags are inherited', () => {
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'leader',
      personaDisplayName: 'leader',
      tags: ['leader'],
      instruction: 'decompose work',
      passPreviousResponse: false,
      teamLeader: {
        persona: 'leader',
        maxConcurrency: 3,
        maxTotalParts: 20,
        refillThreshold: 0,
        timeoutMs: 900000,
      },
    };
    const part: PartDefinition = {
      id: 'part-1',
      title: 'API',
      instruction: 'implement api',
    };

    const partStep = createPartStep(step, part);

    expect(partStep.tags).toEqual(['leader']);
  });

  it('keeps parent providerOptions intact so part option resolution stays in OptionsBuilder', () => {
    // Given
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'Coder',
      instruction: 'do work',
      passPreviousResponse: false,
      providerOptions: {
        codex: {
          networkAccess: false,
        },
        opencode: {
          networkAccess: true,
        },
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash'],
          effort: 'medium',
          sandbox: {
            allowUnsandboxedCommands: true,
            excludedCommands: ['./gradlew'],
          },
        },
      },
      teamLeader: {
        persona: 'leader',
        maxConcurrency: 3,
        maxTotalParts: 20,
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
    expect(partStep.providerOptions).toEqual(step.providerOptions);
  });

  it('keeps part personaDisplayName aligned with the part persona for personaProviders lookup', () => {
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'do work',
      allowGitCommit: true,
      passPreviousResponse: false,
      teamLeader: {
        persona: 'leader',
        maxConcurrency: 3,
        maxTotalParts: 20,
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
    expect(partStep.allowGitCommit).toBe(true);
  });
});

describe('createTeamLeaderPlanningStep', () => {
  it('uses team leader persona identity for provider resolution', () => {
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      providerRoutingPersonaKey: 'coder',
      instruction: 'do work',
      passPreviousResponse: false,
      teamLeader: {
        persona: 'lead',
        personaDisplayName: 'lead',
        providerRoutingPersonaKey: 'lead',
        maxConcurrency: 3,
        maxTotalParts: 20,
        refillThreshold: 0,
        timeoutMs: 900000,
      },
    };

    const planningStep = createTeamLeaderPlanningStep(step);

    expect(planningStep).toEqual(expect.objectContaining({
      persona: 'lead',
      personaDisplayName: 'lead',
      providerRoutingPersonaKey: 'lead',
    }));
  });

  it('falls back to parent provider routing persona key when team leader key is unset', () => {
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      providerRoutingPersonaKey: 'coder',
      instruction: 'do work',
      passPreviousResponse: false,
      teamLeader: {
        maxConcurrency: 3,
        maxTotalParts: 20,
        refillThreshold: 0,
        timeoutMs: 900000,
      },
    };

    const planningStep = createTeamLeaderPlanningStep(step);

    expect(planningStep.providerRoutingPersonaKey).toBe('coder');
  });
});
