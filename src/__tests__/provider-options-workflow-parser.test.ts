import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentWorkflowStep } from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-workflow-'));
  mkdirSync(join(tempDir, 'provider-options'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeCapabilitySet(name: string, body: string): void {
  writeFileSync(join(tempDir, 'provider-options', name + '.yaml'), body);
}

function normalizeWorkflow(
  extra: Record<string, unknown> = {},
  steps: Array<Record<string, unknown>> = [{ name: 'implement', instruction: '{task}' }],
) {
  return normalizeWorkflowConfig({ name: 'workflow', ...extra, steps }, tempDir);
}

describe('workflow capability provider-options references', () => {
  it('resolves a named capability set without exposing workflow provider options', () => {
    writeCapabilitySet('backend', 'claude:\n  allowed_tools: [Read, Grep]\n');

    const workflow = normalizeWorkflow({}, [{
      name: 'implement',
      instruction: '{task}',
      capabilities: 'provider-options/backend.yaml',
    }]);
    const step = workflow.steps[0] as AgentWorkflowStep;

    expect(step.capabilityProviderOptions).toEqual({
      claude: { allowedTools: ['Read', 'Grep'] },
    });
    expect(step).not.toHaveProperty('providerOptions');
    expect(step).not.toHaveProperty('provider');
    expect(step).not.toHaveProperty('model');
  });

});

describe('workflow runtime ownership boundary', () => {
  it.each([
    {
      name: 'workflow_config provider_options',
      workflow: { workflow_config: { provider_options: { codex: { network_access: true } } } },
      steps: undefined,
      error: /runtime\.yaml/,
    },
    {
      name: 'step provider',
      workflow: {},
      steps: [{ name: 'implement', instruction: '{task}', provider: 'mock' }],
      error: /runtime\.yaml/,
    },
    {
      name: 'step model',
      workflow: {},
      steps: [{ name: 'implement', instruction: '{task}', model: 'model' }],
      error: /runtime\.yaml/,
    },
    {
      name: 'step provider_options',
      workflow: {},
      steps: [{ name: 'implement', instruction: '{task}', provider_options: { codex: { network_access: true } } }],
      error: /runtime\.yaml/,
    },
    {
      name: 'workflow auto_routing',
      workflow: { auto_routing: { candidates: [] } },
      steps: undefined,
      error: /runtime\.yaml/,
    },
    {
      name: 'workflow rate_limit_fallback',
      workflow: { rate_limit_fallback: { switch_chain: [] } },
      steps: undefined,
      error: /runtime\.yaml/,
    },
  ])('rejects $name at the workflow load boundary', ({ workflow, steps, error }) => {
    expect(() => normalizeWorkflow(workflow, steps)).toThrow(error);
  });

  it('keeps runtime.prepare while rejecting provider settings', () => {
    const workflow = normalizeWorkflow({
      workflow_config: { runtime: { prepare: ['node'] } },
    });
    expect(workflow.runtime?.prepare).toEqual(['node']);
  });

  it('accepts only runtime ladder promotion entries', () => {
    const workflow = normalizeWorkflow({}, [{
      name: 'review',
      instruction: '{task}',
      promotion: [{ at: 3 }, { at: 6 }],
    }]);
    expect(workflow.steps[0]?.promotion).toEqual([{ at: 3 }, { at: 6 }]);

    expect(() => normalizeWorkflow({}, [{
      name: 'review',
      instruction: '{task}',
      promotion: [{ at: 3, provider: 'codex' }],
    }])).toThrow(/runtime\.yaml|target ladder/);
  });

  it('rejects loop judge and workflow-call provider settings', () => {
    expect(() => normalizeWorkflow({
      loop_monitors: [{
        cycle: ['implement', 'review'],
        judge: {
          provider: 'mock',
          rules: [{ condition: 'progress', next: 'implement' }],
        },
      }],
    })).toThrow(/runtime\.yaml/);

    expect(() => normalizeWorkflow({}, [{
      name: 'call',
      kind: 'workflow_call',
      call: 'child',
      overrides: { provider: 'mock' },
      rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
    }])).toThrow(/runtime\.yaml/);
  });
});
