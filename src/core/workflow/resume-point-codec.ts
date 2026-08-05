import type { WorkflowResumePoint } from '../models/types.js';
import { WorkflowResumePointSchema } from '../models/workflow-resume-schema.js';
import { cloneDynamicParallelSelectionSnapshot } from './dynamic-parallel/snapshot.js';
import { cloneDynamicFacetSelectionSnapshot } from './dynamic-facets/dynamicFacetSelectionStore.js';

function normalizeLegacyDynamicFacetSelections(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const selections = record.dynamic_facet_selections;
  if (typeof selections !== 'object' || selections === null || Array.isArray(selections)) return value;
  const selectionsRecord = selections as Record<string, unknown>;
  let mutated = false;
  const normalized: Record<string, unknown> = {};
  for (const [identity, snapshot] of Object.entries(selectionsRecord)) {
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
      normalized[identity] = snapshot;
      continue;
    }
    const snap = snapshot as Record<string, unknown>;
    if (!('effective_policy_refs' in snap) && !('effective_knowledge_refs' in snap)) {
      normalized[identity] = snap;
      continue;
    }
    const rewritten: Record<string, unknown> = { ...snap };
    if ('effective_policy_refs' in rewritten && !('selected_policy_refs' in rewritten)) {
      rewritten.selected_policy_refs = rewritten.effective_policy_refs;
      delete rewritten.effective_policy_refs;
    }
    if ('effective_knowledge_refs' in rewritten && !('selected_knowledge_refs' in rewritten)) {
      rewritten.selected_knowledge_refs = rewritten.effective_knowledge_refs;
      delete rewritten.effective_knowledge_refs;
    }
    normalized[identity] = rewritten;
    mutated = true;
  }
  return mutated ? { ...record, dynamic_facet_selections: normalized } : value;
}

export function parseWorkflowResumePoint(value: unknown): WorkflowResumePoint {
  return cloneWorkflowResumePoint(WorkflowResumePointSchema.parse(normalizeLegacyDynamicFacetSelections(value)));
}

export function cloneWorkflowResumePoint(resumePoint: WorkflowResumePoint): WorkflowResumePoint {
  return {
    ...resumePoint,
    stack: resumePoint.stack.map((entry) => ({
      ...entry,
      ...(entry.step_iterations === undefined ? {} : { step_iterations: { ...entry.step_iterations } }),
    })),
    ...(resumePoint.dynamic_parallel_selections === undefined
      ? {}
      : {
          dynamic_parallel_selections: Object.fromEntries(Object.entries(resumePoint.dynamic_parallel_selections)
            .map(([identity, snapshot]) => [identity, cloneDynamicParallelSelectionSnapshot(snapshot)])),
        }),
    ...(resumePoint.dynamic_facet_selections === undefined
      ? {}
      : {
          dynamic_facet_selections: Object.fromEntries(Object.entries(resumePoint.dynamic_facet_selections)
            .map(([identity, snapshot]) => [identity, cloneDynamicFacetSelectionSnapshot(snapshot)])),
        }),
    workflow_call_invocations: Object.fromEntries(
      Object.entries(resumePoint.workflow_call_invocations)
        .map(([identity, record]) => [identity, { ...record }]),
    ),
    workflow_step_participations: Object.fromEntries(
      Object.entries(resumePoint.workflow_step_participations)
        .map(([identity, record]) => [
          identity,
          { report_names: [...record.report_names] },
        ]),
    ),
  };
}
