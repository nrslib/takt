import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PieceMovement, RuleMatchMethod } from '../models/types.js';
import { judgeStatus } from '../../agents/agent-usecases.js';
import { StatusJudgmentBuilder, type StatusJudgmentContext } from './instruction/StatusJudgmentBuilder.js';
import { getJudgmentReportFiles } from './evaluation/rule-utils.js';
import { createLogger } from '../../shared/utils/index.js';
import type { PhaseRunnerContext } from './phase-runner.js';

const log = createLogger('phase-runner');

/** Result of Phase 3 status judgment, including the detection method. */
export interface StatusJudgmentPhaseResult {
  tag: string;
  ruleIndex: number;
  method: RuleMatchMethod;
}

/**
 * Build the base context (shared by structured output and tag instructions).
 */
function buildBaseContext(
  step: PieceMovement,
  ctx: PhaseRunnerContext,
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
    throw new Error(`Status judgment requires existing use_judge reports for movement "${step.name}"`);
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
  step: PieceMovement,
  ctx: PhaseRunnerContext,
): Promise<StatusJudgmentPhaseResult> {
  log.debug('Running status judgment phase', { movement: step.name });
  if (!step.rules || step.rules.length === 0) {
    throw new Error(`Status judgment requires rules for movement "${step.name}"`);
  }

  const baseContext = buildBaseContext(step, ctx);
  if (!baseContext) {
    throw new Error(`Status judgment requires report or lastResponse for movement "${step.name}"`);
  }

  const structuredInstruction = new StatusJudgmentBuilder(step, {
    ...baseContext,
    structuredOutput: true,
  }).build();

  const tagInstruction = new StatusJudgmentBuilder(step, {
    ...baseContext,
  }).build();

  ctx.onPhaseStart?.(step, 3, 'judge', structuredInstruction);
  try {
    const result = await judgeStatus(structuredInstruction, tagInstruction, step.rules, {
      cwd: ctx.cwd,
      movementName: step.name,
      language: ctx.language,
      interactive: ctx.interactive,
      onStream: ctx.onStream,
    });
    const tag = `[${step.name.toUpperCase()}:${result.ruleIndex + 1}]`;
    ctx.onPhaseComplete?.(step, 3, 'judge', tag, 'done');
    return { tag, ruleIndex: result.ruleIndex, method: result.method };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    ctx.onPhaseComplete?.(step, 3, 'judge', '', 'error', errorMsg);
    throw error;
  }
}
