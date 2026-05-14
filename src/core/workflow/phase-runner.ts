/**
 * Phase execution logic extracted from engine.ts.
 *
 * Exposes shared phase context plus Phase 2/3 entry points.
 */

import type { WorkflowStep, Language } from '../models/types.js';
import type { StructuredCaller } from '../../agents/structured-caller.js';
import type { PhaseName, PhasePromptParts, JudgeStageEntry, ProviderType, StepProviderInfo } from './types.js';
import type { RunAgentOptions } from '../../agents/runner.js';
import { hasTagBasedRules } from './evaluation/rule-utils.js';
export { runReportPhase, type ReportPhaseBlockedResult, type ReportPhaseRateLimitedResult } from './report-phase-runner.js';
export { runStatusJudgmentPhase, type StatusJudgmentPhaseResult } from './status-judgment-phase.js';

export interface PhaseRunnerContext {
  /** Working directory (agent work dir, may be a clone) */
  cwd: string;
  /** Report directory path */
  reportDir: string;
  /** Language for instructions */
  language?: Language;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
  /** Last response from Phase 1 */
  lastResponse?: string;
  /** Parent workflow iteration for sub-step phase events */
  iteration?: number;
  /** Get persona session ID */
  getSessionId: (persona: string) => string | undefined;
  /** Resolve the session key shared by Phase 1 and resume phases */
  resolveSessionKey: (step: WorkflowStep) => string;
  /** Build resume options for a step */
  buildResumeOptions: (step: WorkflowStep, sessionId: string, overrides: Pick<RunAgentOptions, 'maxTurns'>) => RunAgentOptions;
  /** Build options for report phase retry in a new session */
  buildNewSessionReportOptions: (step: WorkflowStep, overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>) => RunAgentOptions;
  /** Update persona session after a phase run */
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  /** Stream callback for provider event logging (passed to judgeStatus) */
  onStream?: import('../../agents/types.js').StreamCallback;
  /** Structured caller for phase 3 status judgment */
  structuredCaller: StructuredCaller;
  /** Resolve effective provider for the current step */
  resolveProvider: (step: WorkflowStep) => ProviderType | undefined;
  resolveStepProviderModel?: (step: WorkflowStep) => StepProviderInfo;
  /** Callback for phase lifecycle logging */
  onPhaseStart?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  /** Callback for phase completion logging */
  onPhaseComplete?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    status: string,
    error?: string,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  /** Callback for Phase 3 internal stage logging */
  onJudgeStage?: (
    step: WorkflowStep,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
}

/**
 * Check if a step needs Phase 3 (status judgment).
 * Returns true when at least one rule requires tag-based detection.
 */
export function needsStatusJudgmentPhase(step: WorkflowStep): boolean {
  return hasTagBasedRules(step);
}
