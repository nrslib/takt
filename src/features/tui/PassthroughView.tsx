import { Box, Text, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { InteractiveModeResult } from '../interactive/interactive.js';
import { PromptInput } from './PromptInput.js';
import { toDisplayText, toSingleLineText } from './displayText.js';
import {
  applyEditorKey,
  createEditorState,
  type EditorState,
} from './editorState.js';
import { resolvePromptContentWidth } from './promptLayout.js';
import { useImagePaste, type ImagePasteSink, type PendingWork } from './useImagePaste.js';

/**
 * Passthrough takes the typed text as the task verbatim. It never contacts a
 * provider, so it deliberately does not build a conversation session — that
 * would demand a configured provider the mode does not need. It still accepts
 * pasted images, exactly as the readline passthrough does.
 */
export interface PassthroughViewProps {
  readonly intro: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly lang: 'en' | 'ja';
  readonly images: ImagePasteSink;
  readonly initialText: string;
  readonly onDone: (result: InteractiveModeResult) => void;
}

const CANCELLED: InteractiveModeResult = { action: 'cancel', task: '' };

export function PassthroughView({
  intro,
  hint,
  placeholder,
  lang,
  images,
  initialText,
  onDone,
}: PassthroughViewProps): ReactElement {
  // Ink can deliver several keypresses before React re-renders, so the ref is the
  // authoritative buffer that handlers read and edit; the state is its render mirror.
  // The seed keeps its line breaks: this is a multi-line editor and the text is
  // taken as the task verbatim.
  const editorRef = useRef<EditorState>(createEditorState(toDisplayText(initialText)));
  const [editor, setEditorView] = useState<EditorState>(editorRef.current);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRef = useRef<Set<PendingWork>>(new Set());
  const doneRef = useRef(false);
  const finishingRef = useRef(false);
  const { stdout } = useStdout();
  // Resolved once per render: the keys and the box must agree on the row width.
  const contentWidth = resolvePromptContentWidth(stdout?.columns);

  // A teardown started outside this view must stop the saves in flight and seal
  // the store, or a capture that ignores its abort writes a file the caller has
  // already cleaned up.
  useEffect(() => () => {
    doneRef.current = true;
    for (const work of pendingRef.current) {
      work.controller.abort();
    }
    images.sealImages();
  }, [images]);

  const edit = useCallback((next: EditorState) => {
    editorRef.current = next;
    setEditorView(next);
  }, []);

  const insertAtCaret = useCallback((text: string): void => {
    edit(applyEditorKey(editorRef.current, { kind: 'insert', text }));
  }, [edit]);

  const trackPendingWork = useCallback((work: PendingWork) => {
    pendingRef.current.add(work);
    void work.completion.finally(() => pendingRef.current.delete(work));
  }, []);

  const { routeInput, captureClipboard } = useImagePaste({
    sink: images,
    lang,
    insertAtCaret,
    setNotice,
    track: trackPendingWork,
    isStopped: () => doneRef.current,
  });

  const settleOnce = useCallback((result: InteractiveModeResult): void => {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    // Sealed synchronously with the settle: a capture that finishes afterwards
    // must not write a file the caller has already cleaned up.
    images.sealImages();
    onDone(result);
  }, [images, onDone]);

  /**
   * Drains the saves in flight before deciding the task, so a placeholder that
   * lands while the user presses Enter is part of the text, and so the caller's
   * cleanup cannot race a temp file.
   */
  const finish = useCallback(async (
    resolveResult: () => InteractiveModeResult,
  ): Promise<void> => {
    finishingRef.current = true;
    while (pendingRef.current.size > 0) {
      const draining = [...pendingRef.current];
      for (const work of draining) {
        work.controller.abort();
      }
      await Promise.all(draining.map((work) => work.completion));
      for (const work of draining) {
        pendingRef.current.delete(work);
      }
    }
    settleOnce(resolveResult());
  }, [settleOnce]);

  useInput((input, key) => {
    if (doneRef.current) {
      return;
    }
    // Ctrl+D cancels next to Ctrl+C, whatever the draft holds, exactly as the
    // readline editor treats the two (lineEditor.ts).
    if (key.ctrl && (input === 'c' || input === 'd')) {
      // A second interrupt stops waiting on a capture that ignores the abort.
      if (finishingRef.current) {
        settleOnce(CANCELLED);
        return;
      }
      void finish(() => CANCELLED);
      return;
    }
    if (finishingRef.current) {
      return;
    }
    if (routeInput(input, key)) {
      return;
    }
    if (key.ctrl && input === 'v') {
      captureClipboard();
      return;
    }
    // Shift+Enter and Option+Enter insert a line break; plain Enter runs the text.
    if (key.return && (key.shift || key.meta)) {
      edit(applyEditorKey(editorRef.current, { kind: 'newline' }));
      return;
    }
    if (key.return) {
      // Read after the drain: a save still running owns part of the text.
      void finish(() => {
        const task = editorRef.current.text.trim();
        return task ? { action: 'execute', task } : CANCELLED;
      });
      return;
    }
    if (key.backspace) {
      edit(applyEditorKey(editorRef.current, { kind: 'backspace' }));
      return;
    }
    if (key.delete) {
      edit(applyEditorKey(editorRef.current, { kind: 'delete' }));
      return;
    }
    if (key.leftArrow) {
      edit(applyEditorKey(editorRef.current, { kind: 'left' }));
      return;
    }
    if (key.rightArrow) {
      edit(applyEditorKey(editorRef.current, { kind: 'right' }));
      return;
    }
    // The draft is multi-line here, so the arrows walk its lines. There is no
    // history in this mode, so at the first and last line they do nothing.
    if (key.upArrow) {
      edit(applyEditorKey(editorRef.current, { kind: 'up', contentWidth }));
      return;
    }
    if (key.downArrow) {
      edit(applyEditorKey(editorRef.current, { kind: 'down', contentWidth }));
      return;
    }
    if (key.ctrl && input === 'k') {
      edit(applyEditorKey(editorRef.current, { kind: 'deleteToLineEnd' }));
      return;
    }
    // Home/End keys, plus their readline equivalents.
    if (key.home || (key.ctrl && input === 'a')) {
      edit(applyEditorKey(editorRef.current, { kind: 'home' }));
      return;
    }
    if (key.end || (key.ctrl && input === 'e')) {
      edit(applyEditorKey(editorRef.current, { kind: 'end' }));
      return;
    }
    if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) {
      return;
    }
    edit(applyEditorKey(editorRef.current, { kind: 'insert', text: input }));
  });

  return (
    <Box flexDirection="column">
      <Text color="gray" wrap="truncate-end">{toDisplayText(intro)}</Text>
      {/* Always rendered so the frame height never changes underneath Ink. */}
      <Text color="red" wrap="truncate-end">{notice === null ? ' ' : toSingleLineText(notice)}</Text>
      <PromptInput
        text={editor.text}
        cursor={editor.cursor}
        contentWidth={contentWidth}
        placeholder={placeholder}
        hint={hint}
        completions={[]}
        completionIndex={0}
        disabled={false}
      />
    </Box>
  );
}
