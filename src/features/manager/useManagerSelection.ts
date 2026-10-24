import { useRef, useState } from 'react';
import type { Key } from 'ink';
import type { ManagerDisplayGoal, ManagerDisplayNotice } from './savedEvents.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import { layoutQuestionBody } from './questionBodyLayout.js';

type GoalOperation = 'pause' | 'resume' | 'abort';
export type ManagerSelectionCommand = 'answer' | 'goal' | 'notice';
export const MANAGER_SELECTION_PAGE_SIZE = 10;
const BODY_VIEW_ROWS = 8;
export type ManagerSelection = { start: number } & (
  | { kind: 'answer'; candidates: readonly PendingQuestion[]; index: number }
  | { kind: 'goal'; candidates: readonly ManagerDisplayGoal[]; index: number }
  | { kind: 'notice'; candidates: readonly ManagerDisplayNotice[]; index: number; bodyOffset: number | null }
  | { kind: 'action'; target: ManagerDisplayGoal; candidates: readonly GoalOperation[]; index: number });
export type ManagerSelectedTarget =
  | { kind: 'answer'; target: PendingQuestion; onCancel: () => void }
  | { kind: GoalOperation; target: ManagerDisplayGoal };

export function isGoalSelectionCandidate(kind: GoalOperation, goal: ManagerDisplayGoal): boolean {
  return goal.status !== 'completed' && goal.executionStatus !== 'aborted'
    && (kind === 'abort' || goal.executionStatus === (kind === 'pause' ? 'active' : 'paused'));
}

export function useManagerSelection(bodyWidth: number) {
  const [selection, setSelection] = useState<ManagerSelection | null>(null);
  const current = useRef<ManagerSelection | null>(null);
  const update = (next: ManagerSelection | null): void => {
    current.current = next;
    setSelection(next);
  };
  const open = (kind: ManagerSelectionCommand, snapshot: {
    questions: readonly PendingQuestion[]; goals: readonly ManagerDisplayGoal[]; notices: readonly ManagerDisplayNotice[];
  }): boolean => {
    if (kind === 'answer') {
      if (snapshot.questions.length === 0) { update(null); return false; }
      update({ kind, candidates: snapshot.questions, index: 0, start: 0 });
    } else if (kind === 'notice') {
      if (snapshot.notices.length === 0) { update(null); return false; }
      update({ kind, candidates: snapshot.notices, index: 0, start: 0, bodyOffset: null });
    } else {
      const candidates = snapshot.goals.filter((goal) => isGoalSelectionCandidate('abort', goal));
      if (candidates.length === 0) { update(null); return false; }
      update({ kind, candidates, index: 0, start: 0 });
    }
    return true;
  };
  const handleInput = (key: Key, onSelect: (target: ManagerSelectedTarget) => void): void => {
    const target = current.current;
    if (target === null) return;
    if (target.kind === 'notice' && target.bodyOffset !== null) {
      if (key.escape) update({ ...target, bodyOffset: null });
      else if (key.upArrow || key.downArrow) {
        const last = Math.max(0, layoutQuestionBody(target.candidates[target.index]!.message, bodyWidth).length - BODY_VIEW_ROWS);
        const offset = Math.min(target.bodyOffset, last);
        update({ ...target, bodyOffset: Math.max(0, Math.min(last, offset + (key.upArrow ? -1 : 1))) });
      }
      return;
    }
    if (key.escape) update(null);
    else if (key.upArrow || key.downArrow) {
      const index = Math.max(0, Math.min(target.candidates.length - 1,
        target.index + (key.upArrow ? -1 : 1)));
      const start = index < target.start ? index : Math.max(target.start, index - MANAGER_SELECTION_PAGE_SIZE + 1);
      update({ ...target, index, start });
    } else if (key.return) {
      if (target.kind === 'notice') {
        update({ ...target, bodyOffset: 0 });
        return;
      }
      if (target.kind === 'answer') onSelect({ kind: target.kind, target: target.candidates[target.index]!, onCancel: () => update(target) });
      else if (target.kind === 'goal') {
        const goal = target.candidates[target.index]!;
        update({ kind: 'action', target: goal, candidates: [goal.executionStatus === 'active' ? 'pause' : 'resume', 'abort'], index: 0, start: 0 });
        return;
      } else onSelect({ kind: target.candidates[target.index]!, target: target.target });
      update(null);
    }
  };
  const rows = selection?.kind === 'notice' && selection.bodyOffset !== null
    ? layoutQuestionBody(selection.candidates[selection.index]!.message, bodyWidth) : [];
  const start = Math.min(selection?.kind === 'notice' ? selection.bodyOffset ?? 0 : 0,
    Math.max(0, rows.length - BODY_VIEW_ROWS));
  const bodyText = rows.slice(start, start + BODY_VIEW_ROWS).join('\n');
  return { selection, bodyText, open, handleInput };
}
