import { useInput, usePaste } from 'ink';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { applyEditorKey, commitEditorInput, type EditorState } from '../tui/editorState.js';
import { resolveEditorKey } from '../tui/editorKeys.js';
import type { ManagerConversationSession } from './conversationSession.js';
import type { ManagerAbortTarget, useManagerAbortConfirmation } from './useManagerAbortConfirmation.js';
import type { SaveManagerAnswer, useManagerQuestionAnswer } from './useManagerQuestionAnswer.js';
import type { useManagerSummaryApproval } from './useManagerSummaryApproval.js';
import type { ManagerSelectedTarget, ManagerSelectionCommand, useManagerSelection } from './useManagerSelection.js';

export function useManagerInput({
  exiting, active, registering, editorRef, edit, setQueued, onExit, contentWidth, session,
  abortConfirmation, questionAnswer, summaryApproval, selection, selectTarget, abortGoal, saveAnswer, register, onInputUnavailable,
  openMenu, summarize, cancelMenuRequest, cancelOperations,
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
  selection: ReturnType<typeof useManagerSelection>;
  selectTarget: (target: ManagerSelectedTarget) => void;
  abortGoal: (target: ManagerAbortTarget) => Promise<void>;
  saveAnswer: SaveManagerAnswer;
  register: (revision: number) => Promise<void>;
  onInputUnavailable: () => void;
  openMenu: (kind: ManagerSelectionCommand) => void;
  summarize: () => void;
  cancelMenuRequest: () => void;
  cancelOperations: () => void;
}): void {
  const { abortTarget } = abortConfirmation;
  const { answerTarget } = questionAnswer;
  const { pending, setPending } = summaryApproval;
  const editDraft = (next: EditorState): void => {
    if (!registering.current && pending !== null && session.getPendingSummary()?.revision === pending.revision
      && answerTarget === null && selection.selection === null && abortTarget === null
      && next.text !== editorRef.current.text) {
      summaryApproval.dismiss(pending);
    }
    edit(next);
  };
  const insertText = (text: string): void => {
    if (exiting.current || (answerTarget !== null && active.current !== null)) return;
    if (selection.selection !== null) return;
    if (abortTarget !== null) { onInputUnavailable(); return; }
    if (answerTarget !== null) questionAnswer.switchToFreeText();
    editDraft(applyEditorKey(editorRef.current, { kind: 'insert', text }));
  };
  usePaste(insertText);
  useInput((input, key) => {
    if (exiting.current) return;
    if (key.ctrl && input === 'c') {
      exiting.current = true;
      active.current?.abort();
      setQueued([]);
      cancelOperations();
      onExit();
      return;
    }
    if (key.ctrl && (input === 'r' || input === 'g' || input === 'o' || input === 'n' || input === 'p')) {
      if (input === 'o') summarize();
      else if (input === 'n') openMenu('notice');
      else if (input === 'p') openMenu('repository');
      else openMenu(input === 'r' ? 'answer' : 'goal');
      return;
    }
    if (selection.selection !== null) {
      if (key.escape) cancelMenuRequest();
      selection.handleInput(key, selectTarget);
      return;
    }
    if (questionAnswer.handleNavigation(key, editorRef)) {
      if (key.escape) cancelMenuRequest();
      return;
    }
    if (key.escape) cancelOperations();
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
    if (answerTarget !== null && active.current !== null) return;
    if (!registering.current && active.current === null && abortTarget !== null) {
      if (input !== '' && !key.ctrl && !key.meta && !key.return && !key.escape) onInputUnavailable();
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
      if (questionAnswer.handleInput(key, submitInput, editorRef, edit, saveAnswer)) return;
    }
    if (!registering.current && answerTarget === null && pending !== null && session.getPendingSummary()?.revision === pending.revision
      && (key.escape || (editorRef.current.text === ''
        && (key.upArrow || key.downArrow || (editKey === null && !key.return)
          || (key.return && !key.shift && !key.meta))))) {
      if (summaryApproval.handleInput(pending, key, register)) return;
    }
    if (submitInput) {
      if (key.shift || key.meta) {
        editDraft(applyEditorKey(editorRef.current, { kind: 'newline' }));
      } else if (editorRef.current.text.trim() !== '') {
        const text = editorRef.current.text;
        edit(commitEditorInput(editorRef.current, text));
        setQueued((previous) => [...previous, text]);
      }
      return;
    }
    if (editKey !== null) {
      if (editKey.kind === 'insert') insertText(editKey.text);
      else editDraft(applyEditorKey(editorRef.current, editKey));
    }
  });
}
