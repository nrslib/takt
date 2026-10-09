import type { Language } from '../../../core/models/index.js';
import type { SkillPermissionHandler } from '../../../core/workflow/types.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { confirmWithCancel } from '../../../shared/prompt/confirm.js';
import type { StreamDisplay } from '../../../shared/ui/index.js';
import { enterInputWait, leaveInputWait } from './inputWait.js';

export function createSkillPermissionHandler(
  displayRef: { current: StreamDisplay | null },
  language: Language | undefined,
): SkillPermissionHandler {
  let pending: Promise<void> = Promise.resolve();

  return (request, signal) => {
    if (signal.aborted) return Promise.resolve(false);

    let started = false;
    const operation = pending.then(async () => {
      if (signal.aborted) return false;
      started = true;
      if (displayRef.current) {
        displayRef.current.flush();
        displayRef.current = null;
      }
      enterInputWait();
      try {
        const answer = await confirmWithCancel(getLabel('workflow.skillPermission', language, {
          patterns: JSON.stringify(request.patterns),
        }), false, signal);
        return !signal.aborted && answer.kind === 'value' && answer.value;
      } finally {
        leaveInputWait();
      }
    });
    // 入力処理の失敗は呼び出し元へ返し、後続要求の待機列は進める。
    pending = operation.then(() => undefined, () => undefined);

    return new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => {
        if (!started) resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  };
}
