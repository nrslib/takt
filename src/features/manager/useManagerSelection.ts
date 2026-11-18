import { useRef, useState } from 'react';
import type { Key } from 'ink';
import type { ManagerDisplayGoal } from './savedEvents.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import { isGoalFinished } from '../../infra/goals/activity.js';

export type GoalOperation = 'pause' | 'resume' | 'abort' | 'delete';
export type ManagerSelectionCommand = 'answer' | 'goal';
export const MANAGER_SELECTION_PAGE_SIZE = 10;
export type ManagerSelection = { start: number } & (
  | { kind: 'answer'; candidates: readonly PendingQuestion[]; index: number }
  | { kind: 'goal'; candidates: readonly ManagerDisplayGoal[]; index: number }
  | { kind: 'action'; target: ManagerDisplayGoal; candidates: readonly GoalOperation[]; index: number });
export type ManagerSelectedTarget =
  | { kind: 'answer'; target: PendingQuestion; onCancel: () => void }
  | { kind: GoalOperation; target: ManagerDisplayGoal };

export function isGoalSelectionCandidate(kind: GoalOperation, goal: ManagerDisplayGoal): boolean {
  if (kind === 'delete') return isGoalFinished(goal);
  return !isGoalFinished(goal) && (kind === 'abort' || goal.executionStatus === (kind === 'pause' ? 'active' : 'paused'));
}

function goalOperations(goal: ManagerDisplayGoal): GoalOperation[] {
  if (isGoalFinished(goal)) return ['delete'];
  return [goal.executionStatus === 'active' ? 'pause' : 'resume', 'abort'];
}

/** 進行中のゴールを先に並べ、終わったゴールは削除の候補として後ろに置く。 */
function goalCandidates(goals: readonly ManagerDisplayGoal[]): ManagerDisplayGoal[] {
  return [...goals.filter((goal) => !isGoalFinished(goal)), ...goals.filter(isGoalFinished)];
}

export function useManagerSelection() {
  const [selection, setSelection] = useState<ManagerSelection | null>(null);
  const current = useRef<ManagerSelection | null>(null);
  const latest = useRef<Parameters<typeof open>[1] | null>(null);
  const update = (next: ManagerSelection | null): void => {
    current.current = next;
    setSelection(next);
  };
  const open = (kind: ManagerSelectionCommand, snapshot: {
    questions: readonly PendingQuestion[]; goals: readonly ManagerDisplayGoal[];
  }): boolean => {
    snapshot = { ...snapshot, questions: snapshot.questions.filter(({ question }) => question.kind !== 'approval') };
    latest.current = snapshot;
    if (kind === 'answer') {
      if (snapshot.questions.length === 0) { update(null); return false; }
      update({ kind, candidates: snapshot.questions, index: 0, start: 0 });
    } else {
      const candidates = goalCandidates(snapshot.goals);
      if (candidates.length === 0) { update(null); return false; }
      update({ kind, candidates, index: 0, start: 0 });
    }
    return true;
  };
  const refresh = (snapshot: Parameters<typeof open>[1]): void => {
    snapshot = { ...snapshot, questions: snapshot.questions.filter(({ question }) => question.kind !== 'approval') };
    latest.current = snapshot;
    const target = current.current;
    if (target === null) return;
    if (target.kind === 'action') {
      const goal = snapshot.goals.find((goal) => goal.id === target.target.id);
      if (goal === undefined || goal.executionStatus !== target.target.executionStatus
        || isGoalFinished(goal) !== isGoalFinished(target.target)) update(null);
      else update({ ...target, target: goal });
      return;
    }
    const candidates = target.kind === 'answer' ? snapshot.questions : goalCandidates(snapshot.goals);
    if (candidates.length === 0) { update(null); return; }
    let retained = -1;
    if (target.kind === 'answer') {
      const selected = target.candidates[target.index]!;
      retained = snapshot.questions.findIndex((candidate) => candidate.question.id === selected.question.id
        && JSON.stringify(candidate.goalId === null ? candidate.owner : [candidate.repositoryDirectory, candidate.goalId])
        === JSON.stringify(selected.goalId === null ? selected.owner : [selected.repositoryDirectory, selected.goalId]));
    } else if (target.kind === 'goal') {
      const selected = target.candidates[target.index]!;
      retained = goalCandidates(snapshot.goals).findIndex((goal) => goal.id === selected.id);
    }
    const index = retained < 0 ? Math.min(target.index, candidates.length - 1) : retained;
    const start = Math.min(index, Math.max(target.start, index - MANAGER_SELECTION_PAGE_SIZE + 1));
    if (target.kind === 'answer') update({ ...target, index, start, candidates: snapshot.questions });
    else update({ ...target, index, start, candidates: goalCandidates(snapshot.goals) });
  };
  const handleInput = (key: Key, onSelect: (target: ManagerSelectedTarget) => void): void => {
    const target = current.current;
    if (target === null) return;
    if (key.escape) update(null);
    else if (key.upArrow || key.downArrow) {
      const index = Math.max(0, Math.min(target.candidates.length - 1,
        target.index + (key.upArrow ? -1 : 1)));
      const start = index < target.start ? index : Math.max(target.start, index - MANAGER_SELECTION_PAGE_SIZE + 1);
      update({ ...target, index, start });
    } else if (key.return) {
      if (target.kind === 'answer') onSelect({ kind: target.kind, target: target.candidates[target.index]!, onCancel: () => {
        update(target);
        if (latest.current !== null) refresh(latest.current);
      } });
      else if (target.kind === 'goal') {
        const goal = target.candidates[target.index]!;
        update({ kind: 'action', target: goal, candidates: goalOperations(goal), index: 0, start: 0 });
        return;
      } else onSelect({ kind: target.candidates[target.index]!, target: target.target });
      update(null);
    }
  };
  return { selection, open, close: () => update(null), refresh, handleInput };
}
