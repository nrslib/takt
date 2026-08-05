import { describe, expect, it } from 'vitest';
import { restoreAndValidateDynamicFacetSelections } from '../core/workflow/dynamic-facets/dynamicFacetResumeState.js';
import type { WorkflowConfig, DynamicFacetSelectionSnapshot } from '../core/models/workflow-types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { buildDynamicParallelSelectionIdentityFromPath } from '../core/workflow/dynamic-parallel/identity.js';

function makeIdentity(workflowRef: string, stepName: string): string {
  return buildDynamicParallelSelectionIdentityFromPath(workflowRef, stepName, []);
}

function snapshot(identity: string, stepName: string, selectedIds: string[], round: number): DynamicFacetSelectionSnapshot {
  return {
    identity,
    step_name: stepName,
    round,
    selected_ids: [...selectedIds],
    selected_policy_refs: [...selectedIds],
    selected_knowledge_refs: [...selectedIds],
    rationale: `round ${round}`,
  };
}

function makeConfig(): WorkflowConfig {
  return {
    name: 'wf',
    steps: [{
      name: 'fix',
      personaDisplayName: 'fix',
      instruction: 'fix',
      dynamicFacets: { pool: 'fix', maxSelected: 3 },
    } as unknown as WorkflowConfig['steps'][number]],
    initialStep: 'fix',
    maxSteps: 5,
  } as unknown as WorkflowConfig;
}

function makeOptions(selections: Record<string, DynamicFacetSelectionSnapshot>): WorkflowEngineOptions {
  return { resumePoint: { dynamic_facet_selections: selections } } as unknown as WorkflowEngineOptions;
}

describe('DynamicFacetResumeState (C-ROUND-RESUME, C-ROUND-REPLACE)', () => {
  it('should restore selections from a resume point without invoking the selector (C-ROUND-RESUME)', () => {
    const identity = makeIdentity('wf', 'fix');
    const selections: Record<string, DynamicFacetSelectionSnapshot> = {
      [identity]: snapshot(identity, 'fix', ['transaction'], 1),
    };
    const restored = restoreAndValidateDynamicFacetSelections(makeConfig(), makeOptions(selections));
    expect(restored.get(identity)?.selected_ids).toEqual(['transaction']);
  });

  it('should reject a snapshot whose identity does not match a reachable step (C-ROUND-RESUME: 不正 identity)', () => {
    const identity = makeIdentity('wf', 'nonexistent');
    const selections: Record<string, DynamicFacetSelectionSnapshot> = {
      [identity]: snapshot(identity, 'nonexistent', ['transaction'], 1),
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
    const identity = makeIdentity('wf', 'fix');
    const mismatchIdentity = makeIdentity('wf', 'MISMATCH');
    const selections = {
      [identity]: snapshot(mismatchIdentity, 'fix', ['transaction'], 1),
    } as unknown as Record<string, DynamicFacetSelectionSnapshot>;
    expect(() => restoreAndValidateDynamicFacetSelections(makeConfig(), makeOptions(selections))).toThrow();
  });

  it('should restore selections independent of the saved input (C-STATE-RUNTIME: clone isolation)', () => {
    const identity = makeIdentity('wf', 'fix');
    const selections: Record<string, DynamicFacetSelectionSnapshot> = {
      [identity]: snapshot(identity, 'fix', ['transaction'], 1),
    };
    const restored = restoreAndValidateDynamicFacetSelections(makeConfig(), makeOptions(selections));
    const restoredSnapshot = restored.get(identity);
    expect(restoredSnapshot).toBeDefined();
    restoredSnapshot!.selected_ids.push('backend');
    expect(selections[identity]!.selected_ids).toEqual(['transaction']);
  });

  it('should reject a snapshot when the step no longer has dynamic_facets (C-ROUND-RESUME: 設定削除後)', () => {
    const identity = makeIdentity('wf', 'fix');
    const selections: Record<string, DynamicFacetSelectionSnapshot> = {
      [identity]: snapshot(identity, 'fix', ['transaction'], 1),
    };
    const config = makeConfig();
    (config.steps[0] as unknown as { dynamicFacets: undefined }).dynamicFacets = undefined;
    expect(() => restoreAndValidateDynamicFacetSelections(config, makeOptions(selections))).toThrow();
  });
});