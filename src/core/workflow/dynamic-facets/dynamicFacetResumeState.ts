import type {
  DynamicFacetSelectionSnapshot,
  WorkflowConfig,
  WorkflowResumePoint,
} from '../../models/types.js';
import type { WorkflowEngineOptions } from '../types.js';
import { cloneDynamicFacetSelectionSnapshot } from './dynamicFacetSelectionStore.js';

function restoreDynamicFacetSelections(
  resumePoint: WorkflowResumePoint | undefined,
): Map<string, DynamicFacetSelectionSnapshot> {
  const raw = resumePoint?.dynamic_facet_selections;
  if (!raw) return new Map();
  const selections = new Map<string, DynamicFacetSelectionSnapshot>();
  for (const [identity, snapshot] of Object.entries(raw)) {
    if (snapshot.identity !== identity) {
      throw new Error(`Invalid dynamic facet selection snapshot for identity "${identity}"`);
    }
    selections.set(identity, cloneDynamicFacetSelectionSnapshot(snapshot));
  }
  return selections;
}

function validateDynamicFacetSelections(
  config: WorkflowConfig,
  selections: ReadonlyMap<string, DynamicFacetSelectionSnapshot>,
): void {
  if (selections.size === 0) return;
  const stepNames = new Set(config.steps.map((step) => step.name));
  for (const [identity, snapshot] of selections) {
    if (!stepNames.has(snapshot.step_name)) {
      throw new Error(
        `Dynamic facet selection snapshot identity "${identity}" references unknown step "${snapshot.step_name}"`,
      );
    }
  }
}

export function restoreAndValidateDynamicFacetSelections(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
): Map<string, DynamicFacetSelectionSnapshot> {
  const selections = restoreDynamicFacetSelections(options.resumePoint);
  validateDynamicFacetSelections(config, selections);
  return selections;
}