import type { WorkflowStep } from '../../models/types.js';
import type { JudgeStageEntry, PhaseName, PhasePromptParts } from '../types.js';

export interface WorkflowPhaseRelay {
  onPhaseStart: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
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
  ) => void;
  onJudgeStage: (
    step: WorkflowStep,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
}

export function createWorkflowPhaseRelay(
  emit: (event: string, ...args: unknown[]) => void,
): WorkflowPhaseRelay {
  return {
    onPhaseStart: (step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration) => {
      if (phaseExecutionId == null && iteration == null) {
        emit('phase:start', step, phase, phaseName, instruction, promptParts);
        return;
      }
      emit('phase:start', step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration);
    },
    onPhaseComplete: (step, phase, phaseName, content, phaseStatus, error, phaseExecutionId, iteration) => {
      if (phaseExecutionId == null && iteration == null) {
        emit('phase:complete', step, phase, phaseName, content, phaseStatus, error);
        return;
      }
      emit('phase:complete', step, phase, phaseName, content, phaseStatus, error, phaseExecutionId, iteration);
    },
    onJudgeStage: (step, phase, phaseName, entry, phaseExecutionId, iteration) => {
      if (phaseExecutionId == null && iteration == null) {
        emit('phase:judge_stage', step, phase, phaseName, entry);
        return;
      }
      emit('phase:judge_stage', step, phase, phaseName, entry, phaseExecutionId, iteration);
    },
  };
}
