import type { PhaseName } from '../../../core/piece/index.js';
import type { JudgeStageEntry } from '../../../core/piece/types.js';

export type TraceReportMode = 'off' | 'redacted' | 'full';

export interface TraceReportParams {
  tracePath: string;
  pieceName: string;
  task: string;
  runSlug: string;
  status: 'completed' | 'aborted';
  iterations: number;
  endTime: string;
  reason?: string;
}

export interface TracePhase {
  phaseExecutionId: string;
  phase: 1 | 2 | 3;
  phaseName: PhaseName;
  instruction: string;
  systemPrompt: string;
  userInstruction: string;
  response?: string;
  status?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  judgeStages?: JudgeStageEntry[];
}

export interface TraceMovement {
  step: string;
  persona: string;
  iteration: number;
  instruction?: string;
  startedAt: string;
  completedAt?: string;
  phases: TracePhase[];
  result?: {
    status: string;
    content: string;
    error?: string;
    matchedRuleIndex?: number;
    matchedRuleMethod?: string;
    matchMethod?: string;
  };
}
