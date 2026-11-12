import { useRef, useState, type RefObject } from 'react';
import type { Key } from 'ink';
import type { EditorState } from '../tui/editorState.js';
import type { GoalAnswerInput } from '../../infra/goals/schema.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import { layoutQuestionBody } from './questionBodyLayout.js';

const BODY_VIEW_ROWS = 8;

export interface AnswerTarget {
  readonly pending: PendingQuestion;
  readonly stage: 'question' | 'report' | 'comment';
  readonly choice: number | null;
  readonly answer: GoalAnswerInput;
  readonly bodyOffset: number;
  readonly onCancel?: () => void;
}

export type SaveManagerAnswer = (target: PendingQuestion, answer: GoalAnswerInput) => Promise<void>;

export function useManagerQuestionAnswer(bodyWidth: number) {
  const [answerTarget, setAnswerTarget] = useState<AnswerTarget | null>(null);
  const current = useRef<AnswerTarget | null>(null);
  const bodyLayout = useRef<{ body: string; width: number; rows: string[] } | null>(null);
  const getBodyRows = (body: string, width: number): string[] => {
    const cached = bodyLayout.current;
    if (cached !== null && cached.body === body && cached.width === width) return cached.rows;
    const rows = layoutQuestionBody(body, width);
    bodyLayout.current = { body, width, rows };
    return rows;
  };
  const update = (next: AnswerTarget | null): void => {
    current.current = next;
    setAnswerTarget(next);
  };
  const beginAnswer = (target: PendingQuestion, onCancel?: () => void): void => {
    const kind = target.question.kind ?? 'question';
    if (kind === 'approval') return;
    update({
      pending: target, stage: kind === 'operation_request' ? 'report' : 'question',
      choice: kind !== 'question' || target.question.options !== undefined ? 0 : null,
      answer: {}, bodyOffset: 0, onCancel,
    });
  };
  const switchToFreeText = (): void => {
    const target = current.current;
    if (target !== null && target.choice !== null) update({ ...target, choice: null });
  };
  const handleNavigation = (key: Key, editorRef: RefObject<EditorState>): boolean => {
    const target = current.current;
    if (target === null) return false;
    if (key.escape) {
      update(null);
      target.onCancel?.();
      return true;
    }
    if (!key.upArrow && !key.downArrow) return false;
    const options = target.stage === 'report' ? [0, 1] : target.pending.question.options ?? [];
    const selecting = target.stage === 'question' || target.stage === 'report';
    if (selecting && (target.stage !== 'question' || target.choice !== null)) {
      const last = target.stage === 'question' ? options.length : options.length - 1;
      update({ ...target, choice: target.choice === null ? 0 : Math.max(0, Math.min(last, target.choice + (key.upArrow ? -1 : 1))) });
      return true;
    }
    if (editorRef.current.text !== '') return false;
    const last = Math.max(0, getBodyRows(target.pending.question.body, bodyWidth).length - BODY_VIEW_ROWS);
    if (last === 0) return false;
    const offset = Math.min(target.bodyOffset, last);
    update({ ...target, bodyOffset: Math.max(0, Math.min(last, offset + (key.upArrow ? -1 : 1))) });
    return true;
  };
  const handleInput = (key: Key, submitInput: boolean, editorRef: RefObject<EditorState>,
    saveAnswer: SaveManagerAnswer): boolean => {
    const target = current.current!;
    if (!submitInput || key.shift || key.meta) return false;
    const text = editorRef.current.text;
    if (target.stage === 'question') {
      const options = target.pending.question.options ?? [];
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
    } else if (target.stage === 'report') {
      if (target.choice === null) return true;
      update({ ...target, answer: { report: target.choice === 0 ? 'completed' : 'unable' }, stage: 'comment', choice: null });
    } else {
      void saveAnswer(target.pending, { ...target.answer, text });
    }
    return true;
  };

  const rows = answerTarget === null ? [] : getBodyRows(answerTarget.pending.question.body, bodyWidth);
  const start = Math.min(answerTarget?.bodyOffset ?? 0, Math.max(0, rows.length - BODY_VIEW_ROWS));
  const bodyText = rows.slice(start, start + BODY_VIEW_ROWS).join('\n');
  const clearAnswer = (questionId?: string): boolean => {
    if (questionId !== undefined && current.current?.pending.question.id !== questionId) return false;
    update(null);
    return true;
  };
  return { answerTarget, bodyText, clearAnswer, beginAnswer, switchToFreeText, handleNavigation, handleInput };
}
