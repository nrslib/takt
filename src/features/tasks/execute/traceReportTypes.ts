import type { AgentFailureCategory } from '../../../shared/types/agent-failure.js';
import type { NdjsonWorkflowStackEntry } from '../../../shared/utils/index.js';
import type { PhaseName } from '../../../core/workflow/index.js';
import type { JudgeStageEntry } from '../../../core/workflow/types.js';

export type TraceReportMode = 'off' | 'redacted' | 'full';

export interface TraceReportParams {
  tracePath: string;
  workflowName: string;
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

export interface TraceStep {
  step: string;
  persona: string;
  iteration: number;
  workflow?: string;
  stack?: NdjsonWorkflowStackEntry[];
  instruction?: string;
  startedAt: string;
  completedAt?: string;
  phases: TracePhase[];
  result?: {
    status: string;
    content: string;
    error?: string;
    failureCategory?: AgentFailureCategory;
    matchedRuleIndex?: number;
    matchedRuleMethod?: string;
    matchMethod?: string;
  };
}
