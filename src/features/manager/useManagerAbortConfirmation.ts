import { useState, type RefObject } from 'react';
import type { Key } from 'ink';
import type { ManagerDisplayGoal } from './savedEvents.js';

export function useManagerAbortConfirmation({ selected, setApprove, resetChoice }: {
  selected: RefObject<boolean>;
  setApprove: (approve: boolean) => void;
  resetChoice: () => void;
}) {
  const [abortTarget, setAbortTarget] = useState<ManagerDisplayGoal | null>(null);

  const handleInput = (target: ManagerDisplayGoal, key: Key, abortGoal: (goalId: string) => Promise<void>): void => {
    if (key.escape) { setAbortTarget(null); resetChoice(); return; }
    if (key.upArrow || key.downArrow) {
      selected.current = key.upArrow;
      setApprove(selected.current);
    } else if (key.return) {
      if (selected.current) void abortGoal(target.id);
      else { setAbortTarget(null); resetChoice(); }
    }
  };

  return { abortTarget, setAbortTarget, handleInput };
}
