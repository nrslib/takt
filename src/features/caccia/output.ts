import type { ExecuteTaskOptions } from '../tasks/execute/types.js';
import { createOutputFns } from '../tasks/execute/outputFns.js';
import { assertTaskPrefixPair } from '../tasks/execute/workflowExecutionUtils.js';
import { TaskPrefixWriter } from '../../shared/ui/TaskPrefixWriter.js';
import { getLabel } from '../../shared/i18n/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import type { Language } from '../../core/models/types.js';
import type { CacciaResult } from './index.js';

export type CacciaDisplayOptions = Pick<
  ExecuteTaskOptions,
  'outputMode' | 'taskPrefix' | 'taskColorIndex' | 'taskDisplayLabel'
>;

export function createCacciaOutput(
  display: CacciaDisplayOptions & { outputMode: 'terminal' | 'silent' },
  language: Language | undefined,
) {
  assertTaskPrefixPair(display.taskPrefix, display.taskColorIndex);
  const writer = display.taskPrefix != null
    ? new TaskPrefixWriter({
        taskName: display.taskPrefix,
        colorIndex: display.taskColorIndex!,
        displayLabel: display.taskDisplayLabel,
      })
    : undefined;
  const out = createOutputFns(writer, display.outputMode);
  const label = (key: string, vars?: Record<string, string>): string =>
    getLabel(`caccia.${key}`, language, vars);
  return {
    rateLimitExhausted: (commit?: string) => commit === undefined
      ? label('rateLimitExhausted')
      : label('pushedRateLimitExhausted', { commit: sanitizeTerminalText(commit) }),
    waitingForReview: () => out.info(label('waitingForReview')),
    waiting: () => out.info(label('waiting')),
    threads: (count: number) => out.info(label('threads', { count: String(count) })),
    iteration: (current: number, maximum: number) =>
      out.info(label('iteration', { current: String(current), maximum: String(maximum) })),
    cloning: () => out.info(label('cloning')),
    pushed: (headSha: string) => out.info(label('pushed', { commit: sanitizeTerminalText(headSha) })),
    resolved: (threadId: string) => out.info(label('resolved', { thread: sanitizeTerminalText(threadId) })),
    result: (result: CacciaResult): void => {
      switch (result.outcome) {
        case 'success':
          out.success(label('success'));
          break;
        case 'limit':
          out.warn(label('limit', { count: String(result.unresolvedCount) }));
          break;
        case 'skipped':
          if (result.reason === undefined) {
            throw new Error('Caccia skipped without a reason');
          }
          out.warn(label('skipped', { reason: sanitizeTerminalText(result.reason) }));
          break;
        case 'not_run':
          break;
      }
    },
    failed: (message: string) => out.error(label('failed', { error: sanitizeTerminalText(message) })),
  };
}

export type CacciaOutput = ReturnType<typeof createCacciaOutput>;
