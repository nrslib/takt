import type {
  TraceStep,
  TraceReportMode,
  TraceReportParams,
} from './traceReportTypes.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';

function transformText(text: string, mode: TraceReportMode): string {
  if (!text) {
    return text;
  }
  if (mode === 'full') {
    return text;
  }
  return sanitizeSensitiveText(text);
}

export function cloneStepsForMode(
  steps: TraceStep[],
  mode: TraceReportMode,
): TraceStep[] {
  return steps.map((step) => ({
    ...step,
    instruction: step.instruction == null ? undefined : transformText(step.instruction, mode),
    result: step.result
      ? {
          ...step.result,
          content: transformText(step.result.content, mode),
          ...(step.result.error ? { error: transformText(step.result.error, mode) } : {}),
        }
      : undefined,
    phases: step.phases.map((phase) => ({
      ...phase,
      instruction: transformText(phase.instruction, mode),
      systemPrompt: transformText(phase.systemPrompt, mode),
      userInstruction: transformText(phase.userInstruction, mode),
      response: phase.response == null ? undefined : transformText(phase.response, mode),
      error: phase.error == null ? undefined : transformText(phase.error, mode),
      judgeStages: phase.judgeStages?.map((stage) => ({
        ...stage,
        instruction: transformText(stage.instruction, mode),
        response: transformText(stage.response, mode),
      })),
    })),
  }));
}

export function sanitizeTraceParamsForMode(
  params: TraceReportParams,
  mode: TraceReportMode,
): TraceReportParams {
  if (mode === 'full') {
    return params;
  }
  return {
    ...params,
    task: sanitizeSensitiveText(params.task),
    ...(params.reason ? { reason: sanitizeSensitiveText(params.reason) } : {}),
  };
}

export function sanitizeTextForStorage(text: string, allowFullText: boolean): string {
  if (!text) {
    return text;
  }
  if (allowFullText) {
    return text;
  }
  return sanitizeSensitiveText(text);
}
