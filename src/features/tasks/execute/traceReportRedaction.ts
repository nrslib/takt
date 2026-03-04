import type {
  TraceMovement,
  TraceReportMode,
  TraceReportParams,
} from './traceReportTypes.js';

export function sanitizeSensitiveText(text: string): string {
  if (!text) return text;
  return text
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s]+)/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|token|password|secret|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)([^"',\s}\]]+)(["']?)/gi,
      '$1[REDACTED]$3',
    )
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)([^&\s]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED]');
}

function transformText(text: string, mode: TraceReportMode): string {
  if (!text) {
    return text;
  }
  if (mode === 'full') {
    return text;
  }
  return sanitizeSensitiveText(text);
}

export function cloneMovementsForMode(
  movements: TraceMovement[],
  mode: TraceReportMode,
): TraceMovement[] {
  return movements.map((movement) => ({
    ...movement,
    instruction: movement.instruction == null ? undefined : transformText(movement.instruction, mode),
    result: movement.result
      ? {
          ...movement.result,
          content: transformText(movement.result.content, mode),
          ...(movement.result.error ? { error: transformText(movement.result.error, mode) } : {}),
        }
      : undefined,
    phases: movement.phases.map((phase) => ({
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
