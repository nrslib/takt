import { useState, type RefObject } from 'react';
import type { Key } from 'ink';
import type { ManagerConversationSession, PendingManagerSummary } from './conversationSession.js';

export function useManagerSummaryApproval({ selected, setApprove, resetChoice, session }: {
  selected: RefObject<boolean>;
  setApprove: (approve: boolean) => void;
  resetChoice: () => void;
  session: Pick<ManagerConversationSession, 'dismissSummary'>;
}) {
  const [pending, setPending] = useState<PendingManagerSummary | null>(null);

  const dismiss = (target: PendingManagerSummary): void => {
    session.dismissSummary(target.revision);
    setPending(null);
    resetChoice();
  };
  const handleInput = (target: PendingManagerSummary, key: Key, register: (revision: number) => Promise<void>): boolean => {
    if (key.upArrow || key.downArrow) {
      selected.current = key.upArrow;
      setApprove(selected.current);
      return true;
    }
    if (key.return) {
      if (selected.current) void register(target.revision);
      else dismiss(target);
      return true;
    }
    if (key.escape) { dismiss(target); return true; }
    // Typing resumes conversation and leaves the summary unavailable to UI approval.
    dismiss(target);
    return false;
  };

  return { pending, setPending, dismiss, handleInput };
}
