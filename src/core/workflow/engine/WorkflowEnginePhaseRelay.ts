import type { WorkflowStep } from '../../models/types.js';
import type { JudgeStageEntry, PhaseName, PhasePromptParts } from '../types.js';
import type { WorkflowExecutionScope } from '../workflow-execution-scope.js';

export interface WorkflowPhaseRelay {
  onPhaseStart: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
    scope?: WorkflowExecutionScope,
  ) => void;
  onPhaseComplete: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    phaseStatus: string,
    error?: string,
    phaseExecutionId?: string,
    iteration?: number,
    scope?: WorkflowExecutionScope,
  ) => void;
  onJudgeStage: (
    step: WorkflowStep,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId?: string,
    iteration?: number,
    scope?: WorkflowExecutionScope,
  ) => void;
}

export function createWorkflowPhaseRelay(
  emit: (event: string, ...args: unknown[]) => void,
): WorkflowPhaseRelay {
  return {
    onPhaseStart: (step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration, scope) => {
      if (scope === undefined) {
        throw new Error(`phase:start for step "${step.name}" requires an execution scope`);
      }
      emit('phase:start', step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration, scope);
    },
    onPhaseComplete: (step, phase, phaseName, content, phaseStatus, error, phaseExecutionId, iteration, scope) => {
      if (scope === undefined) {
        throw new Error(`phase:complete for step "${step.name}" requires an execution scope`);
      }
      emit('phase:complete', step, phase, phaseName, content, phaseStatus, error, phaseExecutionId, iteration, scope);
    },
    onJudgeStage: (step, phase, phaseName, entry, phaseExecutionId, iteration, scope) => {
      if (scope === undefined) {
        throw new Error(`phase:judge_stage for step "${step.name}" requires an execution scope`);
      }
      emit('phase:judge_stage', step, phase, phaseName, entry, phaseExecutionId, iteration, scope);
    },
  };
}
