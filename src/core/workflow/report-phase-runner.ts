import type { AgentResponse, WorkflowStep } from '../models/types.js';
import { resolveAgentErrorMessage } from '../models/response.js';
import type { RunAgentOptions } from '../../agents/runner.js';
import { executeAgent } from '../../agents/agent-usecases.js';
import { parseStructuredOutputObject } from '../../agents/structured-caller/shared.js';
import { createLogger } from '../../shared/utils/index.js';
import {
  PROVIDER_NATIVE_STRUCTURED_OUTPUT_TOOL_NAME,
  type StreamEvent,
} from '../../shared/types/provider.js';
import { buildPhaseExecutionId } from '../../shared/utils/phaseExecutionId.js';
import { buildSessionKey } from './session-key.js';
import { ReportInstructionBuilder } from './instruction/ReportInstructionBuilder.js';
import { getReportFiles } from './output-contract-files.js';
import type { PhasePromptParts, StepProviderInfo } from './types.js';
import type { ReportPhaseRunnerContext } from './phase-runner.js';
import type {
  FindingContractReviewerOutputStrategy,
} from './instruction/instruction-context.js';
import {
  FINDING_REVIEW_PUBLICATION_SCHEMA_REF,
  findingReviewPublicationReportContent,
} from './findings/review-publication-structured-output.js';
import { runWithPhaseSpan } from './observability/workflowSpans.js';
import { writeReportFile } from './report-writer.js';

const log = createLogger('phase-runner');
const REPORT_PHASE_MAX_TURNS = 3;

/** Result when Phase 2 encounters a blocked status */
export type ReportPhaseBlockedResult = {
  blocked: true;
  response: AgentResponse;
  providerInfo: StepProviderInfo;
};
export type ReportPhaseRateLimitedResult = {
  rateLimited: true;
  response: AgentResponse;
  providerInfo: StepProviderInfo;
};
export interface GeneratedReport {
  readonly reportName: string;
  readonly reportContent: string;
  readonly response: AgentResponse;
  readonly attemptIdentity: ReportAttemptIdentity;
}
export interface GeneratedReportPhaseResult {
  readonly reports: readonly GeneratedReport[];
}

export type ReportContentValidationResult =
  | { readonly valid: true }
  | { readonly valid: false };

export type ReportContentValidator = (
  reportContent: string,
) => ReportContentValidationResult;

export interface ReportPhaseGenerationOptions {
  readonly reviewerOutputStrategy?: FindingContractReviewerOutputStrategy;
  readonly validateReportContent?: ReportContentValidator;
  readonly retryMode?: 'standard' | 'single-attempt';
  readonly nextPhaseSequence?: () => number;
}

export interface ReportPhaseRecoveryMetadata {
  readonly requiresFreshPhase1: boolean;
  readonly failureReasons: readonly ReportRetryFailureReason[];
}

export interface ReportAttemptIdentity {
  readonly providerInfo: StepProviderInfo;
  readonly sessionKey: string;
  readonly sessionId: string | undefined;
  /** Phase 2 の実試行に渡した capability-sensitive options の完全なスナップショット。 */
  readonly agentOptions: Readonly<RunAgentOptions>;
}

class ReportPhaseToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportPhaseToolCallError';
  }
}

export class ReportPhaseGenerationError extends Error {
  constructor(
    message: string,
    readonly failureReason: ReportRetryFailureReason,
    readonly recovery: ReportPhaseRecoveryMetadata,
  ) {
    super(message);
    this.name = 'ReportPhaseGenerationError';
  }
}

/**
 * Phase 2: Report output.
 * Resumes the agent session with no tools to request report content.
 * Each report file is generated individually in a loop.
 * 通常レポートは plain text をそのまま扱う。Finding Contract reviewer は
 * structured publication の reportContent だけを正準本文として扱う。
 */
export async function runReportPhase(
  step: WorkflowStep,
  stepIteration: number,
  ctx: ReportPhaseRunnerContext,
): Promise<ReportPhaseBlockedResult | ReportPhaseRateLimitedResult | void> {
  return executeReportPhase(step, stepIteration, ctx, {}, (report) => {
    writeReportFile(ctx.reportDir, report.reportName, report.reportContent);
  });
}

export async function generateReportPhase(
  step: WorkflowStep,
  stepIteration: number,
  ctx: ReportPhaseRunnerContext,
  options: ReportPhaseGenerationOptions = {},
): Promise<GeneratedReportPhaseResult | ReportPhaseBlockedResult | ReportPhaseRateLimitedResult> {
  const reports: GeneratedReport[] = [];
  const result = await executeReportPhase(step, stepIteration, ctx, options, (report) => {
    reports.push(report);
  });
  return result ?? { reports };
}

function buildReportFindingContractContext(
  step: WorkflowStep,
  ctx: ReportPhaseRunnerContext,
  reviewerOutputStrategy: FindingContractReviewerOutputStrategy | undefined,
) {
  const context = ctx.buildFindingContractInstructionContext?.(
    step,
    reviewerOutputStrategy,
  );
  if (
    reviewerOutputStrategy?.reportGeneration !== 'structured'
    || context?.reviewer?.mode !== 'structured'
    || step.structuredOutput === undefined
  ) {
    return context;
  }
  return {
    ...context,
    reviewer: {
      ...context.reviewer,
      rawFindingsStructuredOutput: step.structuredOutput,
    },
  };
}

async function executeReportPhase(
  step: WorkflowStep,
  stepIteration: number,
  ctx: ReportPhaseRunnerContext,
  options: ReportPhaseGenerationOptions,
  acceptReport: (report: GeneratedReport) => void,
): Promise<ReportPhaseBlockedResult | ReportPhaseRateLimitedResult | void> {
  const reviewerOutputStrategy = options.reviewerOutputStrategy;
  const primarySessionKey = ctx.resolveSessionKey(step);
  let currentSessionId = ctx.getSessionId(primarySessionKey);
  const hasLastResponse = ctx.lastResponse != null && ctx.lastResponse.trim().length > 0;

  log.debug('Running report phase', {
    step: step.name,
    hasSession: currentSessionId !== undefined,
    hasLastResponse,
  });

  const reportFiles = getReportFiles(step.outputContracts);
  if (reportFiles.length === 0) {
    log.debug('No report files configured, skipping report phase');
    return;
  }

  let localPhaseSequence = 0;
  const nextPhaseSequence = options.nextPhaseSequence
    ?? (() => ++localPhaseSequence);
  for (const fileName of reportFiles) {
    const failureReasons = new Set<ReportRetryFailureReason>();
    if (!fileName) {
      throw new Error(`Invalid report file name: ${fileName}`);
    }

    if (!currentSessionId && !hasLastResponse) {
      throw new Error(`Report phase requires a session to resume, but no sessionId found for persona "${primarySessionKey}" in step "${step.name}"`);
    }

    log.debug('Generating report file', { step: step.name, fileName });

    const firstAttemptInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      task: ctx.task,
      reportDir: ctx.reportDir,
      stepIteration,
      language: ctx.language,
      targetFile: fileName,
      lastResponse: currentSessionId ? undefined : ctx.lastResponse,
      findingContract: buildReportFindingContractContext(
        step,
        ctx,
        reviewerOutputStrategy,
      ),
    }).build();
    let firstAttemptOptions: RunAgentOptions;
    if (currentSessionId === undefined) {
      firstAttemptOptions = buildNewSessionRetryOptions(step, ctx);
    } else {
      firstAttemptOptions = ctx.buildResumeOptions(step, currentSessionId, {
        maxTurns: REPORT_PHASE_MAX_TURNS,
      });
    }
    const firstAttemptPhaseExecutionId = nextReportPhaseExecutionId(
      step.name,
      ctx.iteration,
      nextPhaseSequence(),
    );

    const firstAttempt = await runSingleReportAttempt(
      step,
      firstAttemptInstruction,
      firstAttemptOptions,
      ctx,
      firstAttemptPhaseExecutionId,
      options.validateReportContent,
    );
    if (firstAttempt.kind === 'blocked') {
      return {
        blocked: true,
        response: firstAttempt.response,
        providerInfo: firstAttempt.providerInfo,
      };
    }
    if (firstAttempt.kind === 'rate_limited') {
      return {
        rateLimited: true,
        response: firstAttempt.response,
        providerInfo: firstAttempt.providerInfo,
      };
    }
    if (firstAttempt.kind === 'success') {
      acceptReport({
        reportName: fileName,
        reportContent: firstAttempt.content,
        response: firstAttempt.response,
        attemptIdentity: firstAttempt.attemptIdentity,
      });
      currentSessionId = firstAttempt.attemptIdentity.sessionId;
      ctx.updatePersonaSession(firstAttempt.attemptIdentity.sessionKey, currentSessionId);
      log.debug('Report file generated', { step: step.name, fileName });
      continue;
    }
    failureReasons.add(firstAttempt.failureReason);

    if (options.retryMode === 'single-attempt' || !hasLastResponse) {
      throw new ReportPhaseGenerationError(
        `Report phase failed for ${fileName}: ${firstAttempt.errorMessage}`,
        firstAttempt.failureReason,
        buildReportPhaseRecoveryMetadata(failureReasons),
      );
    }

    const baseRetryInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      task: ctx.task,
      reportDir: ctx.reportDir,
      stepIteration,
      language: ctx.language,
      targetFile: fileName,
      lastResponse: ctx.lastResponse,
      findingContract: buildReportFindingContractContext(
        step,
        ctx,
        reviewerOutputStrategy,
      ),
    }).build();
    const retryInstruction = firstAttempt.failureReason === 'invalid_output'
      ? [
          baseRetryInstruction,
          '',
          'The previous report was rejected by deterministic output validation.',
          'Generate the complete report again from the authoritative Phase 1 response.',
          'Do not summarize, quote, repair, or reuse the rejected report.',
        ].join('\n')
      : baseRetryInstruction;
    const retryOptions = buildNewSessionRetryOptions(step, ctx);
    let retryFailure: Extract<ReportAttemptResult, { kind: 'retryable_failure' }> = firstAttempt;
    let fallbackBaseOptions = firstAttemptOptions;

    if (currentSessionId || firstAttempt.failureReason === 'invalid_output') {
      log.info('Report phase failed, retrying with new session', {
        step: step.name,
        fileName,
        reason: firstAttempt.failureReason,
      });

      const retryAttemptPhaseExecutionId = nextReportPhaseExecutionId(
        step.name,
        ctx.iteration,
        nextPhaseSequence(),
      );

      const retryAttempt = await runSingleReportAttempt(
        step,
        retryInstruction,
        retryOptions,
        ctx,
        retryAttemptPhaseExecutionId,
        options.validateReportContent,
      );
      if (retryAttempt.kind === 'blocked') {
        return {
          blocked: true,
          response: retryAttempt.response,
          providerInfo: retryAttempt.providerInfo,
        };
      }
      if (retryAttempt.kind === 'rate_limited') {
        return {
          rateLimited: true,
          response: retryAttempt.response,
          providerInfo: retryAttempt.providerInfo,
        };
      }
      if (retryAttempt.kind === 'success') {
        acceptReport({
          reportName: fileName,
          reportContent: retryAttempt.content,
          response: retryAttempt.response,
          attemptIdentity: retryAttempt.attemptIdentity,
        });
        currentSessionId = retryAttempt.attemptIdentity.sessionId;
        ctx.updatePersonaSession(retryAttempt.attemptIdentity.sessionKey, currentSessionId);
        log.debug('Report file generated', { step: step.name, fileName });
        continue;
      }

      retryFailure = retryAttempt;
      failureReasons.add(retryAttempt.failureReason);
      fallbackBaseOptions = retryOptions;
    }

    const fallbackOptions = buildFallbackReportOptions(step, fallbackBaseOptions, ctx);
    if (fallbackOptions === undefined) {
      throw new ReportPhaseGenerationError(
        `Report phase failed for ${fileName}: ${retryFailure.errorMessage}`,
        retryFailure.failureReason,
        buildReportPhaseRecoveryMetadata(failureReasons),
      );
    }

    log.info('Report phase failed, falling back to report provider', {
      step: step.name,
      fileName,
      reason: retryFailure.failureReason,
      provider: fallbackOptions.resolvedProvider,
    });

    const fallbackAttemptPhaseExecutionId = nextReportPhaseExecutionId(
      step.name,
      ctx.iteration,
      nextPhaseSequence(),
    );
    const fallbackAttempt = await runSingleReportAttempt(
      step,
      retryInstruction,
      fallbackOptions,
      ctx,
      fallbackAttemptPhaseExecutionId,
      options.validateReportContent,
    );
    if (fallbackAttempt.kind === 'blocked') {
      return {
        blocked: true,
        response: fallbackAttempt.response,
        providerInfo: fallbackAttempt.providerInfo,
      };
    }
    if (fallbackAttempt.kind === 'rate_limited') {
      return {
        rateLimited: true,
        response: fallbackAttempt.response,
        providerInfo: fallbackAttempt.providerInfo,
      };
    }
    if (fallbackAttempt.kind === 'retryable_failure') {
      failureReasons.add(fallbackAttempt.failureReason);
      throw new ReportPhaseGenerationError(
        `Report phase failed for ${fileName}: ${fallbackAttempt.errorMessage}`,
        fallbackAttempt.failureReason,
        buildReportPhaseRecoveryMetadata(failureReasons),
      );
    }

    acceptReport({
      reportName: fileName,
      reportContent: fallbackAttempt.content,
      response: fallbackAttempt.response,
      attemptIdentity: fallbackAttempt.attemptIdentity,
    });
    if (fallbackAttempt.attemptIdentity.sessionId !== undefined) {
      ctx.updatePersonaSession(
        fallbackAttempt.attemptIdentity.sessionKey,
        fallbackAttempt.attemptIdentity.sessionId,
      );
    }
    log.debug('Report file generated by fallback provider', { step: step.name, fileName });
  }

  log.debug('Report phase complete', { step: step.name, filesGenerated: reportFiles.length });
}

function nextReportPhaseExecutionId(stepName: string, iteration: number | undefined, sequence: number): string | undefined {
  if (iteration == null) {
    return undefined;
  }
  return buildPhaseExecutionId({
    step: stepName,
    iteration,
    phase: 2,
    sequence,
  });
}

function buildNewSessionRetryOptions(step: WorkflowStep, ctx: ReportPhaseRunnerContext): RunAgentOptions {
  return ctx.buildNewSessionReportOptions(step, {
    allowedTools: [],
    maxTurns: REPORT_PHASE_MAX_TURNS,
  });
}

function buildFallbackReportOptions(
  step: WorkflowStep,
  retryOptions: RunAgentOptions,
  ctx: ReportPhaseRunnerContext,
): RunAgentOptions | undefined {
  return ctx.buildFallbackReportOptions(step, retryOptions, {
    allowedTools: [],
    maxTurns: REPORT_PHASE_MAX_TURNS,
  });
}

function buildReportPhaseToolUseError(tool: string): ReportPhaseToolCallError {
  return new ReportPhaseToolCallError(`Report phase does not allow tool calls, but provider emitted tool "${tool}".`);
}

function buildReportPhaseToolResultError(): ReportPhaseToolCallError {
  return new ReportPhaseToolCallError('Report phase does not allow tool results.');
}

/**
 * Phase 2 のツール禁止ガード。
 *
 * outputSchema を渡した attempt では、provider がネイティブ構造化出力を
 * 疑似ツール呼び出しとして表現することがある（OpenCode の StructuredOutput）。
 * これはエンジン自身が要求した収集機構であり、エージェントのツール使用ではないので
 * 拒否しない。codex は --output-schema、claude は SDK の outputFormat で扱うため
 * そもそもツールイベントを出さない。
 *
 * 構造化出力を要求していない attempt での StructuredOutput 呼び出しは、
 * 汚染セッション由来の本物の違反なので従来どおり拒否する。
 */
function createReportPhaseToolCallDetector(
  allowsNativeStructuredOutputTool: boolean,
): (event: StreamEvent) => ReportPhaseToolCallError | undefined {
  const nativeStructuredOutputToolIds = new Set<string>();
  return (event) => {
    if (event.type === 'tool_use') {
      if (
        allowsNativeStructuredOutputTool
        && event.data.tool === PROVIDER_NATIVE_STRUCTURED_OUTPUT_TOOL_NAME
      ) {
        nativeStructuredOutputToolIds.add(event.data.id);
        return undefined;
      }
      return buildReportPhaseToolUseError(event.data.tool);
    }

    if (event.type === 'tool_result') {
      if (
        event.data.id !== undefined
        && nativeStructuredOutputToolIds.has(event.data.id)
      ) {
        return undefined;
      }
      return buildReportPhaseToolResultError();
    }

    return undefined;
  };
}

type ReportAttemptResult =
  | {
    kind: 'success';
    content: string;
    response: AgentResponse;
    attemptIdentity: ReportAttemptIdentity;
  }
  | { kind: 'blocked'; response: AgentResponse; providerInfo: StepProviderInfo }
  | { kind: 'rate_limited'; response: AgentResponse; providerInfo: StepProviderInfo }
  | {
    kind: 'retryable_failure';
    errorMessage: string;
    failureReason: ReportRetryFailureReason;
    errorKind?: AgentResponse['errorKind'];
  };

export type ReportRetryFailureReason =
  | 'tool_call'
  | 'empty_output'
  | 'provider_error'
  | 'invalid_output';

function isFreshPhase1RecoveryFailure(
  failureReason: ReportRetryFailureReason,
): boolean {
  return failureReason !== 'provider_error';
}

function buildReportPhaseRecoveryMetadata(
  failureReasons: ReadonlySet<ReportRetryFailureReason>,
): ReportPhaseRecoveryMetadata {
  const reasons = [...failureReasons];
  return {
    requiresFreshPhase1: reasons.some(isFreshPhase1RecoveryFailure),
    failureReasons: reasons,
  };
}

interface ReportRetryableFailure {
  readonly failureReason: ReportRetryFailureReason;
  readonly errorMessage: string;
}

async function runSingleReportAttempt(
  step: WorkflowStep,
  instruction: string,
  options: RunAgentOptions,
  ctx: ReportPhaseRunnerContext,
  phaseExecutionId: string | undefined,
  validateReportContent: ReportContentValidator | undefined,
): Promise<ReportAttemptResult> {
  let didEmitPhaseStart = false;
  let resolvedPromptParts: PhasePromptParts | undefined;
  let reportToolCallError: ReportPhaseToolCallError | undefined;
  const detectReportPhaseToolCall = createReportPhaseToolCallDetector(
    options.outputSchema !== undefined,
  );
  const callOptions: RunAgentOptions = {
    ...options,
    onPromptResolved: (promptParts) => {
      resolvedPromptParts = promptParts;
      ctx.onPhaseStart?.(step, 2, 'report', instruction, promptParts, phaseExecutionId, ctx.iteration);
      didEmitPhaseStart = true;
    },
    onStream: (event) => {
      const detected = detectReportPhaseToolCall(event);
      if (detected !== undefined) {
        reportToolCallError ??= detected;
        throw reportToolCallError;
      }
      if (reportToolCallError !== undefined) {
        throw reportToolCallError;
      }

      const streamCallback = options.onStream ?? ctx.onStream;
      streamCallback?.(event);
    },
  };

  let response: AgentResponse;
  let classifiedFailure: ReportRetryableFailure | undefined;
  let didClassifySpanOutcome = false;
  const attemptProviderInfo = resolveReportAttemptProviderInfo(step, options, ctx);
  let didRecordProviderAttempt = false;
  let providerResponse: AgentResponse | undefined;
  try {
    response = await runWithPhaseSpan({
      enabled: ctx.observabilityEnabled === true,
      runId: ctx.observabilityRunId,
      workflowName: ctx.workflowName,
      step,
      iteration: ctx.iteration,
      phase: 2,
      phaseName: 'report',
      instruction,
      phaseExecutionId,
      workflowStack: ctx.getCurrentWorkflowStack?.(),
      sanitizeText: ctx.sanitizeObservabilityText,
      providerInfo: attemptProviderInfo,
      getPromptParts: () => resolvedPromptParts,
    }, async () => {
      const result = await executeAgent(step.persona, instruction, callOptions);
      providerResponse = result;
      return result;
    }, (result) => {
      didClassifySpanOutcome = true;
      classifiedFailure = classifyRetryableFailure(
        step,
        result,
        validateReportContent,
      );
      return buildReportAttemptSpanOutcome(
        result,
        reportToolCallError,
        classifiedFailure,
      );
    });
    if (!didClassifySpanOutcome) {
      classifiedFailure = classifyRetryableFailure(
        step,
        response,
        validateReportContent,
      );
    }
    didRecordProviderAttempt = true;
    ctx.onProviderAttempt?.(
      attemptProviderInfo,
      response.status === 'done'
        && reportToolCallError === undefined
        && classifiedFailure === undefined,
      response.providerUsage,
    );
    if (!didEmitPhaseStart) {
      throw new Error(`Missing prompt parts for phase start: ${step.name}:2`);
    }
  } catch (error) {
    if (!didRecordProviderAttempt) {
      didRecordProviderAttempt = true;
      ctx.onProviderAttempt?.(
        attemptProviderInfo,
        false,
        providerResponse?.providerUsage,
      );
    }
    if (error instanceof ReportPhaseToolCallError) {
      ctx.onPhaseComplete?.(step, 2, 'report', '', 'error', error.message, phaseExecutionId, ctx.iteration);
      return { kind: 'retryable_failure', errorMessage: error.message, failureReason: 'tool_call' };
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    if (didEmitPhaseStart) {
      ctx.onPhaseComplete?.(step, 2, 'report', '', 'error', errorMsg, phaseExecutionId, ctx.iteration);
    }
    throw error;
  }

  if (reportToolCallError !== undefined) {
    ctx.onPhaseComplete?.(step, 2, 'report', '', 'error', reportToolCallError.message, phaseExecutionId, ctx.iteration);
    return { kind: 'retryable_failure', errorMessage: reportToolCallError.message, failureReason: 'tool_call' };
  }

  if (response.status === 'blocked') {
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, undefined, phaseExecutionId, ctx.iteration);
    return { kind: 'blocked', response, providerInfo: attemptProviderInfo };
  }

  if (response.status === 'rate_limited' || response.errorKind === 'rate_limit') {
    const errorMessage = resolveAgentErrorMessage(response.errorKind, response.error || response.content);
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, errorMessage, phaseExecutionId, ctx.iteration);
    return {
      kind: 'rate_limited',
      providerInfo: attemptProviderInfo,
      response: {
        ...response,
        status: 'rate_limited',
        content: '',
        error: errorMessage,
      },
    };
  }

  if (response.status !== 'done') {
    const fallbackMessage = response.error || response.content || 'Unknown error';
    const errorMessage = resolveAgentErrorMessage(response.errorKind, fallbackMessage);
    ctx.onPhaseComplete?.(
      step,
      2,
      'report',
      '',
      response.status,
      buildRetryableFailureEventError('provider_error', response.status),
      phaseExecutionId,
      ctx.iteration,
    );
    return {
      kind: 'retryable_failure',
      errorMessage,
      failureReason: 'provider_error',
      errorKind: response.errorKind,
    };
  }

  const finalReportContent = resolveReportContent(step, response);
  if (classifiedFailure !== undefined) {
    ctx.onPhaseComplete?.(
      step,
      2,
      'report',
      '',
      'error',
      classifiedFailure.errorMessage,
      phaseExecutionId,
      ctx.iteration,
    );
    return {
      kind: 'retryable_failure',
      errorMessage: classifiedFailure.errorMessage,
      failureReason: classifiedFailure.failureReason,
    };
  }

  ctx.onPhaseComplete?.(step, 2, 'report', finalReportContent, response.status, undefined, phaseExecutionId, ctx.iteration);
  return {
    kind: 'success',
    content: finalReportContent,
    response,
    attemptIdentity: buildReportAttemptIdentity(step, options, response, ctx),
  };
}

function buildReportAttemptSpanOutcome(
  result: AgentResponse,
  reportToolCallError: ReportPhaseToolCallError | undefined,
  retryableFailure: ReportRetryableFailure | undefined,
) {
  if (reportToolCallError !== undefined) {
    return {
      status: 'error',
      content: '',
      error: reportToolCallError.message,
      providerUsage: result.providerUsage,
    };
  }

  if (retryableFailure !== undefined) {
    return {
      status: 'error',
      content: '',
      error: retryableFailure.errorMessage,
      providerUsage: result.providerUsage,
    };
  }

  return {
    status: result.status,
    content: result.content,
    error: result.error,
    providerUsage: result.providerUsage,
  };
}

function classifyRetryableFailure(
  step: WorkflowStep,
  response: AgentResponse,
  validateReportContent: ReportContentValidator | undefined,
): ReportRetryableFailure | undefined {
  if (response.status === 'blocked' || response.status === 'rate_limited' || response.errorKind === 'rate_limit') {
    return undefined;
  }
  if (response.status !== 'done') {
    return {
      failureReason: 'provider_error',
      errorMessage: buildRetryableFailureEventError(
        'provider_error',
        response.status,
      ),
    };
  }
  const finalReportContent = resolveReportContent(step, response);
  if (finalReportContent.trim().length === 0) {
    return {
      failureReason: 'empty_output',
      errorMessage: buildRetryableFailureEventError(
        'empty_output',
        response.status,
      ),
    };
  }
  const validation = validateReportContent?.(finalReportContent);
  if (validation !== undefined && !validation.valid) {
    return {
      failureReason: 'invalid_output',
      errorMessage: buildRetryableFailureEventError(
        'invalid_output',
        response.status,
      ),
    };
  }
  return undefined;
}

function resolveReportContent(
  step: WorkflowStep,
  response: AgentResponse,
): string {
  if (step.structuredOutput?.schemaRef !== FINDING_REVIEW_PUBLICATION_SCHEMA_REF) {
    return response.content.trim();
  }
  const structuredOutput = response.structuredOutput
    ?? parseStructuredOutputObject(response.content);
  const reportContent = findingReviewPublicationReportContent(structuredOutput);
  if (reportContent === undefined) {
    throw new Error('Finding review publication reportContent is missing');
  }
  return reportContent;
}

function buildReportAttemptIdentity(
  step: WorkflowStep,
  options: RunAgentOptions,
  response: AgentResponse,
  ctx: ReportPhaseRunnerContext,
): ReportAttemptIdentity {
  const providerInfo = resolveReportAttemptProviderInfo(step, options, ctx);
  const primaryProviderInfo = ctx.resolveStepProviderModel(step);
  const isPrimaryTarget = providerInfo.provider === primaryProviderInfo.provider
    && providerInfo.model === primaryProviderInfo.model;
  return {
    providerInfo,
    sessionKey: isPrimaryTarget
      ? ctx.resolveSessionKey(step)
      : buildSessionKey(step, providerInfo),
    sessionId: response.sessionId ?? options.sessionId,
    agentOptions: Object.freeze({ ...options }),
  };
}

function buildRetryableFailureEventError(
  failureReason: ReportRetryFailureReason,
  status: AgentResponse['status'],
): string {
  if (failureReason === 'empty_output') {
    return 'Report output is empty';
  }
  if (failureReason === 'tool_call') {
    return 'Report phase emitted a tool call';
  }
  if (failureReason === 'invalid_output') {
    return 'Report output failed deterministic validation';
  }
  return `Report phase provider returned status "${status}"`;
}

function resolveReportAttemptProviderInfo(
  step: WorkflowStep,
  options: RunAgentOptions,
  ctx: ReportPhaseRunnerContext,
): StepProviderInfo {
  const providerInfo = ctx.resolveStepProviderModel(step);
  const fallbackProviderInfo = ctx.resolveReportFallbackProviderModel();
  if (
    fallbackProviderInfo?.provider !== undefined
    && options.resolvedProvider === fallbackProviderInfo.provider
    && providerInfo.provider !== fallbackProviderInfo.provider
  ) {
    return {
      ...fallbackProviderInfo,
      model: options.resolvedModel ?? fallbackProviderInfo.model,
      ...(options.resolvedProviderOptions != null
        ? { providerOptions: options.resolvedProviderOptions }
        : {}),
    };
  }
  if (options.resolvedProvider !== undefined || options.resolvedModel !== undefined) {
    return {
      ...providerInfo,
      provider: options.resolvedProvider ?? providerInfo.provider,
      model: options.resolvedModel ?? providerInfo.model,
      ...(options.resolvedProviderOptions != null
        ? { providerOptions: options.resolvedProviderOptions }
        : {}),
    };
  }

  return providerInfo;
}
