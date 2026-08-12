import type { AgentFailureCategory } from '../types/agent-failure.js';
import type { CanonicalWorkflowResumeFrame } from '../types/workflow-resume.js';

/**
 * Type definitions for utils module.
 *
 * Contains session log types and NDJSON record types
 * used by SessionManager and its consumers.
 */

/** Session log entry */
export interface SessionLog {
  task: string;
  projectDir: string;
  workflowName: string;
  iterations: number;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'aborted';
  history: Array<{
    step: string;
    persona: string;
    instruction: string;
    status: string;
    timestamp: string;
    content: string;
    error?: string;
    workflow?: string;
    stack?: NdjsonWorkflowStackEntry[];
    /** Matched rule index (0-based) when rules-based detection was used */
    matchedRuleIndex?: number;
    /** How the rule match was detected */
    matchedRuleMethod?: string;
    /** Method used by status judgment phase */
    matchMethod?: string;
    /** Machine-readable provider-normalized failure classification */
    failureCategory?: AgentFailureCategory;
  }>;
}

// --- NDJSON log types ---

export interface NdjsonWorkflowStart {
  type: 'workflow_start';
  task: string;
  workflowName: string;
  startTime: string;
}

export type NdjsonWorkflowStackEntry = CanonicalWorkflowResumeFrame;

export interface NdjsonWorkflowCallStart {
  type: 'workflow_call_start';
  workflow: string;
  step: string;
  childWorkflow: string;
  callInstance: number;
  stack: NdjsonWorkflowStackEntry[];
  timestamp: string;
}

export interface NdjsonWorkflowCallComplete {
  type: 'workflow_call_complete';
  workflow: string;
  step: string;
  childWorkflow: string;
  callInstance: number;
  stack: NdjsonWorkflowStackEntry[];
  status: 'completed' | 'aborted' | 'failed';
  returnValue?: string;
  abortKind?: string;
  abortReason?: string;
  reason?: string;
  timestamp: string;
}

export interface NdjsonStepStart {
  type: 'step_start';
  step: string;
  persona: string;
  iteration: number;
  timestamp: string;
  workflow?: string;
  stack?: NdjsonWorkflowStackEntry[];
  instruction?: string;
  provider?: string;
  providerSource?: string;
  model?: string;
  modelSource?: string;
  providerOptions?: unknown;
  providerOptionsSources?: Record<string, string>;
}

export interface NdjsonStepComplete {
  type: 'step_complete';
  step: string;
  persona: string;
  iteration: number;
  status: string;
  content: string;
  instruction: string;
  workflow?: string;
  stack?: NdjsonWorkflowStackEntry[];
  matchedRuleIndex?: number;
  matchedRuleMethod?: string;
  matchMethod?: string;
  error?: string;
  failureCategory?: AgentFailureCategory;
  timestamp: string;
}

export interface NdjsonWorkflowComplete {
  type: 'workflow_complete';
  iterations: number;
  endTime: string;
  publicationId?: string;
}

export interface NdjsonWorkflowAbort {
  type: 'workflow_abort';
  iterations: number;
  reason: string;
  failureCategory?: AgentFailureCategory;
  endTime: string;
  publicationId?: string;
}

export interface NdjsonPhaseStart {
  type: 'phase_start';
  step: string;
  iteration?: number;
  workflow?: string;
  stack?: NdjsonWorkflowStackEntry[];
  phase: 1 | 2 | 3;
  phaseName: 'execute' | 'report' | 'judge';
  phaseExecutionId?: string;
  timestamp: string;
  instruction?: string;
  systemPrompt?: string;
  userInstruction?: string;
}

export interface NdjsonPhaseComplete {
  type: 'phase_complete';
  step: string;
  iteration?: number;
  workflow?: string;
  stack?: NdjsonWorkflowStackEntry[];
  phase: 1 | 2 | 3;
  phaseName: 'execute' | 'report' | 'judge';
  phaseExecutionId?: string;
  status: string;
  content?: string;
  timestamp: string;
  error?: string;
}

export interface NdjsonPhaseJudgeStage {
  type: 'phase_judge_stage';
  step: string;
  iteration?: number;
  workflow?: string;
  stack?: NdjsonWorkflowStackEntry[];
  phase: 3;
  phaseName: 'judge';
  phaseExecutionId?: string;
  stage: 1 | 2 | 3;
  method: 'structured_output' | 'phase3_tag' | 'ai_judge';
  status: 'done' | 'error' | 'skipped';
  instruction: string;
  response: string;
  timestamp: string;
}

export interface NdjsonInteractiveStart {
  type: 'interactive_start';
  timestamp: string;
}

export interface NdjsonInteractiveEnd {
  type: 'interactive_end';
  confirmed: boolean;
  task?: string;
  timestamp: string;
}

export type NdjsonCompanionReviewTrigger = 'quiet' | 'forced' | 'completion' | 'commit';

export interface NdjsonCompanionReviewRound {
  type: 'companion_review_round';
  step: string;
  companion: string;
  trigger: NdjsonCompanionReviewTrigger;
  digest: string;
  changedLines: number;
  findingCount: number;
  timestamp: string;
}

export interface NdjsonCompanionQueueCoalesced {
  type: 'companion_queue_coalesced';
  step: string;
  companion: string;
  replaced: {
    trigger: NdjsonCompanionReviewTrigger;
    digest: string;
    changedLines: number;
    observedGeneration: number;
  };
  replacement: {
    trigger: NdjsonCompanionReviewTrigger;
    digest: string;
    changedLines: number;
    observedGeneration: number;
  };
  timestamp: string;
}

export type NdjsonRecord =
  | NdjsonWorkflowStart
  | NdjsonWorkflowCallStart
  | NdjsonWorkflowCallComplete
  | NdjsonStepStart
  | NdjsonStepComplete
  | NdjsonWorkflowComplete
  | NdjsonWorkflowAbort
  | NdjsonPhaseStart
  | NdjsonPhaseComplete
  | NdjsonPhaseJudgeStage
  | NdjsonInteractiveStart
  | NdjsonInteractiveEnd
  | NdjsonCompanionReviewRound
  | NdjsonCompanionQueueCoalesced;

/** Record for debug prompt/response log (debug-*-prompts.jsonl) */
export interface PromptLogRecord {
  step: string;
  phase: 1 | 2 | 3;
  iteration: number;
  scope: string;
  phaseExecutionId: string;
  prompt: string;
  systemPrompt: string;
  userInstruction: string;
  response: string;
  timestamp: string;
}
