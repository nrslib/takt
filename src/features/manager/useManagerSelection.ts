import { useRef, useState } from 'react';
import type { Key } from 'ink';
import type { ManagerDisplayGoal } from './savedEvents.js';
import type { PendingQuestion } from './inquiryAnswer.js';

type GoalOperation = 'pause' | 'resume' | 'abort';
export type ManagerSelectionCommand = 'answer' | 'goal';
export type ManagerSelection =
  | { kind: 'answer'; candidates: readonly PendingQuestion[]; index: number }
  | { kind: 'goal'; candidates: readonly ManagerDisplayGoal[]; index: number }
  | { kind: 'action'; target: ManagerDisplayGoal; candidates: readonly GoalOperation[]; index: number };
export type ManagerSelectedTarget =
  | { kind: 'answer'; target: PendingQuestion }
  | { kind: GoalOperation; target: ManagerDisplayGoal };

export function isGoalSelectionCandidate(kind: GoalOperation, goal: ManagerDisplayGoal): boolean {
  return goal.status !== 'completed' && goal.executionStatus !== 'aborted'
    && (kind === 'abort' || goal.executionStatus === (kind === 'pause' ? 'active' : 'paused'));
}

export function useManagerSelection() {
  const [selection, setSelection] = useState<ManagerSelection | null>(null);
  const current = useRef<ManagerSelection | null>(null);
  const update = (next: ManagerSelection | null): void => {
    current.current = next;
    setSelection(next);
  };
  const open = (kind: ManagerSelectionCommand, snapshot: {
    questions: readonly PendingQuestion[]; goals: readonly ManagerDisplayGoal[];
  }): boolean => {
    if (kind === 'answer') {
      if (snapshot.questions.length === 0) { update(null); return false; }
      update({ kind, candidates: snapshot.questions, index: 0 });
    } else {
      const candidates = snapshot.goals.filter((goal) => isGoalSelectionCandidate('abort', goal));
      if (candidates.length === 0) { update(null); return false; }
      update({ kind, candidates, index: 0 });
    }
    return true;
  };
  const handleInput = (key: Key, onSelect: (target: ManagerSelectedTarget) => void): void => {
    const target = current.current;
    if (target === null) return;
    if (key.escape) update(null);
    else if (key.upArrow || key.downArrow) {
      update({ ...target, index: Math.max(0, Math.min(target.candidates.length - 1,
        target.index + (key.upArrow ? -1 : 1))) });
    } else if (key.return) {
      if (target.kind === 'answer') onSelect({ kind: target.kind, target: target.candidates[target.index]! });
      else if (target.kind === 'goal') {
        const goal = target.candidates[target.index]!;
        update({ kind: 'action', target: goal, candidates: [goal.executionStatus === 'active' ? 'pause' : 'resume', 'abort'], index: 0 });
        return;
      } else onSelect({ kind: target.candidates[target.index]!, target: target.target });
      update(null);
    }
  };
  return { selection, open, handleInput };
}
