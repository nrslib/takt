import type { Language } from '../../core/models/types.js';
import type { WorkflowAssignment } from '../../core/workflow/workflow-prompt-context.js';
import { loadTemplate } from './index.js';

export function phaseName(phase: 1 | 2 | 3, language: Language): string {
  const names = language === 'ja'
    ? { 1: '作業フェーズ（Phase 1）', 2: 'レポートフェーズ（Phase 2）', 3: '判定フェーズ（Phase 3）' }
    : { 1: 'Work phase (Phase 1)', 2: 'Report phase (Phase 2)', 3: 'Judgment phase (Phase 3)' };
  return names[phase];
}

export function assignmentStepName(assignment: Pick<WorkflowAssignment, 'stepName' | 'parallelParent' | 'internalStep'>, language: Language): string {
  const internal = assignment.internalStep;
  if (internal?.kind === 'team_part') {
    return language === 'ja'
      ? `${internal.partName}（${internal.ownerStepName} の part）`
      : `${internal.partName} (part of ${internal.ownerStepName})`;
  }
  if (internal?.kind === 'loop_monitor') {
    return language === 'ja'
      ? `${internal.ownerStepName} の loop monitor の判定`
      : `loop monitor judgment for ${internal.ownerStepName}`;
  }
  if (assignment.parallelParent === undefined) return assignment.stepName;
  return language === 'ja'
    ? `${assignment.stepName}（${assignment.parallelParent} の並列サブステップ）`
    : `${assignment.stepName} (parallel substep of ${assignment.parallelParent})`;
}

export function renderPhaseContext(
  assignment: Pick<WorkflowAssignment, 'stepName' | 'parallelParent' | 'internalStep' | 'stepIteration'>,
  phase: 1 | 2 | 3,
  language: Language,
): string {
  return loadTemplate(`parts/phase${phase}_context`, language, {
    stepName: assignmentStepName(assignment, language),
    stepIteration: String(assignment.stepIteration),
  });
}
