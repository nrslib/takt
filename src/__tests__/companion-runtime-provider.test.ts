import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import {
  compileLegacyProviderEnvironment,
  compileRuntimeProviderEnvironment,
} from '../infra/config/runtime-provider/environment.js';
import { RuntimeProviderFileSchema } from '../infra/config/runtime-provider/schema.js';
import { resolveWorkflowCompanions } from '../infra/config/workflowCompanionResolution.js';

function companionWorkflow(): WorkflowConfig {
  return {
    name: 'companion-runtime',
    initialStep: 'implement',
    maxSteps: 4,
    companions: {
      'security-reviewer': {
        name: 'security-reviewer',
        description: 'security review',
        instruction: 'review WIP',
        intervalMs: 15_000,
      },
      'design-reviewer': {
        name: 'design-reviewer',
        description: 'design review',
        instruction: 'review WIP',
        intervalMs: 15_000,
      },
    },
    steps: [{
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      edit: true,
      instruction: 'implement',
      passPreviousResponse: true,
      companion: { fixed: ['security-reviewer'], pool: ['design-reviewer'] },
      rules: [],
    }],
  } as WorkflowConfig;
}

describe('CT-COMP-03 runtime-only companion provider resolution', () => {
  it('should accept companions as the fifth strict provider target map', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-test' } },
        targets: {
          companions: { 'security-reviewer': { profile: 'default' } },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('should resolve an explicit companion target before runtime defaults', () => {
    const environment = compileRuntimeProviderEnvironment({
      defaults: { profile: 'default' },
      profiles: {
        default: { provider: 'codex', model: 'default-model' },
        security: { provider: 'claude-sdk', model: 'security-model' },
      },
      targets: {
        companions: { 'security-reviewer': { profile: 'security' } },
      },
    });

    const resolved = resolveWorkflowCompanions(companionWorkflow(), environment);

    expect(resolved.get('security-reviewer')).toMatchObject({
      provider: 'claude-sdk',
      model: 'security-model',
    });
    expect(resolved.get('design-reviewer')).toMatchObject({
      provider: 'codex',
      model: 'default-model',
    });
  });

  it('should resolve companion targets referenced only by a workflow_call child', () => {
    const child = companionWorkflow();
    const parent = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 1,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'companion-runtime',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    } as WorkflowConfig;
    const environment = compileRuntimeProviderEnvironment({
      defaults: { profile: 'default' },
      profiles: { default: { provider: 'codex', model: 'default-model' } },
    });

    const resolved = resolveWorkflowCompanions(parent, environment, {
      projectCwd: '/project',
      lookupCwd: '/worktree',
      workflowCallResolver: () => child,
    });

    expect([...resolved.keys()].sort()).toEqual(['design-reviewer', 'security-reviewer']);
  });

  it('should not resolve a workflow_call child unreachable from the initial step', () => {
    const parent = {
      name: 'parent',
      initialStep: 'complete-directly',
      maxSteps: 1,
      steps: [
        {
          name: 'complete-directly',
          persona: 'coder',
          instruction: 'complete',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
        {
          name: 'unreachable-child',
          kind: 'workflow_call',
          call: 'companion-runtime',
          rules: [],
        },
      ],
    } as WorkflowConfig;
    const environment = compileRuntimeProviderEnvironment({
      defaults: { profile: 'default' },
      profiles: { default: { provider: 'codex', model: 'default-model' } },
    });
    const workflowCallResolver = vi.fn(() => companionWorkflow());

    const resolved = resolveWorkflowCompanions(parent, environment, {
      projectCwd: '/project',
      lookupCwd: '/worktree',
      workflowCallResolver,
    });

    expect(resolved.size).toBe(0);
    expect(workflowCallResolver).not.toHaveBeenCalled();
  });

  it('should not require a provider target for an unreachable local companion step', () => {
    const workflow = companionWorkflow();
    workflow.steps.unshift({
      name: 'complete-directly',
      persona: 'coder',
      instruction: 'complete',
      rules: [{ condition: { kind: 'semantic', value: 'done' }, next: 'COMPLETE' }],
    });
    workflow.initialStep = 'complete-directly';
    const environment = compileLegacyProviderEnvironment({
      provider: 'mock',
      providerSource: 'project',
      model: 'mock-model',
      modelSource: 'project',
      personaProviders: undefined,
      providerRouting: undefined,
      autoRouting: undefined,
      providerOptions: undefined,
    });

    expect(resolveWorkflowCompanions(workflow, environment).size).toBe(0);
  });

  it.each([
    { pool: 'reviewers' },
    { ladder: ['default', 'security'] },
  ])('should reject non-profile companion assignment %j while parsing runtime.yaml', (assignment) => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      provider: {
        profiles: {
          default: { provider: 'codex', model: 'gpt-test' },
          security: { provider: 'claude-sdk', model: 'security-model' },
        },
        targets: { companions: { 'security-reviewer': assignment } },
      },
    });

    expect(result.success).toBe(false);
  });

  it('should preserve ladder assignments for non-companion targets', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      provider: {
        profiles: {
          first: { provider: 'codex', model: 'first' },
          second: { provider: 'codex', model: 'second' },
        },
        defaults: { ladder: ['first', 'second'] },
        targets: { steps: { implement: { ladder: ['first', 'second'] } } },
      },
    });

    expect(result.success).toBe(true);
  });

  it('should reject companion use in legacy mode with runtime.yaml migration guidance', () => {
    const legacy = compileLegacyProviderEnvironment({
      provider: 'codex',
      providerSource: 'project',
      model: 'legacy-model',
      modelSource: 'project',
      personaProviders: undefined,
      providerRouting: undefined,
      autoRouting: undefined,
      providerOptions: undefined,
    });

    expect(() => resolveWorkflowCompanions(companionWorkflow(), legacy))
      .toThrow(/runtime\.yaml/);
  });

  it('should reject a provider without strict isolated structured execution support', () => {
    const environment = compileRuntimeProviderEnvironment({
      defaults: { profile: 'unsupported' },
      profiles: { unsupported: { provider: 'opencode', model: 'opencode/model' } },
    });

    expect(() => resolveWorkflowCompanions(companionWorkflow(), environment))
      .toThrow(/opencode.*companion|companion.*opencode/i);
  });
});
