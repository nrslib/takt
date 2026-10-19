import { useInput, usePaste } from 'ink';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { applyEditorKey, commitEditorInput, type EditorState } from '../tui/editorState.js';
import { resolveEditorKey } from '../tui/editorKeys.js';
import type { ManagerConversationSession } from './conversationSession.js';
import type { useManagerAbortConfirmation } from './useManagerAbortConfirmation.js';
import type { PendingQuestion, useManagerQuestionAnswer } from './useManagerQuestionAnswer.js';
import type { useManagerSummaryApproval } from './useManagerSummaryApproval.js';

export function useManagerInput({
  exiting, active, registering, editorRef, edit, setQueued, onExit, contentWidth, session,
  abortConfirmation, questionAnswer, summaryApproval, abortGoal, saveAnswer, register,
}: {
  exiting: RefObject<boolean>;
  active: RefObject<AbortController | null>;
  registering: RefObject<boolean>;
  editorRef: RefObject<EditorState>;
  edit: (next: EditorState) => void;
  setQueued: Dispatch<SetStateAction<string[]>>;
  onExit: () => void;
  contentWidth: number;
  session: Pick<ManagerConversationSession, 'getPendingSummary'>;
  abortConfirmation: ReturnType<typeof useManagerAbortConfirmation>;
  questionAnswer: ReturnType<typeof useManagerQuestionAnswer>;
  summaryApproval: ReturnType<typeof useManagerSummaryApproval>;
  abortGoal: (goalId: string) => Promise<void>;
  saveAnswer: (target: PendingQuestion, text: string) => Promise<void>;
  register: (revision: number) => Promise<void>;
}): void {
  const { abortTarget } = abortConfirmation;
  const { answerTarget } = questionAnswer;
  const { pending, setPending } = summaryApproval;
  const insertText = (text: string): void => {
    if (exiting.current) return;
    if (!registering.current && active.current === null) {
      if (abortTarget !== null) return;
      if (answerTarget !== null) questionAnswer.switchToFreeText(answerTarget);
    }
    if (!registering.current && pending !== null && session.getPendingSummary()?.revision === pending.revision) {
      summaryApproval.dismiss(pending);
    }
    edit(applyEditorKey(editorRef.current, { kind: 'insert', text }));
  };
  usePaste(insertText);
  useInput((input, key) => {
    if (exiting.current) return;
    if (key.ctrl && input === 'c') {
      exiting.current = true;
      active.current?.abort();
      setQueued([]);
      onExit();
      return;
    }
    if (active.current !== null && key.escape) {
      active.current.abort();
      setQueued([]);
      setPending(null);
      return;
    }
    if (registering.current && key.escape) {
      setQueued([]);
      return;
    }
    if (!registering.current && active.current === null && abortTarget !== null) {
      abortConfirmation.handleInput(abortTarget, key, abortGoal);
      return;
    }
    const editKey = resolveEditorKey(input, key, contentWidth);
    // Ink は本文と同じチャンクに入った CR/LF を Enter と分類しない。
    const trailingEnter = !key.return && !(key.shift || key.meta)
      && editKey?.kind === 'insert' && /[\r\n]$/u.test(input);
    if (trailingEnter) insertText(input.replace(/(?:\r\n|\r|\n)$/u, ''));
    const submitInput = key.return || trailingEnter;
    if (!registering.current && active.current === null && answerTarget !== null) {
      if (questionAnswer.handleInput(answerTarget, key, submitInput, editorRef, edit, saveAnswer)) return;
    }
    if (!registering.current && pending !== null && session.getPendingSummary()?.revision === pending.revision) {
      if (summaryApproval.handleInput(pending, key, register)) return;
    }
    if (submitInput) {
      if (key.shift || key.meta) {
        edit(applyEditorKey(editorRef.current, { kind: 'newline' }));
      } else if (editorRef.current.text.trim() !== '') {
        const text = editorRef.current.text;
        edit(commitEditorInput(editorRef.current, text));
        setQueued((previous) => [...previous, text]);
      }
      return;
    }
    if (editKey !== null) edit(applyEditorKey(editorRef.current, editKey));
  });
}
