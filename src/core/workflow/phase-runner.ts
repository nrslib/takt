/**
 * Phase execution logic extracted from engine.ts.
 *
 * Exposes shared phase context plus Phase 2/3 entry points.
 */

import type { WorkflowStep, Language, WorkflowResumePointEntry } from '../models/types.js';
import type { ProviderUsageSnapshot } from '../models/response.js';
import type { StructuredCaller } from '../../agents/structured-caller.js';
import type { PhaseName, PhasePromptParts, JudgeStageEntry, StepProviderInfo } from './types.js';
import type { RunAgentOptions } from '../../agents/runner.js';
import { hasTagBasedRules } from './evaluation/rule-utils.js';
import type { FindingContractInstructionContext } from './instruction/instruction-context.js';
export { runReportPhase, ReportPhaseGenerationError, type ReportPhaseBlockedResult, type ReportPhaseRateLimitedResult } from './report-phase-runner.js';
export { runStatusJudgmentPhase, type StatusJudgmentPhaseResult } from './status-judgment-phase.js';

export interface BasePhaseRunnerContext {
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
  /** Workflow name for observability spans */
  workflowName: string;
  /** Run-local identifier for observability artifact routing */
  observabilityRunId?: string;
  /** Whether OpenTelemetry shadow spans are enabled */
  observabilityEnabled?: boolean;
  /** Optional text sanitizer for observability span attributes */
  sanitizeObservabilityText?: (text: string) => string;
  /** Current workflow stack for observability span parity (phase/judge records) */
  getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  /** Run-local environment values passed to trusted child processes. */
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  /** Stream callback for provider event logging */
  onStream?: import('../../agents/types.js').StreamCallback;
  /** Parent workflow iteration for sub-step phase events */
  iteration?: number;
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
  onProviderAttempt?: (
    providerInfo: StepProviderInfo,
    success: boolean,
    usage: ProviderUsageSnapshot | undefined,
  ) => void;
}

export interface ReportPhaseRunnerContext extends BasePhaseRunnerContext {
  /** Get persona session ID */
  getSessionId: (persona: string) => string | undefined;
  /** Resolve the session key shared by Phase 1 and resume phases */
  resolveSessionKey: (step: WorkflowStep) => string;
  /** Build resume options for a step */
  buildResumeOptions: (step: WorkflowStep, sessionId: string, overrides: Pick<RunAgentOptions, 'maxTurns'>) => RunAgentOptions;
  /** Build options for report phase retry in a new session */
  buildNewSessionReportOptions: (step: WorkflowStep, overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>) => RunAgentOptions;
  buildFallbackReportOptions: (
    step: WorkflowStep,
    failedPrimaryOptions: RunAgentOptions,
    overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>,
  ) => RunAgentOptions | undefined;
  resolveReportFallbackProviderModel: () => StepProviderInfo | undefined;
  /** Update persona session after a phase run */
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  buildFindingContractInstructionContext?: (
    step: WorkflowStep,
    includeRawFindingsSchema: boolean,
  ) => FindingContractInstructionContext | undefined;
  resolveStepProviderModel: (step: WorkflowStep) => StepProviderInfo;
}

export interface StatusJudgmentPhaseContext extends BasePhaseRunnerContext {
  /** Structured caller for phase 3 status judgment */
  structuredCaller: StructuredCaller;
  resolveStepProviderModel: (step: WorkflowStep) => StepProviderInfo;
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
