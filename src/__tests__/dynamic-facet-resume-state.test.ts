import { describe, expect, it } from 'vitest';
import { restoreAndValidateDynamicFacetSelections } from '../core/workflow/dynamic-facets/dynamicFacetResumeState.js';
import type { WorkflowConfig, DynamicFacetSelectionSnapshot } from '../core/models/workflow-types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

function snapshot(identity: string, selectedIds: string[], round: number): DynamicFacetSelectionSnapshot {
  return {
    identity,
    step_name: 'fix',
    round,
    selected_ids: [...selectedIds],
    effective_policy_refs: [...selectedIds],
    effective_knowledge_refs: [...selectedIds],
    rationale: `round ${round}`,
  };
}

function makeConfig(): WorkflowConfig {
  return {
    name: 'wf',
    steps: [{ name: 'fix', personaDisplayName: 'fix', instruction: 'fix' } as unknown as WorkflowConfig['steps'][number]],
    initialStep: 'fix',
    maxSteps: 5,
  } as unknown as WorkflowConfig;
}

function makeOptions(selections: Record<string, DynamicFacetSelectionSnapshot>): WorkflowEngineOptions {
  return { resumePoint: { dynamic_facet_selections: selections } } as unknown as WorkflowEngineOptions;
}

describe('DynamicFacetResumeState (C-ROUND-RESUME, C-ROUND-REPLACE)', () => {
  it('should restore selections from a resume point without invoking the selector (C-ROUND-RESUME)', () => {
    const selections: Record<string, DynamicFacetSelectionSnapshot> = {
      'wf:fix': snapshot('wf:fix', ['transaction'], 1),
    };
    const restored = restoreAndValidateDynamicFacetSelections(makeConfig(), makeOptions(selections));
    expect(restored.get('wf:fix')?.selected_ids).toEqual(['transaction']);
  });

  it('should reject a snapshot whose identity does not match a reachable step (C-ROUND-RESUME: 不正 identity)', () => {
    const selections: Record<string, DynamicFacetSelectionSnapshot> = {
      'wf:nonexistent': snapshot('wf:nonexistent', ['transaction'], 1),
    };
    const config = makeConfig();
    config.steps = [];
    expect(() => restoreAndValidateDynamicFacetSelections(config, makeOptions(selections))).toThrow();
  });

  it('should return an empty map when the resume point has no dynamic facet selections', () => {
    const restored = restoreAndValidateDynamicFacetSelections(makeConfig(), {} as unknown as WorkflowEngineOptions);
    expect(restored.size).toBe(0);
  });

  it('should reject a snapshot whose identity does not match its stored key (C-STATE-RUNTIME: 不正 snapshot)', () => {
    const selections = {
      'wf:fix': snapshot('wf:MISMATCH', ['transaction'], 1),
    } as unknown as Record<string, DynamicFacetSelectionSnapshot>;
    expect(() => restoreAndValidateDynamicFacetSelections(makeConfig(), makeOptions(selections))).toThrow();
  });
});