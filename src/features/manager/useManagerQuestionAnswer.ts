import { useRef, useState, type RefObject } from 'react';
import type { Key } from 'ink';
import type { GoalQuestion } from '../../infra/goals/schema.js';
import { commitEditorInput, type EditorState } from '../tui/editorState.js';

export type PendingQuestion = { goalId: string; objective: string; question: GoalQuestion };
type AnswerTarget = { pending: PendingQuestion; choice: number | null };

export function useManagerQuestionAnswer() {
  const [answerTarget, setAnswerTarget] = useState<AnswerTarget | null>(null);
  const answerChoice = useRef<number | null>(null);

  const beginAnswer = (target: PendingQuestion): void => {
    answerChoice.current = target.question.options === undefined ? null : 0;
    setAnswerTarget({ pending: target, choice: answerChoice.current });
  };
  const switchToFreeText = (target: AnswerTarget): void => {
    if (answerChoice.current !== null) {
      answerChoice.current = null;
      setAnswerTarget({ ...target, choice: null });
    }
  };
  const handleInput = (target: AnswerTarget, key: Key, submitInput: boolean, editorRef: RefObject<EditorState>,
    edit: (next: EditorState) => void, saveAnswer: (target: PendingQuestion, text: string) => Promise<void>): boolean => {
    if (key.escape) { setAnswerTarget(null); return true; }
    const options = target.pending.question.options ?? [];
    if (answerChoice.current !== null && (key.upArrow || key.downArrow)) {
      const next = answerChoice.current + (key.upArrow ? -1 : 1);
      answerChoice.current = Math.max(0, Math.min(options.length, next));
      setAnswerTarget({ ...target, choice: answerChoice.current });
      return true;
    }
    if (key.return && answerChoice.current !== null) {
      if (answerChoice.current === options.length) {
        switchToFreeText(target);
      } else void saveAnswer(target.pending, options[answerChoice.current]!);
      return true;
    }
    if (submitInput && !(key.shift || key.meta) && editorRef.current.text.trim() !== '') {
      const text = editorRef.current.text;
      edit(commitEditorInput(editorRef.current, text));
      void saveAnswer(target.pending, text);
      return true;
    }
    switchToFreeText(target);
    return false;
  };

  return { answerTarget, setAnswerTarget, beginAnswer, switchToFreeText, handleInput };
}
