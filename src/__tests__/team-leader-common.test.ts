import { describe, expect, it } from 'vitest';
import type { PartDefinition, WorkflowStep } from '../core/models/types.js';
import { createPartStep, createTeamLeaderPlanningStep } from '../core/workflow/engine/team-leader-common.js';
import {
  summarizePartResultForFeedback,
  TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS,
} from '../core/workflow/engine/team-leader-part-report.js';
import {
  resolveDirectStepProviderOptions,
  resolveStepCapabilityProviderOptions,
} from '../infra/config/providerOptions.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { makeInstructionContext } from './test-helpers.js';

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

  it('keeps engine-owned providerOptions intact so part option resolution stays in OptionsBuilder', () => {
    // Given
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'Coder',
      instruction: 'do work',
      passPreviousResponse: false,
      engineSynthesized: true,
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

  it('should carry engine and capability provider options when creating a part step', () => {
    // 通常 workflow step に provider execution options は存在しない。
    // ただし engine が合成した part step と capabilities の options は保持する。
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'Coder',
      instruction: 'do work',
      passPreviousResponse: false,
      engineSynthesized: true,
      providerOptions: { codex: { networkAccess: true } },
      capabilityProviderOptions: { claude: { allowedTools: ['Read'] } },
      teamLeader: {
        persona: 'leader',
        maxConcurrency: 3,
        timeoutMs: 900000,
      },
    };

    const partStep = createPartStep(step, { id: 'part-1', title: 'API', instruction: 'implement api' });

    expect(resolveDirectStepProviderOptions(partStep)).toEqual({ codex: { networkAccess: true } });
    expect(resolveStepCapabilityProviderOptions(partStep)).toEqual({ claude: { allowedTools: ['Read'] } });
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

  it('inherits parent facets while keeping members isolated from previous responses', () => {
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'decompose work',
      passPreviousResponse: true,
      policyContents: [{ content: 'policy content' }],
      knowledgeContents: [{ content: 'knowledge content' }],
      qualityGates: ['run focused tests'],
      teamLeader: {
        maxConcurrency: 1,
        timeoutMs: 900000,
      },
    };

    const partStep = createPartStep(step, {
      id: 'part-1',
      title: 'API',
      instruction: 'implement api',
    });

    expect(partStep).toEqual(expect.objectContaining({
      session: 'refresh',
      instruction: 'implement api',
      passPreviousResponse: false,
      policyContents: [{ content: 'policy content' }],
      knowledgeContents: [{ content: 'knowledge content' }],
      qualityGates: ['run focused tests'],
    }));

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
        timeoutMs: 900000,
      },
    };

    const planningStep = createTeamLeaderPlanningStep(step);

    expect(planningStep.providerRoutingPersonaKey).toBe('coder');
  });

  it('bounds the previous state output for the parent planning prompt', () => {
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Plan from {previous_response}',
      passPreviousResponse: true,
      teamLeader: {
        maxConcurrency: 2,
        timeoutMs: 900000,
      },
    };
    const previousOutput = `${'a'.repeat(2500)}\nTAIL_FINDING: preserve this`;
    const context = makeInstructionContext({
      previousOutput: {
        persona: 'review',
        status: 'done',
        content: previousOutput,
        timestamp: new Date(),
      },
    });

    const parentPrompt = new InstructionBuilder(createTeamLeaderPlanningStep(step), context).build();
    const memberPrompt = new InstructionBuilder(createPartStep(step, {
      id: 'part-1',
      title: 'Implementation',
      instruction: 'Implement the change',
    }), context).build();

    expect(parentPrompt).not.toContain('TAIL_FINDING: preserve this');
    expect(parentPrompt).not.toContain('a'.repeat(2500));
    expect(memberPrompt).not.toContain('TAIL_FINDING: preserve this');
  });
});

describe('summarizePartResultForFeedback', () => {
  it('returns the full content when it does not exceed the max chars', () => {
    const content = 'x'.repeat(TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS);
    expect(summarizePartResultForFeedback(content)).toBe(content);
  });

  it('truncates to the max chars and appends a truncation notice when content exceeds the limit', () => {
    const content = 'y'.repeat(TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS + 1234);
    const result = summarizePartResultForFeedback(content);
    expect(result.length).toBeLessThan(content.length);
    expect(result.startsWith('y'.repeat(TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS))).toBe(true);
    expect(result).toContain('[truncated: 1234 chars; see report file for full content]');
  });
});
