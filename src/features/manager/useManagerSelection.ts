import { useRef, useState } from 'react';
import type { Key } from 'ink';
import type { ManagerDisplayGoal, ManagerDisplayNotice } from './savedEvents.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import { layoutQuestionBody } from './questionBodyLayout.js';

type GoalOperation = 'pause' | 'resume' | 'abort';
export type ManagerSelectionCommand = 'answer' | 'goal' | 'notice' | 'repository';
export const MANAGER_SELECTION_PAGE_SIZE = 10;
const BODY_VIEW_ROWS = 8;
export type ManagerSelection = { start: number } & (
  | { kind: 'answer'; candidates: readonly PendingQuestion[]; index: number }
  | { kind: 'goal'; candidates: readonly ManagerDisplayGoal[]; index: number }
  | { kind: 'notice'; candidates: readonly ManagerDisplayNotice[]; index: number; bodyOffset: number | null }
  | { kind: 'repository'; candidates: readonly string[]; index: number }
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
  const latest = useRef<Parameters<typeof open>[1] | null>(null);
  const update = (next: ManagerSelection | null): void => {
    current.current = next;
    setSelection(next);
  };
  const open = (kind: ManagerSelectionCommand, snapshot: {
    questions: readonly PendingQuestion[]; goals: readonly ManagerDisplayGoal[]; notices: readonly ManagerDisplayNotice[];
    repositoryDirectories: readonly string[];
  }): boolean => {
    latest.current = snapshot;
    if (kind === 'answer') {
      if (snapshot.questions.length === 0) { update(null); return false; }
      update({ kind, candidates: snapshot.questions, index: 0, start: 0 });
    } else if (kind === 'notice') {
      if (snapshot.notices.length === 0) { update(null); return false; }
      update({ kind, candidates: snapshot.notices, index: 0, start: 0, bodyOffset: null });
    } else if (kind === 'repository') {
      if (snapshot.repositoryDirectories.length === 0) { update(null); return false; }
      update({ kind, candidates: snapshot.repositoryDirectories, index: 0, start: 0 });
    } else {
      const candidates = snapshot.goals.filter((goal) => isGoalSelectionCandidate('abort', goal));
      if (candidates.length === 0) { update(null); return false; }
      update({ kind, candidates, index: 0, start: 0 });
    }
    return true;
  };
  const refresh = (snapshot: Parameters<typeof open>[1]): void => {
    latest.current = snapshot;
    const target = current.current;
    if (target === null) return;
    if (target.kind === 'action') {
      const goal = snapshot.goals.find((goal) => goal.id === target.target.id && isGoalSelectionCandidate('abort', goal));
      if (goal === undefined || goal.executionStatus !== target.target.executionStatus) update(null);
      else update({ ...target, target: goal });
      return;
    }
    const candidates = target.kind === 'answer' ? snapshot.questions : target.kind === 'notice' ? snapshot.notices
      : target.kind === 'repository' ? snapshot.repositoryDirectories : snapshot.goals.filter((goal) => isGoalSelectionCandidate('abort', goal));
    if (candidates.length === 0) { update(null); return; }
    let retained = -1;
    if (target.kind === 'answer') {
      const selected = target.candidates[target.index]!;
      retained = snapshot.questions.findIndex((candidate) => candidate.question.id === selected.question.id
        && JSON.stringify(candidate.goalId === null ? candidate.owner : [candidate.repositoryDirectory, candidate.goalId])
        === JSON.stringify(selected.goalId === null ? selected.owner : [selected.repositoryDirectory, selected.goalId]));
    } else if (target.kind === 'goal') {
      const selected = target.candidates[target.index]!;
      retained = snapshot.goals.filter((goal) => isGoalSelectionCandidate('abort', goal))
        .findIndex((goal) => goal.id === selected.id);
    } else if (target.kind === 'notice') {
      const selected = target.candidates[target.index]!;
      retained = snapshot.notices.findIndex((notice) => notice.id === selected.id && notice.goalId === selected.goalId
        && notice.repositoryDirectory === selected.repositoryDirectory);
    } else retained = snapshot.repositoryDirectories.indexOf(target.candidates[target.index]!);
    const index = retained < 0 ? Math.min(target.index, candidates.length - 1) : retained;
    const start = Math.min(target.start, index);
    if (target.kind === 'answer') update({ ...target, index, start, candidates: snapshot.questions });
    else if (target.kind === 'notice') update({ ...target, index, start, candidates: snapshot.notices });
    else if (target.kind === 'repository') update({ ...target, index, start, candidates: snapshot.repositoryDirectories });
    else update({ ...target, index, start, candidates: snapshot.goals.filter((goal) => isGoalSelectionCandidate('abort', goal)) });
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
      if (target.kind === 'repository') return;
      if (target.kind === 'notice') {
        update({ ...target, bodyOffset: 0 });
        return;
      }
      if (target.kind === 'answer') onSelect({ kind: target.kind, target: target.candidates[target.index]!, onCancel: () => {
        update(target);
        if (latest.current !== null) refresh(latest.current);
      } });
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
  return { selection, bodyText, open, refresh, handleInput };
}
