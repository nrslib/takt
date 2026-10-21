import { useRef, useState, type RefObject } from 'react';
import type { Key } from 'ink';
import type { GoalAnswerInput } from '../../infra/goals/schema.js';
import { createEditorState, type EditorState } from '../tui/editorState.js';
import { approvalScopeChoices, createPermissionProposal, type ApprovalScopeChoice, type PendingQuestion } from './inquiryAnswer.js';
import type { WritablePermissionScope } from './scopedPermissionStorage.js';
import type { ManagerAssignment } from './startupResolution.js';
import { toDisplayText } from '../tui/displayText.js';

export interface AnswerTarget {
  readonly pending: PendingQuestion;
  readonly stage: 'question' | 'decision' | 'report' | 'scope' | 'comment' | 'permission';
  readonly choice: number | null;
  readonly scopes: readonly ApprovalScopeChoice[];
  readonly answer: GoalAnswerInput;
  readonly permission?: WritablePermissionScope;
}

export type SaveManagerAnswer = (target: PendingQuestion, answer: GoalAnswerInput,
  permission?: { scope: WritablePermissionScope; sentence: string }) => Promise<void>;

export function useManagerQuestionAnswer() {
  const [answerTarget, setAnswerTarget] = useState<AnswerTarget | null>(null);
  const current = useRef<AnswerTarget | null>(null);
  const update = (next: AnswerTarget | null): void => {
    current.current = next;
    setAnswerTarget(next);
  };
  const beginAnswer = (target: PendingQuestion, assignment: ManagerAssignment): void => {
    const kind = target.question.kind ?? 'question';
    update({
      pending: target, stage: kind === 'approval' ? 'decision' : kind === 'operation_request' ? 'report' : 'question',
      choice: kind !== 'question' || target.question.options !== undefined ? 0 : null,
      scopes: kind === 'approval' ? approvalScopeChoices(target, assignment) : [], answer: {},
    });
  };
  const switchToFreeText = (): void => {
    const target = current.current;
    if (target !== null && target.choice !== null && target.stage !== 'scope') update({ ...target, choice: null });
  };
  const handleInput = (key: Key, submitInput: boolean, editorRef: RefObject<EditorState>,
    edit: (next: EditorState) => void, saveAnswer: SaveManagerAnswer): boolean => {
    const target = current.current!;
    if (key.escape) {
      update(null);
      return true;
    }
    const options = target.stage === 'scope' ? target.scopes
      : target.stage === 'decision' || target.stage === 'report' ? [0, 1] : target.pending.question.options ?? [];
    const selecting = target.stage === 'question' || target.stage === 'decision' || target.stage === 'report' || target.stage === 'scope';
    if (selecting && (target.stage !== 'question' || target.choice !== null) && (key.upArrow || key.downArrow)) {
      const last = target.stage === 'question' ? options.length : options.length - 1;
      update({ ...target, choice: target.choice === null ? 0 : Math.max(0, Math.min(last, target.choice + (key.upArrow ? -1 : 1))) });
      return true;
    }
    if (!submitInput || key.shift || key.meta) return false;
    const text = editorRef.current.text;
    if (target.stage === 'question') {
      if (target.choice !== null) {
        if (target.choice === options.length) {
          update({ ...target, choice: null });
          return true;
        }
        const answer = target.pending.question.options![target.choice]!;
        void saveAnswer(target.pending, { text: answer });
      } else if (text.trim() !== '') {
        void saveAnswer(target.pending, { text });
      }
    } else if (target.stage === 'decision' || target.stage === 'report') {
      // 入力済みのコメントを選択の確定と混同しない。
      if (target.choice === null) return true;
      const answer: GoalAnswerInput = target.stage === 'decision'
        ? { decision: target.choice === 0 ? 'allow' : 'deny' }
        : { report: target.choice === 0 ? 'completed' : 'unable' };
      update({ ...target, answer, stage: answer.decision === 'allow' ? 'scope' : 'comment',
        choice: answer.decision === 'allow' ? 0 : null });
    } else if (target.stage === 'scope') {
      const scope = target.scopes[target.choice!]!;
      update({ ...target, answer: { ...target.answer, scope: scope.value }, permission: scope.permission, stage: 'comment', choice: null });
    } else if (target.stage === 'comment') {
      const answer = { ...target.answer, text };
      if (target.permission === undefined) {
        void saveAnswer(target.pending, answer);
      } else {
        update({ ...target, answer, stage: 'permission' });
        const question = target.pending.question;
        edit(createEditorState(toDisplayText(question.permissionProposal ?? createPermissionProposal(question.operation!))));
      }
    } else if (text.trim() !== '') {
      void saveAnswer(target.pending, target.answer, { scope: target.permission!, sentence: text });
    }
    return true;
  };

  return { answerTarget, clearAnswer: () => update(null), beginAnswer, switchToFreeText, handleInput };
}
