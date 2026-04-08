/**
 * iterationLimitHandler — イテレーション上限到達時、およびユーザー入力のインタラクション処理
 *
 * ユーザーに続行/停止を確認し、追加イテレーション数を返す。
 * ユーザー入力待ちハンドラも提供する。
 */

import type { IterationLimitRequest, UserInputRequest } from '../../../core/workflow/index.js';
import { playWarningSound } from '../../../shared/utils/index.js';
import { selectOption, promptInput } from '../../../shared/prompt/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { enterInputWait, leaveInputWait } from './inputWait.js';
import type { OutputFns } from './outputFns.js';
import type { StreamDisplay } from '../../../shared/ui/index.js';

export function createIterationLimitHandler(
  out: OutputFns,
  displayRef: { current: StreamDisplay | null },
  shouldNotify: boolean,
  onExceeded?: (request: IterationLimitRequest) => void,
): (request: IterationLimitRequest) => Promise<number | null> {
  return async (request: IterationLimitRequest): Promise<number | null> => {
    if (displayRef.current) { displayRef.current.flush(); displayRef.current = null; }
    out.blankLine();
    out.warn(getLabel('workflow.iterationLimit.maxReached', undefined, {
      currentIteration: String(request.currentIteration),
      maxSteps: String(request.maxSteps),
    }));
    out.info(getLabel('workflow.iterationLimit.currentStep', undefined, { currentStep: request.currentStep }));
    if (shouldNotify) playWarningSound();
    if (onExceeded) {
      onExceeded(request);
      return null;
    }
    enterInputWait();
    try {
      const action = await selectOption(getLabel('workflow.iterationLimit.continueQuestion'), [
        { label: getLabel('workflow.iterationLimit.continueLabel'), value: 'continue', description: getLabel('workflow.iterationLimit.continueDescription') },
        { label: getLabel('workflow.iterationLimit.stopLabel'), value: 'stop' },
      ]);
      if (action !== 'continue') return null;
      while (true) {
        const input = await promptInput(getLabel('workflow.iterationLimit.inputPrompt'));
        if (!input) return null;
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n > 0) return n;
        out.warn(getLabel('workflow.iterationLimit.invalidInput'));
      }
    } finally {
      leaveInputWait();
    }
  };
}

/**
 * ユーザー入力ハンドラを作成する（interactiveUserInput が有効な場合のみ使用）。
 */
export function createUserInputHandler(
  out: OutputFns,
  displayRef: { current: StreamDisplay | null },
): (request: UserInputRequest) => Promise<string | null> {
  return async (request: UserInputRequest): Promise<string | null> => {
    if (displayRef.current) { displayRef.current.flush(); displayRef.current = null; }
    out.blankLine();
    out.info(request.prompt.trim());
    const input = await promptInput(getLabel('workflow.iterationLimit.userInputPrompt'));
    return input && input.trim() ? input.trim() : null;
  };
}
