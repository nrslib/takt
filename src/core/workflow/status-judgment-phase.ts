import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkflowStep, RuleMatchMethod } from '../models/types.js';
import { StatusJudgmentBuilder, type StatusJudgmentContext } from './instruction/StatusJudgmentBuilder.js';
import { getJudgmentReportFiles } from './output-contract-files.js';
import { createLogger } from '../../shared/utils/index.js';
import type { StatusJudgmentPhaseContext } from './phase-runner.js';
import { buildPhaseExecutionId } from '../../shared/utils/phaseExecutionId.js';
import { recordJudgeStageSpan, runWithPhaseSpan } from './observability/workflowSpans.js';
import { semanticRuleCandidatesOf } from '../models/workflow-rule-condition.js';
import { RuleDetectionExhaustedError } from './evaluation/RuleDetectionExhaustedError.js';

const log = createLogger('phase-runner');

/** Result of Phase 3 status judgment, including the detection method. */
export interface StatusJudgmentPhaseResult {
  label: string;
  method: RuleMatchMethod;
}

/**
 * Build the base context (shared by structured output and tag instructions).
 */
function buildBaseContext(
  step: WorkflowStep,
  ctx: StatusJudgmentPhaseContext,
): Omit<StatusJudgmentContext, 'structuredOutput'> | undefined {
  const reportFiles = getJudgmentReportFiles(step.outputContracts);

  if (reportFiles.length > 0) {
    const reports: string[] = [];
    for (const fileName of reportFiles) {
      const filePath = resolve(ctx.reportDir, fileName);
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, 'utf-8');
      reports.push(`# ${fileName}\n\n${content}`);
    }
    if (reports.length > 0) {
      return {
        language: ctx.language,
        interactive: ctx.interactive,
        reportContent: reports.join('\n\n---\n\n'),
        inputSource: 'report',
      };
    }
    throw new Error(`Status judgment requires existing use_judge reports for step "${step.name}"`);
  }

  if (!ctx.lastResponse) return undefined;

  return {
    language: ctx.language,
    interactive: ctx.interactive,
    lastResponse: ctx.lastResponse,
    inputSource: 'response',
  };
}

/**
 * Phase 3: Status judgment.
 *
 * Builds two instructions from the same context:
 * - Structured output instruction (JSON schema)
 * - Tag instruction (free-form tag detection)
 *
 * `judgeStatus()` tries them in order: structured → tag → ai_judge.
 */
export async function runStatusJudgmentPhase(
  step: WorkflowStep,
  ctx: StatusJudgmentPhaseContext,
): Promise<StatusJudgmentPhaseResult> {
  log.debug('Running status judgment phase', { step: step.name });
  if (!step.rules || step.rules.length === 0) {
    throw new Error(`Status judgment requires rules for step "${step.name}"`);
  }
  const rules = step.rules;
  const semanticCandidates = semanticRuleCandidatesOf(rules, ctx.interactive === true);
  if (semanticCandidates.length < 2) {
    throw new Error(`Status judgment requires multiple semantic rules for step "${step.name}"`);
  }

  const baseContext = buildBaseContext(step, ctx);
  if (!baseContext) {
    throw new Error(`Status judgment requires report or lastResponse for step "${step.name}"`);
  }

  const structuredInstruction = new StatusJudgmentBuilder(step, {
    ...baseContext,
    semanticCandidates,
    structuredOutput: true,
  }).build();

  const tagInstruction = new StatusJudgmentBuilder(step, {
    ...baseContext,
    semanticCandidates,
  }).build();
  if (!ctx.iteration || !Number.isInteger(ctx.iteration) || ctx.iteration <= 0) {
    throw new Error(`Status judgment requires iteration for step "${step.name}"`);
  }
  const phaseExecutionId = buildPhaseExecutionId({
    step: step.name,
    iteration: ctx.iteration,
    phase: 3,
    sequence: 1,
  });

  let didEmitPhaseStart = false;
  let resolvedPromptParts: { systemPrompt: string; userInstruction: string } | undefined;
  const emitPhaseStart = (promptParts: { systemPrompt: string; userInstruction: string }): void => {
    resolvedPromptParts = promptParts;
    ctx.onPhaseStart?.(step, 3, 'judge', structuredInstruction, promptParts, phaseExecutionId, ctx.iteration);
    didEmitPhaseStart = true;
  };

  let stepProvider: ReturnType<StatusJudgmentPhaseContext['resolveStepProviderModel']> | undefined;
  let didRecordProviderAttempt = false;
  try {
    const resolvedStepProvider = ctx.resolveStepProviderModel(step);
    stepProvider = resolvedStepProvider;
    const result = await runWithPhaseSpan(
      {
        enabled: ctx.observabilityEnabled === true,
        runId: ctx.observabilityRunId,
        workflowName: ctx.workflowName,
        step,
        iteration: ctx.iteration,
        phase: 3,
        phaseName: 'judge',
        instruction: structuredInstruction,
        phaseExecutionId,
        workflowStack: ctx.getCurrentWorkflowStack?.(),
        sanitizeText: ctx.sanitizeObservabilityText,
        providerInfo: resolvedStepProvider,
        getPromptParts: () => resolvedPromptParts,
      },
      async () => {
        const judgeResult = await ctx.structuredCaller.judgeStatus(structuredInstruction, tagInstruction, semanticCandidates, {
        cwd: ctx.cwd,
        stepName: step.name,
        provider: resolvedStepProvider.provider,
        resolvedProvider: resolvedStepProvider.provider,
        resolvedModel: resolvedStepProvider.model,
        language: ctx.language,
        abortSignal: ctx.abortSignal,
        childProcessEnv: ctx.childProcessEnv,
        onStream: ctx.onStream,
        onStructuredPromptResolved: (promptParts) => {
          if (!didEmitPhaseStart) {
            emitPhaseStart(promptParts);
          }
        },
        onJudgeStage: (entry) => {
          didRecordProviderAttempt = true;
          ctx.onProviderAttempt?.(
            resolvedStepProvider,
            entry.status === 'done',
            entry.providerUsage,
          );
          recordJudgeStageSpan({
            enabled: ctx.observabilityEnabled === true,
            runId: ctx.observabilityRunId,
            workflowName: ctx.workflowName,
            step,
            iteration: ctx.iteration,
            phaseExecutionId,
            workflowStack: ctx.getCurrentWorkflowStack?.(),
            entry,
            sanitizeText: ctx.sanitizeObservabilityText,
            providerInfo: resolvedStepProvider,
          });
          ctx.onJudgeStage?.(step, 3, 'judge', entry, phaseExecutionId, ctx.iteration);
        },
        });
        const label = semanticCandidates[judgeResult.candidateIndex]?.label;
        if (label === undefined) {
          throw new RuleDetectionExhaustedError(step.name);
        }
        if (!didEmitPhaseStart) {
          throw new Error(`Missing prompt parts for phase start: ${step.name}:3`);
        }
        return { candidateIndex: judgeResult.candidateIndex, label, method: judgeResult.method };
      }, (judgment) => ({
        status: 'done',
        content: `[${step.name.toUpperCase()}:${judgment.candidateIndex + 1}]`,
        matchedRuleMethod: judgment.method,
      }),
    );
    ctx.onPhaseComplete?.(step, 3, 'judge', result.label, 'done', undefined, phaseExecutionId, ctx.iteration);
    return { label: result.label, method: result.method };
  } catch (error) {
    if (stepProvider !== undefined && !didRecordProviderAttempt) {
      ctx.onProviderAttempt?.(stepProvider, false, undefined);
    }
    const errorMsg = error instanceof Error ? error.message : String(error);
    ctx.onPhaseComplete?.(step, 3, 'judge', '', 'error', errorMsg, phaseExecutionId, ctx.iteration);
    throw error;
  }
}
