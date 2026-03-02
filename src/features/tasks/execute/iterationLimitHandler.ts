/**
 * iterationLimitHandler — イテレーション上限到達時、およびユーザー入力のインタラクション処理
 *
 * ユーザーに続行/停止を確認し、追加イテレーション数を返す。
 * ユーザー入力待ちハンドラも提供する。
 */

import type { IterationLimitRequest, UserInputRequest } from '../../../core/piece/index.js';
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
): (request: IterationLimitRequest) => Promise<number | null> {
  return async (request: IterationLimitRequest): Promise<number | null> => {
    if (displayRef.current) { displayRef.current.flush(); displayRef.current = null; }
    out.blankLine();
    out.warn(getLabel('piece.iterationLimit.maxReached', undefined, {
      currentIteration: String(request.currentIteration),
      maxMovements: String(request.maxMovements),
    }));
    out.info(getLabel('piece.iterationLimit.currentMovement', undefined, { currentMovement: request.currentMovement }));
    if (shouldNotify) playWarningSound();
    enterInputWait();
    try {
      const action = await selectOption(getLabel('piece.iterationLimit.continueQuestion'), [
        { label: getLabel('piece.iterationLimit.continueLabel'), value: 'continue', description: getLabel('piece.iterationLimit.continueDescription') },
        { label: getLabel('piece.iterationLimit.stopLabel'), value: 'stop' },
      ]);
      if (action !== 'continue') return null;
      while (true) {
        const input = await promptInput(getLabel('piece.iterationLimit.inputPrompt'));
        if (!input) return null;
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n > 0) return n;
        out.warn(getLabel('piece.iterationLimit.invalidInput'));
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
    const input = await promptInput(getLabel('piece.iterationLimit.userInputPrompt'));
    return input && input.trim() ? input.trim() : null;
  };
}
