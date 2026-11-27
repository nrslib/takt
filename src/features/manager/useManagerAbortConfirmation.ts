import { useState, type RefObject } from 'react';
import type { Key } from 'ink';
import type { ManagerDisplayGoal } from './savedEvents.js';

/** 取り消せないゴール操作（中止・削除）の確認対象。 */
export type ManagerGoalConfirmationTarget = { goal: ManagerDisplayGoal; retry: boolean; kind: 'abort' | 'delete' };

export function useManagerAbortConfirmation({ selected, setApprove, resetChoice }: {
  selected: RefObject<boolean>;
  setApprove: (approve: boolean) => void;
  resetChoice: () => void;
}) {
  const [abortTarget, setAbortTarget] = useState<ManagerGoalConfirmationTarget | null>(null);

  const handleInput = (target: ManagerGoalConfirmationTarget, key: Key,
    confirmGoalOperation: (target: ManagerGoalConfirmationTarget) => Promise<void>): void => {
    if (key.escape) { setAbortTarget(null); resetChoice(); return; }
    if (key.upArrow || key.downArrow) {
      selected.current = key.upArrow;
      setApprove(selected.current);
    } else if (key.return) {
      if (selected.current) void confirmGoalOperation(target);
      else { setAbortTarget(null); resetChoice(); }
    }
  };

  return { abortTarget, setAbortTarget, handleInput };
}
