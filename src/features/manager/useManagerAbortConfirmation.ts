import { useState, type RefObject } from 'react';
import type { Key } from 'ink';
import type { ManagerDisplayGoal } from './savedEvents.js';

export type ManagerAbortTarget = { goal: ManagerDisplayGoal; retry: boolean };

export function useManagerAbortConfirmation({ selected, setApprove, resetChoice }: {
  selected: RefObject<boolean>;
  setApprove: (approve: boolean) => void;
  resetChoice: () => void;
}) {
  const [abortTarget, setAbortTarget] = useState<ManagerAbortTarget | null>(null);

  const handleInput = (target: ManagerAbortTarget, key: Key, abortGoal: (target: ManagerAbortTarget) => Promise<void>): void => {
    if (key.escape) { setAbortTarget(null); resetChoice(); return; }
    if (key.upArrow || key.downArrow) {
      selected.current = key.upArrow;
      setApprove(selected.current);
    } else if (key.return) {
      if (selected.current) void abortGoal(target);
      else { setAbortTarget(null); resetChoice(); }
    }
  };

  return { abortTarget, setAbortTarget, handleInput };
}
