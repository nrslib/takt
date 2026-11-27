import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { WorkflowStepRawSchema } from '../core/models/index.js';
import type { WorkflowEffect, WorkflowStep } from '../core/models/types.js';
import { hasCacciaEffect } from '../core/workflow/workflow-step-traversal.js';
import { validateSystemEffectPayload } from '../core/workflow/system/system-step-effect-runner.js';
import { normalizeWorkflowEffects } from '../infra/config/loaders/workflowSystemStepNormalizer.js';
import { parseGitHubPullRequestTarget } from '../infra/github/pull-request-target.js';

describe('Published GitHub PR target', () => {
  it.each(['github.com', 'ghe.example.test'])('keeps the host, repository and PR number for %s', (hostname) => {
    const url = `https://${hostname}/acme/target/pull/123`;
    expect(parseGitHubPullRequestTarget(url)).toEqual({ hostname, owner: 'acme', repo: 'target', number: 123, url });
  });
});

const step = {
  name: 'review_external', kind: 'system',
  rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
};

describe('Caccia effect detection', () => {
  const effectStep: WorkflowStep = {
    name: 'review', kind: 'system', personaDisplayName: 'system', instruction: '',
    effects: [{ type: 'caccia', pr: 123 }],
  };

  it('detects a system effect independently of its step name', () => {
    expect(hasCacciaEffect([effectStep])).toBe(true);
    expect(hasCacciaEffect([{
      ...effectStep, effects: [{ type: 'comment_pr' as const, pr: 123, body: 'Review' }, { type: 'caccia' as const, pr: 123 }],
    }])).toBe(true);
  });

  it('detects a system effect nested in static parallel steps', () => {
    expect(hasCacciaEffect([{
      name: 'parallel', personaDisplayName: 'parallel', instruction: '',
      parallel: [{ name: 'nested', personaDisplayName: 'parallel', instruction: '', parallel: [effectStep] }],
    }])).toBe(true);
  });

  it('does not infer effects from agent names or instructions', () => {
    expect(hasCacciaEffect([{ name: 'caccia', personaDisplayName: 'coder', instruction: 'type: caccia' }])).toBe(false);
    expect(hasCacciaEffect([])).toBe(false);
  });

  it('does not treat other system effects or a wait-only step as Caccia', () => {
    expect(hasCacciaEffect([
      { ...effectStep, effects: [{ type: 'comment_pr' as const, pr: 123, body: 'type: caccia' }] },
      { ...effectStep, effects: undefined, wait: { until: 'when(true)', intervalMs: 1, maxRetries: 1, onTimeout: 'ABORT' } },
    ])).toBe(false);
  });

  it('visits both dynamic parallel sets without treating instructions as effects', () => {
    expect(hasCacciaEffect([{
      name: 'parallel', personaDisplayName: 'parallel', instruction: '', parallel: {
        kind: 'dynamic', selection: { mode: 'replace' },
        fixed: [{ name: 'fixed', personaDisplayName: 'coder', instruction: 'type: caccia' }],
        pool: [{ name: 'caccia', personaDisplayName: 'coder', instruction: 'type: caccia', description: 'Review' }],
      },
    }])).toBe(false);
  });
});

describe('Caccia system effect input', () => {
  it.each(['"{context:identify.pr.number}"', "'{context:identify.pr.number}'"])(
    'accepts a full context reference from YAML scalar %s', (scalar) => {
      const parsed = WorkflowStepRawSchema.parse({ ...step, effects: [parse(`type: caccia\npr: ${scalar}`)] });
      expect(normalizeWorkflowEffects(parsed.effects)).toEqual([{ type: 'caccia', pr: '{context:identify.pr.number}' }]);
    },
  );
  it.each([123, '{context:identify.pr.number}', '{structured:identify.number}', '{effect:identify.enqueue_task.pr}'])(
    'accepts and normalizes PR input %j', (pr) => {
      const effects = [{ type: 'caccia', pr }];
      const parsed = WorkflowStepRawSchema.parse({ ...step, effects });
      expect(normalizeWorkflowEffects(parsed.effects)).toEqual(effects);
    },
  );

  it.each([
    { type: 'caccia' },
    { type: 'caccia', pr: 0 },
    { type: 'caccia', pr: -1 },
    { type: 'caccia', pr: 1.5 },
    { type: 'caccia', pr: '123' },
    { type: 'caccia', pr: 'PR {context:identify.pr.number}' },
    { type: 'caccia', pr: '{context:identify.pr.number' },
    { type: 'caccia', pr: 123, enabled: true },
  ])('rejects invalid effect %j at the schema boundary', (effect) => {
    expect(WorkflowStepRawSchema.safeParse({ ...step, effects: [effect] }).success).toBe(false);
  });

  // スキーマの実装前にも参照解決後の検証を独立して観測する。
  const effect = { type: 'caccia', pr: '{context:identify.pr.number}' } as unknown as WorkflowEffect;

  it.each([1, 123, Number.MAX_SAFE_INTEGER])('accepts resolved positive safe PR number %j', (pr) => {
    expect(() => validateSystemEffectPayload(effect, { pr })).not.toThrow();
  });

  it.each([undefined, null, '123', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}])(
    'rejects resolved invalid PR number %j before dispatch', (pr) => {
      expect(() => validateSystemEffectPayload(effect, { pr })).toThrow();
    },
  );
});
