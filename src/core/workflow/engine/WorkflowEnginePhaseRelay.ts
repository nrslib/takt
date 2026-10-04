import type {
  WorkflowResumePointEntry,
  WorkflowStep,
} from '../../models/types.js';
import type { JudgeStageEntry, PhaseName, PhasePromptParts } from '../types.js';
import { requireWorkflowResumeStackSnapshot } from '../run/resume-point.js';

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
  getCurrentWorkflowStack: () => readonly WorkflowResumePointEntry[] | undefined,
  recordActivity: () => void = () => {},
): WorkflowPhaseRelay {
  const workflowStackByPhase = new Map<string, WorkflowResumePointEntry[]>();
  const phaseKey = (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseExecutionId: string | undefined,
    iteration: number | undefined,
  ): string => JSON.stringify([
    step.name,
    phase,
    phaseExecutionId,
    iteration,
  ]);
  return {
    onPhaseStart: (step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration) => {
      recordActivity();
      const workflowStack = requireWorkflowResumeStackSnapshot(
        getCurrentWorkflowStack(),
      );
      workflowStackByPhase.set(
        phaseKey(step, phase, phaseExecutionId, iteration),
        workflowStack,
      );
      emit(
        'phase:start',
        step,
        phase,
        phaseName,
        instruction,
        promptParts,
        phaseExecutionId,
        iteration,
        workflowStack,
      );
    },
    onPhaseComplete: (step, phase, phaseName, content, phaseStatus, error, phaseExecutionId, iteration) => {
      recordActivity();
      const key = phaseKey(step, phase, phaseExecutionId, iteration);
      const workflowStack = workflowStackByPhase.get(key);
      if (workflowStack === undefined) {
        throw new Error(`Phase completion has no originating workflow stack: ${step.name}:${phase}`);
      }
      workflowStackByPhase.delete(key);
      emit(
        'phase:complete',
        step,
        phase,
        phaseName,
        content,
        phaseStatus,
        error,
        phaseExecutionId,
        iteration,
        workflowStack,
      );
    },
    onJudgeStage: (step, phase, phaseName, entry, phaseExecutionId, iteration) => {
      recordActivity();
      const workflowStack = workflowStackByPhase.get(
        phaseKey(step, phase, phaseExecutionId, iteration),
      );
      if (workflowStack === undefined) {
        throw new Error(`Judge stage has no originating workflow stack: ${step.name}:${phase}`);
      }
      emit(
        'phase:judge_stage',
        step,
        phase,
        phaseName,
        entry,
        phaseExecutionId,
        iteration,
        workflowStack,
      );
    },
  };
}
