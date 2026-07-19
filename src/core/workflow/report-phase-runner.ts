import type { AgentResponse, WorkflowStep } from '../models/types.js';
import { resolveAgentErrorMessage } from '../models/response.js';
import type { RunAgentOptions } from '../../agents/runner.js';
import { executeAgent } from '../../agents/agent-usecases.js';
import { createLogger } from '../../shared/utils/index.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import { buildPhaseExecutionId } from '../../shared/utils/phaseExecutionId.js';
import { ReportInstructionBuilder } from './instruction/ReportInstructionBuilder.js';
import { getReportFiles } from './evaluation/rule-utils.js';
import type { PhasePromptParts, StepProviderInfo } from './types.js';
import type { ReportPhaseRunnerContext } from './phase-runner.js';
import { runWithPhaseSpan } from './observability/workflowSpans.js';
import { writeReportFile } from './report-writer.js';

const log = createLogger('phase-runner');
const REPORT_PHASE_MAX_TURNS = 3;

/** Result when Phase 2 encounters a blocked status */
export type ReportPhaseBlockedResult = { blocked: true; response: AgentResponse };
export type ReportPhaseRateLimitedResult = { rateLimited: true; response: AgentResponse };

class ReportPhaseToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportPhaseToolCallError';
  }
}

export class ReportPhaseGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportPhaseGenerationError';
  }
}

/**
 * Phase 2: Report output.
 * Resumes the agent session with no tools to request report content.
 * Each report file is generated individually in a loop.
 * Plain text responses are written directly to files (no JSON parsing).
 */
export async function runReportPhase(
  step: WorkflowStep,
  stepIteration: number,
  ctx: ReportPhaseRunnerContext,
): Promise<ReportPhaseBlockedResult | ReportPhaseRateLimitedResult | void> {
  const sessionKey = ctx.resolveSessionKey(step);
  let currentSessionId = ctx.getSessionId(sessionKey);
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

  let phaseSequence = 0;
  for (const fileName of reportFiles) {
    if (!fileName) {
      throw new Error(`Invalid report file name: ${fileName}`);
    }

    if (!currentSessionId && !hasLastResponse) {
      throw new Error(`Report phase requires a session to resume, but no sessionId found for persona "${sessionKey}" in step "${step.name}"`);
    }

    log.debug('Generating report file', { step: step.name, fileName });

    const firstAttemptInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      reportDir: ctx.reportDir,
      stepIteration,
      language: ctx.language,
      targetFile: fileName,
      lastResponse: currentSessionId ? undefined : ctx.lastResponse,
      findingContract: ctx.buildFindingContractInstructionContext?.(step, false),
    }).build();
    const firstAttemptOptions = currentSessionId
      ? ctx.buildResumeOptions(step, currentSessionId, {
        maxTurns: REPORT_PHASE_MAX_TURNS,
      })
      : buildNewSessionRetryOptions(step, ctx);
    const firstAttemptPhaseExecutionId = nextReportPhaseExecutionId(step.name, ctx.iteration, ++phaseSequence);

    const firstAttempt = await runSingleReportAttempt(
      step,
      firstAttemptInstruction,
      firstAttemptOptions,
      ctx,
      firstAttemptPhaseExecutionId,
    );
    if (firstAttempt.kind === 'blocked') {
      return { blocked: true, response: firstAttempt.response };
    }
    if (firstAttempt.kind === 'rate_limited') {
      return { rateLimited: true, response: firstAttempt.response };
    }
    if (firstAttempt.kind === 'success') {
      writeReportFile(ctx.reportDir, fileName, firstAttempt.content);
      if (firstAttempt.response.sessionId) {
        currentSessionId = firstAttempt.response.sessionId;
        ctx.updatePersonaSession(sessionKey, currentSessionId);
      }
      log.debug('Report file generated', { step: step.name, fileName });
      continue;
    }

    if (!hasLastResponse) {
      throw new ReportPhaseGenerationError(`Report phase failed for ${fileName}: ${firstAttempt.errorMessage}`);
    }

    const retryInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      reportDir: ctx.reportDir,
      stepIteration,
      language: ctx.language,
      targetFile: fileName,
      lastResponse: ctx.lastResponse,
      findingContract: ctx.buildFindingContractInstructionContext?.(step, false),
    }).build();
    const retryOptions = buildNewSessionRetryOptions(step, ctx);
    let retryFailure: Extract<ReportAttemptResult, { kind: 'retryable_failure' }> = firstAttempt;
    let fallbackBaseOptions = firstAttemptOptions;

    if (currentSessionId) {
      log.info('Report phase failed, retrying with new session', {
        step: step.name,
        fileName,
        reason: firstAttempt.failureReason,
      });

      const retryAttemptPhaseExecutionId = nextReportPhaseExecutionId(step.name, ctx.iteration, ++phaseSequence);

      const retryAttempt = await runSingleReportAttempt(step, retryInstruction, retryOptions, ctx, retryAttemptPhaseExecutionId);
      if (retryAttempt.kind === 'blocked') {
        return { blocked: true, response: retryAttempt.response };
      }
      if (retryAttempt.kind === 'rate_limited') {
        return { rateLimited: true, response: retryAttempt.response };
      }
      if (retryAttempt.kind === 'success') {
        writeReportFile(ctx.reportDir, fileName, retryAttempt.content);
        currentSessionId = retryAttempt.response.sessionId;
        ctx.updatePersonaSession(sessionKey, currentSessionId);
        log.debug('Report file generated', { step: step.name, fileName });
        continue;
      }

      retryFailure = retryAttempt;
      fallbackBaseOptions = retryOptions;
    }

    const fallbackOptions = buildFallbackReportOptions(step, fallbackBaseOptions, ctx);
    if (fallbackOptions === undefined) {
      throw new ReportPhaseGenerationError(`Report phase failed for ${fileName}: ${retryFailure.errorMessage}`);
    }

    log.info('Report phase failed, falling back to report provider', {
      step: step.name,
      fileName,
      reason: retryFailure.failureReason,
      provider: fallbackOptions.resolvedProvider,
    });

    const fallbackAttemptPhaseExecutionId = nextReportPhaseExecutionId(step.name, ctx.iteration, ++phaseSequence);
    const fallbackAttempt = await runSingleReportAttempt(
      step,
      retryInstruction,
      fallbackOptions,
      ctx,
      fallbackAttemptPhaseExecutionId,
    );
    if (fallbackAttempt.kind === 'blocked') {
      return { blocked: true, response: fallbackAttempt.response };
    }
    if (fallbackAttempt.kind === 'rate_limited') {
      return { rateLimited: true, response: fallbackAttempt.response };
    }
    if (fallbackAttempt.kind === 'retryable_failure') {
      throw new ReportPhaseGenerationError(`Report phase failed for ${fileName}: ${fallbackAttempt.errorMessage}`);
    }

    writeReportFile(ctx.reportDir, fileName, fallbackAttempt.content);
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

function detectReportPhaseToolCall(event: StreamEvent): ReportPhaseToolCallError | undefined {
  if (event.type === 'tool_use') {
    return buildReportPhaseToolUseError(event.data.tool);
  }

  if (event.type === 'tool_result') {
    return buildReportPhaseToolResultError();
  }

  return undefined;
}

type ReportAttemptResult =
  | { kind: 'success'; content: string; response: AgentResponse }
  | { kind: 'blocked'; response: AgentResponse }
  | { kind: 'rate_limited'; response: AgentResponse }
  | {
    kind: 'retryable_failure';
    errorMessage: string;
    failureReason: ReportRetryFailureReason;
    errorKind?: AgentResponse['errorKind'];
  };

type ReportRetryFailureReason = 'tool_call' | 'empty_output' | 'provider_error';

async function runSingleReportAttempt(
  step: WorkflowStep,
  instruction: string,
  options: RunAgentOptions,
  ctx: ReportPhaseRunnerContext,
  phaseExecutionId: string | undefined,
): Promise<ReportAttemptResult> {
  let didEmitPhaseStart = false;
  let resolvedPromptParts: PhasePromptParts | undefined;
  let reportToolCallError: ReportPhaseToolCallError | undefined;
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
  const attemptProviderInfo = resolveReportAttemptProviderInfo(step, options, ctx);
  let didRecordProviderAttempt = false;
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
    }, () => executeAgent(step.persona, instruction, callOptions), (result) =>
      buildReportAttemptSpanOutcome(result, reportToolCallError));
    ctx.onProviderAttempt?.(
      attemptProviderInfo,
      response.status === 'done'
        && reportToolCallError === undefined
        && classifyRetryableFailure(response) === undefined,
      response.providerUsage,
    );
    didRecordProviderAttempt = true;
    if (!didEmitPhaseStart) {
      throw new Error(`Missing prompt parts for phase start: ${step.name}:2`);
    }
  } catch (error) {
    if (!didRecordProviderAttempt) {
      ctx.onProviderAttempt?.(attemptProviderInfo, false, undefined);
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
    return { kind: 'blocked', response };
  }

  if (response.status === 'rate_limited' || response.errorKind === 'rate_limit') {
    const errorMessage = resolveAgentErrorMessage(response.errorKind, response.error || response.content);
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, errorMessage, phaseExecutionId, ctx.iteration);
    return {
      kind: 'rate_limited',
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

  const trimmedContent = response.content.trim();
  if (trimmedContent.length === 0) {
    const errorMessage = 'Report output is empty';
    ctx.onPhaseComplete?.(step, 2, 'report', '', 'error', errorMessage, phaseExecutionId, ctx.iteration);
    return { kind: 'retryable_failure', errorMessage, failureReason: 'empty_output' };
  }

  ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, undefined, phaseExecutionId, ctx.iteration);
  return { kind: 'success', content: trimmedContent, response };
}

function buildReportAttemptSpanOutcome(
  result: AgentResponse,
  reportToolCallError: ReportPhaseToolCallError | undefined,
) {
  if (reportToolCallError !== undefined) {
    return {
      status: 'error',
      content: '',
      error: reportToolCallError.message,
      providerUsage: result.providerUsage,
    };
  }

  const retryableFailure = classifyRetryableFailure(result);
  if (retryableFailure !== undefined) {
    return {
      status: 'error',
      content: '',
      error: buildRetryableFailureEventError(retryableFailure, result.status),
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

function classifyRetryableFailure(response: AgentResponse): ReportRetryFailureReason | undefined {
  if (response.status === 'blocked' || response.status === 'rate_limited' || response.errorKind === 'rate_limit') {
    return undefined;
  }
  if (response.status !== 'done') {
    return 'provider_error';
  }
  return response.content.trim().length === 0 ? 'empty_output' : undefined;
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
    };
  }
  if (options.resolvedProvider !== undefined || options.resolvedModel !== undefined) {
    return {
      ...providerInfo,
      provider: options.resolvedProvider ?? providerInfo.provider,
      model: options.resolvedModel ?? providerInfo.model,
    };
  }

  return providerInfo;
}
